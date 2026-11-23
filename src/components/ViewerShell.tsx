/** Top-level viewer layout: toolbar, sidebar, pages, empty state and an overlay slot for popovers. */
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import type { ViewerSelection } from "../types";
import { listenForExternalOpens, openPdfBytes, openPdfWithDialog } from "../lib/openFile";
import { useViewer } from "../state/viewer";
import PdfViewer from "./PdfViewer";
import Sidebar from "./Sidebar";
import Toolbar from "./Toolbar";

export interface ViewerShellProps {
  onSelectionChange(sel: ViewerSelection | null): void;
  onOpenSettings(): void;
  toolbarRight?: ReactNode;
  children?: ReactNode;
}

/** Composes the full viewer UI and wires file opening (dialog, ⌘O, drag-drop, file associations). */
export default function ViewerShell({ onSelectionChange, onOpenSettings, toolbarRight, children }: ViewerShellProps) {
  const doc = useViewer((s) => s.doc);
  const loading = useViewer((s) => s.loading);
  const error = useViewer((s) => s.error);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => listenForExternalOpens({ onDragOver: setDragOver }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openPdfWithDialog();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Handles HTML5 file drops, which only fire when Tauri's native drag-drop is not intercepting them. */
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = Array.from(e.dataTransfer.files).find((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (file) await openPdfBytes(new Uint8Array(await file.arrayBuffer()), file.name, null);
  };

  return (
    <div className="flex h-full w-full flex-col bg-app text-fg">
      <Toolbar onOpenSettings={onOpenSettings} right={toolbarRight} />
      <div
        className="flex min-h-0 flex-1"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        <Sidebar />
        <main className="relative min-w-0 flex-1">
          {doc ? <PdfViewer onSelectionChange={onSelectionChange} /> : <Welcome loading={loading} />}
          {error && (
            <div className="absolute left-1/2 top-3 z-20 max-w-[80%] -translate-x-1/2 rounded-lg border border-line bg-toolbar px-3 py-2 text-xs text-danger shadow-md">
              {error}
              <button type="button" className="ml-3 text-muted hover:text-fg" onClick={() => useViewer.getState().setError(null)}>
                Dismiss
              </button>
            </div>
          )}
          {dragOver && (
            <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-accent">
              Drop a PDF to open it
            </div>
          )}
          <div className="pointer-events-none absolute inset-0 z-10 [&>*]:pointer-events-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}

/** Empty state with an open button and a drop hint. */
function Welcome({ loading }: { loading: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas text-center">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-muted" aria-hidden="true">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
        <path d="M9 13h6M9 17h4" />
      </svg>
      <div>
        <h1 className="text-lg font-semibold text-fg">Query PDF</h1>
        <p className="mt-1 text-sm text-muted">Select any text to get an explanation.</p>
      </div>
      <button
        type="button"
        disabled={loading}
        onClick={() => void openPdfWithDialog()}
        className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:brightness-110 disabled:opacity-60"
      >
        {loading ? "Opening…" : "Open PDF…"}
      </button>
      <p className="text-xs text-muted">or drop a PDF file here · ⌘O</p>
    </div>
  );
}
