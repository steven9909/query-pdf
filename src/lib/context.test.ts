import { describe, expect, it } from "vitest";
import { buildContext, cleanText, headWindow, tailWindow } from "./context";
import type { ViewerSelection } from "../types";

function selectionOf(page: string, pageIndex: number, needle: string): ViewerSelection {
  const start = page.indexOf(needle);
  return { pageIndex, text: needle, start, end: start + needle.length, anchor: { x: 0, y: 0, width: 0, height: 0 } };
}

describe("cleanText", () => {
  it("joins hyphenated line breaks and collapses whitespace", () => {
    expect(cleanText("an exam-\nple of  wrapped\n\ttext")).toBe("an example of wrapped text");
  });

  it("keeps real hyphenated compounds before capitals", () => {
    expect(cleanText("Navier-\nStokes")).toBe("Navier-Stokes");
  });
});

describe("windows", () => {
  const text = "First sentence here. Second sentence here. Third sentence here.";

  it("returns the whole text when it fits", () => {
    expect(tailWindow(text, 500)).toBe(text);
    expect(headWindow(text, 500)).toBe(text);
  });

  it("drops partial sentences at the cut edge", () => {
    expect(tailWindow(text, 30)).toBe("Third sentence here.");
    expect(headWindow(text, 30)).toBe("First sentence here. ");
  });
});

describe("buildContext", () => {
  const pages = [
    "Page one ends with a setup sentence.",
    "The eigenvalue of the operator is real. It follows from symmetry.",
    "Page three continues the proof.",
  ];
  const lookup = (i: number) => pages[i];

  it("captures text on both sides of a single word", () => {
    const ctx = buildContext(lookup, selectionOf(pages[1], 1, "eigenvalue"), 1000);
    expect(ctx.selection).toBe("eigenvalue");
    expect(ctx.before).toContain("The ");
    expect(ctx.after).toContain("of the operator is real.");
  });

  it("borrows from neighbouring pages when the selection is near an edge", () => {
    const ctx = buildContext(lookup, selectionOf(pages[1], 1, "The eigenvalue"), 1000);
    expect(ctx.before).toContain("setup sentence");
    expect(ctx.after).toContain("Page three");
  });

  it("handles the first and last page without neighbours", () => {
    const first = buildContext(lookup, selectionOf(pages[0], 0, "Page one"), 1000);
    expect(first.before).toBe("");
    const last = buildContext(lookup, selectionOf(pages[2], 2, "proof"), 1000);
    expect(last.after).toBe(".");
  });

  it("limits each side to the character budget", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i}.`).join(" ");
    const page = `${long} TARGET ${long}`;
    const ctx = buildContext(() => page, selectionOf(page, 0, "TARGET"), 300);
    expect(ctx.before.length).toBeLessThanOrEqual(300);
    expect(ctx.after.length).toBeLessThanOrEqual(300);
    expect(ctx.before.startsWith("Sentence")).toBe(true);
  });

  it("passes document metadata through", () => {
    const ctx = buildContext(lookup, selectionOf(pages[1], 1, "symmetry"), 100, { title: "Notes", heading: "Spectra" });
    expect(ctx.title).toBe("Notes");
    expect(ctx.heading).toBe("Spectra");
  });
});
