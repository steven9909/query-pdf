/** App root: wires the viewer's selections to the explain pipeline and the provider settings dialog. */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ViewerShell from "./components/ViewerShell";
import SelectionPopover from "./components/SelectionPopover";
import ExplainPanel from "./components/ExplainPanel";
import ProviderSettings from "./settings/ProviderSettings";
import { loadOutline, type OutlineEntry } from "./components/Sidebar";
import { buildContext } from "./lib/context";
import { getPageTextIndex, type PDFDocumentProxy } from "./lib/pdf";
import { openPdfPath } from "./lib/openFile";
import { explainCacheKey, useExplain } from "./state/explain";
import { providerLabel, useSettings } from "./state/settings";
import { useViewer } from "./state/viewer";
import type { ViewerSelection } from "./types";
import "./ui.css";

interface DocMeta {
  title?: string;
  headings: { title: string; pageIndex: number }[];
}

/** Flattens an outline tree into document-ordered headings that have a resolved page. */
function flattenOutline(entries: OutlineEntry[]): { title: string; pageIndex: number }[] {
  return entries.flatMap((e) => [
    ...(e.pageIndex === null ? [] : [{ title: e.title, pageIndex: e.pageIndex }]),
    ...flattenOutline(e.children),
  ]);
}

/** Loads the document title and outline headings, tolerating PDFs without either. */
async function loadDocMeta(doc: PDFDocumentProxy, fallbackTitle: string | null): Promise<DocMeta> {
  const [meta, outline] = await Promise.all([doc.getMetadata().catch(() => null), loadOutline(doc).catch(() => [])]);
  const info = meta?.info as { Title?: unknown } | undefined;
  const title = typeof info?.Title === "string" && info.Title.trim() ? info.Title.trim() : (fallbackTitle ?? undefined);
  return { title, headings: flattenOutline(outline) };
}

/** Returns the last outline heading at or before the given page. */
function headingFor(meta: DocMeta, pageIndex: number): string | undefined {
  let found: string | undefined;
  for (const h of meta.headings) if (h.pageIndex <= pageIndex) found = h.title;
  return found;
}

/** Renders the viewer, explain popover and panel, and settings dialog. */
export default function App() {
  const doc = useViewer((s) => s.doc);
  const fileName = useViewer((s) => s.fileName);
  const filePath = useViewer((s) => s.filePath);
  const { settings, load } = useSettings();
  const startExplain = useExplain((s) => s.start);
  const conversation = useExplain((s) => s.conversation);
  const [selection, setSelection] = useState<ViewerSelection | null>(null);
  const [panelAnchor, setPanelAnchor] = useState<ViewerSelection["anchor"] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const metaRef = useRef<DocMeta>({ headings: [] });

  useEffect(() => {
    load();
    invoke<string | null>("take_pending_open")
      .then((path) => { if (path) openPdfPath(path); })
      .catch(() => undefined);
  }, [load]);

  useEffect(() => {
    metaRef.current = { headings: [] };
    useExplain.getState().close();
    if (doc) loadDocMeta(doc, fileName).then((m) => (metaRef.current = m));
  }, [doc, fileName]);

  const explainSelection = useCallback(async () => {
    if (!doc || !selection) return;
    const sel = selection;
    const pages = [sel.pageIndex - 1, sel.pageIndex, sel.pageIndex + 1].filter((i) => i >= 0 && i < doc.numPages);
    const indexes = new Map(await Promise.all(pages.map(async (i) => [i, (await getPageTextIndex(doc, i)).text] as const)));
    const meta = metaRef.current;
    const ctx = buildContext((i) => indexes.get(i), sel, settings.contextChars, {
      title: meta.title,
      heading: headingFor(meta, sel.pageIndex),
    });
    const docKey = doc.fingerprints[0] ?? filePath ?? fileName ?? "doc";
    setPanelAnchor(sel.anchor);
    setSelection(null);
    startExplain(ctx, explainCacheKey(docKey, sel.pageIndex, sel.start, sel.end, settings), settings);
  }, [doc, selection, settings, filePath, fileName, startExplain]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e" && selection) {
        e.preventDefault();
        explainSelection();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, explainSelection]);

  return (
    <>
      <ViewerShell
        onSelectionChange={setSelection}
        onOpenSettings={() => setSettingsOpen(true)}
        toolbarRight={
          <button type="button" className="chip whitespace-nowrap" onClick={() => setSettingsOpen(true)} title="AI provider settings">
            {providerLabel(settings)}
          </button>
        }
      >
        {selection && !settingsOpen && <SelectionPopover selection={selection} onExplain={explainSelection} />}
        {conversation && <ExplainPanel anchor={panelAnchor} />}
      </ViewerShell>
      <ProviderSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
