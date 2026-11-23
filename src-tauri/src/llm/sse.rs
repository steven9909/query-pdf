//! Incremental Server-Sent Events parsing plus the HTTP streaming helpers shared by the LLM providers.

use std::time::Duration;

use futures_util::{Stream, StreamExt};
use reqwest::redirect::Policy;
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::LlmError;

/// One dispatched SSE event: its optional `event:` name and its joined `data:` payload.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Incremental SSE parser that accepts arbitrarily split byte chunks (LF, CRLF or CR line endings).
#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
    data: String,
    has_data: bool,
}

impl SseParser {
    /// Creates an empty parser.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds a chunk of bytes and returns every event completed by it.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut start = 0;
        let mut i = 0;
        while i < self.buf.len() {
            let next = match self.buf[i] {
                b'\n' => i + 1,
                b'\r' if i + 1 == self.buf.len() => break,
                b'\r' if self.buf[i + 1] == b'\n' => i + 2,
                b'\r' => i + 1,
                _ => {
                    i += 1;
                    continue;
                }
            };
            let line = String::from_utf8_lossy(&self.buf[start..i]).into_owned();
            if let Some(event) = self.process_line(&line) {
                out.push(event);
            }
            start = next;
            i = next;
        }
        self.buf.drain(..start);
        out
    }

    /// Flushes any unterminated trailing line and pending event at end of stream.
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut out = Vec::new();
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            let line = String::from_utf8_lossy(&rest);
            let line = line.trim_end_matches(['\r', '\n']).to_string();
            if let Some(event) = self.process_line(&line) {
                out.push(event);
            }
        }
        if let Some(event) = self.process_line("") {
            out.push(event);
        }
        out
    }

    /// Applies one complete line to the pending event, returning an event when a blank line dispatches it.
    fn process_line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            let event = self.event.take();
            if !self.has_data {
                return None;
            }
            self.has_data = false;
            return Some(SseEvent { event, data: std::mem::take(&mut self.data) });
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            "event" => self.event = Some(value.to_string()),
            _ => {}
        }
        None
    }
}

/// Signals whether an event handler wants to keep reading the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Continue,
    Stop,
}

/// How an SSE stream finished: the handler asked to stop, or the body ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamEnd {
    Stopped,
    Eof,
}

/// Drives a byte stream through [`SseParser`], calling `handle` per event until it stops, the stream ends, or `cancel` fires.
pub async fn for_each_event<S, B, F>(
    mut stream: S,
    cancel: &CancellationToken,
    mut handle: F,
) -> Result<StreamEnd, LlmError>
where
    S: Stream<Item = Result<B, reqwest::Error>> + Unpin,
    B: AsRef<[u8]>,
    F: FnMut(SseEvent) -> Result<Flow, LlmError>,
{
    let mut parser = SseParser::new();
    loop {
        let item = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(LlmError::Cancelled),
            item = stream.next() => item,
        };
        let done = item.is_none();
        let events = match item {
            Some(Ok(chunk)) => parser.feed(chunk.as_ref()),
            Some(Err(err)) => return Err(network_error(err)),
            None => parser.finish(),
        };
        for event in events {
            if cancel.is_cancelled() {
                return Err(LlmError::Cancelled);
            }
            if handle(event)? == Flow::Stop {
                return Ok(StreamEnd::Stopped);
            }
        }
        if done {
            return Ok(StreamEnd::Eof);
        }
    }
}

/// Builds an HTTP client for long-lived streaming responses that never follows redirects.
pub(crate) fn streaming_client() -> Result<Client, LlmError> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(300))
        .build()
        .map_err(network_error)
}

/// Builds an HTTP client with short timeouts for quick metadata requests that never follows redirects.
pub(crate) fn quick_client(connect: Duration, total: Duration) -> Result<Client, LlmError> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(connect)
        .timeout(total)
        .build()
        .map_err(network_error)
}

