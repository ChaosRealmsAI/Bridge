use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

use crate::agent_session::{
    continue_agent_source_session, create_agent_source_session, AgentSessionTurnRequest,
};
use crate::agent_source::{agent_source_status, AGENT_SOURCE_INTERFACE_VERSION};
use crate::agent_source_catalog::{provider_metadata, source_runtime, source_transport};
use crate::codex_app_server::codex_app_server_request;
use crate::error::classify_chat_error;
use crate::{validate_project_dir, Agent, ChatMode};

pub const AGENT_COMMAND_INTERFACE_VERSION: &str = "agent-command.v1";

#[derive(Debug, Clone, Serialize)]
pub struct AgentCommandCatalog {
    pub ok: bool,
    pub interface_version: &'static str,
    pub source: Agent,
    pub project: String,
    pub commands: Vec<AgentCommandSpec>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentCommandSpec {
    pub id: String,
    pub name: String,
    pub slash: String,
    pub label: String,
    pub description: String,
    pub agent: Agent,
    pub provider: String,
    pub source: Agent,
    pub availability: String,
    pub unavailable_reason: String,
    pub send_mode: String,
    pub requires_session: bool,
    pub requires_args: bool,
    pub risk: String,
    pub side_effects: String,
}

#[derive(Debug, Clone)]
pub struct AgentCommandCatalogRequest {
    pub source: Agent,
    pub project: PathBuf,
}

#[derive(Debug, Clone)]
pub struct AgentCommandRunRequest {
    pub source: Agent,
    pub project: PathBuf,
    pub command_id: String,
    pub args: Option<Value>,
    pub prompt: Option<String>,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub mode: ChatMode,
    pub options: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentCommandRunResult {
    pub ok: bool,
    pub interface_version: &'static str,
    pub source: Agent,
    pub project: String,
    pub command: AgentCommandSpec,
    pub status: String,
    pub display_summary: String,
    pub display: Value,
    pub provider: Value,
    pub session_id: String,
    pub resumed: bool,
    pub error: String,
}

pub fn list_agent_source_commands(
    request: AgentCommandCatalogRequest,
) -> Result<AgentCommandCatalog> {
    let project = validate_project_dir(&request.project)?;
    Ok(AgentCommandCatalog {
        ok: true,
        interface_version: AGENT_COMMAND_INTERFACE_VERSION,
        source: request.source,
        project: project.to_string_lossy().to_string(),
        commands: command_names(request.source)
            .iter()
            .map(|name| command_spec(request.source, name))
            .collect(),
    })
}

pub fn run_agent_source_command(request: AgentCommandRunRequest) -> Result<AgentCommandRunResult> {
    let project = validate_project_dir(&request.project)?;
    let command_id = normalize_command_id(&request.command_id);
    let spec = command_spec(request.source, &command_id);
    if spec.availability != "available" {
        return Ok(command_result(
            request.source,
            project.to_string_lossy().to_string(),
            spec,
            false,
            "unsupported",
            "Command is not executable through this Burn interface.",
            provider_for_unsupported(request.source, &command_id),
            "",
            false,
            "unsupported_command",
        ));
    }
    if spec.requires_session
        && request
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Ok(command_result(
            request.source,
            project.to_string_lossy().to_string(),
            spec,
            false,
            "unsupported",
            "Command requires an existing provider session.",
            provider_for_unsupported(request.source, &command_id),
            "",
            false,
            "missing_session",
        ));
    }

