//! Catalog, download, verification and status of the built-in GGUF models.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

/// Identifier of a built-in model, serialized as in `BuiltinModelId` of src/types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BuiltinModelId {
    /// Qwen3 1.7B, Q4_K_M quantization.
    #[serde(rename = "qwen3-1.7b")]
    Qwen3_1_7b,
    /// Qwen3 0.6B, Q4_K_M quantization.
    #[serde(rename = "qwen3-0.6b")]
    Qwen3_0_6b,
}

/// Download and runtime state of a built-in model, matching `BuiltinStatus` in src/types.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinStatus {
    /// Model this status describes.
    pub model_id: BuiltinModelId,
    /// Whether the verified GGUF file is present on disk.
    pub downloaded: bool,
    /// Whether llama-server is currently serving this model.
    pub running: bool,
    /// Size of the GGUF file in bytes.
    pub size_bytes: u64,
}

/// Progress event emitted while downloading, matching `DownloadEvent` in src/types.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum DownloadEvent {
    /// Bytes received so far and the expected total, if known.
    Progress { downloaded: u64, total: Option<u64> },
    /// The download finished and the checksum is being confirmed.
    Verifying,
    /// The model was verified and moved into place.
    Done,
    /// The download failed or was cancelled.
    Error { message: String },
}

/// Static description of a downloadable model file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelSpec {
    /// Model identifier.
    pub id: BuiltinModelId,
    /// File name inside the models directory.
    pub file_name: &'static str,
    /// HTTPS download URL.
    pub url: &'static str,
    /// Exact file size in bytes.
    pub size: u64,
    /// Lowercase hex SHA-256 of the file.
    pub sha256: &'static str,
}

/// All built-in models.
pub const CATALOG: [ModelSpec; 2] = [
    ModelSpec {
        id: BuiltinModelId::Qwen3_1_7b,
        file_name: "Qwen3-1.7B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
        size: 1_107_409_472,
        sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
    },
    ModelSpec {
        id: BuiltinModelId::Qwen3_0_6b,
        file_name: "Qwen3-0.6B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
        size: 396_705_472,
        sha256: "ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a",
    },
];

const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Returns the catalog entry for a model.
pub fn spec(id: BuiltinModelId) -> &'static ModelSpec {
    CATALOG.iter().find(|s| s.id == id).expect("every model id has a catalog entry")
}

/// Returns the path where a model's GGUF file lives under the app data directory.
pub fn model_path(data_dir: &Path, id: BuiltinModelId) -> PathBuf {
    data_dir.join("models").join(spec(id).file_name)
}

/// Returns the temporary path used while a download is in progress.
fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

/// Downloads and verifies a model into the data directory, emitting progress and a final `Done` or `Error` event.
pub async fn download_model(
    data_dir: &Path,
    id: BuiltinModelId,
    cancel: CancellationToken,
    on_event: impl FnMut(DownloadEvent),
) -> Result<(), String> {
    let s = spec(id);
    download_file(s.url, &model_path(data_dir, id), s.sha256, Some(s.size), cancel, on_event).await
}

/// Streams `url` into `dest` via a `.part` file, verifying size and SHA-256, and removes the partial file on failure.
pub(crate) async fn download_file(
    url: &str,
    dest: &Path,
    sha256: &str,
    expected_size: Option<u64>,
    cancel: CancellationToken,
    mut on_event: impl FnMut(DownloadEvent),
) -> Result<(), String> {
    let part = part_path(dest);
    let result = fetch_to_part(url, dest, &part, sha256, expected_size, &cancel, &mut on_event).await;
    match result {
        Ok(()) => {
            on_event(DownloadEvent::Done);
            Ok(())
        }
        Err(message) => {
            let _ = tokio::fs::remove_file(&part).await;
            on_event(DownloadEvent::Error { message: message.clone() });
            Err(message)
        }
    }
}