/// Sends `request`, aborting on cancellation and mapping non-success statuses to [`LlmError::Http`].
pub(crate) async fn send(request: RequestBuilder, cancel: &CancellationToken) -> Result<Response, LlmError> {
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(LlmError::Cancelled),
        result = request.send() => result.map_err(network_error)?,
    };
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(LlmError::Cancelled),
        body = response.text() => body.unwrap_or_default(),
    };
    Err(LlmError::Http { status: status.as_u16(), message: error_message(status, &body) })
}

/// Maps a transport-level reqwest error to [`LlmError::Network`], including its root causes but never headers.
pub(crate) fn network_error(err: reqwest::Error) -> LlmError {
    let kind = if err.is_timeout() {
        "request timed out"
    } else if err.is_connect() {
        "could not connect"
    } else if err.is_body() || err.is_decode() {
        "connection interrupted"
    } else {
        "request failed"
    };
    let mut detail = err.to_string();
    let mut source = std::error::Error::source(&err);
    while let Some(cause) = source {
        detail.push_str(": ");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    LlmError::Network(format!("{kind} ({detail})"))
}

/// Extracts a human-readable error message from a provider JSON body, falling back to the raw text or status.
pub(crate) fn error_message(status: StatusCode, body: &str) -> String {
    if let Some(message) = serde_json::from_str::<Value>(body).ok().as_ref().and_then(extract_error_message) {
        return message;
    }
    let trimmed = body.trim();
    if !trimmed.is_empty() && !trimmed.starts_with('<') {
        return trimmed.chars().take(300).collect();
    }
    status.canonical_reason().unwrap_or("request failed").to_string()
}

/// Finds the `error.message`, `error` string or top-level `message` in common provider error shapes.
pub(crate) fn extract_error_message(value: &Value) -> Option<String> {
    if let Some(first) = value.as_array().and_then(|items| items.first()) {
        return extract_error_message(first);
    }
    let error = value.get("error");
    let message = error
        .and_then(Value::as_str)
        .or_else(|| error.and_then(|e| e.get("message")).and_then(Value::as_str))
        .or_else(|| value.get("message").and_then(Value::as_str))?;
    let message = message.trim();
    (!message.is_empty()).then(|| message.to_string())
}

/// Removes trailing slashes from a configured base URL.
pub(crate) fn trim_base(base_url: &str) -> &str {
    base_url.trim().trim_end_matches('/')
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    pub(crate) fn split_bytes(body: &str, sizes: &[usize]) -> Vec<Vec<u8>> {
        let bytes = body.as_bytes();
        let mut out = Vec::new();
        let mut pos = 0;
        for &size in sizes {
            let end = (pos + size).min(bytes.len());
            out.push(bytes[pos..end].to_vec());
            pos = end;
        }
        if pos < bytes.len() {
            out.push(bytes[pos..].to_vec());
        }
        out.retain(|c| !c.is_empty());
        out
    }

    pub(crate) async fn chunked_server(chunks: Vec<Vec<u8>>, hold_open: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            let header_end = loop {
                let n = sock.read(&mut buf).await.unwrap();
                if n == 0 {
                    return;
                }
                req.extend_from_slice(&buf[..n]);
                if let Some(p) = req.windows(4).position(|w| w == b"\r\n\r\n") {
                    break p + 4;
                }
            };
            let head = String::from_utf8_lossy(&req[..header_end]).to_lowercase();
            let content_length = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            while req.len() - header_end < content_length {
                let n = sock.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
            }
            let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
            sock.write_all(head.as_bytes()).await.unwrap();
            for chunk in chunks {
                let mut frame = format!("{:x}\r\n", chunk.len()).into_bytes();
                frame.extend_from_slice(&chunk);
                frame.extend_from_slice(b"\r\n");
                if sock.write_all(&frame).await.is_err() {
                    return;
                }
                let _ = sock.flush().await;
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
            if hold_open {
                tokio::time::sleep(Duration::from_secs(30)).await;
            } else {
                let _ = sock.write_all(b"0\r\n\r\n").await;
                let _ = sock.flush().await;
            }
        });
        format!("http://{addr}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut parser = SseParser::new();
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(parser.feed(chunk));
        }
        out.extend(parser.finish());
        out
    }

    fn data(events: &[SseEvent]) -> Vec<&str> {
        events.iter().map(|e| e.data.as_str()).collect()
    }

    #[test]
    fn parses_simple_events() {
        let events = feed_all(&[b"data: one\n\ndata: two\n\n"]);
        assert_eq!(data(&events), ["one", "two"]);
    }

    #[test]
    fn handles_split_mid_line_and_mid_field() {
        let events = feed_all(&[b"da", b"ta: hel", b"lo\n", b"\ndata", b": world\n\n"]);
        assert_eq!(data(&events), ["hello", "world"]);
    }

    #[test]
    fn handles_every_single_byte_split() {
        let input = b"event: x\r\ndata: {\"a\":1}\r\n\r\ndata: b\r\n\r\n";
        let chunks: Vec<&[u8]> = input.chunks(1).collect();
        let events = feed_all(&chunks);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event.as_deref(), Some("x"));
        assert_eq!(events[0].data, "{\"a\":1}");
        assert_eq!(events[1].event, None);
        assert_eq!(events[1].data, "b");
    }

    #[test]
    fn handles_crlf_split_between_cr_and_lf() {
        let events = feed_all(&[b"data: a\r", b"\n\r", b"\ndata: b\r\n\r\n"]);
        assert_eq!(data(&events), ["a", "b"]);
    }

    #[test]
    fn handles_bare_cr_line_endings() {
        let events = feed_all(&[b"data: a\r\rdata: b\r\r"]);
        assert_eq!(data(&events), ["a", "b"]);
    }

    #[test]
    fn joins_multiline_data() {
        let events = feed_all(&[b"data: line1\ndata: line2\ndata:line3\n\n"]);
        assert_eq!(data(&events), ["line1\nline2\nline3"]);
    }

    #[test]
    fn ignores_comments_and_unknown_fields() {
        let events = feed_all(&[b": keepalive\nid: 7\nretry: 100\ndata: x\n\n: ping\n\n"]);
        assert_eq!(data(&events), ["x"]);
    }

    #[test]
    fn event_without_data_is_not_dispatched() {
        let events = feed_all(&[b"event: ping\n\ndata: y\n\n"]);
        assert_eq!(events, vec![SseEvent { event: None, data: "y".into() }]);
    }

    #[test]
    fn empty_data_field_dispatches_empty_payload() {
        let events = feed_all(&[b"data\n\n"]);
        assert_eq!(data(&events), [""]);
    }

    #[test]
    fn preserves_utf8_split_across_chunks() {
        let text = "data: héllo 🌍\n\n".as_bytes();
        let chunks: Vec<&[u8]> = text.chunks(3).collect();
        let events = feed_all(&chunks);
        assert_eq!(data(&events), ["héllo 🌍"]);
    }

    #[test]
    fn finish_flushes_unterminated_event() {
        let events = feed_all(&[b"data: tail"]);
        assert_eq!(data(&events), ["tail"]);
    }

    #[test]
    fn extracts_error_messages_from_common_shapes() {
        let ok = StatusCode::BAD_REQUEST;
        assert_eq!(error_message(ok, r#"{"error":{"message":"bad model"}}"#), "bad model");
        assert_eq!(error_message(ok, r#"{"error":"model not found"}"#), "model not found");
        assert_eq!(error_message(ok, r#"[{"error":{"code":400,"message":"gem"}}]"#), "gem");
        assert_eq!(error_message(ok, r#"{"message":"top"}"#), "top");
        assert_eq!(error_message(ok, "plain text"), "plain text");
        assert_eq!(error_message(ok, ""), "Bad Request");
        assert_eq!(error_message(ok, "<html>nope</html>"), "Bad Request");
    }

    #[tokio::test]
    async fn for_each_event_stops_and_cancels() {
        let chunks: Vec<Result<Vec<u8>, reqwest::Error>> =
            vec![Ok(b"data: a\n\nda".to_vec()), Ok(b"ta: b\n\ndata: c\n\n".to_vec())];
        let mut seen = Vec::new();
        let end = for_each_event(futures_util::stream::iter(chunks), &CancellationToken::new(), |e| {
            seen.push(e.data.clone());
            Ok(if e.data == "b" { Flow::Stop } else { Flow::Continue })
        })
        .await
        .unwrap();
        assert_eq!(end, StreamEnd::Stopped);
        assert_eq!(seen, ["a", "b"]);

        let cancel = CancellationToken::new();
        cancel.cancel();
        let pending = futures_util::stream::pending::<Result<Vec<u8>, reqwest::Error>>();
        let result = for_each_event(pending, &cancel, |_| Ok(Flow::Continue)).await;
        assert!(matches!(result, Err(LlmError::Cancelled)));
    }

    async fn redirecting_pair() -> (wiremock::MockServer, wiremock::MockServer) {
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let target = MockServer::start().await;
        Mock::given(wiremock::matchers::any())
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&target)
            .await;
        let origin = MockServer::start().await;
        Mock::given(wiremock::matchers::any())
            .respond_with(ResponseTemplate::new(302).insert_header("location", format!("{}/stolen", target.uri())))
            .mount(&origin)
            .await;
        (origin, target)
    }

    #[tokio::test]
    async fn clients_do_not_follow_redirects() {
        let (origin, target) = redirecting_pair().await;
        let clients = [streaming_client().unwrap(), quick_client(Duration::from_secs(2), Duration::from_secs(5)).unwrap()];
        for client in clients {
            let request = client
                .post(format!("{}/v1/chat/completions", origin.uri()))
                .header("x-api-key", "secret-key")
                .bearer_auth("secret-key");
            let err = send(request, &CancellationToken::new()).await.unwrap_err();
            assert!(matches!(err, LlmError::Http { status: 302, .. }), "{err}");
        }
        assert!(target.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn provider_key_never_reaches_redirect_target() {
        use crate::llm::{ChatMessage, ChatOptions, Role, anthropic, gemini, openai_compat};
        let (origin, target) = redirecting_pair().await;
        let messages = [ChatMessage { role: Role::User, content: "hi".into() }];
        let opts = ChatOptions { model: "m".into(), temperature: 0.0, max_tokens: 8 };
        let base = origin.uri();
        let mut sink = |_: &str| {};
        let results = [
            openai_compat::stream_chat(&base, Some("secret-key"), &messages, &opts, CancellationToken::new(), &mut sink).await,
            anthropic::stream_chat(&base, "secret-key", &messages, &opts, CancellationToken::new(), &mut sink).await,
            gemini::stream_chat(&base, "secret-key", &messages, &opts, CancellationToken::new(), &mut sink).await,
        ];
        for result in results {
            assert!(matches!(result, Err(LlmError::Http { status: 302, .. })), "{result:?}");
        }
        assert_eq!(origin.received_requests().await.unwrap().len(), 3);
        assert!(target.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn for_each_event_reports_eof() {
        let chunks: Vec<Result<Vec<u8>, reqwest::Error>> = vec![Ok(b"data: a".to_vec())];
        let mut seen = Vec::new();
        let end = for_each_event(futures_util::stream::iter(chunks), &CancellationToken::new(), |e| {
            seen.push(e.data);
            Ok(Flow::Continue)
        })
        .await
        .unwrap();
        assert_eq!(end, StreamEnd::Eof);
        assert_eq!(seen, ["a"]);
    }
}