    match (request.source, command_id.as_str()) {
        (_, "status") => {
            let status = agent_source_status(request.source, &project)?;
            let provider = json!({
                "method": "burn.agent.source.status",
                "payload": status
            });
            Ok(command_result(
                request.source,
                project.to_string_lossy().to_string(),
                spec,
                true,
                "ok",
                &format!("{} source status read.", request.source.as_str()),
                provider,
                "",
                false,
                "",
            ))
        }
        (Agent::Codex, "model") => {
            let params = codex_model_params(request.args.as_ref());
            let payload = codex_app_server_request(&project, "model/list", params.clone())?;
            let provider = json!({
                "method": "model/list",
                "params": params,
                "payload": payload
            });
            Ok(command_result(
                request.source,
                project.to_string_lossy().to_string(),
                spec,
                true,
                "ok",
                "Codex model/list completed.",
                provider,
                "",
                false,
                "",
            ))
        }
        (Agent::Codex, "skills") => {
            let params = codex_skills_params(&project.to_string_lossy(), request.args.as_ref());
            let payload = codex_app_server_request(&project, "skills/list", params.clone())?;
            let provider = json!({
                "method": "skills/list",
                "params": params,
                "payload": payload
            });
            Ok(command_result(
                request.source,
                project.to_string_lossy().to_string(),
                spec,
                true,
                "ok",
                "Codex skills/list completed.",
                provider,
                "",
                false,
                "",
            ))
        }
        (Agent::Claude, "compact") => run_claude_prompt_command(request, project, spec),
        _ => Ok(command_result(
            request.source,
            project.to_string_lossy().to_string(),
            spec,
            false,
            "unsupported",
            "Command is listed but not executable in this version.",
            provider_for_unsupported(request.source, &command_id),
            "",
            false,
            "unsupported_command",
        )),
    }
}

fn run_claude_prompt_command(
    request: AgentCommandRunRequest,
    project: PathBuf,
    spec: AgentCommandSpec,
) -> Result<AgentCommandRunResult> {
    let command_text = command_prompt_text(
        &request.command_id,
        request.prompt.as_deref(),
        request.args.as_ref(),
    );
    let session_id = request
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let resumed = session_id.is_some();
    let turn_request = AgentSessionTurnRequest {
        source: Agent::Claude,
        project: project.clone(),
        session_id,
        prompt: command_text.clone(),
        model: request.model,
        mode: request.mode,
        options: request.options,
    };
    let turn_result = if resumed {
        continue_agent_source_session(turn_request)
    } else {
        create_agent_source_session(turn_request)
    };
    let turn = match turn_result {
        Ok(turn) => turn,
        Err(error) if classify_chat_error(&format!("{error:#}")) == "empty_reply" => {
            let provider = json!({
                "method": if resumed { "burn.agent.session.continue" } else { "burn.agent.session.create" },
                "prompt_text": command_text,
                "outcome": "empty_reply_accepted",
                "empty_reply_accepted": true,
                "error": format!("{error:#}")
            });
            return Ok(command_result(
                Agent::Claude,
                project.to_string_lossy().to_string(),
                spec,
                true,
                "ok",
                "Claude /compact accepted; no assistant reply returned.",
                provider,
                request.session_id.as_deref().unwrap_or(""),
                resumed,
                "",
            ));
        }
        Err(error) => return Err(error),
    };
    let provider = json!({
        "method": if resumed { "burn.agent.session.continue" } else { "burn.agent.session.create" },
        "prompt_text": command_text,
        "payload": turn
    });
    Ok(command_result(
        Agent::Claude,
        project.to_string_lossy().to_string(),
        spec,
        true,
        "ok",
        "Claude slash command prompt completed.",
        provider,
        &turn.session_id,
        resumed,
        "",
    ))
}

fn command_result(
    source: Agent,
    project: String,
    command: AgentCommandSpec,
    ok: bool,
    status: &str,
    summary: &str,
    provider: Value,
    session_id: &str,
    resumed: bool,
    error: &str,
) -> AgentCommandRunResult {
    let kind = if ok { "tool_result" } else { "error" };
    AgentCommandRunResult {
        ok,
        interface_version: AGENT_COMMAND_INTERFACE_VERSION,
        source,
        project,
        command,
        status: status.to_string(),
        display_summary: summary.to_string(),
        display: json!({
            "version": "chat-command-display.v1",
            "blocks": [{
                "kind": kind,
                "priority": if ok { "normal" } else { "high" },
                "title": "Command result",
                "summary": summary,
                "text": summary,
                "raw_json": provider
            }]
        }),
        provider,
        session_id: session_id.to_string(),
        resumed,
        error: error.to_string(),
    }
}

fn command_names(source: Agent) -> &'static [&'static str] {
    match source {
        Agent::Codex => &[
            "model",
            "approvals",
            "fast",
            "plan",
            "goal",
            "review",
            "diff",
            "compact",
            "new",
            "init",
            "mcp",
            "mention",
            "resume",
            "skills",
            "status",
        ],
        Agent::Claude => &[
            "model", "effort", "fast", "plan", "goal", "review", "compact", "clear", "context",
            "init", "mcp", "memory", "agents", "rewind", "status",
        ],
    }
}

