/** Full-text search over page text indexes and hit highlighting inside text layers. */
import type { PageTextIndex } from "../types";
import { getPageTextIndex, type PDFDocumentProxy } from "./pdf";

/** One search match, as offsets into a page's PageTextIndex.text. */
export interface SearchHit {
  pageIndex: number;
  start: number;
  end: number;
}

/** Builds a case-insensitive regex for a query where any whitespace run matches any whitespace run. */
export function queryToRegExp(query: string): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const pattern = trimmed
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(pattern, "giu");
}

/** Finds all non-overlapping matches of a query in a string. */
export function findInText(text: string, query: string): Array<{ start: number; end: number }> {
  const re = queryToRegExp(query);
  if (!re) return [];
  const out: Array<{ start: number; end: number }> = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Searches every page of a document, stopping early if the signal is aborted. */
export async function findInDocument(
  doc: PDFDocumentProxy,
  query: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  if (!queryToRegExp(query)) return hits;
  for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex++) {
    if (signal?.aborted) break;
    const index = await getPageTextIndex(doc, pageIndex);
    for (const h of findInText(index.text, query)) hits.push({ pageIndex, ...h });
  }
  return hits;
}

/** Removes previously inserted hit marks from a text layer, restoring plain span text. */
export function clearHitHighlights(textLayer: HTMLElement): void {
  const spans = textLayer.querySelectorAll<HTMLElement>("[data-item-index]");
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (span.querySelector("mark")) span.textContent = span.textContent ?? "";
  }
}

/**
 * Wraps the parts of text-layer spans covered by hits in <mark class="search-hit"> elements.
 * The hit at activeIndex (within the given list) also gets the "active" class. Returns the active mark.
 */
export function highlightHits(
  textLayer: HTMLElement,
  index: PageTextIndex,
  hits: ReadonlyArray<{ start: number; end: number }>,
  activeIndex = -1,
): HTMLElement | null {
  clearHitHighlights(textLayer);
  if (hits.length === 0) return null;
  let activeMark: HTMLElement | null = null;
  const spans = textLayer.querySelectorAll<HTMLElement>("[data-item-index]");
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const item = Number(span.dataset.itemIndex);
    const itemStart = index.itemOffsets[item];
    if (itemStart === undefined) continue;
    const str = span.textContent ?? "";
    const itemEnd = itemStart + str.length;
    const parts: Array<{ from: number; to: number; active: boolean }> = [];
    hits.forEach((h, hi) => {
      const from = Math.max(h.start, itemStart) - itemStart;
      const to = Math.min(h.end, itemEnd) - itemStart;
      if (to > from) parts.push({ from, to, active: hi === activeIndex });
    });
    if (parts.length === 0) continue;
    parts.sort((a, b) => a.from - b.from);
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const p of parts) {
      const from = Math.max(p.from, pos);
      if (from > pos) frag.append(str.slice(pos, from));
      if (p.to <= from) continue;
      const mark = document.createElement("mark");
      mark.className = p.active ? "search-hit active" : "search-hit";
      mark.textContent = str.slice(from, p.to);
      if (p.active && !activeMark) activeMark = mark;
      frag.append(mark);
      pos = p.to;
    }
    if (pos < str.length) frag.append(str.slice(pos));
    span.replaceChildren(frag);
  }
  return activeMark;
}
