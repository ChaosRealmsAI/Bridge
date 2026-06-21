use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use crate::agent_source_catalog::{
    agent_source_descriptor, availability_hint, provider_metadata, source_runtime,
    source_transport, AgentSourceDescriptor,
};
use crate::error::classify_chat_error;
use crate::{
    send_chat, send_chat_with_progress, validate_project_dir, Agent, ChatMode, ChatRequest,
    ChatSuccess,
};

pub const AGENT_SOURCE_INTERFACE_VERSION: &str = "agent-source.v1";

#[derive(Debug, Clone, Serialize)]
pub struct AgentSourceList {
    pub ok: bool,
    pub interface_version: &'static str,
    pub sources: Vec<AgentSourceDescriptor>,
}

#[derive(Debug, Clone)]
pub struct AgentSourceTurnRequest {
    pub source: Agent,
    pub project: PathBuf,
    pub resume: Option<String>,
    pub prompt: String,
    pub model: Option<String>,
    pub mode: ChatMode,
    pub options: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSourceTurnSuccess {
    pub ok: bool,
    pub interface_version: &'static str,
    pub source: Agent,
    pub common: AgentSourceTurnCommon,
    pub provider: Value,
    pub chat: ChatSuccess,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSourceTurnCommon {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    pub resumed: bool,
    pub reply_non_empty: bool,
    pub display_version: String,
}

pub fn list_agent_sources() -> AgentSourceList {
    AgentSourceList {
        ok: true,
        interface_version: AGENT_SOURCE_INTERFACE_VERSION,
        sources: vec![
            agent_source_descriptor(Agent::Codex),
            agent_source_descriptor(Agent::Claude),
        ],
    }
}

pub fn agent_source_capabilities(source: Agent) -> Result<AgentSourceDescriptor> {
    Ok(agent_source_descriptor(source))
}

pub fn agent_source_status(source: Agent, project: &Path) -> Result<Value> {
    let project = validate_project_dir(project)?;
    Ok(serde_json::json!({
        "ok": true,
        "interface_version": AGENT_SOURCE_INTERFACE_VERSION,
        "source": source,
        "project": project,
        "runtime": source_runtime(source),
        "transport": source_transport(source),
        "side_effects": "none",
        "availability_hint": availability_hint(source)
    }))
}

pub fn run_agent_source_turn(request: AgentSourceTurnRequest) -> Result<AgentSourceTurnSuccess> {
    run_agent_source_turn_with_progress(request, None)
}

pub fn run_agent_source_turn_with_progress(
    request: AgentSourceTurnRequest,
    progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<AgentSourceTurnSuccess> {
    let source = request.source;
    let chat_request = ChatRequest {
        agent: source,
        project: request.project,
        resume: request.resume,
        prompt: request.prompt,
        model: request.model,
        mode: request.mode,
        sdk_options: request.options,
    };
    let chat = send_chat_with_resume_retry(chat_request, progress)?;
    Ok(AgentSourceTurnSuccess {
        ok: true,
        interface_version: AGENT_SOURCE_INTERFACE_VERSION,
        source,
        common: AgentSourceTurnCommon {
            session_id: chat.session_id.clone(),
            provider_turn_id: chat.provider_turn_id.clone(),
            resumed: chat.resumed,
            reply_non_empty: !chat.reply.trim().is_empty(),
            display_version: chat.display.version.clone(),
        },
        provider: provider_metadata(source),
        chat,
    })
}

const CODEX_RESUME_RETRY_DELAYS_MS: &[u64] = &[250, 750, 1500];

fn send_chat_with_resume_retry(
    chat_request: ChatRequest,
    progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<ChatSuccess> {
    let should_retry = chat_request.agent == Agent::Codex && chat_request.resume.is_some();
    match progress {
        Some(progress) => {
            for attempt in 0..=CODEX_RESUME_RETRY_DELAYS_MS.len() {
                match send_chat_with_progress(chat_request.clone(), Some(&mut *progress)) {
                    Ok(chat) => return Ok(chat),
                    Err(error)
                        if should_retry
                            && attempt < CODEX_RESUME_RETRY_DELAYS_MS.len()
                            && is_resume_not_found(&error) =>
                    {
                        thread::sleep(Duration::from_millis(CODEX_RESUME_RETRY_DELAYS_MS[attempt]));
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        None => {
            for attempt in 0..=CODEX_RESUME_RETRY_DELAYS_MS.len() {
                match send_chat(chat_request.clone()) {
                    Ok(chat) => return Ok(chat),
                    Err(error)
                        if should_retry
                            && attempt < CODEX_RESUME_RETRY_DELAYS_MS.len()
                            && is_resume_not_found(&error) =>
                    {
                        thread::sleep(Duration::from_millis(CODEX_RESUME_RETRY_DELAYS_MS[attempt]));
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    }
    unreachable!("resume retry loop always returns")
}

fn is_resume_not_found(error: &anyhow::Error) -> bool {
    let display_message = error.to_string();
    let chain_message = format!("{error:#}");
    let classify_text = if chain_message == display_message {
        display_message
    } else {
        format!("{display_message}\n{chain_message}")
    };
    classify_chat_error(&classify_text) == "resume_not_found"
}
