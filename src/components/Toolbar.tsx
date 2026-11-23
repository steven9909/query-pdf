/** Window toolbar: open, sidebar, page navigation, zoom, rotate, find and settings. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { findInDocument } from "../lib/search";
import { openPdfWithDialog } from "../lib/openFile";
import { useViewer, ZOOM_STEPS } from "../state/viewer";

export interface ToolbarProps {
  onOpenSettings(): void;
  onOpen?(): void;
  right?: ReactNode;
}

/** Renders a small stroke icon from a path list. */
function Icon({ d, size = 16 }: { d: string[]; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

const ICONS = {
  open: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  sidebar: ["M4 5h16v14H4z", "M9 5v14"],
  minus: ["M5 12h14"],
  plus: ["M12 5v14", "M5 12h14"],
  rotateLeft: ["M4 4v5h5", "M4.6 9A8 8 0 1 1 6 17"],
  rotateRight: ["M20 4v5h-5", "M19.4 9A8 8 0 1 0 18 17"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
  up: ["M6 15l6-6 6 6"],
  down: ["M6 9l6 6 6-6"],
  gear: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  ],
};

/** A square icon button in toolbar style. */
function ToolButton(props: { label: string; icon: string[]; onClick(): void; disabled?: boolean; active?: boolean }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-fg transition-colors hover:bg-control-hover disabled:opacity-35 disabled:hover:bg-transparent ${
        props.active ? "bg-control-active" : ""
      }`}
    >
      <Icon d={props.icon} />
    </button>
  );
}

/** The viewer toolbar bound to the viewer store. */
export default function Toolbar({ onOpenSettings, onOpen, right }: ToolbarProps) {
  const doc = useViewer((s) => s.doc);
  const fileName = useViewer((s) => s.fileName);
  const numPages = useViewer((s) => s.numPages);
  const currentPage = useViewer((s) => s.currentPage);
  const zoom = useViewer((s) => s.zoom);
  const fitMode = useViewer((s) => s.fitMode);
  const sidebarMode = useViewer((s) => s.sidebarMode);
  const searchQuery = useViewer((s) => s.searchQuery);
  const hits = useViewer((s) => s.searchHits);
  const activeHit = useViewer((s) => s.activeHit);
  const actions = useViewer.getState();
  const [pageText, setPageText] = useState("");
  const [searching, setSearching] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  const open = onOpen ?? (() => void openPdfWithDialog());

  useEffect(() => {
    setPageText(numPages ? String(currentPage + 1) : "");
  }, [currentPage, numPages]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const s = useViewer.getState();
    if (!doc || !searchQuery.trim()) {
      if (s.searchHits.length) s.setSearchHits([]);
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const t = window.setTimeout(() => {
      findInDocument(doc, searchQuery, ctrl.signal)
        .then((found) => {
          if (ctrl.signal.aborted) return;
          useViewer.getState().setSearchHits(found);
          setSearching(false);
        })
        .catch(() => setSearching(false));
    }, 200);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [doc, searchQuery]);

  const commitPage = () => {
    const n = parseInt(pageText, 10);
    if (Number.isFinite(n)) actions.goToPage(n - 1);
    else setPageText(String(currentPage + 1));
  };

  const zoomValue = fitMode === "custom" ? String(zoom) : fitMode;
  const zoomOptions = ZOOM_STEPS.filter((z) => z >= 0.25 && z <= 4);

  return (
    <header
      data-tauri-drag-region
      className="flex h-11 shrink-0 select-none items-center gap-1 border-b border-line bg-toolbar px-2 text-[13px] text-fg"
    >
      <ToolButton label="Open… (⌘O)" icon={ICONS.open} onClick={open} />
      <ToolButton label="Toggle sidebar" icon={ICONS.sidebar} onClick={actions.toggleSidebar} disabled={!doc} active={!!doc && sidebarMode !== "none"} />

      <div className="mx-1 h-5 w-px bg-line" />

      <div className="flex items-center gap-1 text-muted">
        <input
          aria-label="Page number"
          disabled={!doc}
          value={pageText}
          onChange={(e) => setPageText(e.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitPage();
              e.currentTarget.blur();
            }
          }}
          onBlur={() => setPageText(numPages ? String(useViewer.getState().currentPage + 1) : "")}
          className="h-6 w-10 rounded-md border border-line bg-field text-center text-fg outline-none focus:border-accent disabled:opacity-40"
        />
        <span className="tabular-nums">/ {numPages || "–"}</span>
      </div>

      <div className="mx-1 h-5 w-px bg-line" />

      <ToolButton label="Zoom out (⌘−)" icon={ICONS.minus} onClick={actions.zoomOut} disabled={!doc} />
      <select
        aria-label="Zoom"
        disabled={!doc}
        value={zoomValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "width" || v === "page") actions.setFitMode(v);
          else actions.setZoom(Number(v));
        }}
        className="h-6 rounded-md border border-line bg-field px-1 text-fg outline-none focus:border-accent disabled:opacity-40"
      >
        <option value="width">Fit Width</option>
        <option value="page">Fit Page</option>
        {fitMode === "custom" && !zoomOptions.includes(zoom) && <option value={String(zoom)}>{Math.round(zoom * 100)}%</option>}
        {zoomOptions.map((z) => (
          <option key={z} value={String(z)}>
            {Math.round(z * 100)}%
          </option>
        ))}
      </select>
      <ToolButton label="Zoom in (⌘+)" icon={ICONS.plus} onClick={actions.zoomIn} disabled={!doc} />
      {doc && fitMode !== "custom" && <span className="w-10 text-xs tabular-nums text-muted">{Math.round(zoom * 100)}%</span>}

      <div className="mx-1 h-5 w-px bg-line" />

      <ToolButton label="Rotate left" icon={ICONS.rotateLeft} onClick={() => actions.rotate(-90)} disabled={!doc} />
      <ToolButton label="Rotate right" icon={ICONS.rotateRight} onClick={() => actions.rotate(90)} disabled={!doc} />

      <div data-tauri-drag-region className="flex min-w-4 flex-1 justify-center truncate px-2 text-xs font-medium text-muted">
        {fileName}
      </div>

      <div className="flex items-center gap-1">
        <div className="relative flex items-center">
          <span className="pointer-events-none absolute left-2 text-muted">
            <Icon d={ICONS.search} size={13} />
          </span>
          <input
            ref={findRef}
            type="search"
            placeholder="Find"
            aria-label="Find in document"
            disabled={!doc}
            value={searchQuery}
            onChange={(e) => actions.setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) actions.prevHit();
                else actions.nextHit();
              } else if (e.key === "Escape") {
                actions.setSearchQuery("");
                e.currentTarget.blur();
              }
            }}
            className="h-7 w-44 rounded-md border border-line bg-field pl-7 pr-14 text-fg outline-none placeholder:text-muted focus:border-accent disabled:opacity-40"
          />
          {searchQuery.trim() && (
            <span className="pointer-events-none absolute right-2 text-[11px] tabular-nums text-muted">
              {searching ? "…" : hits.length ? `${activeHit + 1}/${hits.length}` : "0"}
            </span>
          )}
        </div>
        <ToolButton label="Previous match (⇧↩)" icon={ICONS.up} onClick={actions.prevHit} disabled={!hits.length} />
        <ToolButton label="Next match (↩)" icon={ICONS.down} onClick={actions.nextHit} disabled={!hits.length} />
      </div>

      {right}
      <ToolButton label="Settings" icon={ICONS.gear} onClick={onOpenSettings} />
    </header>
  );
}
