mod support;

use serde_json::Value;
use std::fs;
use std::process::{Command, Output};
use support::{unique_temp_dir, unique_temp_path};

#[test]
fn agent_session_cli_lists_shows_and_interrupts_fake_codex_sessions() {
    let dir = unique_temp_dir("burn-agent-source-codex-sessions");
    fs::create_dir(&dir).expect("create temp project dir");
    let runner = unique_temp_path("burn-fake-codex-sessions.mjs");
    fs::write(
        &runner,
        r#"#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    emit({ id: msg.id, result: { serverInfo: { name: "fake-codex" }, capabilities: {} } });
  } else if (msg.method === "thread/list") {
    emit({ id: msg.id, result: { data: [
      { id: "wrong-list-thread", sessionId: "wrong-list-session", cwd: "/tmp/not-this-project", name: "Wrong listed", preview: "wrong list", status: "completed", createdAt: 9, updatedAt: 21, turns: [], path: "/tmp/wrong-codex-list.jsonl" },
      { id: "codex-list-thread", sessionId: "codex-list-session", cwd: msg.params.cwd, name: "Codex listed", preview: "hello list", status: "completed", createdAt: 10, updatedAt: 20, turns: [], path: "/tmp/codex-list.jsonl" }
    ] } });
  } else if (msg.method === "thread/read") {
    const cwd = msg.params.threadId === "wrong-project-thread" ? "/tmp/not-this-project" : process.cwd();
    emit({ id: msg.id, result: { thread: { id: msg.params.threadId, sessionId: "codex-list-session", cwd, name: "Codex read", preview: "hello read", status: "completed", createdAt: 10, updatedAt: 20, path: "/tmp/codex-read.jsonl", turns: [{ items: [{ id: "u1", type: "userMessage", text: "hi" }, { id: "a1", type: "agentMessage", text: "hello from codex history" }, { id: "a2", type: "agentMessage", text: "second codex history page" }] }] } } });
  } else if (msg.method === "turn/interrupt") {
    emit({ id: msg.id, result: { interrupted: true, threadId: msg.params.threadId, turnId: msg.params.turnId } });
  }
});
"#,
    )
    .expect("write fake codex runner");
    make_executable(&runner);

    let project = dir.to_str().expect("temp dir should be utf8");
    let list_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("BURN_CODEX_BIN", &runner)
            .args([
                "source",
                "sessions",
                "list",
                "--source",
                "codex",
                "--project",
                project,
                "--json",
            ]),
    );
    assert_eq!(
        list_value.pointer("/sessions/0/id").and_then(Value::as_str),
        Some("codex-list-thread")
    );
    assert_eq!(
        list_value
            .get("sessions")
            .and_then(Value::as_array)
            .map(|sessions| sessions.len()),
        Some(1)
    );

    let show_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("BURN_CODEX_BIN", &runner)
            .args([
                "source",
                "session",
                "show",
                "--source",
                "codex",
                "--project",
                project,
                "--session-id",
                "codex-list-thread",
                "--cursor",
                "1",
                "--limit",
                "1",
                "--json",
            ]),
    );
    assert_eq!(
        show_value
            .pointer("/messages/0/blocks/0/text")
            .and_then(Value::as_str),
        Some("hello from codex history")
    );
    assert_eq!(
        show_value.pointer("/cursor").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        show_value.pointer("/next_cursor").and_then(Value::as_u64),
        Some(2)
    );
    assert_eq!(
        show_value.pointer("/scanned").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        show_value.pointer("/valid").and_then(Value::as_u64),
        Some(1)
    );

    let latest_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("BURN_CODEX_BIN", &runner)
            .args([
                "source",
                "session",
                "show",
                "--source",
                "codex",
                "--project",
                project,
                "--session-id",
                "codex-list-thread",
                "--latest",
                "--limit",
                "2",
                "--json",
            ]),
    );
    assert_eq!(
        latest_value.pointer("/order").and_then(Value::as_str),
        Some("latest")
    );
    assert_eq!(
        latest_value.pointer("/cursor").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        latest_value.pointer("/prev_cursor").and_then(Value::as_u64),
        Some(0)
    );
    assert_eq!(
        latest_value
            .pointer("/messages/0/blocks/0/text")
            .and_then(Value::as_str),
        Some("hello from codex history")
    );
    assert_eq!(
        latest_value
            .pointer("/messages/1/blocks/0/text")
            .and_then(Value::as_str),
        Some("second codex history page")
    );
    assert_eq!(
        latest_value
            .pointer("/end_of_history")
            .and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        latest_value
            .pointer("/total_messages")
            .and_then(Value::as_u64),
        Some(3)
    );

    let wrong_project = run_error_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("BURN_CODEX_BIN", &runner)
            .args([
                "source",
                "session",
                "show",
                "--source",
                "codex",
                "--project",
                project,
                "--session-id",
                "wrong-project-thread",
                "--json",
            ]),
    );
    assert_eq!(
        wrong_project.get("code").and_then(Value::as_str),
        Some("resume_not_found")
    );

    let wrong_project_interrupt = run_error_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("BURN_CODEX_BIN", &runner)
            .args([
                "source",
                "turn",
                "interrupt",
                "--source",
                "codex",
                "--project",
                project,
                "--session-id",
                "wrong-project-thread",
                "--turn-id",
                "turn-1",
                "--json",
            ]),
    );
    assert_eq!(
        wrong_project_interrupt.get("code").and_then(Value::as_str),
        Some("resume_not_found")
    );

    let interrupt_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("BURN_CODEX_BIN", &runner)
            .args([
                "source",
                "turn",
                "interrupt",
                "--source",
                "codex",
                "--project",
                project,
                "--session-id",
                "codex-list-thread",
                "--turn-id",
                "turn-1",
                "--json",
            ]),
    );
    let _ = fs::remove_file(&runner);
    let _ = fs::remove_dir_all(&dir);
    assert_eq!(
        interrupt_value.get("status").and_then(Value::as_str),
        Some("interrupted")
    );
}

