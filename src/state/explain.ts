/** Explanation conversation state: streaming, follow-ups, cancellation and an answer cache. */
import { create } from "zustand";
import { cancelExplain, explain } from "../lib/api";
import type { ExplainContext } from "../lib/context";
import { buildMessages } from "../lib/prompt";
import type { ChatMessage, ProviderSettings } from "../types";

export interface Conversation {
  ctx: ExplainContext;
  cacheKey: string;
  turns: ChatMessage[];
  streaming: boolean;
  error: string | null;
  requestId: string | null;
}

interface ExplainState {
  conversation: Conversation | null;
  pinned: boolean;
  start: (ctx: ExplainContext, cacheKey: string, settings: ProviderSettings) => void;
  followUp: (question: string, settings: ProviderSettings) => void;
  regenerate: (settings: ProviderSettings) => void;
  stop: () => void;
  close: () => void;
  setPinned: (pinned: boolean) => void;
}

const CACHE_LIMIT = 200;
const cache = new Map<string, string>();

/** Stores a finished first answer, evicting the oldest entry beyond the limit. */
function remember(key: string, answer: string): void {
  cache.delete(key);
  cache.set(key, answer);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

/** Builds a cache key from document identity, selection offsets and the provider/model in use. */
export function explainCacheKey(docKey: string, pageIndex: number, start: number, end: number, s: ProviderSettings): string {
  const model = s.kind === "builtin" ? s.builtin.modelId : s.kind === "ollama" ? s.ollama.model : `${s.cloud.vendor}:${s.cloud.model}`;
  return [docKey, pageIndex, start, end, s.kind, model, s.answerLength].join("|");
}

/** Creates a random id for correlating a stream with its cancel request. */
function newRequestId(): string {
  return crypto.randomUUID();
}

export const useExplain = create<ExplainState>((set, get) => {
  /** Streams the assistant reply for the current turns into the trailing empty assistant message. */
  const run = (settings: ProviderSettings) => {
    const conv = get().conversation;
    if (!conv) return;
    const requestId = newRequestId();
    const history = conv.turns.slice(0, -1);
    const messages = buildMessages(conv.ctx, settings.promptTemplate, history, settings.answerLength);
    set({ conversation: { ...conv, streaming: true, error: null, requestId } });

    const patchLast = (fn: (c: Conversation) => Conversation) => {
      const current = get().conversation;
      if (!current || current.requestId !== requestId) return;
      set({ conversation: fn(current) });
    };

    explain(requestId, messages, settings, (ev) => {
      if (ev.event === "delta") {
        patchLast((c) => {
          const turns = c.turns.slice();
          const last = turns[turns.length - 1];
          turns[turns.length - 1] = { ...last, content: last.content + ev.text };
          return { ...c, turns };
        });
      } else if (ev.event === "done") {
        patchLast((c) => {
          if (c.turns.length === 1) remember(c.cacheKey, c.turns[0].content);
          return { ...c, streaming: false, requestId: null };
        });
      } else {
        patchLast((c) => ({ ...c, streaming: false, requestId: null, error: ev.message }));
      }
    }).catch((err: unknown) => {
      patchLast((c) => ({ ...c, streaming: false, requestId: null, error: String(err) }));
    });
  };

  return {
    conversation: null,
    pinned: false,
    start: (ctx, cacheKey, settings) => {
      get().stop();
      const cached = cache.get(cacheKey);
      const turns: ChatMessage[] = [{ role: "assistant", content: cached ?? "" }];
      set({ conversation: { ctx, cacheKey, turns, streaming: false, error: null, requestId: null } });
      if (cached === undefined) run(settings);
    },
    followUp: (question, settings) => {
      const conv = get().conversation;
      if (!conv || conv.streaming || !question.trim()) return;
      const turns: ChatMessage[] = [
        ...conv.turns,
        { role: "user", content: question.trim() },
        { role: "assistant", content: "" },
      ];
      set({ conversation: { ...conv, turns } });
      run(settings);
    },
    regenerate: (settings) => {
      const conv = get().conversation;
      if (!conv) return;
      get().stop();
      if (conv.turns.length === 1) cache.delete(conv.cacheKey);
      const turns = conv.turns.slice();
      turns[turns.length - 1] = { role: "assistant", content: "" };
      set({ conversation: { ...get().conversation!, turns, error: null } });
      run(settings);
    },
    stop: () => {
      const conv = get().conversation;
      if (!conv?.requestId) return;
      cancelExplain(conv.requestId).catch(() => undefined);
      set({ conversation: { ...conv, streaming: false, requestId: null } });
    },
    close: () => {
      get().stop();
      set({ conversation: null });
    },
    setPinned: (pinned) => set({ pinned }),
  };
});
