/** Builds the surrounding-text window that grounds an explanation of a selection. */
import type { ViewerSelection } from "../types";

export interface ExplainContext {
  selection: string;
  before: string;
  after: string;
  pageIndex: number;
  title?: string;
  heading?: string;
}

export type PageTextLookup = (pageIndex: number) => string | undefined;

/** Joins hyphenated line breaks and collapses runs of whitespace into single spaces. */
export function cleanText(text: string): string {
  return text
    .replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, "$1$2")
    .replace(/(\p{L})-\s*\n\s*(\p{Lu})/gu, "$1-$2")
    .replace(/\s+/g, " ");
}

/** Splits text into sentences using Intl.Segmenter when available, falling back to punctuation. */
export function splitSentences(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [text];
}

/** Keeps at most maxChars from the end of text, dropping a leading partial sentence when truncated. */
export function tailWindow(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(text.length - maxChars);
  const sentences = splitSentences(sliced);
  return sentences.length > 1 ? sentences.slice(1).join("") : sliced;
}

/** Keeps at most maxChars from the start of text, dropping a trailing partial sentence when truncated. */
export function headWindow(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const sentences = splitSentences(sliced);
  return sentences.length > 1 ? sentences.slice(0, -1).join("") : sliced;
}

/** Extracts cleaned text before and after the selection, borrowing from neighbouring pages near page edges. */
export function buildContext(
  getPageText: PageTextLookup,
  sel: ViewerSelection,
  maxChars: number,
  meta: { title?: string; heading?: string } = {},
): ExplainContext {
  const page = getPageText(sel.pageIndex) ?? "";
  let before = page.slice(0, sel.start);
  let after = page.slice(sel.end);

  if (before.length < maxChars) {
    const prev = getPageText(sel.pageIndex - 1);
    if (prev) before = `${prev}\n${before}`;
  }
  if (after.length < maxChars) {
    const next = getPageText(sel.pageIndex + 1);
    if (next) after = `${after}\n${next}`;
  }

  const selection = cleanText(page.slice(sel.start, sel.end) || sel.text).trim();
  return {
    selection,
    before: tailWindow(cleanText(before), maxChars).trimStart(),
    after: headWindow(cleanText(after), maxChars).trimEnd(),
    pageIndex: sel.pageIndex,
    title: meta.title,
    heading: meta.heading,
  };
}