#[test]
fn agent_session_cli_falls_back_to_monitor_for_codex_history() {
    let home = unique_temp_dir("burn-agent-source-codex-monitor-home");
    let project_dir = home.join("projects").join("codex-history-project");
    fs::create_dir_all(&project_dir).expect("create temp project dir");
    fs::write(
        project_dir.join("Cargo.toml"),
        "[package]\nname = \"fixture\"\n",
    )
    .expect("write project marker");
    let default_transcript = home
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("06")
        .join("20")
        .join("rollout-default-codex-session.jsonl");
    fs::create_dir_all(
        default_transcript
            .parent()
            .expect("default transcript parent"),
    )
    .expect("create default transcript dir");
    let profile_home = home.join(".codex-work");
    let transcript = profile_home
        .join("sessions")
        .join("2026")
        .join("06")
        .join("20")
        .join("rollout-monitor-codex-session.jsonl");
    fs::create_dir_all(transcript.parent().expect("transcript parent"))
        .expect("create transcript dir");
    let project = project_dir.to_str().expect("temp dir should be utf8");
    fs::write(
        &default_transcript,
        &format!(
            r#"{{"type":"session_meta","payload":{{"id":"default-codex-session","cwd":"{project}","timestamp":"2026-06-20T00:00:00Z"}}}}
{{"type":"response_item","payload":{{"item":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"Default history should be ignored when CODEX_HOME is explicit"}}]}}}}}}"#
        ),
    )
    .expect("write default codex transcript");
    fs::write(
        &transcript,
        &format!(
            r#"{{"type":"session_meta","payload":{{"id":"monitor-codex-session","cwd":"{project}","timestamp":"2026-06-20T01:00:00Z"}}}}
{{"type":"response_item","payload":{{"item":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"List raw Codex history"}}]}}}}}}
{{"type":"event_msg","payload":{{"type":"agent_message","message":"Raw Codex history is indexed"}}}}"#
        ),
    )
    .expect("write codex transcript");

    let missing_codex = home.join("missing-codex-bin");
    let list_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("HOME", &home)
            .env("BURN_CODEX_BIN", &missing_codex)
            .env("CODEX_HOME", &profile_home)
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("BURN_AGENT_PROFILE_ID")
            .args([
                "source",
                "sessions",
                "list",
                "--source",
                "codex",
                "--project",
                project,
                "--json",
            ]),
    );
    assert_eq!(
        list_value.pointer("/sessions/0/id").and_then(Value::as_str),
        Some("monitor-codex-session")
    );
    assert_eq!(
        list_value
            .get("sessions")
            .and_then(Value::as_array)
            .map(|sessions| sessions.len()),
        Some(1)
    );
    assert_eq!(
        list_value
            .pointer("/sessions/0/transcript_path")
            .and_then(Value::as_str),
        Some(transcript.to_str().expect("transcript should be utf8"))
    );
    assert_eq!(
        list_value
            .pointer("/provider/history_source")
            .and_then(Value::as_str),
        Some("burn_monitor_transcript_fallback")
    );
    let profile_id_list_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("HOME", &home)
            .env("BURN_CODEX_BIN", &missing_codex)
            .env_remove("CODEX_HOME")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env("BURN_AGENT_PROFILE_ID", "codex:codex-work")
            .args([
                "source",
                "sessions",
                "list",
                "--source",
                "codex",
                "--project",
                project,
                "--json",
            ]),
    );
    assert_eq!(
        profile_id_list_value
            .pointer("/sessions/0/id")
            .and_then(Value::as_str),
        Some("monitor-codex-session")
    );
    assert_eq!(
        profile_id_list_value
            .get("sessions")
            .and_then(Value::as_array)
            .map(|sessions| sessions.len()),
        Some(1)
    );

    let show_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("HOME", &home)
            .env("BURN_CODEX_BIN", &missing_codex)
            .env("CODEX_HOME", &profile_home)
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("BURN_AGENT_PROFILE_ID")
            .args([
                "source",
                "session",
                "show",
                "--source",
                "codex",
                "--project",
                project,
                "--session-id",
                "monitor-codex-session",
                "--json",
            ]),
    );
    let _ = fs::remove_dir_all(&home);
    assert_eq!(
        show_value
            .pointer("/messages/0/blocks/0/text")
            .and_then(Value::as_str),
        Some("List raw Codex history")
    );
    assert_eq!(
        show_value
            .pointer("/messages/1/blocks/0/text")
            .and_then(Value::as_str),
        Some("Raw Codex history is indexed")
    );
}