/// Performs the streaming download, hashing and atomic rename without cleanup, aborting once more than `expected_size` bytes arrive.
async fn fetch_to_part(
    url: &str,
    dest: &Path,
    part: &Path,
    sha256: &str,
    expected_size: Option<u64>,
    cancel: &CancellationToken,
    on_event: &mut impl FnMut(DownloadEvent),
) -> Result<(), String> {
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err("download cancelled".into()),
        r = client.get(url).send() => r.map_err(|e| format!("download failed: {e}"))?,
    };
    let response = response
        .error_for_status()
        .map_err(|e| format!("download failed: {e}"))?;
    if let (Some(size), Some(len)) = (expected_size, response.content_length())
        && len > size
    {
        return Err(format!("download too large: server reports {len} bytes, expected {size}"));
    }
    let total = response.content_length().or(expected_size);
    let mut file = tokio::fs::File::create(part)
        .await
        .map_err(|e| format!("cannot create {}: {e}", part.display()))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut last_emit: Option<Instant> = None;
    let mut stream = response.bytes_stream();
    on_event(DownloadEvent::Progress { downloaded, total });
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("download cancelled".into()),
            c = stream.next() => c,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        downloaded += chunk.len() as u64;
        if let Some(size) = expected_size
            && downloaded > size
        {
            return Err(format!("download too large: received more than the expected {size} bytes"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write failed: {e}"))?;
        if last_emit.is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL) {
            last_emit = Some(Instant::now());
            on_event(DownloadEvent::Progress { downloaded, total });
        }
    }
    on_event(DownloadEvent::Progress { downloaded, total });
    file.flush().await.map_err(|e| format!("write failed: {e}"))?;
    file.sync_all().await.map_err(|e| format!("write failed: {e}"))?;
    drop(file);
    on_event(DownloadEvent::Verifying);
    if let Some(size) = expected_size
        && downloaded != size
    {
        return Err(format!("size mismatch: expected {size} bytes, got {downloaded}"));
    }
    let actual = hex::encode(hasher.finalize());
    if !actual.eq_ignore_ascii_case(sha256) {
        return Err(format!("checksum mismatch: expected {sha256}, got {actual}"));
    }
    tokio::fs::rename(part, dest)
        .await
        .map_err(|e| format!("cannot move model into place: {e}"))
}

/// Deletes a downloaded model and any leftover partial download.
pub fn delete_model(data_dir: &Path, id: BuiltinModelId) -> Result<(), String> {
    let path = model_path(data_dir, id);
    for p in [part_path(&path), path] {
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot delete {}: {e}", p.display())),
        }
    }
    Ok(())
}

