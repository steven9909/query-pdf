//! Tauri commands bridging the frontend to providers, secrets, built-in models and file access.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::builtin::BuiltinServer;
use crate::llm::{self, ChatMessage, ChatOptions, LlmError, Role, Target, Vendor};
use crate::models::{self, BuiltinModelId, BuiltinStatus, DownloadEvent};
use crate::secrets;

/// Which kind of backend answers explanation requests.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Builtin,
    Ollama,
    Cloud,
}

/// Built-in provider options.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinSettings {
    pub model_id: BuiltinModelId,
}

/// Ollama provider options.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaSettings {
    pub base_url: String,
    pub model: String,
}

/// Cloud provider options; the API key is looked up from the keychain, never sent from the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSettings {
    pub vendor: Vendor,
    pub model: String,
    pub base_url: String,
}

/// Provider settings as persisted by the frontend; extra fields such as the prompt template are ignored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub kind: ProviderKind,
    pub builtin: BuiltinSettings,
    pub ollama: OllamaSettings,
    pub cloud: CloudSettings,
    pub temperature: f32,
    pub max_tokens: u32,
}

/// Streaming events delivered to the explain panel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum StreamEvent {
    Delta { text: String },
    Done,
    Error { message: String },
}

/// Official OpenAI API base URL; the only endpoint an OpenAI key is sent to.
pub const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
/// Official Anthropic API base URL; the only endpoint an Anthropic key is sent to.
pub const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
/// Official Gemini API base URL; the only endpoint a Gemini key is sent to.
pub const GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com";
/// Largest PDF `read_pdf` will load into memory.
pub const MAX_PDF_BYTES: u64 = 1 << 30;
/// Number of leading bytes searched for the `%PDF` signature.
const PDF_HEADER_WINDOW: u64 = 1024;
/// Error returned for paths the user never chose.
const NOT_AUTHORIZED: &str = "This file was not opened by the user.";

/// Cancellation tokens for in-flight explanations and downloads, a file queued for opening at launch, and user-authorized PDF paths.
#[derive(Default)]
pub struct AppState {
    explains: Mutex<HashMap<String, CancellationToken>>,
    downloads: Mutex<HashMap<BuiltinModelId, CancellationToken>>,
    pending_open: Mutex<Option<String>>,
    authorized: Mutex<HashSet<PathBuf>>,
}

impl AppState {
    /// Remembers a file path to open once the frontend asks for it.
    pub fn set_pending_open(&self, path: String) {
        *self.pending_open.lock().unwrap() = Some(path);
    }

    /// Canonicalizes a path the user chose, records it as readable and returns the canonical path string.
    pub fn authorize(&self, path: &Path) -> Result<String, String> {
        let canonical = std::fs::canonicalize(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
        let text = canonical.to_string_lossy().into_owned();
        self.authorized.lock().unwrap().insert(canonical);
        Ok(text)
    }

    /// Returns the canonical form of `path` if the user authorized it.
    pub fn authorized_path(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical = std::fs::canonicalize(path).map_err(|_| NOT_AUTHORIZED.to_string())?;
        if self.authorized.lock().unwrap().contains(&canonical) {
            Ok(canonical)
        } else {
            Err(NOT_AUTHORIZED.into())
        }
    }
}

/// Returns the directory where downloaded models are stored.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Removes trailing slashes so URL joins never produce double slashes.
fn trim_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Appends `/v1` to an Ollama base URL unless it is already present.
pub fn ollama_v1(base_url: &str) -> String {
    let base = trim_url(base_url);
    if base.ends_with("/v1") { base } else { format!("{base}/v1") }
}

/// Reports whether a URL's host is `localhost` or a loopback IP address.
fn is_loopback_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost") || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Accepts a custom endpoint only if it is https, or http on a loopback host, returning it without trailing slashes.
pub fn validate_custom_url(raw: &str) -> Result<String, String> {
    let trimmed = trim_url(raw);
    if trimmed.is_empty() {
        return Err("Enter a base URL for the custom provider in Settings.".into());
    }
    let url = reqwest::Url::parse(&trimmed).map_err(|e| format!("The custom base URL is not a valid URL ({e})."))?;
    let allowed = match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => is_loopback_host(&url),
        _ => false,
    };
    if allowed {
        Ok(trimmed)
    } else {
        Err("The custom base URL must use https:// (plain http:// is only allowed for localhost).".into())
    }
}

