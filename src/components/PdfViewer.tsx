/** Continuous, virtualized PDF page view with HiDPI canvases, selectable text layers, zoom and search highlights. */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ViewerSelection } from "../types";
import {
  PDF_TO_CSS_UNITS,
  getPageSizes,
  getPageTextContent,
  getPageTextIndex,
  pdfjs,
  peekPageTextIndex,
  rotatedSize,
  type PDFDocumentProxy,
  type PageSize,
  type RenderTask,
} from "../lib/pdf";
import { captureSelection } from "../lib/selection";
import { highlightHits } from "../lib/search";
import { clampZoom, useViewer } from "../state/viewer";

export interface PdfViewerProps {
  onSelectionChange(sel: ViewerSelection | null): void;
}

interface PageBox {
  width: number;
  height: number;
  top: number;
}

interface PageHits {
  ranges: Array<{ start: number; end: number }>;
  active: number;
}

const PAD = 16;
const GAP = 12;
const RENDER_MARGIN = 2;
const MAX_CANVAS_PIXELS = 4096 * 4096;
const NO_HITS: PageHits = { ranges: [], active: -1 };

/** Computes on-screen boxes for every page at a CSS scale and user rotation. */
function computeLayout(sizes: PageSize[], cssScale: number, rotation: number): { boxes: PageBox[]; width: number } {
  let top = PAD;
  let width = 0;
  const boxes = sizes.map((s) => {
    const r = rotatedSize(s, rotation);
    const box = { width: Math.floor(r.width * cssScale), height: Math.floor(r.height * cssScale), top };
    top += box.height + GAP;
    width = Math.max(width, box.width);
    return box;
  });
  return { boxes, width };
}

