/** Maps a DOM text selection inside the viewer's text layers to page text offsets. */
import type { PageTextIndex, ViewerSelection } from "../types";

/** Resolves a page's text index synchronously, or undefined if it is not loaded yet. */
export type TextIndexResolver = (pageIndex: number) => PageTextIndex | undefined;

/** Returns the closest ancestor element (or the node itself) matching a selector. */
function closestElement(node: Node, selector: string): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return (el?.closest(selector) as HTMLElement | null) ?? null;
}

/** Returns the item spans of a page in document order. */
function itemSpans(pageEl: HTMLElement): HTMLElement[] {
  return Array.from(pageEl.querySelectorAll<HTMLElement>("[data-item-index]"));
}

/** Returns the item index stored on a text-layer span, or -1. */
function itemIndexOf(span: HTMLElement): number {
  const n = Number(span.dataset.itemIndex);
  return Number.isInteger(n) ? n : -1;
}

/** Returns the length of an item in the page text, preferring the span's own text. */
function itemLength(span: HTMLElement): number {
  return (span.textContent ?? "").length;
}

/** Returns the character offset of a point inside a text node relative to the start of its span. */
function offsetWithinSpan(span: HTMLElement, textNode: Node, offset: number): number {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === textNode) return total + Math.min(offset, (n.nodeValue ?? "").length);
    total += (n.nodeValue ?? "").length;
  }
  return total;
}

/** Compares a boundary point with a node position: negative if the node position is before the point. */
function comparePointTo(node: Node, offset: number, other: Node, otherOffset: number): number {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  return r.comparePoint(other, otherOffset);
}

/** Converts a range boundary to an offset into the page text, snapping forward for starts and backward for ends. */
function boundaryToOffset(
  pageEl: HTMLElement,
  index: PageTextIndex,
  node: Node,
  offset: number,
  isStart: boolean,
): number {
  const base = (span: HTMLElement): number => index.itemOffsets[itemIndexOf(span)] ?? 0;
  if (node.nodeType === Node.TEXT_NODE) {
    const span = closestElement(node, "[data-item-index]");
    if (span && pageEl.contains(span) && itemIndexOf(span) >= 0) {
      return base(span) + offsetWithinSpan(span, node, offset);
    }
  }
  const spans = itemSpans(pageEl).filter((s) => itemIndexOf(s) >= 0);
  if (isStart) {
    for (const s of spans) {
      if (comparePointTo(node, offset, s, 0) >= 0) return base(s);
    }
    return index.text.length;
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    if (comparePointTo(node, offset, s, s.childNodes.length) <= 0) return base(s) + itemLength(s);
  }
  return 0;
}

/** Returns the bounding rect of a range in viewport coordinates, or a zero rect when unsupported. */
function rangeRect(range: Range): ViewerSelection["anchor"] {
  if (typeof range.getBoundingClientRect !== "function") return { x: 0, y: 0, width: 0, height: 0 };
  const r = range.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/**
 * Captures the current selection as offsets into the start page's PageTextIndex.text.
 * Selections that extend past the start page are clamped to it. Returns null when the
 * selection is empty, collapsed, outside the container, or the page index is not loaded.
 */
export function captureSelection(
  sel: Selection | null,
  container: HTMLElement,
  resolveIndex: TextIndexResolver,
): ViewerSelection | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return null;
  const startPage = closestElement(range.startContainer, "[data-page-index]");
  const endPage = closestElement(range.endContainer, "[data-page-index]");
  const pageEl =
    startPage && container.contains(startPage) ? startPage : endPage && container.contains(endPage) ? endPage : null;
  if (!pageEl) return null;
  const pageIndex = Number(pageEl.dataset.pageIndex);
  if (!Number.isInteger(pageIndex)) return null;
  const index = resolveIndex(pageIndex);
  if (!index) return null;

  const clamped = range.cloneRange();
  if (endPage !== pageEl) clamped.setEnd(pageEl, pageEl.childNodes.length);
  if (startPage !== pageEl) clamped.setStart(pageEl, 0);

  const start = boundaryToOffset(pageEl, index, clamped.startContainer, clamped.startOffset, true);
  const end = boundaryToOffset(pageEl, index, clamped.endContainer, clamped.endOffset, false);
  if (end <= start) return null;
  const text = index.text.slice(start, end);
  if (text.trim().length === 0) return null;
  return { pageIndex, text, start, end, anchor: rangeRect(clamped) };
}
