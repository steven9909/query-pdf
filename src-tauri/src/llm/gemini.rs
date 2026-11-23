//! Google Gemini `streamGenerateContent` streaming client.

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::sse::{self, Flow};
use super::{ChatMessage, ChatOptions, LlmError, Role};

/// Finish reasons that mean the model refused or was stopped by a safety filter.
const BLOCKING_FINISH_REASONS: &[&str] =
    &["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"];

/// Builds the request body, mapping system prompts to `systemInstruction` and assistant turns to role `model`.
fn build_body(messages: &[ChatMessage], opts: &ChatOptions) -> Value {
    let system: Vec<&str> = messages
        .iter()
        .filter(|m| m.role == Role::System && !m.content.trim().is_empty())
        .map(|m| m.content.as_str())
        .collect();
    let mut turns: Vec<(&str, String)> = Vec::new();
    for message in messages.iter().filter(|m| m.role != Role::System) {
        let role = if message.role == Role::Assistant { "model" } else { "user" };
        match turns.last_mut() {
            Some((last_role, content)) if *last_role == role => {
                content.push_str("\n\n");
                content.push_str(&message.content);
            }
            _ => turns.push((role, message.content.clone())),
        }
    }
    let mut body = json!({
        "contents": turns
            .iter()
            .map(|(role, text)| json!({"role": role, "parts": [{"text": text}]}))
            .collect::<Vec<_>>(),
        "generationConfig": {
            "temperature": opts.temperature,
            "maxOutputTokens": opts.max_tokens,
        },
    });
    if !system.is_empty() {
        body["systemInstruction"] = json!({"parts": [{"text": system.join("\n\n")}]});
    }
    body
}

/// Normalises a model id (accepting a `models/` prefix) and rejects characters that would alter the URL.
fn model_path(model: &str) -> Result<&str, LlmError> {
    let model = model.trim();
    let model = model.strip_prefix("models/").unwrap_or(model);
    let valid = !model.is_empty()
        && model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '@'));
    if valid { Ok(model) } else { Err(LlmError::Config(format!("invalid Gemini model name: {model:?}"))) }
}

