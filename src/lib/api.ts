/** Typed wrappers around the Rust commands exposed by the Tauri backend. */
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  BuiltinModelId,
  BuiltinStatus,
  ChatMessage,
  DownloadEvent,
  ProviderSettings,
  StreamEvent,
  Vendor,
} from "../types";

/** Streams an explanation for the given messages, delivering events to onEvent until done, error or cancel. */
export async function explain(
  requestId: string,
  messages: ChatMessage[],
  settings: ProviderSettings,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  await invoke("explain", { requestId, messages, settings, channel });
}

/** Cancels an in-flight explanation by its request id. */
export function cancelExplain(requestId: string): Promise<void> {
  return invoke("cancel_explain", { requestId });
}

/** Sends a tiny prompt through the configured provider and returns the reply text. */
export function testProvider(settings: ProviderSettings): Promise<string> {
  return invoke("test_provider", { settings });
}

/** Lists model names installed in a local Ollama server. */
export function listOllamaModels(baseUrl: string): Promise<string[]> {
  return invoke("list_ollama_models", { baseUrl });
}

/** Stores an API key for a cloud vendor in the OS keychain. */
export function setApiKey(vendor: Vendor, key: string): Promise<void> {
  return invoke("set_api_key", { vendor, key });
}

/** Reports whether a key is stored for a vendor without revealing it. */
export function hasApiKey(vendor: Vendor): Promise<boolean> {
  return invoke("has_api_key", { vendor });
}

/** Removes a vendor's API key from the OS keychain. */
export function deleteApiKey(vendor: Vendor): Promise<void> {
  return invoke("delete_api_key", { vendor });
}

/** Returns download and runtime status for a built-in model. */
export function builtinStatus(modelId: BuiltinModelId): Promise<BuiltinStatus> {
  return invoke("builtin_status", { modelId });
}

/** Downloads a built-in model, reporting progress through onEvent. */
export async function downloadModel(
  modelId: BuiltinModelId,
  onEvent: (event: DownloadEvent) => void,
): Promise<void> {
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = onEvent;
  await invoke("download_model", { modelId, channel });
}

/** Cancels an in-progress model download. */
export function cancelDownload(modelId: BuiltinModelId): Promise<void> {
  return invoke("cancel_download", { modelId });
}

/** Deletes a downloaded built-in model from disk. */
export function deleteModel(modelId: BuiltinModelId): Promise<void> {
  return invoke("delete_model", { modelId });
}