/// Returns the fixed official base URL for a cloud vendor, or validates the user URL for `Custom`.
pub fn cloud_base_url(vendor: Vendor, user_url: &str) -> Result<String, String> {
    match vendor {
        Vendor::OpenAI => Ok(OPENAI_BASE_URL.into()),
        Vendor::Anthropic => Ok(ANTHROPIC_BASE_URL.into()),
        Vendor::Gemini => Ok(GEMINI_BASE_URL.into()),
        Vendor::Custom => validate_custom_url(user_url),
    }
}

/// Fetches a vendor's key from the keychain on a blocking thread.
async fn load_key(vendor: Vendor) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || secrets::get_api_key(vendor))
        .await
        .map_err(|e| e.to_string())?
}

/// Converts settings into a concrete endpoint and chat options, starting the built-in server if needed.
async fn resolve(app: &AppHandle, settings: &ProviderSettings) -> Result<(Target, ChatOptions), String> {
    let mut opts = ChatOptions {
        model: String::new(),
        temperature: settings.temperature,
        max_tokens: settings.max_tokens,
    };
    let target = match settings.kind {
        ProviderKind::Builtin => {
            let id = settings.builtin.model_id;
            let path = models::model_path(&data_dir(app)?, id);
            if !models::status(&data_dir(app)?, id, false).downloaded {
                return Err("The built-in model is not downloaded yet. Open Settings → AI Provider to download it.".into());
            }
            let server = app.state::<BuiltinServer>();
            let endpoint = server.ensure_running(app, &path, id).await?;
            opts.model = models::spec(id).file_name.to_string();
            Target::OpenAiCompatible { base_url: endpoint.base_url, api_key: Some(endpoint.api_key) }
        }
        ProviderKind::Ollama => {
            if settings.ollama.model.trim().is_empty() {
                return Err("Choose an Ollama model in Settings.".into());
            }
            opts.model = settings.ollama.model.clone();
            Target::OpenAiCompatible { base_url: ollama_v1(&settings.ollama.base_url), api_key: None }
        }
        ProviderKind::Cloud => {
            let cloud = &settings.cloud;
            if cloud.model.trim().is_empty() {
                return Err("Enter a model name in Settings.".into());
            }
            opts.model = cloud.model.trim().to_string();
            let base_url = cloud_base_url(cloud.vendor, &cloud.base_url)?;
            let key = load_key(cloud.vendor).await?;
            let require = |k: Option<String>| k.ok_or_else(|| "No API key saved for this provider. Add one in Settings.".to_string());
            match cloud.vendor {
                Vendor::OpenAI => Target::OpenAiCompatible { base_url, api_key: Some(require(key)?) },
                Vendor::Custom => Target::OpenAiCompatible { base_url, api_key: key },
                Vendor::Anthropic => Target::Anthropic { base_url, api_key: require(key)? },
                Vendor::Gemini => Target::Gemini { base_url, api_key: require(key)? },
            }
        }
    };
    Ok((target, opts))
}

/// Turns provider errors into short user-facing messages.
fn describe(err: LlmError) -> String {
    match err {
        LlmError::Http { status: 401 | 403, .. } => "The provider rejected the API key (unauthorized).".into(),
        LlmError::Http { status: 404, message } => format!("Model or endpoint not found: {message}"),
        LlmError::Http { status: 429, .. } => "Rate limited by the provider. Try again shortly.".into(),
        other => other.to_string(),
    }
}