fn command_spec(source: Agent, raw_name: &str) -> AgentCommandSpec {
    let name = normalize_command_id(raw_name);
    let mut availability = "unavailable";
    let mut unavailable_reason =
        "Provider command is visible but not safely executable through Burn in this version.";
    let mut send_mode = "unsupported";
    let mut requires_session = false;
    let requires_args = false;
    let mut risk = "medium";
    let mut side_effects = "provider_control";
    let description = command_description(source, &name);

    if name == "status" {
        availability = "available";
        unavailable_reason = "";
        send_mode = "relayCommand";
        risk = "low";
        side_effects = "read_project_metadata";
    } else if source == Agent::Codex && name == "model" {
        availability = "available";
        unavailable_reason = "";
        send_mode = "codexRpc";
        risk = "low";
        side_effects = "read_models";
    } else if source == Agent::Codex && name == "skills" {
        availability = "available";
        unavailable_reason = "";
        send_mode = "codexRpc";
        risk = "low";
        side_effects = "read_skills";
    } else if source == Agent::Claude && name == "compact" {
        availability = "available";
        unavailable_reason = "";
        send_mode = "promptText";
        requires_session = true;
        risk = "medium";
        side_effects = "provider_context_compaction";
    } else if matches!(
        name.as_str(),
        "fast" | "plan" | "effort" | "approvals" | "model"
    ) {
        unavailable_reason = "Use the fixed chat top controls for this provider option.";
        send_mode = "providerOption";
        risk = "low";
        side_effects = "turn_option";
    } else if matches!(
        name.as_str(),
        "mcp" | "memory" | "agents" | "init" | "clear" | "rewind"
    ) {
        unavailable_reason = "Provider-only or higher-risk command; visible but not executable by Burn in this version.";
        risk = "high";
        side_effects = "provider_configuration_or_context_mutation";
    }

    AgentCommandSpec {
        id: name.clone(),
        name: name.clone(),
        slash: format!("/{name}"),
        label: format!("/{name}"),
        description,
        agent: source,
        provider: source_runtime(source).to_string(),
        source,
        availability: availability.to_string(),
        unavailable_reason: unavailable_reason.to_string(),
        send_mode: send_mode.to_string(),
        requires_session,
        requires_args,
        risk: risk.to_string(),
        side_effects: side_effects.to_string(),
    }
}

fn command_description(source: Agent, name: &str) -> String {
    match (source, name) {
        (_, "status") => "Read local source status without starting a provider turn.",
        (Agent::Codex, "model") => "Read Codex app-server model/list.",
        (Agent::Codex, "skills") => "Read Codex app-server skills/list for this project.",
        (Agent::Claude, "compact") => "Send /compact as a Claude Agent SDK prompt slash command.",
        _ => "Provider command is displayed with availability metadata.",
    }
    .to_string()
}

fn provider_for_unsupported(source: Agent, command_id: &str) -> Value {
    json!({
        "method": "unsupported",
        "command_id": command_id,
        "runtime": source_runtime(source),
        "transport": source_transport(source),
        "provider": provider_metadata(source),
        "interface_version": AGENT_SOURCE_INTERFACE_VERSION
    })
}

fn codex_model_params(args: Option<&Value>) -> Value {
    let Some(Value::Object(map)) = args else {
        return json!({});
    };
    let mut out = Map::new();
    if let Some(limit) = map.get("limit").cloned() {
        out.insert("limit".to_string(), limit);
    }
    out.insert("includeHidden".to_string(), Value::Bool(false));
    Value::Object(out)
}

fn codex_skills_params(project: &str, args: Option<&Value>) -> Value {
    let mut out = match args {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    out.insert("cwds".to_string(), json!([project]));
    out.insert("forceReload".to_string(), Value::Bool(false));
    Value::Object(out)
}

fn command_prompt_text(command_id: &str, prompt: Option<&str>, args: Option<&Value>) -> String {
    let raw = prompt.unwrap_or("").trim();
    if !raw.is_empty() {
        return raw.to_string();
    }
    let command = normalize_command_id(command_id);
    let arg_text = args
        .and_then(|value| value.get("text").and_then(Value::as_str))
        .unwrap_or("")
        .trim();
    if arg_text.is_empty() {
        format!("/{command}")
    } else {
        format!("/{command} {arg_text}")
    }
}

fn normalize_command_id(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('/')
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}
