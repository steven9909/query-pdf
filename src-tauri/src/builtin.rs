//! Lifecycle manager for the bundled llama-server sidecar that serves the built-in model.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tokio::sync::{Mutex, mpsc::Receiver};

use crate::models::BuiltinModelId;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);
const HEALTH_POLL: Duration = Duration::from_millis(250);
const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const IDLE_CHECK: Duration = Duration::from_secs(30);
const LOG_LINES: usize = 50;
const CTX_SIZE: &str = "8192";
const REDACTED: &str = "[redacted]";
/// Environment variable llama-server reads its API key from.
const API_KEY_VAR: &str = "LLAMA_API_KEY";

#[cfg(target_os = "macos")]
const LIB_MARKER: &str = "libllama.0.dylib";
#[cfg(target_os = "macos")]
const LIB_PATH_VAR: &str = "DYLD_LIBRARY_PATH";
#[cfg(windows)]
const LIB_MARKER: &str = "llama.dll";
#[cfg(windows)]
const LIB_PATH_VAR: &str = "PATH";
#[cfg(not(any(target_os = "macos", windows)))]
const LIB_MARKER: &str = "libllama.so.0";
#[cfg(not(any(target_os = "macos", windows)))]
const LIB_PATH_VAR: &str = "LD_LIBRARY_PATH";

/// Ring buffer of the most recent llama-server output lines.
type Logs = Arc<StdMutex<VecDeque<String>>>;

/// Metadata about the live llama-server process.
struct Running {
    model_id: BuiltinModelId,
    endpoint: BuiltinEndpoint,
    exited: Arc<AtomicBool>,
}

/// Address and per-launch bearer token of a running llama-server.
#[derive(Clone)]
pub struct BuiltinEndpoint {
    /// OpenAI-compatible `/v1` base URL.
    pub base_url: String,
    /// Random token llama-server requires on every endpoint except `/health`.
    pub api_key: String,
}

impl std::fmt::Debug for BuiltinEndpoint {
    /// Formats the endpoint without revealing the token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BuiltinEndpoint")
            .field("base_url", &self.base_url)
            .field("api_key", &REDACTED)
            .finish()
    }
}

/// Mutable state guarded by the async mutex.
#[derive(Default)]
struct State {
    running: Option<Running>,
    generation: u64,
}

/// Owns the llama-server sidecar; store one instance in Tauri state via `app.manage(BuiltinServer::default())`.
#[derive(Clone)]
pub struct BuiltinServer {
    state: Arc<Mutex<State>>,
    child: Arc<StdMutex<Option<CommandChild>>>,
    last_activity: Arc<StdMutex<Instant>>,
}

impl Default for BuiltinServer {
    /// Creates a manager with no process running.
    fn default() -> Self {
        Self {
            state: Arc::default(),
            child: Arc::default(),
            last_activity: Arc::new(StdMutex::new(Instant::now())),
        }
    }
}

/// Locks a std mutex, ignoring poisoning.
fn lock<T>(m: &StdMutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Kills the child process held in the slot, if any.
fn kill_child(slot: &StdMutex<Option<CommandChild>>) {
    if let Some(child) = lock(slot).take() {
        let _ = child.kill();
    }
}

impl BuiltinServer {
    /// Records activity so the idle-shutdown timer restarts.
    pub fn touch(&self) {
        *lock(&self.last_activity) = Instant::now();
    }

    /// Starts llama-server for `model_id` (or reuses it if already serving that model) and returns its endpoint and token.
    pub async fn ensure_running(
        &self,
        app: &AppHandle,
        model_path: &Path,
        model_id: BuiltinModelId,
    ) -> Result<BuiltinEndpoint, String> {
        let mut state = self.state.lock().await;
        self.touch();
        if let Some(r) = &state.running
            && r.model_id == model_id
            && !r.exited.load(Ordering::SeqCst)
        {
            return Ok(r.endpoint.clone());
        }
        state.running = None;
        state.generation += 1;
        kill_child(&self.child);
        if !model_path.is_file() {
            return Err(format!("model file not found: {}", model_path.display()));
        }

        let port = free_port()?;
        let api_key = new_token()?;
        let mut cmd = app
            .shell()
            .sidecar("llama-server")
            .map_err(|e| format!("cannot locate llama-server: {e}"))?
            .args(server_args(model_path, port))
            .env(API_KEY_VAR, &api_key)
            .kill_on_drop(true);
        if let Some(dir) = lib_dir(app) {
            cmd = cmd.current_dir(&dir).env(LIB_PATH_VAR, lib_path_value(&dir));
        }
        let (rx, child) = cmd
            .spawn()
            .map_err(|e| redact(&format!("cannot start llama-server: {e}"), &api_key))?;
        *lock(&self.child) = Some(child);

        let logs: Logs = Arc::default();
        let exited = Arc::new(AtomicBool::new(false));
        tauri::async_runtime::spawn(drain(rx, logs.clone(), exited.clone(), api_key.clone()));

        let root = format!("http://127.0.0.1:{port}");
        if let Err(e) = wait_healthy(&root, HEALTH_TIMEOUT, &exited).await {
            kill_child(&self.child);
            let tail = lock(&logs).iter().cloned().collect::<Vec<_>>().join("\n");
            return Err(format!("{e}\nllama-server output:\n{tail}"));
        }

        let endpoint = BuiltinEndpoint { base_url: format!("{root}/v1"), api_key };
        state.running = Some(Running {
            model_id,
            endpoint: endpoint.clone(),
            exited,
        });
        self.touch();
        self.spawn_idle_watcher(state.generation);
        Ok(endpoint)
    }

    /// Stops the running llama-server, if any.
    pub async fn stop(&self) {
        let mut state = self.state.lock().await;
        state.running = None;
        state.generation += 1;
        kill_child(&self.child);
    }

    /// Reports whether llama-server is alive and serving `model_id`.
    pub async fn is_running(&self, model_id: BuiltinModelId) -> bool {
        let state = self.state.lock().await;
        state
            .running
            .as_ref()
            .is_some_and(|r| r.model_id == model_id && !r.exited.load(Ordering::SeqCst))
    }

    /// Synchronously kills the child process; call from the `RunEvent::Exit` handler.
    pub fn shutdown(&self) {
        kill_child(&self.child);
        if let Ok(mut state) = self.state.try_lock() {
            state.running = None;
            state.generation += 1;
        }
    }

    /// Spawns a task that stops the server after `IDLE_TIMEOUT` without activity for this generation.
    fn spawn_idle_watcher(&self, generation: u64) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(IDLE_CHECK).await;
                let mut state = this.state.lock().await;
                if state.generation != generation || state.running.is_none() {
                    break;
                }
                if lock(&this.last_activity).elapsed() >= IDLE_TIMEOUT {
                    state.running = None;
                    state.generation += 1;
                    kill_child(&this.child);
                    break;
                }
            }
        });
    }
}

