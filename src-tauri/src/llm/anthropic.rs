//! Anthropic Messages API streaming client.

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::sse::{self, Flow, StreamEnd};
use super::{ChatMessage, ChatOptions, LlmError, Role};

/// Anthropic API version sent with every request.
const API_VERSION: &str = "2023-06-01";

/// Builds the Messages API body, lifting system prompts to `system` and merging consecutive same-role turns.
fn build_body(messages: &[ChatMessage], opts: &ChatOptions) -> Value {
    let system: Vec<&str> = messages
        .iter()
        .filter(|m| m.role == Role::System && !m.content.trim().is_empty())
        .map(|m| m.content.as_str())
        .collect();
    let mut turns: Vec<(&str, String)> = Vec::new();
    for message in messages.iter().filter(|m| m.role != Role::System) {
        let role = if message.role == Role::Assistant { "assistant" } else { "user" };
        match turns.last_mut() {
            Some((last_role, content)) if *last_role == role => {
                content.push_str("\n\n");
                content.push_str(&message.content);
            }
            _ => turns.push((role, message.content.clone())),
        }
    }
    let mut body = json!({
        "model": opts.model,
        "max_tokens": opts.max_tokens,
        "temperature": opts.temperature,
        "stream": true,
        "messages": turns
            .iter()
            .map(|(role, content)| json!({"role": role, "content": content}))
            .collect::<Vec<_>>(),
    });
    if !system.is_empty() {
        body["system"] = json!(system.join("\n\n"));
    }
    body
}

/// Maps an Anthropic error type to its documented HTTP status code.
fn error_status(kind: &str) -> u16 {
    match kind {
        "invalid_request_error" => 400,
        "authentication_error" => 401,
        "permission_error" => 403,
        "not_found_error" => 404,
        "request_too_large" => 413,
        "rate_limit_error" => 429,
        "overloaded_error" => 529,
        _ => 500,
    }
}

