use anyhow::{bail, Result};
use burn_chat::{error_response, send_chat, Agent, ChatMode, ChatRequest};
use clap::{Arg, ArgAction, Command};
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;
use std::process;

mod source_cli;
mod source_cli_args;

fn main() {
    if let Err(err) = try_main() {
        print_json_stderr(&error_response(err));
        process::exit(1);
    }
}

fn try_main() -> Result<()> {
    let matches = match cli().try_get_matches() {
        Ok(matches) => matches,
        Err(err) if err.kind() == clap::error::ErrorKind::DisplayHelp => {
            print!("{err}");
            return Ok(());
        }
        Err(err) if err.kind() == clap::error::ErrorKind::DisplayVersion => {
            print!("{err}");
            return Ok(());
        }
        Err(err) => bail!(err.to_string()),
    };

    match matches.subcommand() {
        Some(("send", args)) => {
            let request = ChatRequest {
                agent: Agent::parse(required_ref(args, "agent")?)?,
                project: PathBuf::from(required_ref(args, "project")?),
                resume: optional_value(args, "resume"),
                prompt: required(args, "prompt")?,
                model: optional_value(args, "model"),
                mode: ChatMode::parse(optional_value(args, "mode").as_deref().unwrap_or("chat"))?,
                sdk_options: build_sdk_options(args)?,
            };
            print_json_stdout(&send_chat(request)?);
            Ok(())
        }
        Some(("sources", args)) => source_cli::handle_sources(args),
        Some(("source", args)) => source_cli::handle_source(args),
        _ => bail!("missing command"),
    }
}

fn cli() -> Command {
    Command::new("burn-chat")
        .about("Drive local Codex and Claude Code chats")
        .color(clap::ColorChoice::Never)
        .arg_required_else_help(true)
        .subcommand(
            Command::new("send")
                .about("Start or resume an agent chat turn")
                .arg(
                    Arg::new("agent")
                        .long("agent")
                        .required(true)
                        .value_name(Agent::USAGE)
                        .value_parser(Agent::NAMES),
                )
                .arg(
                    Arg::new("project")
                        .long("project")
                        .required(true)
                        .value_name("P"),
                )
                .arg(Arg::new("resume").long("resume").value_name("session_id"))
                .arg(
                    Arg::new("prompt")
                        .long("prompt")
                        .required(true)
                        .value_name("text"),
                )
                .arg(Arg::new("model").long("model").value_name("M"))
                .arg(
                    Arg::new("mode")
                        .long("mode")
                        .value_name("chat|plan")
                        .value_parser(["chat", "plan"])
                        .default_value("chat"),
                )
                .arg(
                    Arg::new("permission-mode")
                        .long("permission-mode")
                        .value_name("M")
                        .value_parser([
                            "default",
                            "acceptEdits",
                            "bypassPermissions",
                            "plan",
                            "dontAsk",
                            "auto",
                        ])
                        .help("Claude Agent SDK permissionMode; backend-only"),
                )
                .arg(
                    Arg::new("sdk-options-json")
                        .long("sdk-options-json")
                        .value_name("JSON")
                        .help("Claude Agent SDK options object; backend-only"),
                )
                .arg(
                    Arg::new("sdk-options-file")
                        .long("sdk-options-file")
                        .value_name("P")
                        .help("Path to a Claude Agent SDK options JSON object; backend-only"),
                )
                .arg(
                    Arg::new("json")
                        .long("json")
                        .action(ArgAction::SetTrue)
                        .help("Emit JSON; send always returns JSON"),
                ),
        )
        .subcommand(source_cli::sources_cli())
        .subcommand(source_cli::source_cli())
}

fn required(matches: &clap::ArgMatches, name: &str) -> Result<String> {
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

fn build_sdk_options(matches: &clap::ArgMatches) -> Result<Option<Value>> {
    let mut options = Map::new();
    if let Some(path) = optional_value(matches, "sdk-options-file") {
        let raw = fs::read_to_string(&path)?;
        merge_sdk_options(&mut options, &raw, &path)?;
    }
    if let Some(raw) = optional_value(matches, "sdk-options-json") {
        merge_sdk_options(&mut options, &raw, "--sdk-options-json")?;
    }
    if let Some(permission_mode) = optional_value(matches, "permission-mode") {
        options.insert("permissionMode".to_string(), Value::String(permission_mode));
    }
    if options.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Object(options)))
    }
}

fn merge_sdk_options(target: &mut Map<String, Value>, raw: &str, label: &str) -> Result<()> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|err| anyhow::anyhow!("invalid Agent SDK options JSON in {label}: {err}"))?;
    let Value::Object(map) = value else {
        bail!("Agent SDK options in {label} must be a JSON object");
    };
    for (key, value) in map {
        target.insert(key, value);
    }
    Ok(())
}

fn print_json_stdout<T: Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(json) => println!("{json}"),
        Err(err) => println!(r#"{{"ok":false,"error":"failed to encode JSON: {err}"}}"#),
    }
}

fn print_json_stderr<T: Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(json) => eprintln!("{json}"),
        Err(err) => eprintln!(r#"{{"ok":false,"error":"failed to encode JSON: {err}"}}"#),
    }
}