/// Streams an explanation over `channel`; always finishes with a Done or Error event.
#[tauri::command]
pub async fn explain(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    messages: Vec<ChatMessage>,
    settings: ProviderSettings,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    let cancel = CancellationToken::new();
    state.explains.lock().unwrap().insert(request_id.clone(), cancel.clone());

    let result = async {
        let (target, opts) = resolve(&app, &settings).await?;
        let server = app.state::<BuiltinServer>();
        let is_builtin = settings.kind == ProviderKind::Builtin;
        let mut on_delta = |text: &str| {
            if is_builtin {
                server.touch();
            }
            let _ = channel.send(StreamEvent::Delta { text: text.to_string() });
        };
        llm::stream_chat(&target, &messages, &opts, cancel.clone(), &mut on_delta)
            .await
            .map_err(describe)
    }
    .await;

    state.explains.lock().unwrap().remove(&request_id);
    let event = match result {
        Ok(()) => StreamEvent::Done,
        Err(_) if cancel.is_cancelled() => StreamEvent::Done,
        Err(message) => StreamEvent::Error { message },
    };
    let _ = channel.send(event);
    Ok(())
}

/// Cancels an in-flight explanation.
#[tauri::command]
pub fn cancel_explain(state: State<'_, AppState>, request_id: String) {
    if let Some(token) = state.explains.lock().unwrap().remove(&request_id) {
        token.cancel();
    }
}

/// Sends a one-line prompt through the configured provider and returns the reply.
#[tauri::command]
pub async fn test_provider(app: AppHandle, settings: ProviderSettings) -> Result<String, String> {
    let (target, mut opts) = resolve(&app, &settings).await?;
    opts.max_tokens = opts.max_tokens.min(64);
    let messages = [ChatMessage { role: Role::User, content: "Reply with exactly: Connection OK".into() }];
    let mut reply = String::new();
    let mut on_delta = |t: &str| reply.push_str(t);
    llm::stream_chat(&target, &messages, &opts, CancellationToken::new(), &mut on_delta)
        .await
        .map_err(describe)?;
    let reply = reply.trim().to_string();
    Ok(if reply.is_empty() { "Connected (empty reply)".into() } else { reply })
}

/// Lists models installed in an Ollama server.
#[tauri::command]
pub async fn list_ollama_models(base_url: String) -> Result<Vec<String>, String> {
    llm::openai_compat::list_ollama_models(&trim_url(&base_url)).await.map_err(|e| e.to_string())
}

/// Saves an API key to the OS keychain.
#[tauri::command]
pub async fn set_api_key(vendor: Vendor, key: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || secrets::set_api_key(vendor, &key))
        .await
        .map_err(|e| e.to_string())?
}

/// Reports whether a key is stored for a vendor.
#[tauri::command]
pub async fn has_api_key(vendor: Vendor) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || secrets::has_api_key(vendor))
        .await
        .map_err(|e| e.to_string())
}

/// Deletes a vendor's API key from the OS keychain.
#[tauri::command]
pub async fn delete_api_key(vendor: Vendor) -> Result<(), String> {
    tokio::task::spawn_blocking(move || secrets::delete_api_key(vendor))
        .await
        .map_err(|e| e.to_string())?
}

/// Returns download and runtime status for a built-in model.
#[tauri::command]
pub async fn builtin_status(app: AppHandle, model_id: BuiltinModelId) -> Result<BuiltinStatus, String> {
    let running = app.state::<BuiltinServer>().is_running(model_id).await;
    Ok(models::status(&data_dir(&app)?, model_id, running))
}

/// Downloads a built-in model, streaming progress events over `channel`.
#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model_id: BuiltinModelId,
    channel: Channel<DownloadEvent>,
) -> Result<(), String> {
    let cancel = CancellationToken::new();
    {
        let mut downloads = state.downloads.lock().unwrap();
        if downloads.contains_key(&model_id) {
            return Err("This model is already downloading.".into());
        }
        downloads.insert(model_id, cancel.clone());
    }
    let dir = data_dir(&app)?;
    let result = models::download_model(&dir, model_id, cancel, |ev| {
        let _ = channel.send(ev);
    })
    .await;
    state.downloads.lock().unwrap().remove(&model_id);
    result
}

