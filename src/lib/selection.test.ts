/** Tests for mapping DOM selections in a hand-built text layer to page text offsets. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPageTextIndex } from "./pdf";
import { captureSelection } from "./selection";
import { highlightHits } from "./search";
import type { PageTextIndex } from "../types";

const pages: Record<number, PageTextIndex> = {
  0: buildPageTextIndex([{ str: "Hello" }, { str: "world", hasEOL: true }, { str: "second line" }]),
  1: buildPageTextIndex([{ str: "Page two" }, { str: "text" }]),
};
const resolve = (i: number) => pages[i];

let container: HTMLElement;

/** Builds a viewer DOM with one text layer per page. */
function buildDom(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="pdf-page" data-page-index="0"><div class="canvasWrapper"></div><div class="textLayer">
      <span data-item-index="0">Hello</span><span data-item-index="1">world</span><br><span data-item-index="2">second line</span>
    </div></div>
    <div class="pdf-page" data-page-index="1"><div class="canvasWrapper"></div><div class="textLayer">
      <span data-item-index="0">Page two</span><span data-item-index="1">text</span>
    </div></div>`;
  document.body.append(root);
  return root;
}

/** Returns the text node of the span with the given item index on a page. */
function textOf(page: number, item: number): Text {
  return container.querySelector(`[data-page-index="${page}"] [data-item-index="${item}"]`)!.firstChild as Text;
}

/** Selects a DOM range and returns the window selection. */
function select(sc: Node, so: number, ec: Node, eo: number): Selection {
  const sel = window.getSelection()!;
  const r = document.createRange();
  r.setStart(sc, so);
  r.setEnd(ec, eo);
  sel.removeAllRanges();
  sel.addRange(r);
  return sel;
}

beforeEach(() => {
  container = buildDom();
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  container.remove();
});

describe("captureSelection", () => {
  it("returns null for a collapsed selection", () => {
    const t = textOf(0, 0);
    expect(captureSelection(select(t, 2, t, 2), container, resolve)).toBeNull();
  });

  it("returns null without a selection", () => {
    window.getSelection()!.removeAllRanges();
    expect(captureSelection(window.getSelection()!, container, resolve)).toBeNull();
  });

  it("maps a selection within one span", () => {
    const t = textOf(0, 0);
    const sel = captureSelection(select(t, 1, t, 4), container, resolve)!;
    expect(sel).toMatchObject({ pageIndex: 0, start: 1, end: 4, text: "ell" });
  });

  it("maps a selection spanning several spans and a line break", () => {
    const sel = captureSelection(select(textOf(0, 0), 3, textOf(0, 2), 6), container, resolve)!;
    expect(sel.text).toBe("lo world\nsecond");
    expect(sel.start).toBe(3);
    expect(sel.end).toBe(pages[0].itemOffsets[2] + 6);
  });

  it("maps element boundaries to the nearest span edges", () => {
    const layer = container.querySelector('[data-page-index="0"] .textLayer')!;
    const sel = captureSelection(select(layer, 0, layer, layer.childNodes.length), container, resolve)!;
    expect(sel.start).toBe(0);
    expect(sel.end).toBe(pages[0].itemOffsets[2] + "second line".length);
    expect(sel.text).toBe("Hello world\nsecond line");
  });

  it("clamps a cross-page selection to the start page", () => {
    const sel = captureSelection(select(textOf(0, 2), 7, textOf(1, 1), 2), container, resolve)!;
    expect(sel.pageIndex).toBe(0);
    expect(sel.text).toBe("line");
  });

  it("returns null when the page index is unavailable", () => {
    const t = textOf(1, 0);
    expect(captureSelection(select(t, 0, t, 4), container, () => undefined)).toBeNull();
  });

  it("returns null for selections outside the container", () => {
    const other = document.createElement("p");
    other.textContent = "outside";
    document.body.append(other);
    const t = other.firstChild!;
    expect(captureSelection(select(t, 0, t, 3), container, resolve)).toBeNull();
    other.remove();
  });

  it("still maps offsets after search highlights split span text nodes", () => {
    const layer = container.querySelector<HTMLElement>('[data-page-index="1"] .textLayer')!;
    highlightHits(layer, pages[1], [{ start: 2, end: 4 }], 0);
    const span = layer.querySelector('[data-item-index="0"]')!;
    expect(span.querySelectorAll("mark").length).toBe(1);
    const last = span.lastChild as Text;
    const sel = captureSelection(select(last, 1, textOf(1, 1), 4), container, resolve)!;
    expect(sel.text).toBe("two text");
    expect(sel.start).toBe(5);
  });
});
