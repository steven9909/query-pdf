/** Settings dialog for choosing and configuring the LLM provider used for explanations. */
import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { DEFAULT_TEMPLATE } from "../lib/prompt";
import { useSettings, VENDOR_DEFAULTS } from "../state/settings";
import type { BuiltinModelId, BuiltinStatus, ProviderKind, Vendor } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
}

const KINDS: { id: ProviderKind; title: string; blurb: string }[] = [
  { id: "builtin", title: "Built-in (Qwen)", blurb: "Runs a small model on this computer. No setup or account." },
  { id: "ollama", title: "Ollama", blurb: "Use models from a local Ollama server." },
  { id: "cloud", title: "Cloud", blurb: "OpenAI, Anthropic, Gemini or any OpenAI-compatible API with your key." },
];

const BUILTIN_MODELS: { id: BuiltinModelId; label: string }[] = [
  { id: "qwen3-1.7b", label: "Qwen3 1.7B (recommended, ~1.1 GB)" },
  { id: "qwen3-0.6b", label: "Qwen3 0.6B (low memory, ~0.4 GB)" },
];

/** Formats a byte count as a short human-readable size. */
function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

/** Renders the modal with provider tabs, provider-specific fields and shared generation options. */
export default function ProviderSettings({ open, onClose }: Props) {
  const { settings, update, reset } = useSettings();
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "error"; text: string }>({ state: "idle", text: "" });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => setTest({ state: "idle", text: "" }), [settings.kind]);

  if (!open) return null;

  const runTest = async () => {
    setTest({ state: "running", text: "" });
    try {
      const reply = await api.testProvider(settings);
      setTest({ state: "ok", text: reply });
    } catch (err) {
      setTest({ state: "error", text: String(err) });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-neutral-900"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <h2 className="text-base font-semibold">AI Provider</h2>
          <button type="button" className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
          <div className="grid gap-2 sm:grid-cols-3">
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => update({ kind: k.id })}
                className={`rounded-xl border p-3 text-left transition ${
                  settings.kind === k.id
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                    : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-700"
                }`}
              >
                <p className="font-medium">{k.title}</p>
                <p className="mt-1 text-xs text-neutral-500">{k.blurb}</p>
              </button>
            ))}
          </div>

          {settings.kind === "builtin" && <BuiltinSection />}
          {settings.kind === "ollama" && <OllamaSection />}
          {settings.kind === "cloud" && <CloudSection />}

          <div className="flex items-center gap-3">
            <button type="button" className="btn" onClick={runTest} disabled={test.state === "running"}>
              {test.state === "running" ? "Testing…" : "Test connection"}
            </button>
            {test.state === "ok" && <span className="truncate text-green-600">✓ {test.text}</span>}
            {test.state === "error" && <span className="text-red-600">{test.text}</span>}
          </div>

          <Field label="Answer length">
            <div className="flex gap-2">
              {(["short", "detailed"] as const).map((len) => (
                <button
                  key={len}
                  type="button"
                  onClick={() => update({ answerLength: len })}
                  className={`chip capitalize ${settings.answerLength === len ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40" : ""}`}
                >
                  {len}
                </button>
              ))}
            </div>
          </Field>

          <details className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-700">
            <summary className="cursor-pointer font-medium">Advanced</summary>
            <div className="mt-3 space-y-3">
              <Field label={`Temperature (${settings.temperature.toFixed(2)})`}>
                <input type="range" min={0} max={1} step={0.05} value={settings.temperature} onChange={(e) => update({ temperature: Number(e.target.value) })} className="w-full" />
              </Field>
              <Field label="Max answer tokens">
                <input type="number" min={64} max={8192} className="input" value={settings.maxTokens} onChange={(e) => update({ maxTokens: Number(e.target.value) || 600 })} />
              </Field>
              <Field label="Context characters on each side of the selection">
                <input type="number" min={200} max={8000} step={100} className="input" value={settings.contextChars} onChange={(e) => update({ contextChars: Number(e.target.value) || 1500 })} />
              </Field>
              <Field label="Prompt template ({{title}}, {{heading}}, {{passage}}, {{selection}}, {{task}}, {{page}})">
                <textarea rows={8} className="input font-mono text-xs" value={settings.promptTemplate} onChange={(e) => update({ promptTemplate: e.target.value })} />
              </Field>
              <div className="flex gap-2">
                <button type="button" className="chip" onClick={() => update({ promptTemplate: DEFAULT_TEMPLATE })}>
                  Reset template
                </button>
                <button type="button" className="chip" onClick={reset}>
                  Reset all settings
                </button>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