#[test]
fn agent_session_cli_falls_back_to_monitor_for_claude_configured_history() {
    let home = unique_temp_dir("burn-agent-source-claude-monitor-home");
    let project_dir = home.join("projects").join("claude-history-project");
    fs::create_dir_all(&project_dir).expect("create temp project dir");
    fs::write(
        project_dir.join("Cargo.toml"),
        "[package]\nname = \"fixture\"\n",
    )
    .expect("write project marker");
    let project = project_dir.to_str().expect("temp dir should be utf8");
    let default_transcript = home
        .join(".claude")
        .join("projects")
        .join("default-storage")
        .join("default-claude-session.jsonl");
    fs::create_dir_all(
        default_transcript
            .parent()
            .expect("default transcript parent"),
    )
    .expect("create default transcript dir");
    fs::write(
        &default_transcript,
        &format!(
            r#"{{"type":"user","cwd":"{project}","sessionId":"default-claude-session","timestamp":"2026-06-20T00:00:00Z","message":{{"role":"user","content":[{{"type":"text","text":"Default Claude history should be ignored when CLAUDE_CONFIG_DIR is explicit"}}]}}}}"#
        ),
    )
    .expect("write default claude transcript");

    let config_dir = home.join(".claude-work");
    let transcript = config_dir
        .join("projects")
        .join("work-storage")
        .join("monitor-claude-session.jsonl");
    fs::create_dir_all(transcript.parent().expect("transcript parent"))
        .expect("create transcript dir");
    fs::write(
        &transcript,
        &format!(
            r#"{{"type":"user","cwd":"{project}","sessionId":"monitor-claude-session","timestamp":"2026-06-20T01:00:00Z","message":{{"role":"user","content":[{{"type":"text","text":"List configured Claude history"}}]}}}}
{{"type":"assistant","cwd":"{project}","sessionId":"monitor-claude-session","timestamp":"2026-06-20T01:01:00Z","message":{{"role":"assistant","content":[{{"type":"text","text":"Configured Claude history is indexed"}}]}}}}"#
        ),
    )
    .expect("write claude transcript");

    let missing_runner = home.join("missing-claude-agent-sdk-runner.mjs");
    let list_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("HOME", &home)
            .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &missing_runner)
            .env_remove("CODEX_HOME")
            .env("CLAUDE_CONFIG_DIR", &config_dir)
            .env_remove("BURN_AGENT_PROFILE_ID")
            .args([
                "source",
                "sessions",
                "list",
                "--source",
                "claude",
                "--project",
                project,
                "--json",
            ]),
    );
    assert_eq!(
        list_value.pointer("/sessions/0/id").and_then(Value::as_str),
        Some("monitor-claude-session")
    );
    assert_eq!(
        list_value
            .get("sessions")
            .and_then(Value::as_array)
            .map(|sessions| sessions.len()),
        Some(1)
    );
    assert_eq!(
        list_value
            .pointer("/sessions/0/transcript_path")
            .and_then(Value::as_str),
        Some(transcript.to_str().expect("transcript should be utf8"))
    );

    let profile_id_list_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("HOME", &home)
            .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &missing_runner)
            .env_remove("CODEX_HOME")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env("BURN_AGENT_PROFILE_ID", "claude:claude-work")
            .args([
                "source",
                "sessions",
                "list",
                "--source",
                "claude",
                "--project",
                project,
                "--json",
            ]),
    );
    assert_eq!(
        profile_id_list_value
            .pointer("/sessions/0/id")
            .and_then(Value::as_str),
        Some("monitor-claude-session")
    );
    assert_eq!(
        profile_id_list_value
            .get("sessions")
            .and_then(Value::as_array)
            .map(|sessions| sessions.len()),
        Some(1)
    );

    let show_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("HOME", &home)
            .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &missing_runner)
            .env_remove("CODEX_HOME")
            .env("CLAUDE_CONFIG_DIR", &config_dir)
            .env_remove("BURN_AGENT_PROFILE_ID")
            .args([
                "source",
                "session",
                "show",
                "--source",
                "claude",
                "--project",
                project,
                "--session-id",
                "monitor-claude-session",
                "--json",
            ]),
    );
    let _ = fs::remove_dir_all(&home);
    assert_eq!(
        show_value
            .pointer("/messages/0/blocks/0/text")
            .and_then(Value::as_str),
        Some("List configured Claude history")
    );
    assert_eq!(
        show_value
            .pointer("/messages/1/blocks/0/text")
            .and_then(Value::as_str),
        Some("Configured Claude history is indexed")
    );
}

