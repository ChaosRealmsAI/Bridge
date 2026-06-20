use anyhow::{bail, Result};
use burn_chat::{
    agent_source_capabilities, agent_source_status, continue_agent_source_session,
    continue_agent_source_session_with_progress, create_agent_source_session,
    create_agent_source_session_with_progress, display_blocks_from_event,
    interrupt_agent_source_turn, list_agent_source_sessions, list_agent_sources,
    run_agent_source_turn, run_agent_source_turn_with_progress, show_agent_source_session, Agent,
};
use clap::{Arg, Command};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{self, Write};
use std::path::PathBuf;

use crate::source_cli_args::{
    cursor_arg, interrupt_request, json_arg, json_stream_arg, latest_arg, limit_arg, mode_arg,
    model_arg, options_arg, project_arg, prompt_arg, required, session_id_arg,
    session_list_request, session_show_request, session_turn_request, source_arg,
    source_turn_request,
};

pub(crate) fn handle_sources(args: &clap::ArgMatches) -> Result<()> {
    match args.subcommand() {
        Some(("list", _)) => {
            print_json_stdout(&list_agent_sources());
            Ok(())
        }
        _ => bail!("missing sources command"),
    }
}

pub(crate) fn handle_source(args: &clap::ArgMatches) -> Result<()> {
    match args.subcommand() {
        Some(("capabilities", source_args)) => {
            let source = Agent::parse(required(source_args, "source")?.as_str())?;
            print_json_stdout(&agent_source_capabilities(source)?);
            Ok(())
        }
        Some(("status", source_args)) => {
            let source = Agent::parse(required(source_args, "source")?.as_str())?;
            let project = PathBuf::from(required(source_args, "project")?);
            print_json_stdout(&agent_source_status(source, &project)?);
            Ok(())
        }
        Some(("turn", turn_args)) => handle_turn(turn_args),
        Some(("sessions", sessions_args)) => handle_sessions(sessions_args),
        Some(("session", session_args)) => handle_session(session_args),
        _ => bail!("missing source command"),
    }
}

pub(crate) fn sources_cli() -> Command {
    Command::new("sources")
        .about("Inspect registered local agent sources")
        .subcommand(
            Command::new("list")
                .about("List Agent Source descriptors")
                .arg(json_arg()),
        )
}

pub(crate) fn source_cli() -> Command {
    Command::new("source")
        .about("Inspect or run one local agent source")
        .subcommand(capabilities_cli())
        .subcommand(status_cli())
        .subcommand(turn_cli())
        .subcommand(sessions_cli())
        .subcommand(session_cli())
}

fn handle_turn(args: &clap::ArgMatches) -> Result<()> {
    match args.subcommand() {
        Some(("start", start_args)) => {
            let request = source_turn_request(start_args)?;
            if start_args.get_flag("json-stream") {
                let source = request.source;
                let mut progress = progress_printer(source);
                let result = run_agent_source_turn_with_progress(request, Some(&mut progress))?;
                print_json_line(
                    &json!({ "type": "final", "schema": "burn.agent.turn.final.v1", "data": result }),
                );
            } else {
                print_json_stdout(&run_agent_source_turn(request)?);
            }
            Ok(())
        }
        Some(("interrupt", interrupt_args)) => {
            print_json_stdout(&interrupt_agent_source_turn(interrupt_request(
                interrupt_args,
            )?)?);
            Ok(())
        }
        _ => bail!("missing source turn command"),
    }
}

fn handle_sessions(args: &clap::ArgMatches) -> Result<()> {
    match args.subcommand() {
        Some(("list", list_args)) => {
            print_json_stdout(&list_agent_source_sessions(session_list_request(
                list_args,
            )?)?);
            Ok(())
        }
        _ => bail!("missing source sessions command"),
    }
}

fn handle_session(args: &clap::ArgMatches) -> Result<()> {
    match args.subcommand() {
        Some(("show", show_args)) => {
            print_json_stdout(&show_agent_source_session(session_show_request(
                show_args,
            )?)?);
            Ok(())
        }
        Some(("create", create_args)) => {
            let request = session_turn_request(create_args, None)?;
            if create_args.get_flag("json-stream") {
                let source = request.source;
                let mut progress = progress_printer(source);
                let result =
                    create_agent_source_session_with_progress(request, Some(&mut progress))?;
                print_json_line(
                    &json!({ "type": "final", "schema": "burn.agent.turn.final.v1", "data": result }),
                );
            } else {
                print_json_stdout(&create_agent_source_session(request)?);
            }
            Ok(())
        }
        Some(("continue", continue_args)) => {
            let session_id = required(continue_args, "session-id")?;
            let request = session_turn_request(continue_args, Some(session_id))?;
            if continue_args.get_flag("json-stream") {
                let source = request.source;
                let mut progress = progress_printer(source);
                let result =
                    continue_agent_source_session_with_progress(request, Some(&mut progress))?;
                print_json_line(
                    &json!({ "type": "final", "schema": "burn.agent.turn.final.v1", "data": result }),
                );
            } else {
                print_json_stdout(&continue_agent_source_session(request)?);
            }
            Ok(())
        }
        _ => bail!("missing source session command"),
    }
}

