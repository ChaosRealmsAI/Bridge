use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

mod agent_session;
mod agent_session_history;
mod agent_session_parse;
mod agent_source;
mod agent_source_catalog;
mod claude_agent_sdk;
mod codex_app_server;
mod display;
mod drivers;
mod error;
mod json_text;
mod source_commands;
pub use agent_session::{
    continue_agent_source_session, continue_agent_source_session_with_progress,
    create_agent_source_session, create_agent_source_session_with_progress,
    interrupt_agent_source_turn, list_agent_source_sessions, show_agent_source_session,
    AgentSessionListRequest, AgentSessionListSuccess, AgentSessionShowRequest,
    AgentSessionShowSuccess, AgentSessionSummary, AgentSessionTurnRequest, AgentSessionTurnSuccess,
    AgentTurnInterruptRequest, AgentTurnInterruptSuccess,
};
pub use agent_source::{
    agent_source_capabilities, agent_source_status, list_agent_sources, run_agent_source_turn,
    run_agent_source_turn_with_progress, AgentSourceList, AgentSourceTurnRequest,
    AgentSourceTurnSuccess,
};
pub use agent_source_catalog::{AgentSourceCapability, AgentSourceDescriptor};
use codex_app_server::{find_codex_thread_id_in_events, find_codex_transcript_path_in_events};
use display::{build_chat_display, compact_json, git_status_snapshot};
pub use display::{
    display_blocks_from_event, parse_agent_display_from_jsonl, ChatDisplay, DisplayBlock,
};
use drivers::{run_agent_driver, run_agent_driver_with_progress};
#[cfg(test)]
use error::classify_chat_error;
pub use error::{error_response, ChatError};
use json_text::find_text_by_paths;
pub(crate) use json_text::{
    find_session_id, find_text_by_key, find_transcript_path, get_path, tail_text, text_from_value,
};
pub use source_commands::{
    list_agent_source_commands, run_agent_source_command, AgentCommandCatalog,
    AgentCommandCatalogRequest, AgentCommandRunRequest, AgentCommandRunResult, AgentCommandSpec,
};

pub(crate) const DEFAULT_CODEX_TIMEOUT_MS: u64 = 600_000;
pub(crate) const DEFAULT_CLAUDE_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Codex,
    Claude,
}

