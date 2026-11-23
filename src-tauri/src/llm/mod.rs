//! LLM provider abstraction: shared chat types and dispatch to concrete backends.

pub mod anthropic;
pub mod gemini;
pub mod openai_compat;
pub mod sse;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOptions {
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Vendor {
    OpenAI,
    Anthropic,
    Gemini,
    Custom,
}

/// A fully resolved endpoint the dispatcher can call without further lookups.
#[derive(Debug, Clone)]
pub enum Target {
    OpenAiCompatible { base_url: String, api_key: Option<String> },
    Anthropic { base_url: String, api_key: String },
    Gemini { base_url: String, api_key: String },
}

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("network error: {0}")]
    Network(String),
    #[error("provider returned {status}: {message}")]
    Http { status: u16, message: String },
    #[error("malformed response: {0}")]
    Protocol(String),
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Config(String),
}

/// Streams a chat completion from `target`, invoking `on_delta` for each text fragment until done or cancelled.
pub async fn stream_chat(
    target: &Target,
    messages: &[ChatMessage],
    opts: &ChatOptions,
    cancel: CancellationToken,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<(), LlmError> {
    match target {
        Target::OpenAiCompatible { base_url, api_key } => {
            openai_compat::stream_chat(base_url, api_key.as_deref(), messages, opts, cancel, on_delta).await
        }
        Target::Anthropic { base_url, api_key } => {
            anthropic::stream_chat(base_url, api_key, messages, opts, cancel, on_delta).await
        }
        Target::Gemini { base_url, api_key } => {
            gemini::stream_chat(base_url, api_key, messages, opts, cancel, on_delta).await
        }
    }
}
