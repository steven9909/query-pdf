/** Left sidebar with lazily rendered page thumbnails and the document outline. */
import { memo, useEffect, useRef, useState } from "react";
import { getPageSizes, rotatedSize, type PDFDocumentProxy, type PageSize, type RenderTask } from "../lib/pdf";
import { useViewer } from "../state/viewer";

const THUMB_WIDTH = 116;

/** Outline entry with its destination resolved to a page index. */
export interface OutlineEntry {
  title: string;
  pageIndex: number | null;
  bold: boolean;
  italic: boolean;
  children: OutlineEntry[];
}

type RawOutline = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>;

/** Resolves an outline destination (named or explicit) to a 0-based page index. */
export async function resolveDestination(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const target = explicit[0];
    if (Number.isInteger(target)) return target as number;
    if (target && typeof target === "object") return await doc.getPageIndex(target as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
    return null;
  } catch {
    return null;
  }
}

/** Loads the outline tree and resolves every destination. */
export async function loadOutline(doc: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const raw: RawOutline = (await doc.getOutline()) ?? [];
  const convert = async (items: RawOutline): Promise<OutlineEntry[]> =>
    Promise.all(
      items.map(async (item) => ({
        title: item.title,
        pageIndex: await resolveDestination(doc, item.dest),
        bold: item.bold,
        italic: item.italic,
        children: await convert((item.items ?? []) as RawOutline),
      })),
    );
  return convert(raw);
}

/** Renders the sidebar for the current document and sidebar mode. */
export default function Sidebar() {
  const doc = useViewer((s) => s.doc);
  const mode = useViewer((s) => s.sidebarMode);
  const setMode = useViewer((s) => s.setSidebarMode);
  if (!doc || mode === "none") return null;
  return (
    <aside className="flex h-full w-48 shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex shrink-0 gap-1 p-2">
        {(["thumbnails", "outline"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              mode === m ? "bg-control-active text-fg" : "text-muted hover:bg-control-hover"
            }`}
          >
            {m === "thumbnails" ? "Thumbnails" : "Contents"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === "thumbnails" ? <Thumbnails doc={doc} /> : <Outline doc={doc} />}
      </div>
    </aside>
  );
}

/** Scrollable list of page thumbnails; the current page is highlighted and kept in view. */
function Thumbnails({ doc }: { doc: PDFDocumentProxy }) {
  const [sizes, setSizes] = useState<PageSize[] | null>(null);
  const rotation = useViewer((s) => s.rotation);
  const current = useViewer((s) => s.currentPage);
  const goToPage = useViewer((s) => s.goToPage);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSizes(null);
    getPageSizes(doc)
      .then((s) => !cancelled && setSizes(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doc]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-thumb-index="${current}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [current, sizes]);

  if (!sizes) return null;
  return (
    <div ref={listRef} className="flex flex-col items-center gap-3 px-2 pb-4 pt-1">
      {sizes.map((size, i) => (
        <button
          key={i}
          type="button"
          data-thumb-index={i}
          onClick={() => goToPage(i)}
          className="group flex flex-col items-center gap-1 outline-none"
        >
          <Thumbnail doc={doc} pageIndex={i} size={size} rotation={rotation} selected={i === current} />
          <span className={`text-[11px] ${i === current ? "font-semibold text-fg" : "text-muted"}`}>{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

interface ThumbnailProps {
  doc: PDFDocumentProxy;
  pageIndex: number;
  size: PageSize;
  rotation: number;
  selected: boolean;
}

/** A single thumbnail canvas that renders once it scrolls near the viewport. */
const Thumbnail = memo(function Thumbnail({ doc, pageIndex, size, rotation, selected }: ThumbnailProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const shown = rotatedSize(size, rotation);
  const scale = THUMB_WIDTH / shown.width;
  const height = Math.round(shown.height * scale);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      rootMargin: "300px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !near) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    doc
      .getPage(pageIndex + 1)
      .then(async (page) => {
        if (cancelled) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const vp = page.getViewport({ scale: scale * ratio, rotation: (((page.rotate + rotation) % 360) + 360) % 360 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(vp.width));
        canvas.height = Math.max(1, Math.floor(vp.height));
        canvas.className = "block h-full w-full";
        task = page.render({ canvas, viewport: vp });
        await task.promise;
        if (!cancelled) el.replaceChildren(canvas);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageIndex, rotation, near, scale]);

  return (
    <div
      ref={ref}
      style={{ width: THUMB_WIDTH, height }}
      className={`overflow-hidden rounded-[3px] bg-white shadow-sm ring-offset-2 ring-offset-sidebar transition-shadow ${
        selected ? "ring-2 ring-accent" : "ring-1 ring-line group-hover:ring-muted"
      }`}
    />
  );
});

/** The document outline as a collapsible tree. */
function Outline({ doc }: { doc: PDFDocumentProxy }) {
  const [entries, setEntries] = useState<OutlineEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    loadOutline(doc)
      .then((e) => !cancelled && setEntries(e))
      .catch(() => !cancelled && setEntries([]));
    return () => {
      cancelled = true;
    };
  }, [doc]);

  if (!entries) return <p className="px-3 py-2 text-xs text-muted">Loading…</p>;
  if (entries.length === 0) return <p className="px-3 py-2 text-xs text-muted">No table of contents</p>;
  return (
    <ul className="px-1 pb-4 text-[13px]">
      {entries.map((e, i) => (
        <OutlineNode key={i} entry={e} depth={0} />
      ))}
    </ul>
  );
}

/** One outline row with its children. */
function OutlineNode({ entry, depth }: { entry: OutlineEntry; depth: number }) {
  const [open, setOpen] = useState(depth === 0 && entry.children.length <= 12);
  const goToPage = useViewer((s) => s.goToPage);
  const hasChildren = entry.children.length > 0;
  return (
    <li>
      <div className="flex items-center rounded-md hover:bg-control-hover" style={{ paddingLeft: depth * 12 }}>
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          onClick={() => setOpen(!open)}
          className={`flex h-6 w-5 shrink-0 items-center justify-center text-muted ${hasChildren ? "" : "invisible"}`}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" className={`transition-transform ${open ? "rotate-90" : ""}`}>
            <path d="M2 1l4 3-4 3z" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          disabled={entry.pageIndex === null}
          onClick={() => entry.pageIndex !== null && goToPage(entry.pageIndex)}
          className={`min-w-0 flex-1 truncate py-1 pr-2 text-left text-fg disabled:text-muted ${entry.bold ? "font-semibold" : ""} ${
            entry.italic ? "italic" : ""
          }`}
          title={entry.title}
        >
          {entry.title}
        </button>
      </div>
      {open && hasChildren && (
        <ul>
          {entry.children.map((c, i) => (
            <OutlineNode key={i} entry={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
