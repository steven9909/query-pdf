import { describe, expect, it } from "vitest";
import { buildMessages, DEFAULT_TEMPLATE, isShortPhrase, renderTemplate } from "./prompt";
import type { ExplainContext } from "./context";

const ctx: ExplainContext = {
  selection: "eigenvalue",
  before: "The ",
  after: " of the operator is real.",
  pageIndex: 4,
  title: "Linear Algebra",
};

describe("isShortPhrase", () => {
  it("distinguishes words from sentences", () => {
    expect(isShortPhrase("eigenvalue")).toBe(true);
    expect(isShortPhrase("spectral radius")).toBe(true);
    expect(isShortPhrase("The operator is self-adjoint.")).toBe(false);
    expect(isShortPhrase("one two three four five")).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("marks the selection inside the passage and fills metadata", () => {
    const out = renderTemplate(DEFAULT_TEMPLATE, ctx);
    expect(out).toContain("The <<eigenvalue>> of the operator is real.");
    expect(out).toContain("Document: Linear Algebra");
    expect(out).toContain("Section: unknown");
    expect(out).toContain('What does "eigenvalue" mean in this passage?');
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderTemplate("{{page}} {{nope}}", ctx)).toBe("5 {{nope}}");
  });
});

describe("buildMessages", () => {
  it("starts with system and user turns and appends follow-ups", () => {
    const msgs = buildMessages(ctx, "", [
      { role: "assistant", content: "It is a scalar." },
      { role: "user", content: "Why real?" },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(msgs[1].content).toContain("<<eigenvalue>>");
  });
});

describe("answer length", () => {
  it("adds a brevity rule by default and a detailed rule on request", () => {
    expect(buildMessages(ctx, "")[0].content).toContain("at most 3 sentences");
    expect(buildMessages(ctx, "", [], "detailed")[0].content).toContain("thorough");
  });
});
