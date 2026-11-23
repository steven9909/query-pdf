import { describe, expect, it } from "vitest";
import { isExternalUrl, linkAt, pageLinks } from "./links";

const flipY = (r: number[]) => [r[0], 100 - r[1], r[2], 100 - r[3]];

describe("isExternalUrl", () => {
  it("accepts http and https only", () => {
    expect(isExternalUrl("https://example.com")).toBe(true);
    expect(isExternalUrl("http://example.com/a")).toBe(true);
    expect(isExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isExternalUrl("not a url")).toBe(false);
  });
});

describe("pageLinks", () => {
  it("normalizes rectangles and keeps url or dest", () => {
    const links = pageLinks(
      [
        { subtype: "Link", rect: [10, 20, 30, 40], url: "https://example.com" },
        { subtype: "Link", rect: [0, 0, 5, 5], dest: "sec:intro" },
      ],
      flipY,
    );
    expect(links).toEqual([
      { left: 10, top: 60, width: 20, height: 20, url: "https://example.com" },
      { left: 0, top: 95, width: 5, height: 5, dest: "sec:intro" },
    ]);
  });

  it("skips non-links, unsafe urls and targetless links", () => {
    const links = pageLinks(
      [
        { subtype: "Text", rect: [0, 0, 1, 1], url: "https://example.com" },
        { subtype: "Link", rect: [0, 0, 1, 1], url: "javascript:alert(1)" },
        { subtype: "Link", rect: [0, 0, 1, 1] },
        { subtype: "Link", url: "https://example.com" },
      ],
      flipY,
    );
    expect(links).toEqual([]);
  });
});

describe("linkAt", () => {
  const links = [
    { left: 10, top: 10, width: 20, height: 10, url: "https://example.com" },
    { left: 50, top: 10, width: 20, height: 10, dest: "x" },
  ];
  it("finds the link under a point", () => {
    expect(linkAt(links, 15, 15)).toBe(0);
    expect(linkAt(links, 70, 20)).toBe(1);
    expect(linkAt(links, 40, 15)).toBe(-1);
  });
});
