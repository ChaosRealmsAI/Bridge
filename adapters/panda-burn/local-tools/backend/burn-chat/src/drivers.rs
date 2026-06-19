use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::path::Path;

use crate::claude_agent_sdk::run_claude_driver;
use crate::codex_app_server::run_codex_driver;
use crate::{Agent, ChatRequest, ParsedAgentOutput};

#[derive(Debug, Clone)]
pub(crate) struct DriverRun {
    pub(crate) parsed: ParsedAgentOutput,
    pub(crate) display_events: Option<Vec<Value>>,
    pub(crate) provider_turn_id: Option<String>,
}

pub(crate) struct AgentDriver {
    pub(crate) agent: Agent,
    pub(crate) id: &'static str,
}

pub(crate) static AGENT_DRIVERS: &[AgentDriver] = &[
    AgentDriver {
        agent: Agent::Codex,
        id: "codex-app-server",
    },
    AgentDriver {
        agent: Agent::Claude,
        id: "claude-agent-sdk",
    },
];

pub(crate) fn agent_driver(agent: Agent) -> Result<&'static AgentDriver> {
    AGENT_DRIVERS
        .iter()
        .find(|driver| driver.agent == agent)
        .ok_or_else(|| anyhow!("unsupported agent driver: {}", agent.as_str()))
}

pub(crate) fn run_agent_driver(request: &ChatRequest, project: &Path) -> Result<DriverRun> {
    run_agent_driver_with_progress(request, project, None)
}

pub(crate) fn run_agent_driver_with_progress(
    request: &ChatRequest,
    project: &Path,
    progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<DriverRun> {
    let driver = agent_driver(request.agent)?;
    match request.agent {
        Agent::Codex => run_codex_driver(request, project, progress),
        Agent::Claude => run_claude_driver(request, project, progress),
    }
    .with_context(|| format!("{} driver failed", driver.id))
}