/// Reports whether a model is downloaded (present with the expected size) and whether it is running.
pub fn status(data_dir: &Path, id: BuiltinModelId, running: bool) -> BuiltinStatus {
    let s = spec(id);
    let downloaded = std::fs::metadata(model_path(data_dir, id)).is_ok_and(|m| m.is_file() && m.len() == s.size);
    BuiltinStatus {
        model_id: id,
        downloaded,
        running,
        size_bytes: s.size,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Returns a payload and its SHA-256 hex digest.
    fn payload() -> (Vec<u8>, String) {
        let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let sha = hex::encode(Sha256::digest(&body));
        (body, sha)
    }

    /// Starts a mock server serving `body` at /model.gguf with an optional delay.
    async fn serve(body: Vec<u8>, delay: Duration) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/model.gguf"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body).set_delay(delay))
            .mount(&server)
            .await;
        server
    }

    /// Serialized shapes match the TypeScript types.
    #[test]
    fn serde_shapes_match_frontend() {
        let ev = serde_json::to_value(DownloadEvent::Progress { downloaded: 5, total: Some(10) }).unwrap();
        assert_eq!(ev, serde_json::json!({"event": "progress", "downloaded": 5, "total": 10}));
        let ev = serde_json::to_value(DownloadEvent::Progress { downloaded: 5, total: None }).unwrap();
        assert_eq!(ev, serde_json::json!({"event": "progress", "downloaded": 5, "total": null}));
        assert_eq!(serde_json::to_value(DownloadEvent::Verifying).unwrap(), serde_json::json!({"event": "verifying"}));
        assert_eq!(serde_json::to_value(DownloadEvent::Done).unwrap(), serde_json::json!({"event": "done"}));
        let ev = serde_json::to_value(DownloadEvent::Error { message: "x".into() }).unwrap();
        assert_eq!(ev, serde_json::json!({"event": "error", "message": "x"}));
        let st = serde_json::to_value(status(Path::new("/nonexistent"), BuiltinModelId::Qwen3_0_6b, true)).unwrap();
        assert_eq!(
            st,
            serde_json::json!({"modelId": "qwen3-0.6b", "downloaded": false, "running": true, "sizeBytes": 396_705_472u64})
        );
        let id: BuiltinModelId = serde_json::from_str("\"qwen3-1.7b\"").unwrap();
        assert_eq!(id, BuiltinModelId::Qwen3_1_7b);
    }

    /// A correct checksum leaves the final file and no partial file.
    #[tokio::test]
    async fn download_success_verifies_and_renames() {
        let (body, sha) = payload();
        let server = serve(body.clone(), Duration::ZERO).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("models").join("m.gguf");
        let mut events = Vec::new();
        download_file(
            &format!("{}/model.gguf", server.uri()),
            &dest,
            &sha,
            Some(body.len() as u64),
            CancellationToken::new(),
            |e| events.push(e),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert!(!part_path(&dest).exists());
        assert!(events.contains(&DownloadEvent::Progress { downloaded: body.len() as u64, total: Some(body.len() as u64) }));
        assert_eq!(&events[events.len() - 2..], &[DownloadEvent::Verifying, DownloadEvent::Done]);
    }

    /// A wrong checksum fails and removes the partial file.
    #[tokio::test]
    async fn download_sha_mismatch_removes_part() {
        let (body, _) = payload();
        let server = serve(body.clone(), Duration::ZERO).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let mut events = Vec::new();
        let err = download_file(
            &format!("{}/model.gguf", server.uri()),
            &dest,
            &"0".repeat(64),
            Some(body.len() as u64),
            CancellationToken::new(),
            |e| events.push(e),
        )
        .await
        .unwrap_err();
        assert!(err.contains("checksum mismatch"), "{err}");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
        assert!(matches!(events.last(), Some(DownloadEvent::Error { .. })));
    }

    /// Cancelling while waiting for the response aborts promptly.
    #[tokio::test]
    async fn download_cancel_before_response() {
        let (body, sha) = payload();
        let server = serve(body, Duration::from_secs(5)).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            trigger.cancel();
        });
        let started = Instant::now();
        let err = download_file(&format!("{}/model.gguf", server.uri()), &dest, &sha, None, cancel, |_| {})
            .await
            .unwrap_err();
        assert!(err.contains("cancelled"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
    }

    /// Cancelling mid-stream removes the partial file.
    #[tokio::test]
    async fn download_cancel_mid_stream_removes_part() {
        let (body, sha) = payload();
        let server = serve(body, Duration::ZERO).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let part = part_path(&dest);
        let mut saw_part = false;
        let err = download_file(&format!("{}/model.gguf", server.uri()), &dest, &sha, None, cancel, |e| {
            if matches!(e, DownloadEvent::Progress { .. }) {
                saw_part |= part.exists();
                trigger.cancel();
            }
        })
        .await
        .unwrap_err();
        assert!(saw_part);
        assert!(err.contains("cancelled"), "{err}");
        assert!(!dest.exists());
        assert!(!part.exists());
    }

    #[tokio::test]
    async fn download_rejects_oversized_content_length() {
        let (body, sha) = payload();
        let server = serve(body.clone(), Duration::ZERO).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let mut events = Vec::new();
        let err = download_file(
            &format!("{}/model.gguf", server.uri()),
            &dest,
            &sha,
            Some(body.len() as u64 - 1),
            CancellationToken::new(),
            |e| events.push(e),
        )
        .await
        .unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert!(!dest.exists() && !part_path(&dest).exists());
        assert!(!events.iter().any(|e| matches!(e, DownloadEvent::Progress { .. })));
        assert!(matches!(events.last(), Some(DownloadEvent::Error { .. })));
    }

    #[tokio::test]
    async fn download_aborts_when_stream_exceeds_expected_size() {
        let chunks: Vec<Vec<u8>> = (0..20).map(|_| vec![7u8; 4096]).collect();
        let url = crate::llm::sse::test_support::chunked_server(chunks, true).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let mut max_seen = 0;
        let started = Instant::now();
        let err = download_file(&url, &dest, &"0".repeat(64), Some(10_000), CancellationToken::new(), |e| {
            if let DownloadEvent::Progress { downloaded, .. } = e {
                max_seen = max_seen.max(downloaded);
            }
        })
        .await
        .unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert!(max_seen <= 10_000);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!dest.exists() && !part_path(&dest).exists());
    }

    /// Status and deletion reflect files on disk.
    #[test]
    fn status_and_delete_follow_disk_state() {
        let dir = tempfile::tempdir().unwrap();
        let id = BuiltinModelId::Qwen3_0_6b;
        assert!(!status(dir.path(), id, false).downloaded);
        let path = model_path(dir.path(), id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::File::create(&path).unwrap().set_len(spec(id).size).unwrap();
        std::fs::write(part_path(&path), b"x").unwrap();
        assert!(status(dir.path(), id, false).downloaded);
        delete_model(dir.path(), id).unwrap();
        assert!(!path.exists() && !part_path(&path).exists());
        delete_model(dir.path(), id).unwrap();
    }
}
