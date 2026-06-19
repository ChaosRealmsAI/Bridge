use anyhow::{bail, Result};
use burn_chat::{
    Agent, AgentSessionListRequest, AgentSessionShowRequest, AgentSessionTurnRequest,
    AgentSourceTurnRequest, AgentTurnInterruptRequest, ChatMode,
};
use clap::{Arg, ArgAction};
use serde_json::Value;
use std::path::PathBuf;

pub(crate) fn source_turn_request(args: &clap::ArgMatches) -> Result<AgentSourceTurnRequest> {
    Ok(AgentSourceTurnRequest {
        source: Agent::parse(required_ref(args, "source")?)?,
        project: PathBuf::from(required_ref(args, "project")?),
        resume: optional_value(args, "resume"),
        prompt: required(args, "prompt")?,
        model: optional_value(args, "model"),
        mode: ChatMode::parse(optional_value(args, "mode").as_deref().unwrap_or("chat"))?,
        options: source_options(args)?,
    })
}

pub(crate) fn session_list_request(args: &clap::ArgMatches) -> Result<AgentSessionListRequest> {
    Ok(AgentSessionListRequest {
        source: Agent::parse(required_ref(args, "source")?)?,
        project: PathBuf::from(required_ref(args, "project")?),
        limit: usize_value(args, "limit", 50)?,
    })
}

pub(crate) fn session_show_request(args: &clap::ArgMatches) -> Result<AgentSessionShowRequest> {
    Ok(AgentSessionShowRequest {
        source: Agent::parse(required_ref(args, "source")?)?,
        project: PathBuf::from(required_ref(args, "project")?),
        session_id: required(args, "session-id")?,
        cursor: usize_value(args, "cursor", 0)?,
        limit: usize_value(args, "limit", 50)?,
        latest: args.get_flag("latest"),
    })
}

pub(crate) fn session_turn_request(
    args: &clap::ArgMatches,
    session_id: Option<String>,
) -> Result<AgentSessionTurnRequest> {
    Ok(AgentSessionTurnRequest {
        source: Agent::parse(required_ref(args, "source")?)?,
        project: PathBuf::from(required_ref(args, "project")?),
        session_id,
        prompt: required(args, "prompt")?,
        model: optional_value(args, "model"),
        mode: ChatMode::parse(optional_value(args, "mode").as_deref().unwrap_or("chat"))?,
        options: source_options(args)?,
    })
}

pub(crate) fn interrupt_request(args: &clap::ArgMatches) -> Result<AgentTurnInterruptRequest> {
    Ok(AgentTurnInterruptRequest {
        source: Agent::parse(required_ref(args, "source")?)?,
        project: PathBuf::from(required_ref(args, "project")?),
        session_id: required(args, "session-id")?,
        turn_id: optional_value(args, "turn-id"),
    })
}

pub(crate) fn source_arg() -> Arg {
    Arg::new("source")
        .long("source")
        .required(true)
        .value_name(Agent::USAGE)
        .value_parser(Agent::NAMES)
}

pub(crate) fn project_arg() -> Arg {
    Arg::new("project")
        .long("project")
        .required(true)
        .value_name("P")
}

pub(crate) fn session_id_arg() -> Arg {
    Arg::new("session-id")
        .long("session-id")
        .required(true)
        .value_name("session_id")
}

pub(crate) fn prompt_arg() -> Arg {
    Arg::new("prompt")
        .long("prompt")
        .required(true)
        .value_name("text")
}

pub(crate) fn model_arg() -> Arg {
    Arg::new("model").long("model").value_name("M")
}

pub(crate) fn mode_arg() -> Arg {
    Arg::new("mode")
        .long("mode")
        .value_name("chat|plan")
        .value_parser(["chat", "plan"])
        .default_value("chat")
}

pub(crate) fn options_arg() -> Arg {
    Arg::new("options-json")
        .long("options-json")
        .value_name("JSON")
        .help("Backend-only provider options object")
}

pub(crate) fn cursor_arg() -> Arg {
    Arg::new("cursor")
        .long("cursor")
        .value_name("N")
        .default_value("0")
}

pub(crate) fn limit_arg() -> Arg {
    Arg::new("limit")
        .long("limit")
        .value_name("N")
        .default_value("50")
}

pub(crate) fn latest_arg() -> Arg {
    Arg::new("latest")
        .long("latest")
        .action(ArgAction::SetTrue)
        .help("Read the latest page and return prev_cursor for loading older history")
}

pub(crate) fn json_arg() -> Arg {
    Arg::new("json")
        .long("json")
        .action(ArgAction::SetTrue)
        .help("Emit JSON; source commands always return JSON")
}

pub(crate) fn json_stream_arg() -> Arg {
    Arg::new("json-stream")
        .long("json-stream")
        .action(ArgAction::SetTrue)
        .help("Emit JSONL progress events and a final JSON line")
}

pub(crate) fn required(matches: &clap::ArgMatches, name: &str) -> Result<String> {
    Ok(required_ref(matches, name)?.to_string())
}

fn required_ref<'a>(matches: &'a clap::ArgMatches, name: &str) -> Result<&'a str> {
    matches
        .get_one::<String>(name)
        .map(String::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing required argument: {name}"))
}

fn optional_value(matches: &clap::ArgMatches, name: &str) -> Option<String> {
    matches.get_one::<String>(name).cloned()
}

fn source_options(matches: &clap::ArgMatches) -> Result<Option<Value>> {
    optional_value(matches, "options-json")
        .map(|raw| parse_json_object(&raw, "--options-json"))
        .transpose()
}

fn usize_value(matches: &clap::ArgMatches, name: &str, fallback: usize) -> Result<usize> {
    let Some(raw) = optional_value(matches, name) else {
        return Ok(fallback);
    };
    raw.parse::<usize>()
        .map_err(|err| anyhow::anyhow!("invalid {name}: {err}"))
}

fn parse_json_object(raw: &str, label: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|err| anyhow::anyhow!("invalid options JSON in {label}: {err}"))?;
    if value.is_object() {
        Ok(value)
    } else {
        bail!("options in {label} must be a JSON object");
    }
}
