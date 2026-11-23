/** Turns an explain context into chat messages using an editable prompt template. */
import type { AnswerLength, ChatMessage } from "../types";
import type { ExplainContext } from "./context";

export const SYSTEM_PROMPT =
  "You explain text that a reader highlighted in a document. Explain it as it is used in the given passage, not in general. " +
  "Be concise: define terms, resolve pronouns and acronyms, and note any domain-specific meaning. " +
  "Use Markdown. Do not repeat the passage or the question back, and skip preambles and closing summaries. " +
  "Write every mathematical expression in LaTeX: inline math as $...$ and displayed equations as $$...$$ on their own lines. " +
  "Never put math in code blocks or approximate it with Unicode. " +
  "The passage marks the highlighted text with << >>; never include those markers in your answer.";

export const DEFAULT_TEMPLATE = `Document: {{title}}
Section: {{heading}}

Passage (the highlighted part is marked with << >>):
"""
{{passage}}
"""

{{task}}`;

export const LENGTH_RULES: Record<AnswerLength, string> = {
  short: "Keep answers brief: at most 3 sentences or 3 short bullets (about 60 words) unless the reader asks for more.",
  detailed: "Give a thorough explanation, but stay focused on the passage.",
};

/** Builds the system prompt with the reader's preferred answer length. */
export function systemPrompt(length: AnswerLength = "short"): string {
  return `${SYSTEM_PROMPT} ${LENGTH_RULES[length]}`;
}

/** Returns true when the selection looks like a word or short phrase rather than a sentence. */
export function isShortPhrase(selection: string): boolean {
  const words = selection.trim().split(/\s+/).filter(Boolean);
  return words.length <= 4 && !/[.!?;:]\s*$/.test(selection.trim());
}

/** Chooses the instruction that matches the shape of the selection. */
export function taskFor(selection: string): string {
  return isShortPhrase(selection)
    ? `What does "${selection}" mean in this passage? Define it precisely as the passage uses it, using the surrounding sentences.`
    : `Explain the highlighted text in plain language: paraphrase it, then say why it matters in the surrounding argument.`;
}

/** Fills template placeholders from the context, collapsing missing metadata to "unknown". */
export function renderTemplate(template: string, ctx: ExplainContext): string {
  const passage = `${ctx.before}<<${ctx.selection}>>${ctx.after}`.trim();
  const values: Record<string, string> = {
    title: ctx.title?.trim() || "unknown",
    heading: ctx.heading?.trim() || "unknown",
    passage,
    selection: ctx.selection,
    task: taskFor(ctx.selection),
    page: String(ctx.pageIndex + 1),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

/** Builds the full message list for an explanation, appending any follow-up conversation turns. */
export function buildMessages(
  ctx: ExplainContext,
  template: string,
  followUps: ChatMessage[] = [],
  length: AnswerLength = "short",
): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt(length) },
    { role: "user", content: renderTemplate(template || DEFAULT_TEMPLATE, ctx) },
    ...followUps,
  ];
}
