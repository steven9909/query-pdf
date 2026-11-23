/** Shared types between the viewer, the explain pipeline and the Rust backend. */

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export type ProviderKind = "builtin" | "ollama" | "cloud";
export type Vendor = "openai" | "anthropic" | "gemini" | "custom";
export type AnswerLength = "short" | "detailed";
export type BuiltinModelId = "qwen3-1.7b" | "qwen3-0.6b";

export interface ProviderSettings {
  kind: ProviderKind;
  builtin: { modelId: BuiltinModelId };
  ollama: { baseUrl: string; model: string };
  cloud: { vendor: Vendor; model: string; baseUrl: string };
  temperature: number;
  maxTokens: number;
  contextChars: number;
  answerLength: AnswerLength;
  promptTemplate: string;
}

export type StreamEvent =
  | { event: "delta"; text: string }
  | { event: "done" }
  | { event: "error"; message: string };

export type DownloadEvent =
  | { event: "progress"; downloaded: number; total: number | null }
  | { event: "verifying" }
  | { event: "done" }
  | { event: "error"; message: string };

export interface BuiltinStatus {
  modelId: BuiltinModelId;
  downloaded: boolean;
  running: boolean;
  sizeBytes: number;
}

/** Text of one PDF page plus the starting character offset of each pdf.js text item within it. */
export interface PageTextIndex {
  text: string;
  itemOffsets: number[];
}

/** A user selection inside a single page's text layer, expressed as offsets into PageTextIndex.text. */
export interface ViewerSelection {
  pageIndex: number;
  text: string;
  start: number;
  end: number;
  anchor: { x: number; y: number; width: number; height: number };
}
