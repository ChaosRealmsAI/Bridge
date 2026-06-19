use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::agent_session_history::{
    list_claude_sessions_with_fallback, list_codex_sessions_with_fallback,
    show_claude_session_with_fallback, show_codex_session_with_fallback,
};
use crate::agent_session_parse::{
    provider_metadata_with_history, session_value_belongs_to_project,
};
use crate::agent_source::{
    run_agent_source_turn, run_agent_source_turn_with_progress, AgentSourceTurnRequest,
    AgentSourceTurnSuccess,
};
use crate::codex_app_server::{interrupt_codex_app_server_turn, read_codex_app_server_thread};
use crate::{validate_project_dir, Agent, ChatMode};

pub const AGENT_SESSION_INTERFACE_VERSION: &str = "agent-session.v1";

#[derive(Debug, Clone)]
pub struct AgentSessionListRequest {
    pub source: Agent,
    pub project: PathBuf,
    pub limit: usize,
}

#[derive(Debug, Clone)]
pub struct AgentSessionShowRequest {
    pub source: Agent,
    pub project: PathBuf,
    pub session_id: String,
    pub cursor: usize,
    pub limit: usize,
    pub latest: bool,
}

#[derive(Debug, Clone)]
pub struct AgentSessionTurnRequest {
    pub source: Agent,
    pub project: PathBuf,
    pub session_id: Option<String>,
    pub prompt: String,
    pub model: Option<String>,
    pub mode: ChatMode,
    pub options: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct AgentTurnInterruptRequest {
    pub source: Agent,
    pub project: PathBuf,
    pub session_id: String,
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionListSuccess {
    pub ok: bool,
    pub interface_version: &'static str,
    pub source: Agent,
    pub project: String,
    pub sessions: Vec<AgentSessionSummary>,
    pub provider: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionShowSuccess {
    pub ok: bool,
    pub interface_version: &'static str,
    pub source: Agent,
    pub project: String,
    pub summary: AgentSessionSummary,
    pub cursor: usize,
    pub next_cursor: Option<usize>,
    pub prev_cursor: Option<usize>,
    pub end_of_history: bool,
    pub total_messages: usize,
    pub order: &'static str,
    pub scanned: usize,
    pub valid: usize,
    pub skipped: usize,
    pub messages: Vec<AgentSessionMessage>,
    pub provider: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionTurnSuccess {
    pub ok: bool,
    pub interface_version: &'static str,
    pub source: Agent,
    pub operation: &'static str,
    pub session_id: String,
    pub provider: Value,
    pub turn: AgentSourceTurnSuccess,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentTurnInterruptSuccess {
    pub ok: bool,
    pub interface_version: &'static str,
    pub source: Agent,
    pub project: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub status: String,
    pub provider: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_result: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionSummary {
    pub id: String,
    pub source: Agent,
    pub project: String,
    pub title: String,
    pub started_at: String,
    pub last_activity: String,
    pub running: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    pub last_message_preview: String,
    pub provider: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionMessage {
    pub id: String,
    pub role: String,
    pub ts: String,
    pub blocks: Vec<AgentSessionMessageBlock>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionMessageBlock {
    pub kind: String,
    pub text: String,
}

pub fn list_agent_source_sessions(
    request: AgentSessionListRequest,
) -> Result<AgentSessionListSuccess> {
    let project = validate_project_dir(&request.project)?;
    let limit = request.limit.clamp(1, 200);
    match request.source {
        Agent::Codex => list_codex_sessions_with_fallback(&project, limit),
        Agent::Claude => list_claude_sessions_with_fallback(&project, limit),
    }
}

pub fn show_agent_source_session(
    request: AgentSessionShowRequest,
) -> Result<AgentSessionShowSuccess> {
    let project = validate_project_dir(&request.project)?;
    ensure_session_id(&request.session_id, "source session show")?;
    match request.source {
        Agent::Codex => show_codex_session_with_fallback(
            &project,
            &request.session_id,
            request.cursor,
            request.limit,
            request.latest,
        ),
        Agent::Claude => show_claude_session_with_fallback(
            &project,
            &request.session_id,
            request.cursor,
            request.limit,
            request.latest,
        ),
    }
}

pub fn create_agent_source_session(
    request: AgentSessionTurnRequest,
) -> Result<AgentSessionTurnSuccess> {
    run_session_turn("create", request, None)
}

pub fn create_agent_source_session_with_progress(
    request: AgentSessionTurnRequest,
    progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<AgentSessionTurnSuccess> {
    run_session_turn_with_progress("create", request, None, progress)
}

pub fn continue_agent_source_session(
    request: AgentSessionTurnRequest,
) -> Result<AgentSessionTurnSuccess> {
    let Some(session_id) = request.session_id.clone() else {
        bail!("session_id is required for source session continue");
    };
    ensure_session_id(&session_id, "source session continue")?;
    run_session_turn("continue", request, Some(session_id))
}

pub fn continue_agent_source_session_with_progress(
    request: AgentSessionTurnRequest,
    progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<AgentSessionTurnSuccess> {
    let Some(session_id) = request.session_id.clone() else {
        bail!("session_id is required for source session continue");
    };
    ensure_session_id(&session_id, "source session continue")?;
    run_session_turn_with_progress("continue", request, Some(session_id), progress)
}

pub fn interrupt_agent_source_turn(
    request: AgentTurnInterruptRequest,
) -> Result<AgentTurnInterruptSuccess> {
    let project = validate_project_dir(&request.project)?;
    ensure_session_id(&request.session_id, "source turn interrupt")?;
    match request.source {
        Agent::Codex => interrupt_codex_turn(project, request),
        Agent::Claude => Ok(AgentTurnInterruptSuccess {
            ok: true,
            interface_version: AGENT_SESSION_INTERFACE_VERSION,
            source: Agent::Claude,
            project: project.to_string_lossy().to_string(),
            session_id: request.session_id,
            turn_id: request.turn_id,
            status: "not_running".to_string(),
            provider: provider_metadata_with_history(
                Agent::Claude,
                "claude_agent_sdk_no_persistent_runner",
            ),
            provider_result: Some(json!({
                "reason": "Claude Agent SDK turns are one-shot local runner processes; no persistent in-process runner is active to interrupt."
            })),
        }),
    }
}

fn interrupt_codex_turn(
    project: PathBuf,
    request: AgentTurnInterruptRequest,
) -> Result<AgentTurnInterruptSuccess> {
    let turn_id = request
        .turn_id
        .as_deref()
        .ok_or_else(|| anyhow!("turn_id is required for codex turn interrupt"))?;
    let thread = read_codex_app_server_thread(&project, &request.session_id)?;
    let thread = thread.get("thread").unwrap_or(&thread);
    if !session_value_belongs_to_project(thread, &project) {
        bail!("session not found in project: {}", request.session_id);
    }
    let provider_result = interrupt_codex_app_server_turn(&project, &request.session_id, turn_id)?;
    Ok(AgentTurnInterruptSuccess {
        ok: true,
        interface_version: AGENT_SESSION_INTERFACE_VERSION,
        source: Agent::Codex,
        project: project.to_string_lossy().to_string(),
        session_id: request.session_id,
        turn_id: Some(turn_id.to_string()),
        status: "interrupted".to_string(),
        provider: provider_metadata_with_history(Agent::Codex, "codex_app_server_turn_interrupt"),
        provider_result: Some(provider_result),
    })
}

fn run_session_turn(
    operation: &'static str,
    request: AgentSessionTurnRequest,
    resume: Option<String>,
) -> Result<AgentSessionTurnSuccess> {
    run_session_turn_with_progress(operation, request, resume, None)
}

fn run_session_turn_with_progress(
    operation: &'static str,
    request: AgentSessionTurnRequest,
    resume: Option<String>,
    progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<AgentSessionTurnSuccess> {
    let source = request.source;
    let turn_request = AgentSourceTurnRequest {
        source: request.source,
        project: request.project,
        resume,
        prompt: request.prompt,
        model: request.model,
        mode: request.mode,
        options: request.options,
    };
    let turn = match progress {
        Some(progress) => run_agent_source_turn_with_progress(turn_request, Some(progress))?,
        None => run_agent_source_turn(turn_request)?,
    };
    Ok(AgentSessionTurnSuccess {
        ok: true,
        interface_version: AGENT_SESSION_INTERFACE_VERSION,
        source,
        operation,
        session_id: turn.common.session_id.clone(),
        provider: turn.provider.clone(),
        turn,
    })
}

fn ensure_session_id(session_id: &str, operation: &str) -> Result<()> {
    if session_id.trim().is_empty() {
        bail!("session_id is required for {operation}");
    }
    Ok(())
}