/// Streams a reply from `{base_url}/v1/messages`, calling `on_delta` with each text fragment.
pub async fn stream_chat(
    base_url: &str,
    api_key: &str,
    messages: &[ChatMessage],
    opts: &ChatOptions,
    cancel: CancellationToken,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<(), LlmError> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(LlmError::Config("Anthropic API key is not set".into()));
    }
    let request = sse::streaming_client()?
        .post(format!("{}/v1/messages", sse::trim_base(base_url)))
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .json(&build_body(messages, opts));
    let response = sse::send(request, &cancel).await?;

    let end = sse::for_each_event(response.bytes_stream(), &cancel, |event| {
        if event.data.trim().is_empty() {
            return Ok(Flow::Continue);
        }
        let value: Value = serde_json::from_str(&event.data)
            .map_err(|e| LlmError::Protocol(format!("invalid JSON in stream: {e}")))?;
        let kind = value["type"].as_str().or(event.event.as_deref()).unwrap_or_default();
        match kind {
            "content_block_delta" => {
                if value["delta"]["type"] == "text_delta"
                    && let Some(text) = value["delta"]["text"].as_str()
                    && !text.is_empty()
                {
                    on_delta(text);
                }
                Ok(Flow::Continue)
            }
            "message_stop" => Ok(Flow::Stop),
            "error" => Err(LlmError::Http {
                status: error_status(value["error"]["type"].as_str().unwrap_or_default()),
                message: sse::extract_error_message(&value).unwrap_or_else(|| "stream error".into()),
            }),
            _ => Ok(Flow::Continue),
        }
    })
    .await?;

    match end {
        StreamEnd::Stopped => Ok(()),
        StreamEnd::Eof => Err(LlmError::Protocol("stream ended before message_stop".into())),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    use super::*;
    use crate::llm::sse::test_support::{chunked_server, split_bytes};

    const KEY: &str = "sk-ant-test-placeholder";

    fn msgs() -> Vec<ChatMessage> {
        vec![
            ChatMessage { role: Role::System, content: "be brief".into() },
            ChatMessage { role: Role::System, content: "be kind".into() },
            ChatMessage { role: Role::User, content: "hi".into() },
            ChatMessage { role: Role::User, content: "there".into() },
        ]
    }

    fn opts() -> ChatOptions {
        ChatOptions { model: "claude-test".into(), temperature: 0.3, max_tokens: 100 }
    }

    fn ev(name: &str, data: Value) -> String {
        format!("event: {name}\ndata: {data}\n\n")
    }

    fn happy_body() -> String {
        [
            ev("message_start", json!({"type":"message_start","message":{"id":"msg_1","content":[]}})),
            ev("content_block_start", json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})),
            ev("ping", json!({"type":"ping"})),
            ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}})),
            ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}})),
            ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo ✨"}})),
            ev("content_block_stop", json!({"type":"content_block_stop","index":0})),
            ev("message_delta", json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}})),
            ev("message_stop", json!({"type":"message_stop"})),
        ]
        .concat()
    }

    async fn run(base: &str, cancel: CancellationToken) -> (Result<(), LlmError>, String) {
        let mut out = String::new();
        let mut cb = |t: &str| out.push_str(t);
        let result = stream_chat(base, KEY, &msgs(), &opts(), cancel, &mut cb).await;
        (result, out)
    }

    #[tokio::test]
    async fn streams_text_deltas_with_headers_and_system() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", KEY))
            .and(header("anthropic-version", "2023-06-01"))
            .and(body_partial_json(json!({
                "model": "claude-test",
                "max_tokens": 100,
                "stream": true,
                "system": "be brief\n\nbe kind",
                "messages": [{"role": "user", "content": "hi\n\nthere"}]
            })))
            .respond_with(|req: &Request| {
                assert!(!req.headers.contains_key("authorization"));
                ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(happy_body())
            })
            .expect(1)
            .mount(&server)
            .await;
        let (result, out) = run(&format!("{}/", server.uri()), CancellationToken::new()).await;
        result.unwrap();
        assert_eq!(out, "Hello ✨");
    }

    #[tokio::test]
    async fn handles_events_split_across_network_chunks() {
        let body = happy_body().replace('\n', "\r\n");
        let base = chunked_server(split_bytes(&body, &[5, 50, 3, 120, 1, 1, 77, 200, 9, 64, 33]), false).await;
        let (result, out) = run(&base, CancellationToken::new()).await;
        result.unwrap();
        assert_eq!(out, "Hello ✨");
    }

    #[tokio::test]
    async fn maps_http_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "type": "error",
                "error": {"type": "authentication_error", "message": "invalid x-api-key"}
            })))
            .mount(&server)
            .await;
        let (result, _) = run(&server.uri(), CancellationToken::new()).await;
        match result {
            Err(LlmError::Http { status, message }) => {
                assert_eq!(status, 401);
                assert_eq!(message, "invalid x-api-key");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn surfaces_error_events() {
        let server = MockServer::start().await;
        let body = [
            ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}})),
            ev("error", json!({"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}})),
        ]
        .concat();
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(body))
            .mount(&server)
            .await;
        let (result, out) = run(&server.uri(), CancellationToken::new()).await;
        assert!(matches!(result, Err(LlmError::Http { status: 529, ref message }) if message == "Overloaded"));
        assert_eq!(out, "a");
    }

    #[tokio::test]
    async fn missing_message_stop_is_protocol_error() {
        let server = MockServer::start().await;
        let body = ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}));
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(&server)
            .await;
        let (result, _) = run(&server.uri(), CancellationToken::new()).await;
        assert!(matches!(result, Err(LlmError::Protocol(_))));
    }

    #[tokio::test]
    async fn rejects_blank_key_without_request() {
        let mut cb = |_: &str| {};
        let result = stream_chat("http://127.0.0.1:9", "  ", &msgs(), &opts(), CancellationToken::new(), &mut cb).await;
        assert!(matches!(result, Err(LlmError::Config(_))));
    }

    #[tokio::test]
    async fn cancels_while_waiting_for_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string(happy_body()).set_delay(Duration::from_secs(10)))
            .mount(&server)
            .await;
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            trigger.cancel();
        });
        let started = Instant::now();
        let (result, _) = run(&server.uri(), cancel).await;
        assert!(matches!(result, Err(LlmError::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn cancels_mid_stream() {
        let first = ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}));
        let base = chunked_server(vec![first.into_bytes()], true).await;
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let mut out = Vec::new();
        let mut cb = |t: &str| {
            out.push(t.to_string());
            trigger.cancel();
        };
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            stream_chat(&base, KEY, &msgs(), &opts(), cancel, &mut cb),
        )
        .await
        .expect("cancellation should be prompt");
        assert!(matches!(result, Err(LlmError::Cancelled)));
        assert_eq!(out, ["first"]);
    }

    #[tokio::test]
    #[ignore]
    async fn live_anthropic() {
        let Ok(key) = std::env::var("ANTHROPIC_API_KEY") else { return };
        let model = std::env::var("ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-haiku-4-5".into());
        let messages = vec![ChatMessage { role: Role::User, content: "Say hello in three words.".into() }];
        let options = ChatOptions { model, temperature: 0.2, max_tokens: 32 };
        let mut out = String::new();
        let mut cb = |t: &str| out.push_str(t);
        stream_chat("https://api.anthropic.com", &key, &messages, &options, CancellationToken::new(), &mut cb)
            .await
            .unwrap();
        assert!(!out.trim().is_empty());
    }
}
