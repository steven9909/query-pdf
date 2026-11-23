/** Persistent provider settings backed by the Tauri store plugin. */
import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import { DEFAULT_TEMPLATE } from "../lib/prompt";
import type { ProviderSettings, Vendor } from "../types";

export const VENDOR_DEFAULTS: Record<Vendor, { label: string; baseUrl: string; model: string }> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com", model: "claude-haiku-5-5" },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash" },
  custom: { label: "Custom (OpenAI-compatible)", baseUrl: "http://localhost:1234/v1", model: "" },
};

export const DEFAULT_SETTINGS: ProviderSettings = {
  kind: "builtin",
  builtin: { modelId: "qwen3-1.7b" },
  ollama: { baseUrl: "http://localhost:11434", model: "" },
  cloud: { vendor: "openai", model: VENDOR_DEFAULTS.openai.model, baseUrl: VENDOR_DEFAULTS.openai.baseUrl },
  temperature: 0.3,
  maxTokens: 600,
  contextChars: 1500,
  answerLength: "short",
  promptTemplate: DEFAULT_TEMPLATE,
};

const STORE_FILE = "settings.json";
const STORE_KEY = "provider";

interface SettingsState {
  settings: ProviderSettings;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<ProviderSettings>) => Promise<void>;
  reset: () => Promise<void>;
}

let storePromise: Promise<Store> | null = null;

/** Lazily opens the settings store file. */
function store(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: true, defaults: {} });
  return storePromise;
}

/** Merges saved settings over defaults so newly added fields always have values. */
export function mergeSettings(saved: Partial<ProviderSettings> | undefined): ProviderSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    builtin: { ...DEFAULT_SETTINGS.builtin, ...saved?.builtin },
    ollama: { ...DEFAULT_SETTINGS.ollama, ...saved?.ollama },
    cloud: { ...DEFAULT_SETTINGS.cloud, ...saved?.cloud },
  };
}

/** Writes settings to disk, ignoring failures so the UI stays usable outside Tauri. */
async function persist(settings: ProviderSettings): Promise<void> {
  try {
    await (await store()).set(STORE_KEY, settings);
  } catch (err) {
    console.warn("Could not save settings", err);
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    try {
      const saved = await (await store()).get<Partial<ProviderSettings>>(STORE_KEY);
      set({ settings: mergeSettings(saved), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  update: async (patch) => {
    const settings = mergeSettings({ ...get().settings, ...patch });
    set({ settings });
    await persist(settings);
  },
  reset: async () => {
    set({ settings: DEFAULT_SETTINGS });
    await persist(DEFAULT_SETTINGS);
  },
}));

/** Returns a short human-readable label for the active provider and model. */
export function providerLabel(s: ProviderSettings): string {
  if (s.kind === "builtin") return `Built-in · ${s.builtin.modelId}`;
  if (s.kind === "ollama") return `Ollama · ${s.ollama.model || "no model"}`;
  return `${VENDOR_DEFAULTS[s.cloud.vendor].label} · ${s.cloud.model || "no model"}`;
}