#[test]
fn agent_session_cli_lists_shows_and_interrupts_fake_claude_sessions() {
    let dir = unique_temp_dir("burn-agent-source-claude-sessions");
    fs::create_dir(&dir).expect("create temp project dir");
    let runner = unique_temp_path("burn-fake-claude-sessions.mjs");
    fs::write(
        &runner,
        r#"
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (request.op === "sessions.list") {
    emit({ type: "burn_result", sessions: [
      { id: "claude-list-session", cwd: request.cwd, title: "Claude listed", status: "history", transcript_path: "/tmp/claude-list.jsonl", preview: "hello claude" },
      { id: "other-project-session", cwd: "/tmp/not-this-project", title: "Wrong project", status: "history", transcript_path: "/tmp/not-this-project/claude.jsonl", preview: "wrong project" },
      { id: "missing-project-locator", title: "Missing locator", status: "history", preview: "no locator" }
    ], history_source: "claude_agent_sdk" });
  } else if (request.op === "session.messages") {
    const cwd = request.session_id === "other-project-session" ? "/tmp/not-this-project" : request.cwd;
    emit({ type: "burn_result", session: { id: request.session_id, cwd, title: "Claude read" }, messages: [{ id: "m1", role: "user", text: "hi" }, { id: "m2", role: "assistant", text: "hello from claude history" }, { id: "m3", role: "assistant", text: "second claude history page" }], history_source: "claude_agent_sdk" });
  } else {
    emit({ type: "burn_error", message: "unexpected op" });
    process.exitCode = 1;
  }
});
"#,
    )
    .expect("write fake claude session runner");

    let project = dir.to_str().expect("temp dir should be utf8");
    let list_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &runner)
            .args([
                "source",
                "sessions",
                "list",
                "--source",
                "claude",
                "--project",
                project,
                "--json",
            ]),
    );
    assert_eq!(
        list_value.pointer("/sessions/0/id").and_then(Value::as_str),
        Some("claude-list-session")
    );
    assert_eq!(
        list_value
            .get("sessions")
            .and_then(Value::as_array)
            .map(|sessions| sessions.len()),
        Some(1)
    );

    let show_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &runner)
            .args([
                "source",
                "session",
                "show",
                "--source",
                "claude",
                "--project",
                project,
                "--session-id",
                "claude-list-session",
                "--json",
            ]),
    );
    assert_eq!(
        show_value
            .pointer("/messages/1/blocks/0/text")
            .and_then(Value::as_str),
        Some("hello from claude history")
    );

    let paged_show_value = run_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &runner)
            .args([
                "source",
                "session",
                "show",
                "--source",
                "claude",
                "--project",
                project,
                "--session-id",
                "claude-list-session",
                "--cursor",
                "1",
                "--limit",
                "1",
                "--json",
            ]),
    );
    assert_eq!(
        paged_show_value
            .pointer("/messages/0/blocks/0/text")
            .and_then(Value::as_str),
        Some("hello from claude history")
    );
    assert_eq!(
        paged_show_value
            .pointer("/next_cursor")
            .and_then(Value::as_u64),
        Some(2)
    );

    let wrong_project = run_error_json(
        Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &runner)
            .args([
                "source",
                "session",
                "show",
                "--source",
                "claude",
                "--project",
                project,
                "--session-id",
                "other-project-session",
                "--json",
            ]),
    );
    assert_eq!(
        wrong_project.get("code").and_then(Value::as_str),
        Some("resume_not_found")
    );

    let interrupt_value = run_json(Command::new(env!("CARGO_BIN_EXE_burn-chat")).args([
        "source",
        "turn",
        "interrupt",
        "--source",
        "claude",
        "--project",
        project,
        "--session-id",
        "claude-list-session",
        "--json",
    ]));
    let _ = fs::remove_file(&runner);
    let _ = fs::remove_dir_all(&dir);
    assert_eq!(
        interrupt_value.get("status").and_then(Value::as_str),
        Some("not_running")
    );
}

fn run_json(command: &mut Command) -> Value {
    let output = command.output().expect("run burn-chat source command");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("stdout JSON")
}

fn run_error_json(command: &mut Command) -> Value {
    let output = command.output().expect("run burn-chat source command");
    assert!(
        !output.status.success(),
        "stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    stderr_json(&output)
}

fn stderr_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stderr).unwrap_or_else(|err| {
        panic!(
            "stderr should be JSON: {err}\n{}",
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[cfg(unix)]
fn make_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path).expect("runner metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).expect("chmod runner");
}

#[cfg(not(unix))]
fn make_executable(_path: &std::path::Path) {}