impl Agent {
    pub const NAMES: [&'static str; 2] = ["codex", "claude"];
    pub const USAGE: &'static str = "codex|claude";

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            _ => bail!("unsupported agent: {value}"),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatMode {
    Chat,
    Plan,
}

impl ChatMode {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "" | "chat" => Ok(Self::Chat),
            "plan" => Ok(Self::Plan),
            _ => bail!("unsupported chat mode: {value}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub agent: Agent,
    pub project: PathBuf,
    pub resume: Option<String>,
    pub prompt: String,
    pub model: Option<String>,
    pub mode: ChatMode,
    pub sdk_options: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatSuccess {
    pub ok: bool,
    pub agent: Agent,
    pub reply: String,
    pub session_id: String,
    pub resumed: bool,
    pub display: ChatDisplay,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAgentOutput {
    pub reply: String,
    pub session_id: Option<String>,
    pub transcript_path: Option<String>,
}

pub fn send_chat(request: ChatRequest) -> Result<ChatSuccess> {
    send_chat_with_progress(request, None)
}

pub fn send_chat_with_progress(
    request: ChatRequest,
    progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<ChatSuccess> {
    let project = validate_project_dir(&request.project)?;
    let resumed = request.resume.is_some();
    let git_before = git_status_snapshot(&project).ok();
    let output = match progress {
        Some(progress) => run_agent_driver_with_progress(&request, &project, Some(progress))?,
        None => run_agent_driver(&request, &project)?,
    };
    let parsed = output.parsed;
    let git_after = git_status_snapshot(&project).ok();
    let display = build_chat_display(
        request.agent,
        &parsed,
        output.display_events.as_deref(),
        &project,
        git_before.as_ref(),
        git_after.as_ref(),
    );
    let session_id = parsed
        .session_id
        .or_else(|| request.resume.clone())
        .ok_or_else(|| anyhow!("agent output did not include a session_id"))?;

    Ok(ChatSuccess {
        ok: true,
        agent: request.agent,
        reply: parsed.reply,
        session_id,
        resumed,
        display,
        provider_turn_id: output.provider_turn_id,
        transcript_path: parsed.transcript_path,
    })
}

pub fn validate_project_dir(path: &Path) -> Result<PathBuf> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("project does not exist: {}", path.display()))?;
    if !metadata.is_dir() {
        bail!("project is not a directory: {}", path.display());
    }
    fs::canonicalize(path)
        .with_context(|| format!("cannot canonicalize project: {}", path.display()))
}

pub fn parse_codex_json(value: &Value) -> Result<ParsedAgentOutput> {
    let reply = find_text_by_paths(
        value,
        &[
            &["reply"],
            &["last_agent_message"],
            &["output"],
            &["summary", "reply"],
            &["summary", "last_agent_message"],
            &["summary", "output"],
            &["result", "reply"],
            &["result", "last_agent_message"],
            &["result", "output"],
        ],
    )
    .or_else(|| find_text_by_key(value, &["reply", "last_agent_message", "output"]))
    .ok_or_else(|| anyhow!("codex JSON did not include a final reply field"))?;

    Ok(ParsedAgentOutput {
        reply,
        session_id: find_session_id(value),
        transcript_path: find_transcript_path(value),
    })
}

pub fn parse_codex_app_server_events(
    events: &[Value],
    thread_id: Option<String>,
    transcript_path: Option<String>,
) -> Result<ParsedAgentOutput> {
    let mut final_answer = None;
    let mut latest_phase_unknown_message = None;
    let mut deltas: HashMap<String, String> = HashMap::new();
    let mut latest_delta_item = None;
    let mut turn_failure = None;

    for value in events {
        let method = value.get("method").and_then(Value::as_str).unwrap_or("");
        if method == "item/agentMessage/delta" {
            let params = value.get("params").unwrap_or(&Value::Null);
            if let (Some(item_id), Some(delta)) = (
                params.get("itemId").and_then(Value::as_str),
                params.get("delta").and_then(text_from_value),
            ) {
                deltas
                    .entry(item_id.to_string())
                    .or_default()
                    .push_str(&delta);
                latest_delta_item = Some(item_id.to_string());
            }
            continue;
        }

        if method == "item/completed" {
            let item = value.pointer("/params/item").unwrap_or(&Value::Null);
            if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                if let Some(text) = text_from_value(item).filter(|text| !text.trim().is_empty()) {
                    match item.get("phase").and_then(Value::as_str) {
                        Some("final_answer") => final_answer = Some(text),
                        None => latest_phase_unknown_message = Some(text),
                        Some(_) => {}
                    }
                }
            }
            continue;
        }

        if method == "turn/completed" {
            let turn = value.pointer("/params/turn").unwrap_or(&Value::Null);
            let status = turn
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if status != "completed" {
                turn_failure = Some(turn_error_message(turn, status));
            }
        }
    }

    if let Some(message) = turn_failure {
        bail!("{message}");
    }

    let reply = final_answer
        .or_else(|| {
            latest_delta_item
                .as_deref()
                .and_then(|item_id| deltas.get(item_id))
                .cloned()
        })
        .or(latest_phase_unknown_message)
        .filter(|text| !text.trim().is_empty());

    if let Some(reply) = reply {
        return Ok(ParsedAgentOutput {
            reply,
            session_id: thread_id.or_else(|| find_codex_thread_id_in_events(events)),
            transcript_path: transcript_path
                .or_else(|| find_codex_transcript_path_in_events(events)),
        });
    }

    bail!("codex app-server completed without a final agent message")
}

pub(crate) fn turn_error_message(turn: &Value, status: &str) -> String {
    find_text_by_key(turn, &["error", "message", "codexErrorInfo"]).unwrap_or_else(|| {
        format!(
            "Codex turn status: {status}; detail: {}",
            compact_json(turn)
        )
    })
}

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

#[cfg(test)]
pub(crate) use codex_app_server::{
    codex_fatal_notification_message, codex_server_request_error_response,
    codex_thread_request_parts,
};
#[cfg(test)]
pub(crate) use drivers::{agent_driver, AGENT_DRIVERS};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_driver_registry_covers_supported_agents() {
        let registered: Vec<&str> = AGENT_DRIVERS
            .iter()
            .map(|driver| driver.agent.as_str())
            .collect();

        assert_eq!(registered, Agent::NAMES);
        for agent in [Agent::Codex, Agent::Claude] {
            assert!(agent_driver(agent).is_ok());
        }
    }

    #[test]
    fn codex_resume_error_text_maps_to_stable_code() {
        assert_eq!(
            classify_chat_error("no rollout found for thread id 00000000-0000"),
            "resume_not_found"
        );
        assert_eq!(
            classify_chat_error("resume_cold_unavailable: Claude warm session is not running"),
            "resume_cold_unavailable"
        );
    }

    #[test]
    fn wrapped_codex_errors_keep_stable_codes() {
        let empty = anyhow!("codex app-server completed without a final agent message")
            .context("codex app-server stderr tail: noisy stderr");
        assert_eq!(error_response(empty).code, "empty_reply");

        let timeout = anyhow!("timeout waiting for codex app-server")
            .context("codex app-server stderr tail: noisy stderr");
        assert_eq!(error_response(timeout).code, "chat_timeout");

        let auth =
            anyhow!("authentication failed").context("codex app-server stderr tail: noisy stderr");
        assert_eq!(error_response(auth).code, "agent_not_logged_in");

        let auth_wrapped_timeout = anyhow!("authentication failed")
            .context("codex app-server turn did not complete before timeout");
        assert_eq!(
            error_response(auth_wrapped_timeout).code,
            "agent_not_logged_in"
        );
    }

    #[test]
    fn codex_thread_request_uses_start_or_resume_with_never_approval() {
        let mut request = ChatRequest {
            agent: Agent::Codex,
            project: PathBuf::from("."),
            resume: None,
            prompt: "hello".to_string(),
            model: Some("gpt-5".to_string()),
            mode: ChatMode::Chat,
            sdk_options: None,
        };

        let (method, params) =
            codex_thread_request_parts(&request, "/tmp/project").expect("thread params");
        assert_eq!(method, "thread/start");
        assert_eq!(
            params.get("cwd").and_then(Value::as_str),
            Some("/tmp/project")
        );
        assert_eq!(
            params.get("approvalPolicy").and_then(Value::as_str),
            Some("never")
        );
        assert_eq!(params.get("model").and_then(Value::as_str), Some("gpt-5"));
        assert!(params.get("threadId").is_none());

        request.resume = Some("thread-123".to_string());
        let (method, params) =
            codex_thread_request_parts(&request, "/tmp/project").expect("resume params");
        assert_eq!(method, "thread/resume");
        assert_eq!(
            params.get("threadId").and_then(Value::as_str),
            Some("thread-123")
        );
        assert_eq!(
            params.get("approvalPolicy").and_then(Value::as_str),
            Some("never")
        );
    }

    #[test]
    fn codex_server_requests_get_noninteractive_error_response() {
        let response = codex_server_request_error_response(&json!({
            "id": "approval-1",
            "method": "approval/request",
            "params": {"reason": "needs user input"}
        }));

        assert_eq!(
            response.get("id").and_then(Value::as_str),
            Some("approval-1")
        );
        assert_eq!(
            response.pointer("/error/code").and_then(Value::as_i64),
            Some(-32000)
        );
        assert!(response
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("cannot answer interactive"));
    }

    #[test]
    fn codex_top_level_error_notification_is_terminal() {
        let message = codex_fatal_notification_message(&json!({
            "method": "error",
            "params": {"message": "authentication failed"}
        }));

        assert_eq!(message.as_deref(), Some("authentication failed"));
        assert!(codex_fatal_notification_message(&json!({
            "method": "turn/completed",
            "params": {}
        }))
        .is_none());
    }
}