/** Labelled form row. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
    </label>
  );
}

/** Model picker plus download, delete and status for the bundled llama.cpp provider. */
function BuiltinSection() {
  const { settings, update } = useSettings();
  const modelId = settings.builtin.modelId;
  const [status, setStatus] = useState<BuiltinStatus | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null } | null>(null);
  const [message, setMessage] = useState("");

  const refresh = useCallback(() => {
    api.builtinStatus(modelId).then(setStatus).catch((e) => setMessage(String(e)));
  }, [modelId]);

  useEffect(refresh, [refresh]);

  const download = async () => {
    setMessage("");
    setProgress({ downloaded: 0, total: null });
    try {
      await api.downloadModel(modelId, (ev) => {
        if (ev.event === "progress") setProgress({ downloaded: ev.downloaded, total: ev.total });
        if (ev.event === "verifying") setMessage("Verifying…");
        if (ev.event === "done") setMessage("Ready");
        if (ev.event === "error") setMessage(ev.message);
      });
    } catch (e) {
      setMessage(String(e));
    } finally {
      setProgress(null);
      refresh();
    }
  };

  const pct = progress?.total ? Math.round((progress.downloaded / progress.total) * 100) : null;

  return (
    <div className="space-y-3">
      <Field label="Model">
        <select className="input" value={modelId} onChange={(e) => update({ builtin: { modelId: e.target.value as BuiltinModelId } })}>
          {BUILTIN_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex items-center gap-3">
        {progress ? (
          <>
            <div className="h-2 flex-1 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-700">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct ?? 5}%` }} />
            </div>
            <span className="w-28 text-right text-xs tabular-nums">{formatBytes(progress.downloaded)}{pct !== null && ` · ${pct}%`}</span>
            <button type="button" className="chip" onClick={() => api.cancelDownload(modelId)}>
              Cancel
            </button>
          </>
        ) : status?.downloaded ? (
          <>
            <span className="text-green-600">● Downloaded{status.running ? " · running" : ""}</span>
            <span className="text-xs text-neutral-500">{formatBytes(status.sizeBytes)}</span>
            <button type="button" className="chip ml-auto" onClick={() => api.deleteModel(modelId).then(refresh)}>
              Delete
            </button>
          </>
        ) : (
          <>
            <span className="text-neutral-500">Not downloaded</span>
            <button type="button" className="btn ml-auto" onClick={download}>
              Download
            </button>
          </>
        )}
      </div>
      {message && <p className="text-xs text-neutral-500">{message}</p>}
      <p className="text-xs text-neutral-500">Small models are good for definitions and paraphrases. For dense technical text, Ollama or a cloud model gives better answers.</p>
    </div>
  );
}

/** Ollama server URL and model selection populated from the server. */
function OllamaSection() {
  const { settings, update } = useSettings();
  const { baseUrl, model } = settings.ollama;
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    setError("");
    api
      .listOllamaModels(baseUrl)
      .then((list) => {
        setModels(list);
        if (!model && list.length) update({ ollama: { baseUrl, model: list[0] } });
      })
      .catch((e) => {
        setModels([]);
        setError(String(e));
      });
  }, [baseUrl, model, update]);

  useEffect(refresh, [baseUrl]);

  return (
    <div className="space-y-3">
      <Field label="Server URL">
        <input className="input" value={baseUrl} onChange={(e) => update({ ollama: { baseUrl: e.target.value, model } })} />
      </Field>
      <Field label="Model">
        <div className="flex gap-2">
          <select className="input flex-1" value={model} onChange={(e) => update({ ollama: { baseUrl, model: e.target.value } })}>
            {!models.includes(model) && <option value={model}>{model || "Select a model"}</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button type="button" className="chip" onClick={refresh}>
            Refresh
          </button>
        </div>
      </Field>
      {error && <p className="text-xs text-red-600">{error}. Is Ollama running? Install a model with <code>ollama pull qwen3</code>.</p>}
    </div>
  );
}

/** Cloud vendor, model, endpoint and keychain-backed API key entry. */
function CloudSection() {
  const { settings, update } = useSettings();
  const { vendor, model, baseUrl } = settings.cloud;
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setKeyInput("");
    api.hasApiKey(vendor).then(setHasKey).catch(() => setHasKey(false));
  }, [vendor]);

  const chooseVendor = (v: Vendor) => update({ cloud: { vendor: v, model: VENDOR_DEFAULTS[v].model, baseUrl: VENDOR_DEFAULTS[v].baseUrl } });

  const saveKey = async () => {
    setError("");
    try {
      await api.setApiKey(vendor, keyInput);
      setKeyInput("");
      setHasKey(true);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-3">
      <Field label="Provider">
        <select className="input" value={vendor} onChange={(e) => chooseVendor(e.target.value as Vendor)}>
          {(Object.keys(VENDOR_DEFAULTS) as Vendor[]).map((v) => (
            <option key={v} value={v}>
              {VENDOR_DEFAULTS[v].label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Model">
        <input className="input" value={model} onChange={(e) => update({ cloud: { vendor, baseUrl, model: e.target.value } })} />
      </Field>
      {vendor === "custom" && (
        <Field label="Base URL (https, or http on localhost)">
          <input className="input" value={baseUrl} onChange={(e) => update({ cloud: { vendor, model, baseUrl: e.target.value } })} />
        </Field>
      )}
      <Field label="API key (stored in your system keychain)">
        {hasKey ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-green-600">● Key saved</span>
            <button type="button" className="chip" onClick={() => api.deleteApiKey(vendor).then(() => setHasKey(false))}>
              Remove
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input type="password" autoComplete="off" className="input flex-1" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="Paste API key" />
            <button type="button" className="btn" disabled={!keyInput.trim()} onClick={saveKey}>
              Save
            </button>
          </div>
        )}
      </Field>
      {vendor === "custom" && <p className="text-xs text-neutral-500">A key is optional for local OpenAI-compatible servers such as LM Studio.</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