fn capabilities_cli() -> Command {
    Command::new("capabilities")
        .about("Print one source capability descriptor")
        .arg(source_arg())
        .arg(json_arg())
}

fn status_cli() -> Command {
    Command::new("status")
        .about("Read local source status without starting a turn")
        .arg(source_arg())
        .arg(project_arg())
        .arg(json_arg())
}

fn turn_cli() -> Command {
    Command::new("turn")
        .about("Operate source turns")
        .subcommand(turn_start_cli())
        .subcommand(
            Command::new("interrupt")
                .about("Interrupt one provider turn when supported")
                .arg(source_arg())
                .arg(project_arg())
                .arg(session_id_arg())
                .arg(Arg::new("turn-id").long("turn-id").value_name("turn_id"))
                .arg(json_arg()),
        )
}

fn turn_start_cli() -> Command {
    Command::new("start")
        .about("Start or resume one source turn")
        .arg(source_arg())
        .arg(project_arg())
        .arg(Arg::new("resume").long("resume").value_name("session_id"))
        .arg(prompt_arg())
        .arg(model_arg())
        .arg(mode_arg())
        .arg(options_arg())
        .arg(json_stream_arg())
        .arg(json_arg())
}

fn sessions_cli() -> Command {
    Command::new("sessions")
        .about("Discover source sessions")
        .subcommand(
            Command::new("list")
                .about("List sessions for one source and project")
                .arg(source_arg())
                .arg(project_arg())
                .arg(limit_arg())
                .arg(json_arg()),
        )
}

fn session_cli() -> Command {
    Command::new("session")
        .about("Read or operate one source session")
        .subcommand(
            Command::new("show")
                .about("Read one source session history")
                .arg(source_arg())
                .arg(project_arg())
                .arg(session_id_arg())
                .arg(cursor_arg())
                .arg(limit_arg())
                .arg(latest_arg())
                .arg(json_arg()),
        )
        .subcommand(session_turn_cli(
            "create",
            "Create a new source session",
            false,
        ))
        .subcommand(session_turn_cli(
            "continue",
            "Continue an existing source session",
            true,
        ))
}

fn session_turn_cli(name: &'static str, about: &'static str, needs_session: bool) -> Command {
    let mut command = Command::new(name)
        .about(about)
        .arg(source_arg())
        .arg(project_arg());
    if needs_session {
        command = command.arg(session_id_arg());
    }
    command
        .arg(prompt_arg())
        .arg(model_arg())
        .arg(mode_arg())
        .arg(options_arg())
        .arg(json_stream_arg())
        .arg(json_arg())
}

fn print_json_stdout<T: Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(json) => println!("{json}"),
        Err(err) => println!(r#"{{"ok":false,"error":"failed to encode JSON: {err}"}}"#),
    }
}

fn print_json_line<T: Serialize>(value: &T) {
    match serde_json::to_string(value) {
        Ok(json) => println!("{json}"),
        Err(err) => println!(r#"{{"ok":false,"error":"failed to encode JSON: {err}"}}"#),
    }
    let _ = io::stdout().flush();
}

fn progress_printer(source: Agent) -> impl FnMut(&Value) {
    let mut seq: u64 = 0;
    move |event| {
        let blocks = display_blocks_from_event(source, event);
        let session_id = turn_handle_session_id(event);
        let turn_id = turn_handle_turn_id(event);
        if blocks.is_empty() && session_id.is_some() && turn_id.is_some() {
            seq += 1;
            print_json_line(&json!({
                "ok": true,
                "type": "progress",
                "schema": "burn.agent.turn.event.v1",
                "source": source,
                "seq": seq,
                "status": event_status(event),
                "session_id": session_id,
                "turn_id": turn_id,
                "block": null,
                "raw_json": event,
            }));
            return;
        }
        for block in blocks {
            seq += 1;
            print_json_line(&json!({
                "ok": true,
                "type": "progress",
                "schema": "burn.agent.turn.event.v1",
                "source": source,
                "seq": seq,
                "status": event_status(event),
                "session_id": session_id,
                "turn_id": turn_id,
                "block": block,
                "raw_json": event,
            }));
        }
    }
}

fn event_status(event: &Value) -> &'static str {
    match event.get("method").and_then(Value::as_str) {
        Some("turn/started") => "started",
        Some("turn/completed") => "completed",
        _ => "streaming",
    }
}

fn turn_handle_session_id(event: &Value) -> Option<&str> {
    text_at(
        event,
        &[
            "/params/threadId",
            "/params/turn/threadId",
            "/session_id",
            "/sessionId",
            "/threadId",
        ],
    )
}

fn turn_handle_turn_id(event: &Value) -> Option<&str> {
    text_at(
        event,
        &["/params/turn/id", "/params/turnId", "/turn_id", "/turnId"],
    )
}

fn text_at<'a>(event: &'a Value, paths: &[&str]) -> Option<&'a str> {
    paths
        .iter()
        .filter_map(|path| event.pointer(path).and_then(Value::as_str))
        .find(|text| !text.trim().is_empty())
}