/// Returns a currently free TCP port on 127.0.0.1.
pub(crate) fn free_port() -> Result<u16, String> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("cannot find a free port: {e}"))
}

/// Returns 32 random bytes from the OS, hex-encoded, for use as a per-launch API key.
pub(crate) fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("cannot generate a server token: {e}"))?;
    Ok(hex::encode(bytes))
}

/// Replaces every occurrence of `secret` in `text` with a placeholder.
pub(crate) fn redact(text: &str, secret: &str) -> String {
    if secret.is_empty() { text.to_string() } else { text.replace(secret, REDACTED) }
}

/// Builds the llama-server command-line arguments; the API key is passed via `API_KEY_VAR` so it never appears in the process list.
pub(crate) fn server_args(model_path: &Path, port: u16) -> Vec<String> {
    let mut args = vec![
        "--model".to_string(),
        model_path.to_string_lossy().into_owned(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--ctx-size".into(),
        CTX_SIZE.into(),
        "--parallel".into(),
        "1".into(),
        "--jinja".into(),
        "--reasoning".into(),
        "off".into(),
    ];
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        args.extend(["-ngl".into(), "99".into()]);
    }
    args
}

/// Finds the directory holding llama-server's shared libraries in bundled or dev layouts.
fn lib_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("llama-libs"));
    }
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        candidates.push(exe_dir);
    }
    if cfg!(debug_assertions) {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    }
    candidates.into_iter().find(|d| d.join(LIB_MARKER).is_file())
}

/// Prepends `dir` to the platform's library search path variable.
pub(crate) fn lib_path_value(dir: &Path) -> OsString {
    let existing = std::env::var_os(LIB_PATH_VAR).unwrap_or_default();
    let paths = std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&existing));
    std::env::join_paths(paths).unwrap_or_else(|_| dir.as_os_str().to_owned())
}

/// Consumes sidecar output, keeping the last `LOG_LINES` lines with `secret` redacted and flagging termination.
async fn drain(mut rx: Receiver<CommandEvent>, logs: Logs, exited: Arc<AtomicBool>, secret: String) {
    while let Some(event) = rx.recv().await {
        let line = match event {
            CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => String::from_utf8_lossy(&b).trim_end().to_string(),
            CommandEvent::Error(e) => format!("error: {e}"),
            CommandEvent::Terminated(t) => {
                exited.store(true, Ordering::SeqCst);
                format!("exited with code {:?} signal {:?}", t.code, t.signal)
            }
            _ => continue,
        };
        let line = redact(&line, &secret);
        let mut logs = lock(&logs);
        if logs.len() == LOG_LINES {
            logs.pop_front();
        }
        logs.push_back(line);
    }
    exited.store(true, Ordering::SeqCst);
}

