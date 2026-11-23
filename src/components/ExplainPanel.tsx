/** Streaming explanation card with follow-up chat, shown floating near the selection or pinned to the side. */
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { openUrl } from "@tauri-apps/plugin-opener";
import "katex/dist/katex.min.css";
import { normalizeMath, stripMarkers } from "../lib/math";
import { useExplain } from "../state/explain";
import { providerLabel, useSettings } from "../state/settings";

interface Props {
  anchor: { x: number; y: number; width: number; height: number } | null;
}

type Anchor = Props["anchor"];

const PANEL_WIDTH = 380;
const MARGIN = 12;
const TOOLBAR_HEIGHT = 44;

/** Places the panel below, above, or beside the anchor so it fits the viewport without covering the selection when possible. */
export function floatingPosition(anchor: Anchor, height: number, viewport: { width: number; height: number }) {
  const width = Math.min(PANEL_WIDTH, viewport.width - MARGIN * 2);
  const maxHeight = Math.max(160, viewport.height - TOOLBAR_HEIGHT - MARGIN * 2);
  const h = Math.min(height, maxHeight);
  const minTop = TOOLBAR_HEIGHT + MARGIN;
  const maxTop = viewport.height - MARGIN - h;
  if (!anchor) return { top: minTop, left: viewport.width - width - MARGIN, width, maxHeight };
  const below = anchor.y + anchor.height + MARGIN;
  const above = anchor.y - MARGIN - h;
  const clampLeft = (x: number) => Math.max(MARGIN, Math.min(viewport.width - width - MARGIN, x));
  if (below <= maxTop) return { top: below, left: clampLeft(anchor.x), width, maxHeight };
  if (above >= minTop) return { top: above, left: clampLeft(anchor.x), width, maxHeight };
  const top = Math.max(minTop, Math.min(maxTop, anchor.y - h / 2));
  const right = anchor.x + anchor.width + MARGIN;
  const leftSide = anchor.x - MARGIN - width;
  if (right + width <= viewport.width - MARGIN) return { top, left: right, width, maxHeight };
  if (leftSide >= MARGIN) return { top, left: leftSide, width, maxHeight };
  return { top: Math.max(minTop, maxTop), left: clampLeft(anchor.x), width, maxHeight };
}

/** Tracks the window size so floating layout recomputes on resize. */
function useViewport() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** Renders markdown links as buttons that open http(s) URLs in the system browser instead of the app window. */
function ExternalLink({ href, children }: ComponentProps<"a">) {
  const safe = typeof href === "string" && /^https?:\/\//i.test(href);
  if (!safe) return <span>{children}</span>;
  return (
    <a
      href={href}
      title={href}
      className="text-blue-600 underline dark:text-blue-400"
      onClick={(e) => {
        e.preventDefault();
        openUrl(href).catch(() => undefined);
      }}
    >
      {children}
    </a>
  );
}

/** Renders assistant markdown with LaTeX math support. */
function Answer({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]} components={{ a: ExternalLink }}>
      {normalizeMath(stripMarkers(text))}
    </Markdown>
  );
}

/** Renders the active explanation conversation, or nothing when there is none. */
export default function ExplainPanel({ anchor }: Props) {
  const { conversation, pinned, setPinned, followUp, regenerate, stop, close } = useExplain();
  const settings = useSettings((s) => s.settings);
  const [question, setQuestion] = useState("");
  const [height, setHeight] = useState(320);
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewport = useViewport();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [conversation?.turns]);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el || pinned) return;
    const observer = new ResizeObserver(() => setHeight(el.getBoundingClientRect().height));
    observer.observe(el);
    return () => observer.disconnect();
  }, [pinned, conversation !== null]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && conversation && !pinned) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conversation, pinned, close]);

  if (!conversation) return null;
  const { ctx, turns, streaming, error } = conversation;
  const lastAnswer = turns[turns.length - 1]?.content ?? "";
  const pos = floatingPosition(anchor, height, viewport);

  const container = pinned
    ? "fixed right-0 bottom-0 z-30 flex flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    : "fixed z-40 flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900";
  const style: React.CSSProperties = pinned
    ? { top: TOOLBAR_HEIGHT, width: Math.min(PANEL_WIDTH, viewport.width) }
    : { top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight };

  return (
    <aside ref={panelRef} className={container} style={style} onMouseDown={(e) => e.stopPropagation()}>
      <header className="flex shrink-0 items-start gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">“{ctx.selection}”</p>
          <p className="text-[11px] text-neutral-500">
            Page {ctx.pageIndex + 1} · {providerLabel(settings)}
          </p>
        </div>
        <button type="button" className="icon-btn" title={pinned ? "Unpin" : "Pin to side"} onClick={() => setPinned(!pinned)}>
          {pinned ? "⇱" : "⇲"}
        </button>
        <button type="button" className="icon-btn" title="Close" onClick={close}>
          ✕
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
        {turns.map((t, i) =>
          t.role === "user" ? (
            <p key={i} className="ml-8 rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
              {t.content}
            </p>
          ) : (
            <div key={i} className="markdown">
              {t.content ? <Answer text={t.content} /> : streaming && i === turns.length - 1 ? <ThinkingDots /> : null}
            </div>
          ),
        )}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      </div>

      <footer className="shrink-0 space-y-2 border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex gap-2 text-xs">
          {streaming ? (
            <button type="button" className="chip" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="button" className="chip" onClick={() => regenerate(settings)}>
              Regenerate
            </button>
          )}
          <button type="button" className="chip" disabled={!lastAnswer} onClick={() => navigator.clipboard.writeText(lastAnswer)}>
            Copy
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            followUp(question, settings);
            setQuestion("");
          }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={streaming}
            placeholder="Ask a follow-up…"
            className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700"
          />
        </form>
      </footer>
    </aside>
  );
}

/** Animated placeholder shown before the first token arrives. */
function ThinkingDots() {
  return (
    <span className="inline-flex gap-1 py-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </span>
  );
}
