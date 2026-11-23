/** Tests for page text index construction and rotation helpers. */
import { describe, expect, it } from "vitest";
import { buildPageTextIndex, rotatedSize } from "./pdf";

describe("buildPageTextIndex", () => {
  it("returns empty text for no items", () => {
    expect(buildPageTextIndex([])).toEqual({ text: "", itemOffsets: [] });
  });

  it("inserts a single space between items without whitespace", () => {
    const idx = buildPageTextIndex([{ str: "Hello" }, { str: "world" }]);
    expect(idx.text).toBe("Hello world");
    expect(idx.itemOffsets).toEqual([0, 6]);
  });

  it("does not add a space when either side already has whitespace", () => {
    const idx = buildPageTextIndex([{ str: "Hello " }, { str: "world" }, { str: " again" }]);
    expect(idx.text).toBe("Hello world again");
    expect(idx.itemOffsets).toEqual([0, 6, 11]);
  });

  it("appends a newline after items with hasEOL and no extra space", () => {
    const idx = buildPageTextIndex([{ str: "line one", hasEOL: true }, { str: "line two", hasEOL: true }]);
    expect(idx.text).toBe("line one\nline two\n");
    expect(idx.itemOffsets).toEqual([0, 9]);
  });

  it("handles empty items, including empty EOL markers", () => {
    const idx = buildPageTextIndex([{ str: "a" }, { str: "" }, { str: "", hasEOL: true }, { str: "b" }]);
    expect(idx.text).toBe("a\nb");
    expect(idx.itemOffsets).toEqual([0, 1, 1, 2]);
  });

  it("skips marked-content entries so offsets follow text item order", () => {
    const idx = buildPageTextIndex([
      { type: "beginMarkedContent", id: "" },
      { str: "x" },
      { type: "endMarkedContent", id: "" },
      { str: "y" },
    ]);
    expect(idx.text).toBe("x y");
    expect(idx.itemOffsets).toEqual([0, 2]);
  });

  it("maps every item offset back to its text", () => {
    const items = [{ str: "The" }, { str: " quick", hasEOL: true }, { str: "brown\t" }, { str: "fox" }];
    const idx = buildPageTextIndex(items);
    items.forEach((it, i) => expect(idx.text.slice(idx.itemOffsets[i], idx.itemOffsets[i] + it.str.length)).toBe(it.str));
  });
});

describe("rotatedSize", () => {
  it("swaps dimensions for quarter turns including intrinsic rotation", () => {
    const s = { width: 100, height: 200, rotate: 90, userUnit: 1 };
    expect(rotatedSize(s, 0)).toEqual({ width: 200, height: 100 });
    expect(rotatedSize(s, 90)).toEqual({ width: 100, height: 200 });
    expect(rotatedSize(s, -90)).toEqual({ width: 100, height: 200 });
  });
});
