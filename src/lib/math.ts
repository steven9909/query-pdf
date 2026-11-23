/** Cleans model output for display: strips selection markers and normalizes LaTeX math delimiters. */

/** Converts \( \) and \[ \] delimiters to $ and $$, leaving fenced and inline code untouched. */
export function normalizeMath(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`),
    )
    .join("");
}

/** Removes the << >> selection markers that models sometimes echo back from the prompt. */
export function stripMarkers(text: string): string {
  return text.replace(/<<\s*([\s\S]*?)\s*>>/g, "$1");
}
