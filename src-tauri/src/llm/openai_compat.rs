//! OpenAI-compatible Chat Completions client (OpenAI, Ollama, llama-server and similar servers) plus model listing.

use std::time::Duration;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::sse::{self, Flow, StreamEnd};
use super::{ChatMessage, ChatOptions, LlmError};

/// Request parameter variants, relaxed when a server rejects a parameter.
#[derive(Debug, Clone, Copy)]
struct Params {
    completion_tokens_field: bool,
    send_temperature: bool,
}

impl Params {
    /// Picks the initial parameter style for `base_url`.
    fn for_base(base_url: &str) -> Self {
        Self { completion_tokens_field: base_url.contains("api.openai.com"), send_temperature: true }
    }

    /// Adjusts parameters in response to a 400 error, returning whether a retry is worthwhile.
    fn relax(&mut self, message: &str) -> bool {
        let message = message.to_ascii_lowercase();
        if message.contains("max_tokens") && !self.completion_tokens_field {
            self.completion_tokens_field = true;
            return true;
        }
        if message.contains("temperature") && self.send_temperature {
            self.send_temperature = false;
            return true;
        }
        false
    }
}

/// Builds the JSON request body for a streaming chat completion.
fn build_body(messages: &[ChatMessage], opts: &ChatOptions, params: Params) -> Value {
    let mut body = json!({
        "model": opts.model,
        "messages": messages,
        "stream": true,
    });
    let tokens_field = if params.completion_tokens_field { "max_completion_tokens" } else { "max_tokens" };
    body[tokens_field] = json!(opts.max_tokens);
    if params.send_temperature {
        body["temperature"] = json!(opts.temperature);
    }
    body
}

/// Returns the API key trimmed, or `None` when absent or blank.
fn usable_key(api_key: Option<&str>) -> Option<&str> {
    api_key.map(str::trim).filter(|k| !k.is_empty())
}