/// Polls `{root}/health` until it returns 200, the process exits, or `timeout` elapses.
pub(crate) async fn wait_healthy(root: &str, timeout: Duration, exited: &AtomicBool) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{root}/health");
    let deadline = Instant::now() + timeout;
    loop {
        if exited.load(Ordering::SeqCst) {
            return Err("llama-server exited during startup".into());
        }
        if let Ok(r) = client.get(&url).send().await
            && r.status() == reqwest::StatusCode::OK
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("llama-server not ready after {}s", timeout.as_secs()));
        }
        tokio::time::sleep(HEALTH_POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// The free-port helper returns a bindable, non-zero port.
    #[test]
    fn free_port_is_bindable() {
        let port = free_port().unwrap();
        assert_ne!(port, 0);
        TcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap();
    }

    /// Arguments include the model, port, context size and the thinking switch.
    #[test]
    fn args_contain_required_flags() {
        let args = server_args(Path::new("/m/q.gguf"), 4321).join(" ");
        assert!(args.starts_with("--model /m/q.gguf --host 127.0.0.1 --port 4321 --ctx-size 8192"));
        assert!(args.contains("--jinja") && args.contains("--reasoning off"));
        assert!(!args.contains("--api-key"));
        assert_eq!(args.contains("-ngl 99"), cfg!(all(target_os = "macos", target_arch = "aarch64")));
    }

    #[test]
    fn tokens_are_random_hex_and_redacted() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        let line = format!("main: args --api-key {a} --port 1");
        let red = redact(&line, &a);
        assert!(!red.contains(&a));
        assert!(red.contains(REDACTED));
        let ep = BuiltinEndpoint { base_url: "http://127.0.0.1:1/v1".into(), api_key: a.clone() };
        assert!(!format!("{ep:?}").contains(&a));
    }

    #[tokio::test]
    async fn drained_logs_never_contain_token() {
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        let logs: Logs = Arc::default();
        let exited = Arc::new(AtomicBool::new(false));
        tx.send(CommandEvent::Stderr(b"argv: --api-key s3cr3t".to_vec())).await.unwrap();
        drop(tx);
        drain(rx, logs.clone(), exited.clone(), "s3cr3t".into()).await;
        let joined = lock(&logs).iter().cloned().collect::<Vec<_>>().join("\n");
        assert!(!joined.contains("s3cr3t") && joined.contains(REDACTED));
        assert!(exited.load(Ordering::SeqCst));
    }

    /// The library directory is prepended to the search path.
    #[test]
    fn lib_path_prepends_dir() {
        let v = lib_path_value(Path::new("/libs"));
        assert_eq!(std::env::split_paths(&v).next().unwrap(), PathBuf::from("/libs"));
    }

    /// Health polling succeeds on 200, fails on timeout and fails fast on exit.
    #[tokio::test]
    async fn health_polling() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/health"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(2)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/health"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let alive = AtomicBool::new(false);
        wait_healthy(&server.uri(), Duration::from_secs(5), &alive).await.unwrap();

        let down = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&down)
            .await;
        let err = wait_healthy(&down.uri(), Duration::from_millis(600), &alive).await.unwrap_err();
        assert!(err.contains("not ready"), "{err}");
        let dead = AtomicBool::new(true);
        let err = wait_healthy(&down.uri(), Duration::from_secs(5), &dead).await.unwrap_err();
        assert!(err.contains("exited"), "{err}");
    }

    /// Downloads the 0.6B model, starts the fetched llama-server and runs one chat completion.
    #[tokio::test]
    #[ignore = "downloads ~400 MB and runs llama-server"]
    async fn real_download_and_serve() {
        use crate::models::{self, BuiltinModelId};
        let data_dir = std::env::temp_dir().join("query-pdf-it");
        let id = BuiltinModelId::Qwen3_0_6b;
        if !models::status(&data_dir, id, false).downloaded {
            models::download_model(&data_dir, id, Default::default(), |_| {}).await.unwrap();
        }
        let bin_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let exe = std::fs::read_dir(&bin_dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.file_name().unwrap().to_string_lossy().starts_with("llama-server-"))
            .expect("run scripts/fetch-llama-server.mjs first");
        let port = free_port().unwrap();
        let token = new_token().unwrap();
        let mut child = tokio::process::Command::new(exe)
            .args(server_args(&models::model_path(&data_dir, id), port))
            .env(API_KEY_VAR, &token)
            .current_dir(&bin_dir)
            .env(LIB_PATH_VAR, lib_path_value(&bin_dir))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let root = format!("http://127.0.0.1:{port}");
        let started = Instant::now();
        wait_healthy(&root, HEALTH_TIMEOUT, &AtomicBool::new(false)).await.unwrap();
        println!("healthy after {:?}", started.elapsed());
        let unauth = reqwest::Client::new().get(format!("{root}/v1/models")).send().await.unwrap();
        assert_eq!(unauth.status(), reqwest::StatusCode::UNAUTHORIZED);
        let body: serde_json::Value = reqwest::Client::new()
            .post(format!("{root}/v1/chat/completions"))
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "messages": [{"role": "user", "content": "In one sentence, what is a PDF?"}],
                "max_tokens": 64
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let msg = &body["choices"][0]["message"];
        println!("response: {msg}");
        let content = msg["content"].as_str().unwrap();
        assert!(!content.trim().is_empty());
        assert!(!content.contains("<think>"));
        child.kill().await.unwrap();
    }
}
