/** pdf.js setup, document loading, page sizes and cached per-page text indexes. */
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { TextContent, TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";
import type { PageTextIndex } from "../types";

if (typeof window !== "undefined" && !pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
}

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextContent, TextItem, TextMarkedContent };

/** CSS pixels per PDF point, so that zoom 1 renders a page at its physical size. */
export const PDF_TO_CSS_UNITS = 96 / 72;

/** Unrotated size of a page in PDF points (user unit applied), its intrinsic /Rotate and user unit. */
export interface PageSize {
  width: number;
  height: number;
  rotate: number;
  userUnit: number;
}

/** Minimal shape of a text item used to build a text index. */
export interface TextLike {
  str: string;
  hasEOL?: boolean;
}

interface DocCache {
  content: Map<number, Promise<TextContent>>;
  index: Map<number, PageTextIndex>;
  indexPromises: Map<number, Promise<PageTextIndex>>;
  sizes?: Promise<PageSize[]>;
}

const caches = new WeakMap<PDFDocumentProxy, DocCache>();

/** Returns the cache bucket for a document, creating it if needed. */
function cacheFor(doc: PDFDocumentProxy): DocCache {
  let c = caches.get(doc);
  if (!c) {
    c = { content: new Map(), index: new Map(), indexPromises: new Map() };
    caches.set(doc, c);
  }
  return c;
}

/** Loads a PDF document from raw bytes. The bytes are transferred to the worker. */
export async function loadDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({ data: bytes });
  return task.promise;
}

/** Narrows a pdf.js text content entry to a real text item (not a marked-content marker). */
export function isTextItem(item: TextItem | TextMarkedContent | TextLike): item is TextItem {
  return typeof (item as TextItem).str === "string";
}

/** Returns only the text items of a text content list, in order; their positions are the item indexes. */
export function textItemsOf(items: Array<TextItem | TextMarkedContent>): TextItem[] {
  return items.filter(isTextItem);
}

/** Returns true when the character is whitespace. */
function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * Joins text items into page text. Items with hasEOL are followed by "\n"; otherwise a single
 * space separates consecutive items unless either side already has whitespace.
 * Marked-content entries are skipped, so itemOffsets is indexed by text item order.
 */
export function buildPageTextIndex(items: ReadonlyArray<TextLike | TextMarkedContent>): PageTextIndex {
  let text = "";
  const itemOffsets: number[] = [];
  for (const raw of items) {
    if (!isTextItem(raw as TextLike)) continue;
    const item = raw as TextLike;
    if (item.str.length > 0 && text.length > 0 && !isSpace(text[text.length - 1]) && !isSpace(item.str[0])) {
      text += " ";
    }
    itemOffsets.push(text.length);
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return { text, itemOffsets };
}

/** Returns the cached text content of a page (0-based index), fetching it once. */
export function getPageTextContent(doc: PDFDocumentProxy, pageIndex: number): Promise<TextContent> {
  const c = cacheFor(doc);
  let p = c.content.get(pageIndex);
  if (!p) {
    p = doc.getPage(pageIndex + 1).then((page) => page.getTextContent());
    p.catch(() => c.content.delete(pageIndex));
    c.content.set(pageIndex, p);
  }
  return p;
}

/** Returns the cached PageTextIndex for a page (0-based index). */
export function getPageTextIndex(doc: PDFDocumentProxy, pageIndex: number): Promise<PageTextIndex> {
  const c = cacheFor(doc);
  const ready = c.index.get(pageIndex);
  if (ready) return Promise.resolve(ready);
  let p = c.indexPromises.get(pageIndex);
  if (!p) {
    p = getPageTextContent(doc, pageIndex).then((content) => {
      const index = buildPageTextIndex(content.items);
      c.index.set(pageIndex, index);
      return index;
    });
    p.catch(() => c.indexPromises.delete(pageIndex));
    c.indexPromises.set(pageIndex, p);
  }
  return p;
}

/** Returns a page's text index synchronously if it has already been built. */
export function peekPageTextIndex(doc: PDFDocumentProxy, pageIndex: number): PageTextIndex | undefined {
  return caches.get(doc)?.index.get(pageIndex);
}

/** Returns the unrotated size of every page in PDF points, cached per document. */
export function getPageSizes(doc: PDFDocumentProxy): Promise<PageSize[]> {
  const c = cacheFor(doc);
  if (!c.sizes) {
    const tasks: Promise<PageSize>[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      tasks.push(
        doc.getPage(i).then((page) => {
          const vp = page.getViewport({ scale: 1, rotation: 0 });
          return { width: vp.width, height: vp.height, rotate: page.rotate, userUnit: page.userUnit || 1 };
        }),
      );
    }
    c.sizes = Promise.all(tasks);
  }
  return c.sizes;
}

/** Returns a page's displayed size in PDF points for a total rotation in degrees. */
export function rotatedSize(size: PageSize, rotation: number): { width: number; height: number } {
  const quarter = (((size.rotate + rotation) % 360) + 360) % 180 !== 0;
  return quarter ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
}

/** Drops all cached data for a document and destroys it. */
export async function closeDocument(doc: PDFDocumentProxy): Promise<void> {
  caches.delete(doc);
  await doc.loadingTask.destroy();
}