/// Cancels an in-progress model download.
#[tauri::command]
pub fn cancel_download(state: State<'_, AppState>, model_id: BuiltinModelId) {
    if let Some(token) = state.downloads.lock().unwrap().remove(&model_id) {
        token.cancel();
    }
}

/// Stops the server if it uses this model, then deletes the model file.
#[tauri::command]
pub async fn delete_model(app: AppHandle, model_id: BuiltinModelId) -> Result<(), String> {
    let server = app.state::<BuiltinServer>();
    if server.is_running(model_id).await {
        server.stop().await;
    }
    models::delete_model(&data_dir(&app)?, model_id)
}

/// Shows the native open dialog filtered to PDFs, authorizes the chosen file and returns its path, or `None` if cancelled.
#[tauri::command]
pub async fn pick_pdf(app: AppHandle, window: Window, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter("PDF", &["pdf"])
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    let Some(file) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    state.authorize(&path).map(Some)
}

/// Reads a PDF after checking its size limit and `%PDF` signature.
pub(crate) async fn read_pdf_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let open_err = |e: std::io::Error| format!("Could not open {}: {e}", path.display());
    let meta = tokio::fs::metadata(path).await.map_err(open_err)?;
    if !meta.is_file() {
        return Err("This is not a regular file.".into());
    }
    if meta.len() > MAX_PDF_BYTES {
        return Err("This PDF is larger than 1 GiB and cannot be opened.".into());
    }
    let mut file = tokio::fs::File::open(path).await.map_err(open_err)?;
    let mut bytes = Vec::with_capacity(PDF_HEADER_WINDOW as usize);
    (&mut file).take(PDF_HEADER_WINDOW).read_to_end(&mut bytes).await.map_err(open_err)?;
    if !bytes.windows(4).any(|w| w == b"%PDF") {
        return Err("This file does not look like a PDF.".into());
    }
    bytes.reserve(meta.len().saturating_sub(bytes.len() as u64) as usize);
    let limit = MAX_PDF_BYTES + 1 - bytes.len() as u64;
    file.take(limit).read_to_end(&mut bytes).await.map_err(open_err)?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("This PDF is larger than 1 GiB and cannot be opened.".into());
    }
    Ok(bytes)
}

/// Reads a user-authorized PDF from disk and returns its raw bytes as a binary IPC response.
#[tauri::command]
pub async fn read_pdf(state: State<'_, AppState>, path: String) -> Result<Response, String> {
    let canonical = state.authorized_path(Path::new(&path))?;
    read_pdf_bytes(&canonical).await.map(Response::new)
}

