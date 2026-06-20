use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::Agent;

#[derive(Debug, Clone, Serialize)]
pub struct AgentSourceDescriptor {
    pub id: &'static str,
    pub agent: Agent,
    pub label: &'static str,
    pub runtime: &'static str,
    pub transport: &'static str,
    pub session_kind: &'static str,
    pub common_capabilities: Vec<AgentSourceCapability>,
    pub provider_extensions: Vec<AgentSourceCapability>,
    pub risk_summary: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSourceCapability {
    pub id: &'static str,
    pub title: &'static str,
    pub namespace: &'static str,
    pub support: &'static str,
    pub status: &'static str,
    pub risk: &'static str,
    pub side_effects: &'static str,
    pub permission_policy: &'static str,
}

type CapRow = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
);

#[rustfmt::skip]
const COMMON_CAPS: &[CapRow] = &[
    ("source.status", "Read local source status", "common", "implemented", "available", "low", "read_project_metadata", "none"),
    ("sessions.list", "List project sessions", "common", "implemented", "available", "low", "read_history", "source_project_authorized"),
    ("session.show", "Read one session history", "common", "implemented", "available", "low", "read_history", "source_project_authorized"),
    ("session.create", "Create a new agent session", "common", "implemented", "available", "medium", "agent_execution", "source_project_authorized"),
    ("session.continue", "Continue an existing agent session", "common", "implemented", "available", "medium", "agent_execution", "source_project_authorized"),
    ("turn.start", "Start or resume one agent turn", "common", "implemented", "available", "medium", "agent_execution", "source_project_authorized"),
    ("turn.interrupt", "Interrupt one running turn where provider supports it", "common", "implemented", "available", "medium", "agent_control", "source_project_authorized"),
    ("session.identity", "Return provider session identity", "common", "implemented", "available", "low", "read_identity", "source_project_authorized"),
    ("events.normalized", "Return normalized display result", "common", "implemented", "available", "low", "read_events", "source_project_authorized"),
    ("events.provider_raw", "Retain provider-native event trail", "common", "implemented", "available", "medium", "read_provider_events", "source_project_authorized"),
];

#[rustfmt::skip]
const CODEX_EXTENSIONS: &[CapRow] = &[
    ("codex.thread.start", "App Server thread/start", "codex", "implemented", "available", "medium", "agent_session_create", "source_project_authorized"),
    ("codex.thread.resume", "App Server thread/resume", "codex", "implemented", "available", "medium", "agent_session_continue", "source_project_authorized"),
    ("codex.turn.start", "App Server turn/start", "codex", "implemented", "available", "medium", "agent_execution", "source_project_authorized"),
    ("codex.turn.interrupt", "App Server turn/interrupt", "codex", "implemented", "available", "medium", "agent_control", "source_project_authorized"),
    ("codex.thread.list", "App Server thread/list", "codex", "implemented", "available", "low", "read_history", "source_project_authorized"),
    ("codex.thread.read", "App Server thread/read", "codex", "implemented", "available", "low", "read_history", "source_project_authorized"),
    ("codex.review.start", "App Server review/start", "codex", "provider_supported", "provider_configurable", "medium", "code_review_execution", "codex.review"),
    ("codex.account.read", "App Server account/read", "codex", "provider_supported", "provider_configurable", "low", "read_account", "codex.account.read"),
    ("codex.model.list", "App Server model/list", "codex", "provider_supported", "provider_configurable", "low", "read_models", "codex.model.list"),
    ("codex.mcp.status", "App Server MCP status/read", "codex", "provider_supported", "provider_configurable", "medium", "read_mcp", "codex.mcp.read"),
    ("codex.fs.writeFile", "App Server fs/writeFile", "codex", "provider_supported", "provider_configurable", "high", "write_files", "codex.fs.write"),
    ("codex.command.exec", "App Server command/exec", "codex", "provider_supported", "provider_configurable", "high", "execute_commands", "codex.command.exec"),
    ("codex.bypass", "App Server bypass/unsandboxed execution", "codex", "provider_supported", "provider_configurable", "high", "unsandboxed_execution", "codex.provider_options"),
    ("codex.config.write", "App Server config write", "codex", "provider_supported", "provider_configurable", "high", "write_config", "codex.config.write"),
    ("codex.plugin.install", "App Server plugin install", "codex", "provider_supported", "provider_configurable", "high", "install_plugins", "codex.plugin.install"),
    ("codex.account.login", "App Server account login/logout", "codex", "provider_supported", "provider_configurable", "high", "account_auth", "codex.account"),
];