/// Streams a chat completion from `{base_url}/chat/completions`, calling `on_delta` with each content fragment.
pub async fn stream_chat(
    base_url: &str,
    api_key: Option<&str>,
    messages: &[ChatMessage],
    opts: &ChatOptions,
    cancel: CancellationToken,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<(), LlmError> {
    let url = format!("{}/chat/completions", sse::trim_base(base_url));
    let client = sse::streaming_client()?;
    let key = usable_key(api_key);
    let mut params = Params::for_base(base_url);
    let mut retries = 0;
    let response = loop {
        let mut request = client.post(&url).json(&build_body(messages, opts, params));
        if let Some(key) = key {
            request = request.bearer_auth(key);
        }
        match sse::send(request, &cancel).await {
            Ok(response) => break response,
            Err(LlmError::Http { status: 400, message }) if retries < 2 && params.relax(&message) => retries += 1,
            Err(err) => return Err(err),
        }
    };

    let mut finished = false;
    let end = sse::for_each_event(response.bytes_stream(), &cancel, |event| {
        let data = event.data.trim();
        if data == "[DONE]" {
            return Ok(Flow::Stop);
        }
        if data.is_empty() {
            return Ok(Flow::Continue);
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|e| LlmError::Protocol(format!("invalid JSON in stream: {e}")))?;
        if value.get("error").is_some() {
            let status = value["error"]["code"].as_u64().and_then(|c| u16::try_from(c).ok()).unwrap_or(500);
            let message = sse::extract_error_message(&value).unwrap_or_else(|| "stream error".to_string());
            return Err(LlmError::Http { status, message });
        }
        if let Some(choice) = value["choices"].get(0) {
            if let Some(text) = choice["delta"]["content"].as_str()
                && !text.is_empty()
            {
                on_delta(text);
            }
            if choice["finish_reason"].is_string() {
                finished = true;
            }
        }
        Ok(Flow::Continue)
    })
    .await?;

    match end {
        StreamEnd::Stopped => Ok(()),
        StreamEnd::Eof if finished => Ok(()),
        StreamEnd::Eof => Err(LlmError::Protocol("stream ended before the response completed".into())),
    }
}

/// Lists model ids from `{base_url}/models` without authentication (local servers).
pub async fn list_models(base_url: &str) -> Result<Vec<String>, LlmError> {
    list_models_with_key(base_url, None).await
}

/// Lists model ids from `{base_url}/models`, sending a Bearer token when `api_key` is present.
pub async fn list_models_with_key(base_url: &str, api_key: Option<&str>) -> Result<Vec<String>, LlmError> {
    let client = sse::quick_client(Duration::from_secs(5), Duration::from_secs(20))?;
    let mut request = client.get(format!("{}/models", sse::trim_base(base_url)));
    if let Some(key) = usable_key(api_key) {
        request = request.bearer_auth(key);
    }
    let response = sse::send(request, &CancellationToken::new()).await?;
    let value: Value = response.json().await.map_err(|e| LlmError::Protocol(format!("invalid models response: {e}")))?;
    let mut ids: Vec<String> = value["data"]
        .as_array()
        .ok_or_else(|| LlmError::Protocol("models response has no `data` array".into()))?
        .iter()
        .filter_map(|m| m["id"].as_str().map(str::to_string))
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// Lists locally installed Ollama models via `{base_url}/api/tags`, failing fast when Ollama is not running.
pub async fn list_ollama_models(base_url: &str) -> Result<Vec<String>, LlmError> {
    let base = sse::trim_base(base_url);
    let base = base.strip_suffix("/v1").unwrap_or(base);
    let client = sse::quick_client(Duration::from_millis(1500), Duration::from_secs(5))?;
    let response = sse::send(client.get(format!("{base}/api/tags")), &CancellationToken::new())
        .await
        .map_err(|err| match err {
            LlmError::Network(_) => LlmError::Network(format!(
                "Ollama is not reachable at {base}. Make sure Ollama is installed and running."
            )),
            other => other,
        })?;
    let value: Value = response.json().await.map_err(|e| LlmError::Protocol(format!("invalid Ollama response: {e}")))?;
    let mut names: Vec<String> = value["models"]
        .as_array()
        .ok_or_else(|| LlmError::Protocol("Ollama response has no `models` array".into()))?
        .iter()
        .filter_map(|m| m["name"].as_str().or_else(|| m["model"].as_str()).map(str::to_string))
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use wiremock::matchers::{body_partial_json, header, header_exists, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    use super::*;
    use crate::llm::Role;
    use crate::llm::sse::test_support::{chunked_server, split_bytes};

    const KEY: &str = "sk-test-placeholder";

    fn msgs() -> Vec<ChatMessage> {
        vec![
            ChatMessage { role: Role::System, content: "be brief".into() },
            ChatMessage { role: Role::User, content: "hi".into() },
        ]
    }

    fn opts() -> ChatOptions {
        ChatOptions { model: "test-model".into(), temperature: 0.2, max_tokens: 64 }
    }

    fn chunk(content: &str) -> String {
        format!("data: {}\n\n", json!({"choices":[{"index":0,"delta":{"content":content}}]}))
    }

    fn sse_response(body: String) -> ResponseTemplate {
        ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(body)
    }

    async fn run(base: &str, key: Option<&str>, cancel: CancellationToken) -> (Result<(), LlmError>, String) {
        let mut out = String::new();
        let mut cb = |t: &str| out.push_str(t);
        let result = stream_chat(base, key, &msgs(), &opts(), cancel, &mut cb).await;
        (result, out)
    }

    #[tokio::test]
    async fn streams_deltas_with_bearer_and_ignores_reasoning() {
        let server = MockServer::start().await;
        let body = format!(
            "{}{}: comment\n\n{}{}data: {}\n\ndata: [DONE]\n\n",
            format_args!("data: {}\n\n", json!({"choices":[{"delta":{"role":"assistant","reasoning_content":"thinking"}}]})),
            chunk("Hel"),
            chunk("lo"),
            format_args!("data: {}\n\n", json!({"choices":[{"delta":{"reasoning":"more","content":null}}]})),
            json!({"choices":[{"delta":{},"finish_reason":"stop"}]}),
        );
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", format!("Bearer {KEY}").as_str()))
            .and(body_partial_json(json!({"model":"test-model","stream":true,"max_tokens":64,
                "messages":[{"role":"system","content":"be brief"},{"role":"user","content":"hi"}]})))
            .respond_with(sse_response(body))
            .expect(1)
            .mount(&server)
            .await;
        let (result, out) = run(&format!("{}/v1/", server.uri()), Some(KEY), CancellationToken::new()).await;
        result.unwrap();
        assert_eq!(out, "Hello");
    }

    #[tokio::test]
    async fn omits_authorization_without_key() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(|req: &Request| {
                if req.headers.contains_key("authorization") {
                    ResponseTemplate::new(400)
                } else {
                    sse_response(format!("{}data: [DONE]\n\n", chunk("ok")))
                }
            })
            .mount(&server)
            .await;
        let (result, out) = run(&format!("{}/v1", server.uri()), Some("   "), CancellationToken::new()).await;
        result.unwrap();
        assert_eq!(out, "ok");
    }

    #[tokio::test]
    async fn handles_deltas_split_across_network_chunks() {
        let body = format!(
            "{}{}{}data: [DONE]\r\n\r\n",
            chunk("Grüß"),
            chunk(" dich"),
            chunk(" 🌍")
        )
        .replace("\n\n", "\r\n\r\n");
        let base = chunked_server(split_bytes(&body, &[7, 13, 1, 30, 2, 5, 41, 3, 9]), false).await;
        let (result, out) = run(&format!("{base}/v1"), None, CancellationToken::new()).await;
        result.unwrap();
        assert_eq!(out, "Grüß dich 🌍");
    }

    #[tokio::test]
    async fn maps_http_errors_with_provider_message() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "error": {"message": "Incorrect API key provided", "type": "invalid_request_error"}
            })))
            .mount(&server)
            .await;
        let (result, _) = run(&format!("{}/v1", server.uri()), Some(KEY), CancellationToken::new()).await;
        match result {
            Err(LlmError::Http { status, message }) => {
                assert_eq!(status, 401);
                assert_eq!(message, "Incorrect API key provided");
                assert!(!message.contains(KEY));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn retries_with_max_completion_tokens_and_without_temperature() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(|req: &Request| {
                let body: Value = serde_json::from_slice(&req.body).unwrap();
                if body.get("max_tokens").is_some() {
                    ResponseTemplate::new(400).set_body_json(json!({"error":{"message":"Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead."}}))
                } else if body.get("temperature").is_some() {
                    ResponseTemplate::new(400).set_body_json(json!({"error":{"message":"Unsupported value: 'temperature' does not support 0.2"}}))
                } else {
                    sse_response(format!("{}data: [DONE]\n\n", chunk("done")))
                }
            })
            .expect(3)
            .mount(&server)
            .await;
        let (result, out) = run(&format!("{}/v1", server.uri()), Some(KEY), CancellationToken::new()).await;
        result.unwrap();
        assert_eq!(out, "done");
    }

    #[tokio::test]
    async fn surfaces_in_stream_error() {
        let server = MockServer::start().await;
        let body = format!("{}data: {}\n\n", chunk("a"), json!({"error":{"message":"context too long","code":400}}));
        Mock::given(method("POST")).respond_with(sse_response(body)).mount(&server).await;
        let (result, out) = run(&format!("{}/v1", server.uri()), None, CancellationToken::new()).await;
        assert!(matches!(result, Err(LlmError::Http { status: 400, ref message }) if message == "context too long"));
        assert_eq!(out, "a");
    }

    #[tokio::test]
    async fn truncated_stream_is_protocol_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).respond_with(sse_response(chunk("partial"))).mount(&server).await;
        let (result, _) = run(&format!("{}/v1", server.uri()), None, CancellationToken::new()).await;
        assert!(matches!(result, Err(LlmError::Protocol(_))));
    }

    #[tokio::test]
    async fn cancels_while_waiting_for_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(sse_response("data: [DONE]\n\n".into()).set_delay(Duration::from_secs(10)))
            .mount(&server)
            .await;
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            trigger.cancel();
        });
        let started = Instant::now();
        let (result, _) = run(&format!("{}/v1", server.uri()), None, cancel).await;
        assert!(matches!(result, Err(LlmError::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn cancels_mid_stream() {
        let base = chunked_server(vec![chunk("first").into_bytes()], true).await;
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let mut out = Vec::new();
        let mut cb = |t: &str| {
            out.push(t.to_string());
            trigger.cancel();
        };
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            stream_chat(&format!("{base}/v1"), None, &msgs(), &opts(), cancel, &mut cb),
        )
        .await
        .expect("cancellation should be prompt");
        assert!(matches!(result, Err(LlmError::Cancelled)));
        assert_eq!(out, ["first"]);
    }

    #[tokio::test]
    async fn lists_models() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "object": "list", "data": [{"id": "b-model"}, {"id": "a-model"}]
            })))
            .mount(&server)
            .await;
        let models = list_models(&format!("{}/v1", server.uri())).await.unwrap();
        assert_eq!(models, ["a-model", "b-model"]);
    }

    #[tokio::test]
    async fn lists_models_with_key() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": [{"id": "gpt-x"}]})))
            .mount(&server)
            .await;
        let models = list_models_with_key(&format!("{}/v1", server.uri()), Some(KEY)).await.unwrap();
        assert_eq!(models, ["gpt-x"]);
    }

    #[tokio::test]
    async fn lists_ollama_models() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "models": [{"name": "qwen3:8b", "model": "qwen3:8b"}, {"name": "llama3.2:latest"}]
            })))
            .mount(&server)
            .await;
        let models = list_ollama_models(&server.uri()).await.unwrap();
        assert_eq!(models, ["llama3.2:latest", "qwen3:8b"]);
        let via_v1 = list_ollama_models(&format!("{}/v1/", server.uri())).await.unwrap();
        assert_eq!(via_v1.len(), 2);
    }

    #[tokio::test]
    async fn ollama_not_running_fails_fast_with_friendly_message() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let started = Instant::now();
        let err = list_ollama_models(&format!("http://127.0.0.1:{port}")).await.unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(3));
        match err {
            LlmError::Network(message) => assert!(message.contains("Ollama is not reachable")),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    #[ignore]
    async fn live_openai() {
        let Ok(key) = std::env::var("OPENAI_API_KEY") else { return };
        let model = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into());
        let messages = vec![ChatMessage { role: Role::User, content: "Say hello in three words.".into() }];
        let options = ChatOptions { model, temperature: 0.2, max_tokens: 32 };
        let mut out = String::new();
        let mut cb = |t: &str| out.push_str(t);
        stream_chat("https://api.openai.com/v1", Some(&key), &messages, &options, CancellationToken::new(), &mut cb)
            .await
            .unwrap();
        assert!(!out.trim().is_empty());
    }
}
