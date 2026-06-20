use crate::model::Counts;
use serde::Serialize;
use serde_json::Value;
use std::fmt;
use std::path::PathBuf;

pub(super) const DEFAULT_LIMIT: usize = 200;
pub(super) const MAX_LIMIT: usize = 1000;

#[derive(Clone, Debug, Serialize)]
pub struct TranscriptResponse {
    pub ok: bool,
    pub session_id: String,
    pub agent: String,
    pub project: Option<String>,
    pub transcript_path: String,
    pub cursor: usize,
    pub messages: Vec<TranscriptMessage>,
    pub next_cursor: Option<usize>,
    pub prev_cursor: Option<usize>,
    pub end_of_history: bool,
    pub total_messages: usize,
    pub order: &'static str,
    pub counts: Counts,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TranscriptMessage {
    pub id: String,
    pub role: String,
    pub ts: Option<String>,
    pub blocks: Vec<MessageBlock>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MessageBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
}

impl MessageBlock {
    pub(super) fn text(text: String, role: &str) -> Self {
        let block_type = if role == "assistant" {
            "markdown"
        } else {
            "text"
        };
        Self::with_text(block_type, text)
    }

    pub(super) fn thinking(text: String) -> Self {
        Self::with_text("thinking", text)
    }

    pub(super) fn html(html: String) -> Self {
        Self {
            block_type: "html".to_owned(),
            text: None,
            html: Some(html),
            name: None,
            input: None,
            output: None,
            ok: None,
        }
    }

    pub(super) fn tool_call(name: String, input: Value) -> Self {
        Self {
            block_type: "tool_call".to_owned(),
            text: None,
            html: None,
            name: Some(name),
            input: Some(input),
            output: None,
            ok: None,
        }
    }

    pub(super) fn tool_result(ok: bool, text: Option<String>, output: Option<Value>) -> Self {
        Self {
            block_type: "tool_result".to_owned(),
            text,
            html: None,
            name: None,
            input: None,
            output,
            ok: Some(ok),
        }
    }

    fn with_text(block_type: &str, text: String) -> Self {
        Self {
            block_type: block_type.to_owned(),
            text: Some(text),
            html: None,
            name: None,
            input: None,
            output: None,
            ok: None,
        }
    }
}

#[derive(Debug)]
pub struct ShowError {
    pub code: &'static str,
    pub error: String,
}

impl ShowError {
    pub(super) fn new(code: &'static str, error: impl Into<String>) -> Self {
        Self {
            code,
            error: error.into(),
        }
    }
}

impl fmt::Display for ShowError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.error)
    }
}

impl std::error::Error for ShowError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SourceKind {
    Codex,
    Claude,
    PandacodeLog,
}

impl SourceKind {
    pub(super) fn agent(self) -> &'static str {
        match self {
            Self::Codex | Self::PandacodeLog => "codex",
            Self::Claude => "claude",
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct TranscriptSource {
    pub(super) kind: SourceKind,
    pub(super) path: PathBuf,
    pub(super) project: Option<String>,
}