/// Returns and clears a file path passed at launch (command line or OS "Open with").
#[tauri::command]
pub fn take_pending_open(state: State<'_, AppState>) -> Option<String> {
    state.pending_open.lock().unwrap().take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_url_gets_single_v1_suffix() {
        assert_eq!(ollama_v1("http://localhost:11434"), "http://localhost:11434/v1");
        assert_eq!(ollama_v1("http://localhost:11434/"), "http://localhost:11434/v1");
        assert_eq!(ollama_v1("http://localhost:11434/v1/"), "http://localhost:11434/v1");
    }

    #[test]
    fn settings_deserialize_from_frontend_shape() {
        let json = r#"{
            "kind": "cloud",
            "builtin": { "modelId": "qwen3-0.6b" },
            "ollama": { "baseUrl": "http://localhost:11434", "model": "qwen3" },
            "cloud": { "vendor": "anthropic", "model": "claude-haiku-5-5", "baseUrl": "https://api.anthropic.com" },
            "temperature": 0.3,
            "maxTokens": 600,
            "contextChars": 1500,
            "promptTemplate": "{{passage}}"
        }"#;
        let s: ProviderSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.kind, ProviderKind::Cloud);
        assert_eq!(s.cloud.vendor, Vendor::Anthropic);
        assert_eq!(s.builtin.model_id, BuiltinModelId::Qwen3_0_6b);
        assert_eq!(s.max_tokens, 600);
    }

    #[test]
    fn stream_events_match_frontend_shape() {
        let delta = serde_json::to_value(StreamEvent::Delta { text: "hi".into() }).unwrap();
        assert_eq!(delta, serde_json::json!({ "event": "delta", "text": "hi" }));
        let done = serde_json::to_value(StreamEvent::Done).unwrap();
        assert_eq!(done, serde_json::json!({ "event": "done" }));
    }

    #[test]
    fn official_vendors_ignore_user_base_url() {
        let evil = "https://evil.example/v1";
        assert_eq!(cloud_base_url(Vendor::OpenAI, evil).unwrap(), OPENAI_BASE_URL);
        assert_eq!(cloud_base_url(Vendor::Anthropic, evil).unwrap(), ANTHROPIC_BASE_URL);
        assert_eq!(cloud_base_url(Vendor::Gemini, "").unwrap(), GEMINI_BASE_URL);
    }

    #[test]
    fn custom_url_requires_https_or_loopback_http() {
        for ok in [
            "https://api.example.com/v1/",
            "https://10.0.0.5:8443/v1",
            "http://localhost:8080/v1",
            "http://LOCALHOST:8080",
            "http://127.0.0.1:1234/v1",
            "http://127.9.8.7",
            "http://[::1]:8000/v1",
        ] {
            assert!(cloud_base_url(Vendor::Custom, ok).is_ok(), "{ok}");
        }
        assert_eq!(cloud_base_url(Vendor::Custom, " https://a.example/v1/ ").unwrap(), "https://a.example/v1");
        for bad in [
            "",
            "http://example.com/v1",
            "http://192.168.1.10:8080",
            "http://localhost.evil.com",
            "http://127.0.0.1.nip.io",
            "http://[::2]",
            "ftp://localhost/",
            "file:///etc/passwd",
            "not a url",
            "localhost:8080",
        ] {
            assert!(cloud_base_url(Vendor::Custom, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_authorized_paths_are_readable() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.pdf");
        std::fs::write(&file, b"%PDF-1.7\n").unwrap();
        let state = AppState::default();
        assert_eq!(state.authorized_path(&file).unwrap_err(), NOT_AUTHORIZED);
        assert_eq!(state.authorized_path(&dir.path().join("missing.pdf")).unwrap_err(), NOT_AUTHORIZED);
        let returned = state.authorize(&file).unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        assert_eq!(PathBuf::from(&returned), canonical);
        let indirect = dir.path().join(".").join("a.pdf");
        assert_eq!(state.authorized_path(&indirect).unwrap(), canonical);
        assert!(state.authorize(&dir.path().join("missing.pdf")).is_err());
    }

    #[tokio::test]
    async fn read_pdf_bytes_checks_header_and_size() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("good.pdf");
        let mut content = b"junk\n%PDF-1.4\n".to_vec();
        content.extend(std::iter::repeat_n(b'x', 5000));
        std::fs::write(&good, &content).unwrap();
        assert_eq!(read_pdf_bytes(&good).await.unwrap(), content);

        let late = dir.path().join("late.pdf");
        let mut content = vec![b' '; 2000];
        content.extend_from_slice(b"%PDF");
        std::fs::write(&late, &content).unwrap();
        assert!(read_pdf_bytes(&late).await.unwrap_err().contains("does not look like a PDF"));

        let huge = dir.path().join("huge.pdf");
        let f = std::fs::File::create(&huge).unwrap();
        f.set_len(MAX_PDF_BYTES + 1).unwrap();
        assert!(read_pdf_bytes(&huge).await.unwrap_err().contains("1 GiB"));

        assert!(read_pdf_bytes(dir.path()).await.is_err());
    }

    #[test]
    fn auth_errors_are_friendly() {
        let msg = describe(LlmError::Http { status: 401, message: "bad key".into() });
        assert!(msg.contains("unauthorized"));
    }
}
