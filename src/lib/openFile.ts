/** Opening PDFs: file dialog, drag-and-drop, OS file associations and a browser fallback. */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { closeDocument, loadDocument } from "./pdf";
import { useViewer } from "../state/viewer";

/** Returns the file name portion of a path on any platform. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Returns true when a path looks like a PDF file. */
export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/** Reads a file's bytes through the backend's read_pdf command. */
export async function readPdfBytes(path: string): Promise<Uint8Array> {
  const data = await invoke<number[] | ArrayBuffer | Uint8Array>("read_pdf", { path });
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Uint8Array.from(data);
}

let loadToken = 0;

/** Parses PDF bytes and makes the result the current document, replacing any previous one. */
export async function openPdfBytes(bytes: Uint8Array, fileName: string, filePath: string | null): Promise<void> {
  const token = ++loadToken;
  const store = useViewer.getState();
  store.setError(null);
  store.setLoading(true);
  try {
    const doc = await loadDocument(bytes);
    if (token !== loadToken) {
      void closeDocument(doc);
      return;
    }
    const prev = useViewer.getState().doc;
    useViewer.getState().setDocument(doc, { fileName, filePath });
    if (prev) void closeDocument(prev);
  } catch (e) {
    if (token === loadToken) useViewer.getState().setError(`Could not open ${fileName}: ${errorMessage(e)}`);
  }
}

/** Reads and opens a PDF from a filesystem path. */
export async function openPdfPath(path: string): Promise<void> {
  const store = useViewer.getState();
  store.setError(null);
  store.setLoading(true);
  try {
    const bytes = await readPdfBytes(path);
    await openPdfBytes(bytes, baseName(path), path);
  } catch (e) {
    useViewer.getState().setError(`Could not read ${baseName(path)}: ${errorMessage(e)}`);
  }
}

/** Shows the native open dialog (or a browser file picker outside Tauri) and opens the chosen PDF. */
export async function openPdfWithDialog(): Promise<void> {
  if (!isTauri()) {
    pickWithInput();
    return;
  }
  try {
    const path = await invoke<string | null>("pick_pdf");
    if (path) await openPdfPath(path);
  } catch (e) {
    useViewer.getState().setError(`Could not open file dialog: ${errorMessage(e)}`);
  }
}

/** Opens a browser file input as a fallback when running outside Tauri. */
function pickWithInput(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/pdf,.pdf";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openPdfBytes(bytes, file.name, null);
  };
  input.click();
}

/** Handlers for external open sources. */
export interface ExternalOpenHandlers {
  onDragOver?(over: boolean): void;
}

/**
 * Tracks drag-over state for the drop hint and opens files announced by the backend's "open-file" event, which covers drops, OS opens and CLI arguments.
 * Returns a function that removes all listeners.
 */
export function listenForExternalOpens(handlers: ExternalOpenHandlers = {}): () => void {
  if (!isTauri()) return () => {};
  const unlisteners: Array<() => void> = [];
  let disposed = false;
  const keep = (p: Promise<() => void>) => {
    p.then((un) => (disposed ? un() : unlisteners.push(un))).catch(() => {});
  };
  keep(
    getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter") handlers.onDragOver?.(payload.paths.some(isPdfPath));
      else if (payload.type === "leave") handlers.onDragOver?.(false);
      else if (payload.type === "drop") {
        handlers.onDragOver?.(false);
      }
    }),
  );
  keep(
    listen<string>("open-file", (event) => {
      if (typeof event.payload === "string" && event.payload) void openPdfPath(event.payload);
    }),
  );
  return () => {
    disposed = true;
    for (const un of unlisteners.splice(0)) un();
  };
}

/** Converts an unknown thrown value to a readable message. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}
