import { describe, expect, it } from "vitest";
import { normalizeMath, stripMarkers } from "./math";

describe("normalizeMath", () => {
  it("converts inline paren delimiters to dollars", () => {
    expect(normalizeMath("where \\( x^2 \\) is")).toBe("where $x^2$ is");
  });

  it("converts bracket delimiters to display math blocks", () => {
    expect(normalizeMath("see \\[ \\int_0^1 f \\] now")).toBe("see \n$$\n\\int_0^1 f\n$$\n now");
  });

  it("leaves existing dollar math alone", () => {
    expect(normalizeMath("$a+b$ and $$c$$")).toBe("$a+b$ and $$c$$");
  });

  it("does not touch code spans or fences", () => {
    const src = "`\\(x\\)` and\n```\n\\[y\\]\n```";
    expect(normalizeMath(src)).toBe(src);
  });
});

describe("stripMarkers", () => {
  it("removes echoed selection markers", () => {
    expect(stripMarkers("<<Fiedler vector>> is a vector")).toBe("Fiedler vector is a vector");
    expect(stripMarkers("a << b >> c")).toBe("a b c");
  });
});
