import { describe, expect, it } from "vitest";
import { floatingPosition } from "./ExplainPanel";

const viewport = { width: 1200, height: 800 };
const anchorAt = (y: number) => ({ x: 100, y, width: 50, height: 16 });

describe("floatingPosition", () => {
  it("places the panel below the selection when it fits", () => {
    const pos = floatingPosition(anchorAt(100), 300, viewport);
    expect(pos.top).toBe(128);
  });

  it("flips above a selection near the bottom of the window", () => {
    const pos = floatingPosition(anchorAt(700), 300, viewport);
    expect(pos.top + 300).toBeLessThanOrEqual(700);
  });

  it("keeps a tall panel fully inside a short window", () => {
    const small = { width: 500, height: 400 };
    const pos = floatingPosition(anchorAt(200), 900, small);
    expect(pos.top).toBeGreaterThanOrEqual(56);
    expect(pos.top + Math.min(900, pos.maxHeight)).toBeLessThanOrEqual(small.height - 12);
  });

  it("narrows and clamps horizontally on small widths", () => {
    const pos = floatingPosition({ x: 480, y: 100, width: 10, height: 10 }, 200, { width: 360, height: 800 });
    expect(pos.width).toBe(336);
    expect(pos.left + pos.width).toBeLessThanOrEqual(348);
  });
});

describe("floatingPosition side placement", () => {
  it("moves beside the selection when it fits neither above nor below", () => {
    const anchor = { x: 300, y: 400, width: 120, height: 16 };
    const pos = floatingPosition(anchor, 700, viewport);
    expect(pos.left).toBeGreaterThanOrEqual(anchor.x + anchor.width);
  });

  it("uses the left side when the selection is near the right edge", () => {
    const anchor = { x: 1000, y: 400, width: 120, height: 16 };
    const pos = floatingPosition(anchor, 700, viewport);
    expect(pos.left + pos.width).toBeLessThanOrEqual(anchor.x);
  });
});