#[rustfmt::skip]
const CLAUDE_EXTENSIONS: &[CapRow] = &[
    ("claude.query", "Agent SDK query()", "claude", "implemented", "available", "medium", "agent_execution", "source_project_authorized"),
    ("claude.session.resume", "Agent SDK resume", "claude", "implemented", "available", "medium", "agent_session_continue", "source_project_authorized"),
    ("claude.session.list", "Agent SDK session list", "claude", "implemented_with_fallback", "available", "low", "read_history", "source_project_authorized"),
    ("claude.session.messages", "Agent SDK session messages", "claude", "implemented_with_fallback", "available", "low", "read_history", "source_project_authorized"),
    ("claude.permissions", "Agent SDK permissions", "claude", "provider_supported", "provider_configurable", "high", "permission_policy", "claude.permissions"),
    ("claude.hooks", "Agent SDK hooks", "claude", "provider_supported", "provider_configurable", "high", "run_hooks", "claude.hooks"),
    ("claude.mcp", "Agent SDK MCP servers", "claude", "provider_supported", "provider_configurable", "medium", "mcp_tools", "claude.mcp"),
    ("claude.subagents", "Agent SDK subagents", "claude", "provider_supported", "provider_configurable", "medium", "subagent_execution", "claude.subagents"),
    ("claude.skills", "Agent SDK skills", "claude", "provider_supported", "provider_configurable", "medium", "load_skills", "claude.skills"),
    ("claude.usage", "Agent SDK usage/cost", "claude", "provider_supported", "provider_configurable", "low", "read_usage", "claude.usage.read"),
    ("claude.checkpoint", "Agent SDK file checkpointing", "claude", "provider_supported", "provider_configurable", "high", "file_checkpointing", "claude.checkpoint"),
    ("claude.callback", "Agent SDK callback/custom tool injection", "claude", "provider_supported", "provider_configurable", "high", "custom_tool_callbacks", "claude.callback"),
    ("claude.bypass", "Agent SDK bypass/unsandboxed execution", "claude", "provider_supported", "provider_configurable", "high", "unsandboxed_execution", "claude.provider_options"),
    ("claude.env_path", "Agent SDK env/executable path injection", "claude", "provider_supported", "provider_configurable", "high", "process_environment", "claude.provider_options"),
];

pub fn agent_source_descriptor(source: Agent) -> AgentSourceDescriptor {
    match source {
        Agent::Codex => AgentSourceDescriptor {
            id: "codex",
            agent: Agent::Codex,
            label: "Codex",
            runtime: "codex-app-server",
            transport: "stdio app-server JSON-RPC",
            session_kind: "codex_thread",
            common_capabilities: caps(COMMON_CAPS),
            provider_extensions: caps(CODEX_EXTENSIONS),
            risk_summary: vec![
                "Codex App Server exposes rich client methods; Burn records them under codex.* with risk and provider-native configuration metadata.",
                "High-risk file, command, config, plugin and account operations stay visible as provider capabilities; Burn does not resolve a second grant policy.",
            ],
        },
        Agent::Claude => AgentSourceDescriptor {
            id: "claude",
            agent: Agent::Claude,
            label: "Claude Code",
            runtime: "claude-agent-sdk",
            transport: "local Node runner + @anthropic-ai/claude-agent-sdk query",
            session_kind: "claude_sdk_session",
            common_capabilities: caps(COMMON_CAPS),
            provider_extensions: caps(CLAUDE_EXTENSIONS),
            risk_summary: vec![
                "Claude Agent SDK capabilities stay under claude.*; query/resume/session history are available through Burn backend interfaces.",
                "Callbacks, hooks, custom tools, env/executable path and bypass permissions are provider-native options/config; Burn routes them without a Burn grant resolver.",
            ],
        },
    }
}

pub fn provider_metadata(source: Agent) -> Value {
    let descriptor = agent_source_descriptor(source);
    json!({
        "runtime": descriptor.runtime,
        "transport": descriptor.transport,
        "session_kind": descriptor.session_kind,
        "extension_namespace": match source {
            Agent::Codex => "codex",
            Agent::Claude => "claude",
        }
    })
}

pub fn availability_hint(source: Agent) -> Value {
    match source {
        Agent::Codex => json!({
            "executable": std::env::var("BURN_CODEX_BIN").unwrap_or_else(|_| "codex".to_string()),
            "runtime_probe": "not_invoked_by_status"
        }),
        Agent::Claude => json!({
            "node": std::env::var("BURN_CLAUDE_AGENT_SDK_NODE").unwrap_or_else(|_| "node".to_string()),
            "runner": std::env::var("BURN_CLAUDE_AGENT_SDK_RUNNER").unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("claude-agent-sdk-runner.mjs")
                    .to_string_lossy()
                    .to_string()
            }),
            "runtime_probe": "not_invoked_by_status"
        }),
    }
}

pub fn source_runtime(source: Agent) -> &'static str {
    agent_source_descriptor(source).runtime
}

pub fn source_transport(source: Agent) -> &'static str {
    agent_source_descriptor(source).transport
}

fn caps(rows: &[CapRow]) -> Vec<AgentSourceCapability> {
    rows.iter()
        .map(|row| AgentSourceCapability {
            id: row.0,
            title: row.1,
            namespace: row.2,
            support: row.3,
            status: row.4,
            risk: row.5,
            side_effects: row.6,
            permission_policy: row.7,
        })
        .collect()
}