/** Returns the index of the page box containing a vertical content offset. */
function pageAtOffset(boxes: PageBox[], y: number): number {
  let lo = 0;
  let hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (boxes[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Returns true if an error is pdf.js signalling a cancelled render or text layer. */
function isCancel(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "RenderingCancelledException" || name === "AbortException";
}

/** Renders the PDF viewer; fires onSelectionChange with text-layer selections. */
export default function PdfViewer({ onSelectionChange }: PdfViewerProps) {
  const doc = useViewer((s) => s.doc);
  const zoom = useViewer((s) => s.zoom);
  const fitMode = useViewer((s) => s.fitMode);
  const rotation = useViewer((s) => s.rotation);
  const navRequest = useViewer((s) => s.navRequest);
  const searchHits = useViewer((s) => s.searchHits);
  const activeHit = useViewer((s) => s.activeHit);
  const hitNonce = useViewer((s) => s.hitNonce);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<PageSize[] | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [visible, setVisible] = useState({ first: 0, last: 0 });
  const [zooming, setZooming] = useState(false);
  const cssScale = zoom * PDF_TO_CSS_UNITS;

  useEffect(() => {
    setSizes(null);
    if (!doc) return;
    let cancelled = false;
    getPageSizes(doc)
      .then((s) => !cancelled && setSizes(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const layout = useMemo(() => (sizes ? computeLayout(sizes, cssScale, rotation) : null), [sizes, cssScale, rotation]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!sizes || fitMode === "custom" || viewport.w === 0) return;
    const availW = Math.max(50, viewport.w - PAD * 2);
    const availH = Math.max(50, viewport.h - PAD * 2);
    let z: number;
    if (fitMode === "width") {
      const widest = Math.max(...sizes.map((s) => rotatedSize(s, rotation).width));
      z = availW / (widest * PDF_TO_CSS_UNITS);
    } else {
      const page = rotatedSize(sizes[Math.min(useViewer.getState().currentPage, sizes.length - 1)], rotation);
      z = Math.min(availW / (page.width * PDF_TO_CSS_UNITS), availH / (page.height * PDF_TO_CSS_UNITS));
    }
    useViewer.getState().setFittedZoom(Math.floor(z * 1000) / 1000);
  }, [sizes, fitMode, rotation, viewport.w, viewport.h]);

  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const prevLayoutRef = useRef<{ boxes: PageBox[]; width: number } | null>(null);
  const prevScaleRef = useRef(cssScale);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevLayoutRef.current;
    const prevScale = prevScaleRef.current;
    prevLayoutRef.current = layout;
    prevScaleRef.current = cssScale;
    if (!el || !layout || !prev || prev.boxes.length !== layout.boxes.length || prevScale === cssScale) return;
    const anchor = anchorRef.current ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    anchorRef.current = null;
    const oldY = el.scrollTop + anchor.y;
    const k = pageAtOffset(prev.boxes, oldY);
    const fy = (oldY - prev.boxes[k].top) / Math.max(1, prev.boxes[k].height);
    const nb = layout.boxes[k];
    el.scrollTop = nb.top + fy * nb.height - anchor.y;
    const oldX = el.scrollLeft + anchor.x;
    el.scrollLeft = oldX * (cssScale / prevScale) - anchor.x;
  }, [layout, cssScale]);

  const zoomScaleRef = useRef(cssScale);
  useEffect(() => {
    if (zoomScaleRef.current === cssScale) return;
    zoomScaleRef.current = cssScale;
    setZooming(true);
    const t = window.setTimeout(() => setZooming(false), 250);
    return () => window.clearTimeout(t);
  }, [cssScale]);

  const appliedNavRef = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !layout || !navRequest || appliedNavRef.current === navRequest.nonce) return;
    const box = layout.boxes[navRequest.pageIndex];
    if (!box) return;
    appliedNavRef.current = navRequest.nonce;
    el.scrollTop = box.top - PAD / 2;
    setVisible({ first: navRequest.pageIndex, last: navRequest.pageIndex });
  }, [navRequest, layout]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !sizes) return;
    const seen = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.pageIndex);
          if (e.isIntersecting && e.intersectionRect.height > 0) seen.set(idx, e.intersectionRect.height);
          else seen.delete(idx);
        }
        if (seen.size === 0) return;
        let first = Infinity;
        let last = -1;
        let best = -1;
        let bestH = -1;
        seen.forEach((h, idx) => {
          first = Math.min(first, idx);
          last = Math.max(last, idx);
          if (h > bestH || (h === bestH && idx < best)) {
            best = idx;
            bestH = h;
          }
        });
        setVisible((v) => (v.first === first && v.last === last ? v : { first, last }));
        useViewer.getState().setCurrentPage(best);
      },
      { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1] },
    );
    const pages = root.querySelectorAll("[data-page-index]");
    for (let i = 0; i < pages.length; i++) io.observe(pages[i]);
    return () => io.disconnect();
  }, [sizes]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !doc) return;
    let gestureStart: number | null = null;
    const anchorFrom = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      anchorRef.current = { x: clientX - r.left, y: clientY - r.top };
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (gestureStart !== null) return;
      const dy = Math.max(-25, Math.min(25, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
      anchorFrom(e.clientX, e.clientY);
      const s = useViewer.getState();
      s.setZoom(clampZoom(s.zoom * Math.exp(-dy * 0.01)));
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = useViewer.getState().zoom;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      if (gestureStart === null) return;
      anchorFrom(g.clientX, g.clientY);
      useViewer.getState().setZoom(gestureStart * g.scale);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gestureStart = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const s = useViewer.getState();
      if (e.key === "+" || e.key === "=") s.zoomIn();
      else if (e.key === "-" || e.key === "_") s.zoomOut();
      else if (e.key === "0") s.setZoom(1);
      else return;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      window.removeEventListener("keydown", onKey);
    };
  }, [doc]);

  const onSelectionRef = useRef(onSelectionChange);
  onSelectionRef.current = onSelectionChange;
  const lastSelRef = useRef<ViewerSelection | null>(null);

  const emitSelection = useCallback((sel: ViewerSelection | null) => {
    const last = lastSelRef.current;
    if (!sel && !last) return;
    if (
      sel &&
      last &&
      sel.pageIndex === last.pageIndex &&
      sel.start === last.start &&
      sel.end === last.end &&
      sel.anchor.x === last.anchor.x &&
      sel.anchor.y === last.anchor.y
    )
      return;
    lastSelRef.current = sel;
    onSelectionRef.current(sel);
  }, []);

  useEffect(() => {
    lastSelRef.current = null;
    onSelectionRef.current(null);
  }, [doc]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !doc) return;
    const inViewer = (node: Node | null) => !!node && el.contains(node);
    const capture = () => {
      const sel = window.getSelection();
      const result = captureSelection(sel, el, (i) => peekPageTextIndex(doc, i));
      if (result) emitSelection(result);
      else if (!sel || sel.rangeCount === 0 || sel.isCollapsed || inViewer(sel.anchorNode)) emitSelection(null);
    };
    const onUp = () => {
      el.querySelectorAll(".textLayer.selecting").forEach((n) => n.classList.remove("selecting"));
      capture();
    };
    const onDown = (e: MouseEvent) => {
      const layer = (e.target as Element | null)?.closest?.(".textLayer");
      if (layer && el.contains(layer)) layer.classList.add("selecting");
    };
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || (sel.isCollapsed && (inViewer(sel.anchorNode) || !sel.anchorNode))) {
        emitSelection(null);
      }
    };
    const onScroll = () => {
      if (!lastSelRef.current) return;
      const result = captureSelection(window.getSelection(), el, (i) => peekPageTextIndex(doc, i));
      if (result) emitSelection(result);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    el.addEventListener("keyup", capture);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
      el.removeEventListener("keyup", capture);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [doc, emitSelection]);

  const hitsByPage = useMemo(() => {
    const m = new Map<number, PageHits>();
    searchHits.forEach((h, i) => {
      let entry = m.get(h.pageIndex);
      if (!entry) {
        entry = { ranges: [], active: -1 };
        m.set(h.pageIndex, entry);
      }
      if (i === activeHit) entry.active = entry.ranges.length;
      entry.ranges.push({ start: h.start, end: h.end });
    });
    return m;
  }, [searchHits, activeHit]);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    const { searchHits: hits, activeHit: active } = useViewer.getState();
    const hit = hits[active];
    if (!hit || hitNonce === 0) return;
    const { first, last } = visibleRef.current;
    if (hit.pageIndex < first || hit.pageIndex > last) useViewer.getState().goToPage(hit.pageIndex);
  }, [hitNonce]);

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const outputScale = zooming ? Math.min(dpr, 1) : Math.min(dpr, 3);

  return (
    <div ref={scrollRef} className="pdf-scroll relative h-full w-full overflow-auto bg-canvas outline-none" tabIndex={-1}>
      {doc && sizes && layout && (
        <div className="pdf-pages" style={{ width: "max-content", minWidth: "100%", padding: PAD, paddingBottom: PAD + GAP }}>
          {sizes.map((size, i) => (
            <PageView
              key={i}
              doc={doc}
              pageIndex={i}
              size={size}
              box={layout.boxes[i]}
              cssScale={cssScale}
              rotation={rotation}
              active={i >= visible.first - RENDER_MARGIN && i <= visible.last + RENDER_MARGIN}
              outputScale={outputScale}
              hits={hitsByPage.get(i) ?? NO_HITS}
              hitNonce={hitNonce}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PageViewProps {
  doc: PDFDocumentProxy;
  pageIndex: number;
  size: PageSize;
  box: PageBox;
  cssScale: number;
  rotation: number;
  active: boolean;
  outputScale: number;
  hits: PageHits;
  hitNonce: number;
}

/** One page: a sized placeholder that renders its canvas and text layer only while active. */
const PageView = memo(function PageView({
  doc,
  pageIndex,
  size,
  box,
  cssScale,
  rotation,
  active,
  outputScale,
  hits,
  hitNonce,
}: PageViewProps) {
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [textReady, setTextReady] = useState(false);
  const scaleRef = useRef(cssScale);
  scaleRef.current = cssScale;
  const totalRotation = (((size.rotate + rotation) % 360) + 360) % 360;

  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    if (!active) {
      wrap.replaceChildren();
      setRendered(false);
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    doc
      .getPage(pageIndex + 1)
      .then(async (page) => {
        if (cancelled) return;
        const vp = page.getViewport({ scale: cssScale, rotation: totalRotation });
        let ratio = outputScale;
        if (vp.width * vp.height * ratio * ratio > MAX_CANVAS_PIXELS) {
          ratio = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height));
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(vp.width * ratio));
        canvas.height = Math.max(1, Math.floor(vp.height * ratio));
        canvas.setAttribute("aria-hidden", "true");
        const sx = canvas.width / vp.width;
        const sy = canvas.height / vp.height;
        task = page.render({ canvas, viewport: vp, transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : undefined });
        await task.promise;
        if (cancelled) return;
        wrap.replaceChildren(canvas);
        setRendered(true);
      })
      .catch((e) => {
        if (!isCancel(e)) console.error("Page render failed", e);
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageIndex, active, cssScale, totalRotation, outputScale]);

  useEffect(() => {
    const container = textRef.current;
    if (!container) return;
    setTextReady(false);
    if (!active) {
      container.replaceChildren();
      return;
    }
    let cancelled = false;
    let layer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    Promise.all([doc.getPage(pageIndex + 1), getPageTextContent(doc, pageIndex), getPageTextIndex(doc, pageIndex)])
      .then(async ([page, content]) => {
        if (cancelled) return;
        container.replaceChildren();
        const vp = page.getViewport({ scale: scaleRef.current, rotation: totalRotation });
        layer = new pdfjs.TextLayer({ textContentSource: content, container, viewport: vp });
        await layer.render();
        if (cancelled) return;
        layer.textDivs.forEach((div, i) => {
          div.dataset.itemIndex = String(i);
        });
        const end = document.createElement("div");
        end.className = "endOfContent";
        container.append(end);
        setTextReady(true);
      })
      .catch((e) => {
        if (!isCancel(e)) console.error("Text layer failed", e);
      });
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [doc, pageIndex, active, totalRotation]);

  const scrolledNonceRef = useRef(0);
  useEffect(() => {
    const container = textRef.current;
    if (!container || !textReady) return;
    const index = peekPageTextIndex(doc, pageIndex);
    if (!index) return;
    const mark = highlightHits(container, index, hits.ranges, hits.active);
    if (mark && hits.active >= 0 && scrolledNonceRef.current !== hitNonce) {
      scrolledNonceRef.current = hitNonce;
      mark.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [doc, pageIndex, hits, hitNonce, textReady]);

  const style = {
    width: box.width,
    height: box.height,
    "--scale-factor": cssScale,
    "--user-unit": size.userUnit,
  } as CSSProperties;

  return (
    <div className="pdf-page" data-page-index={pageIndex} style={style}>
      <div ref={canvasWrapRef} className="canvasWrapper" />
      <div ref={textRef} className="textLayer" />
      {!rendered && <div className="pdf-page-loading" aria-hidden="true" />}
    </div>
  );
});