/// Streams a reply from Gemini's `streamGenerateContent` endpoint, calling `on_delta` with each text part.
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
        return Err(LlmError::Config("Gemini API key is not set".into()));
    }
    let url = format!(
        "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
        sse::trim_base(base_url),
        model_path(&opts.model)?
    );
    let request = sse::streaming_client()?
        .post(url)
        .header("x-goog-api-key", api_key)
        .json(&build_body(messages, opts));
    let response = sse::send(request, &cancel).await?;

    let mut emitted = false;
    let mut blocked: Option<String> = None;
    sse::for_each_event(response.bytes_stream(), &cancel, |event| {
        if event.data.trim().is_empty() {
            return Ok(Flow::Continue);
        }
        let value: Value = serde_json::from_str(&event.data)
            .map_err(|e| LlmError::Protocol(format!("invalid JSON in stream: {e}")))?;
        if value.get("error").is_some() {
            let status = value["error"]["code"].as_u64().and_then(|c| u16::try_from(c).ok()).unwrap_or(500);
            let message = sse::extract_error_message(&value).unwrap_or_else(|| "stream error".into());
            return Err(LlmError::Http { status, message });
        }
        if let Some(reason) = value["promptFeedback"]["blockReason"].as_str() {
            blocked = Some(format!("prompt blocked by Gemini ({reason})"));
        }
        let candidate = &value["candidates"][0];
        if let Some(parts) = candidate["content"]["parts"].as_array() {
            for part in parts {
                if part["thought"].as_bool() == Some(true) {
                    continue;
                }
                if let Some(text) = part["text"].as_str()
                    && !text.is_empty()
                {
                    emitted = true;
                    on_delta(text);
                }
            }
        }
        if let Some(reason) = candidate["finishReason"].as_str()
            && BLOCKING_FINISH_REASONS.contains(&reason)
        {
            blocked = Some(format!("response blocked by Gemini ({reason})"));
        }
        Ok(Flow::Continue)
    })
    .await?;

    match blocked {
        Some(reason) if !emitted => Err(LlmError::Protocol(reason)),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use wiremock::matchers::{body_partial_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    use super::*;
    use crate::llm::sse::test_support::{chunked_server, split_bytes};

    const KEY: &str = "gemini-test-placeholder";

    fn msgs() -> Vec<ChatMessage> {
        vec![
            ChatMessage { role: Role::System, content: "be brief".into() },
            ChatMessage { role: Role::User, content: "hi".into() },
            ChatMessage { role: Role::Assistant, content: "hello".into() },
            ChatMessage { role: Role::User, content: "explain".into() },
        ]
    }

    fn opts() -> ChatOptions {
        ChatOptions { model: "gemini-test".into(), temperature: 0.5, max_tokens: 128 }
    }

    fn chunk(parts: Value, finish: Option<&str>) -> String {
        let mut candidate = json!({"content": {"role": "model", "parts": parts}, "index": 0});
        if let Some(reason) = finish {
            candidate["finishReason"] = json!(reason);
        }
        format!("data: {}\r\n\r\n", json!({"candidates": [candidate]}))
    }

    fn happy_body() -> String {
        [
            chunk(json!([{"text": "thinking", "thought": true}]), None),
            chunk(json!([{"text": "Bon"}, {"text": "jour"}]), None),
            chunk(json!([{"text": " à tous"}]), Some("STOP")),
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
    async fn streams_parts_with_header_key_and_mapped_roles() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1beta/models/gemini-test:streamGenerateContent"))
            .and(query_param("alt", "sse"))
            .and(header("x-goog-api-key", KEY))
            .and(body_partial_json(json!({
                "systemInstruction": {"parts": [{"text": "be brief"}]},
                "contents": [
                    {"role": "user", "parts": [{"text": "hi"}]},
                    {"role": "model", "parts": [{"text": "hello"}]},
                    {"role": "user", "parts": [{"text": "explain"}]}
                ],
                "generationConfig": {"temperature": 0.5, "maxOutputTokens": 128}
            })))
            .respond_with(|req: &Request| {
                assert!(!req.url.as_str().contains(KEY));
                assert!(req.url.query_pairs().all(|(k, _)| k == "alt"));
                ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(happy_body())
            })
            .expect(1)
            .mount(&server)
            .await;
        let (result, out) = run(&format!("{}/", server.uri()), CancellationToken::new()).await;
        result.unwrap();
        assert_eq!(out, "Bonjour à tous");
    }

    #[tokio::test]
    async fn handles_parts_split_across_network_chunks() {
        let body = happy_body();
        let base = chunked_server(split_bytes(&body, &[4, 90, 2, 2, 150, 7, 60, 31]), false).await;
        let (result, out) = run(&base, CancellationToken::new()).await;
        result.unwrap();
        assert_eq!(out, "Bonjour à tous");
    }

    #[tokio::test]
    async fn maps_http_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}
            })))
            .mount(&server)
            .await;
        let (result, _) = run(&server.uri(), CancellationToken::new()).await;
        match result {
            Err(LlmError::Http { status, message }) => {
                assert_eq!(status, 400);
                assert_eq!(message, "API key not valid. Please pass a valid API key.");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn blocked_prompt_is_reported() {
        let server = MockServer::start().await;
        let body = format!("data: {}\n\n", json!({"promptFeedback": {"blockReason": "SAFETY"}}));
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(&server)
            .await;
        let (result, _) = run(&server.uri(), CancellationToken::new()).await;
        assert!(matches!(result, Err(LlmError::Protocol(ref m)) if m.contains("SAFETY")));
    }

    #[tokio::test]
    async fn rejects_bad_model_and_blank_key() {
        let mut cb = |_: &str| {};
        let bad = ChatOptions { model: "x/../y?key=1".into(), ..opts() };
        let result = stream_chat("http://127.0.0.1:9", KEY, &msgs(), &bad, CancellationToken::new(), &mut cb).await;
        assert!(matches!(result, Err(LlmError::Config(_))));
        let result = stream_chat("http://127.0.0.1:9", "", &msgs(), &opts(), CancellationToken::new(), &mut cb).await;
        assert!(matches!(result, Err(LlmError::Config(_))));
        assert_eq!(model_path("models/gemini-2.5-flash").unwrap(), "gemini-2.5-flash");
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
        let base = chunked_server(vec![chunk(json!([{"text": "first"}]), None).into_bytes()], true).await;
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
    async fn live_gemini() {
        let Ok(key) = std::env::var("GEMINI_API_KEY") else { return };
        let model = std::env::var("GEMINI_MODEL").unwrap_or_else(|_| "gemini-2.5-flash".into());
        let messages = vec![ChatMessage { role: Role::User, content: "Say hello in three words.".into() }];
        let options = ChatOptions { model, temperature: 0.2, max_tokens: 256 };
        let mut out = String::new();
        let mut cb = |t: &str| out.push_str(t);
        stream_chat(
            "https://generativelanguage.googleapis.com",
            &key,
            &messages,
            &options,
            CancellationToken::new(),
            &mut cb,
        )
        .await
        .unwrap();
        assert!(!out.trim().is_empty());
    }
}
