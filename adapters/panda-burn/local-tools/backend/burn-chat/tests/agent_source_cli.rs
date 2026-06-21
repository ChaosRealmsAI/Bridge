mod support;

use burn_chat::{agent_source_capabilities, list_agent_sources, Agent};
use serde_json::Value;
use std::fs;
use std::process::Command;
use support::{unique_temp_dir, unique_temp_path};

#[test]
fn agent_source_catalog_keeps_common_and_provider_extensions() {
    let sources = list_agent_sources();
    assert_eq!(sources.sources.len(), 2);

    let codex = agent_source_capabilities(Agent::Codex).expect("codex descriptor");
    assert!(codex
        .common_capabilities
        .iter()
        .any(|cap| cap.id == "turn.start" && cap.status == "available"));
    assert!(codex
        .provider_extensions
        .iter()
        .any(|cap| cap.id == "codex.thread.start" && cap.status == "available"));
    assert!(codex
        .provider_extensions
        .iter()
        .any(|cap| cap.id == "codex.command.exec"
            && cap.status == "provider_configurable"
            && cap.risk == "high"
            && cap.permission_policy == "codex.command.exec"));

    let claude = agent_source_capabilities(Agent::Claude).expect("claude descriptor");
    assert!(claude
        .provider_extensions
        .iter()
        .any(|cap| cap.id == "claude.query" && cap.status == "available"));
    assert!(claude
        .provider_extensions
        .iter()
        .any(|cap| cap.id == "claude.callback"
            && cap.status == "provider_configurable"
            && cap.risk == "high"
            && cap.permission_policy == "claude.callback"));
}

#[test]
fn cli_lists_agent_sources() {
    let output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .args(["sources", "list", "--json"])
        .output()
        .expect("run burn-chat sources list");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("stdout JSON");
    assert_eq!(value.get("ok").and_then(Value::as_bool), Some(true));
    let sources = value
        .get("sources")
        .and_then(Value::as_array)
        .expect("sources array");
    assert!(sources
        .iter()
        .any(|source| source.get("id").and_then(Value::as_str) == Some("codex")));
    assert!(sources
        .iter()
        .any(|source| source.get("id").and_then(Value::as_str) == Some("claude")));
}

#[test]
fn agent_source_command_catalog_lists_provider_metadata() {
    // REQ-CHAT-CMD-001 / BDD-CHAT-CMD-001: catalog includes provider command
    // metadata, availability, send mode, and unsupported reasons.
    let dir = unique_temp_dir("burn-agent-source-command-catalog");
    fs::create_dir(&dir).expect("create temp project dir");

    let output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .args([
            "source",
            "commands",
            "list",
            "--source",
            "codex",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--json",
        ])
        .output()
        .expect("run burn-chat source commands list");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("stdout JSON");
    let commands = value
        .get("commands")
        .and_then(Value::as_array)
        .expect("commands array");
    let model = commands
        .iter()
        .find(|command| command.get("id").and_then(Value::as_str) == Some("model"))
        .expect("model command");
    assert_eq!(
        model.get("availability").and_then(Value::as_str),
        Some("available")
    );
    assert_eq!(
        model.get("send_mode").and_then(Value::as_str),
        Some("codexRpc")
    );
    let approvals = commands
        .iter()
        .find(|command| command.get("id").and_then(Value::as_str) == Some("approvals"))
        .expect("approvals command");
    assert_eq!(
        approvals.get("availability").and_then(Value::as_str),
        Some("unavailable")
    );
    assert!(approvals
        .get("unavailable_reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .contains("top controls"));

    let claude_output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .args([
            "source",
            "commands",
            "list",
            "--source",
            "claude",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--json",
        ])
        .output()
        .expect("run burn-chat source commands list for claude");
    let _ = fs::remove_dir_all(&dir);
    assert!(
        claude_output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&claude_output.stderr)
    );
    let claude_value: Value = serde_json::from_slice(&claude_output.stdout).expect("stdout JSON");
    let claude_commands = claude_value
        .get("commands")
        .and_then(Value::as_array)
        .expect("claude commands array");
    let compact = claude_commands
        .iter()
        .find(|command| command.get("id").and_then(Value::as_str) == Some("compact"))
        .expect("compact command");
    assert_eq!(
        compact.get("requires_session").and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn agent_source_command_run_maps_codex_model_and_unsupported() {
    // REQ-CHAT-CMD-002 / BDD-CHAT-CMD-002: Codex command dispatch reaches the
    // app-server method and unsupported commands return structured proof.
    let dir = unique_temp_dir("burn-agent-source-command-codex");
    fs::create_dir(&dir).expect("create temp project dir");
    let canonical_project = fs::canonicalize(&dir).expect("canonical temp project dir");
    let runner = unique_temp_path("burn-fake-codex-command-app-server.mjs");
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
  } else if (msg.method === "model/list") {
    emit({ id: msg.id, result: { models: [{ id: "fake-model" }], params: msg.params || {} } });
  } else if (msg.method === "skills/list") {
    emit({ id: msg.id, result: { skills: [{ name: "fake-skill" }], params: msg.params || {} } });
  }
});
"#,
    )
    .expect("write fake codex runner");
    make_executable(&runner);

    let output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CODEX_BIN", &runner)
        .args([
            "source",
            "command",
            "run",
            "--source",
            "codex",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--command",
            "model",
            "--args",
            r#"{"limit":2,"includeHidden":true}"#,
            "--json",
        ])
        .output()
        .expect("run burn-chat source command run model");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("stdout JSON");
    assert_eq!(value.pointer("/ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        value.pointer("/provider/method").and_then(Value::as_str),
        Some("model/list")
    );
    assert_eq!(
        value
            .pointer("/provider/payload/models/0/id")
            .and_then(Value::as_str),
        Some("fake-model")
    );
    assert_eq!(
        value
            .pointer("/provider/params/limit")
            .and_then(Value::as_i64),
        Some(2)
    );
    assert_eq!(
        value
            .pointer("/provider/params/includeHidden")
            .and_then(Value::as_bool),
        Some(false)
    );

    let skills = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CODEX_BIN", &runner)
        .args([
            "source",
            "command",
            "run",
            "--source",
            "codex",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--command",
            "skills",
            "--args",
            r#"{"cwds":["/tmp/not-this-project"],"forceReload":true}"#,
            "--json",
        ])
        .output()
        .expect("run burn-chat source command run skills");
    assert!(
        skills.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&skills.stderr)
    );
    let skills_value: Value = serde_json::from_slice(&skills.stdout).expect("stdout JSON");
    assert_eq!(
        skills_value
            .pointer("/provider/method")
            .and_then(Value::as_str),
        Some("skills/list")
    );
    assert_eq!(
        skills_value
            .pointer("/provider/params/cwds/0")
            .and_then(Value::as_str),
        Some(
            canonical_project
                .to_str()
                .expect("canonical temp dir should be utf8"),
        )
    );
    assert_eq!(
        skills_value
            .pointer("/provider/params/forceReload")
            .and_then(Value::as_bool),
        Some(false)
    );

    let unsupported = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .args([
            "source",
            "command",
            "run",
            "--source",
            "codex",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--command",
            "approvals",
            "--json",
        ])
        .output()
        .expect("run unsupported codex command");
    let _ = fs::remove_file(&runner);
    let _ = fs::remove_dir_all(&dir);

    assert!(
        unsupported.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&unsupported.stderr)
    );
    let unsupported_value: Value =
        serde_json::from_slice(&unsupported.stdout).expect("stdout JSON");
    assert_eq!(
        unsupported_value.pointer("/ok").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        unsupported_value.pointer("/status").and_then(Value::as_str),
        Some("unsupported")
    );
    assert_eq!(
        unsupported_value.pointer("/error").and_then(Value::as_str),
        Some("unsupported_command")
    );
    assert_eq!(
        unsupported_value
            .pointer("/provider/method")
            .and_then(Value::as_str),
        Some("unsupported")
    );
}

#[test]
fn agent_source_command_run_maps_claude_prompt_slash() {
    // REQ-CHAT-CMD-002 / BDD-CHAT-CMD-002: Claude slash commands run as prompt
    // text through the existing Agent SDK session create/continue route.
    let dir = unique_temp_dir("burn-agent-source-command-claude");
    fs::create_dir(&dir).expect("create temp project dir");
    let runner = unique_temp_path("burn-fake-claude-command-runner.mjs");
    fs::write(
        &runner,
        r#"
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  const session = request.resume || "claude-command-session";
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  emit({ type: "sdk_message", message: { type: "system", subtype: "init", session_id: session } });
  emit({ type: "sdk_message", message: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `ran ${request.prompt}` }] } } });
  emit({ type: "sdk_message", message: { type: "result", subtype: "success", session_id: session, result: `ran ${request.prompt}` } });
  emit({ type: "burn_result", reply: `ran ${request.prompt}`, session_id: session });
});
"#,
    )
    .expect("write fake claude runner");

    let output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &runner)
        .args([
            "source",
            "command",
            "run",
            "--source",
            "claude",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--command",
            "compact",
            "--session-id",
            "claude-command-session",
            "--json",
        ])
        .output()
        .expect("run burn-chat source command run compact");
    let _ = fs::remove_file(&runner);
    let _ = fs::remove_dir_all(&dir);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("stdout JSON");
    assert_eq!(value.pointer("/ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        value.pointer("/provider/method").and_then(Value::as_str),
        Some("burn.agent.session.continue")
    );
    assert_eq!(
        value
            .pointer("/provider/prompt_text")
            .and_then(Value::as_str),
        Some("/compact")
    );
    assert_eq!(
        value.pointer("/session_id").and_then(Value::as_str),
        Some("claude-command-session")
    );
}

#[test]
fn agent_source_command_run_accepts_claude_compact_empty_reply() {
    // REQ-CHAT-CMD-002 / BDD-CHAT-CMD-003: Claude slash command execution
    // must return a visible command result even when /compact does not produce
    // a final assistant message.
    let dir = unique_temp_dir("burn-agent-source-command-claude-empty");
    fs::create_dir(&dir).expect("create temp project dir");
    let runner = unique_temp_path("burn-fake-claude-command-empty-runner.mjs");
    fs::write(
        &runner,
        r#"
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  const session = request.resume || "claude-command-empty-session";
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  emit({ type: "sdk_message", message: { type: "system", subtype: "init", session_id: session } });
  emit({ type: "sdk_message", message: { type: "result", subtype: "success", session_id: session } });
  emit({ type: "burn_result", session_id: session });
});
"#,
    )
    .expect("write fake claude empty runner");

    let output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &runner)
        .args([
            "source",
            "command",
            "run",
            "--source",
            "claude",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--command",
            "compact",
            "--session-id",
            "claude-command-empty-session",
            "--json",
        ])
        .output()
        .expect("run burn-chat source command run compact with empty reply");
    let _ = fs::remove_file(&runner);
    let _ = fs::remove_dir_all(&dir);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("stdout JSON");
    assert_eq!(value.pointer("/ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        value.pointer("/provider/outcome").and_then(Value::as_str),
        Some("empty_reply_accepted")
    );
    assert_eq!(
        value
            .pointer("/display/blocks/0/text")
            .and_then(Value::as_str),
        Some("Claude /compact accepted; no assistant reply returned.")
    );
}

#[test]
fn agent_source_command_run_rejects_claude_compact_without_session() {
    // REQ-CHAT-CMD-003 / BDD-CHAT-CMD-004: /compact is visible in the catalog
    // but must not start a new Claude session when no existing session is open.
    let dir = unique_temp_dir("burn-agent-source-command-claude-no-session");
    fs::create_dir(&dir).expect("create temp project dir");

    let output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .args([
            "source",
            "command",
            "run",
            "--source",
            "claude",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--command",
            "compact",
            "--json",
        ])
        .output()
        .expect("run burn-chat source command run compact without session");
    let _ = fs::remove_dir_all(&dir);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("stdout JSON");
    assert_eq!(value.pointer("/ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        value.pointer("/error").and_then(Value::as_str),
        Some("missing_session")
    );
    assert_eq!(
        value.pointer("/display_summary").and_then(Value::as_str),
        Some("Command requires an existing provider session.")
    );
}

#[test]
fn agent_source_cli_turn_start_runs_fake_codex_app_server() {
    let dir = unique_temp_dir("burn-agent-source-codex");
    fs::create_dir(&dir).expect("create temp project dir");
    let runner = unique_temp_path("burn-fake-codex-app-server.mjs");
    fs::write(
        &runner,
        r#"#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
const failOnceFile = process.env.BURN_FAKE_CODEX_RESUME_FAIL_ONCE_FILE || "";
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    emit({ id: msg.id, result: { serverInfo: { name: "fake-codex" }, capabilities: {} } });
  } else if (msg.method === "thread/resume" && msg.params?.threadId === "codex-flaky-thread" && failOnceFile && !fs.existsSync(failOnceFile)) {
    fs.writeFileSync(failOnceFile, "failed");
    emit({ id: msg.id, error: { code: -32000, message: "resume_not_found: rollout not found yet" } });
  } else if (msg.method === "thread/start" || msg.method === "thread/resume") {
    emit({ id: msg.id, result: { thread: { id: msg.params?.threadId || "codex-source-thread", path: "/tmp/fake-codex-rollout.jsonl" } } });
  } else if (msg.method === "turn/start") {
    emit({ id: msg.id, result: { turn: { id: "turn-source-1", status: "inProgress" } } });
    emit({ method: "item/completed", params: { threadId: msg.params.threadId, item: { type: "agentMessage", text: "source fake ok", phase: "final_answer" } } });
    emit({ method: "turn/completed", params: { threadId: msg.params.threadId, turn: { id: "turn-source-1", status: "completed" } } });
  }
});
"#,
    )
    .expect("write fake codex runner");
    make_executable(&runner);

    let output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CODEX_BIN", &runner)
        .args([
            "source",
            "turn",
            "start",
            "--source",
            "codex",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--prompt",
            "hi",
            "--json",
        ])
        .output()
        .expect("run burn-chat source turn start");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("stdout JSON");
    assert_eq!(value.pointer("/ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        value.pointer("/chat/reply").and_then(Value::as_str),
        Some("source fake ok")
    );
    assert_eq!(
        value.pointer("/common/session_id").and_then(Value::as_str),
        Some("codex-source-thread")
    );
    assert_eq!(
        value.pointer("/provider/runtime").and_then(Value::as_str),
        Some("codex-app-server")
    );

    let create_output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CODEX_BIN", &runner)
        .args([
            "source",
            "session",
            "create",
            "--source",
            "codex",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--prompt",
            "new",
            "--json",
        ])
        .output()
        .expect("run burn-chat source session create");
    assert!(
        create_output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&create_output.stderr)
    );
    let create_value: Value = serde_json::from_slice(&create_output.stdout).expect("stdout JSON");
    assert_eq!(
        create_value.pointer("/operation").and_then(Value::as_str),
        Some("create")
    );

    let continue_output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CODEX_BIN", &runner)
        .args([
            "source",
            "session",
            "continue",
            "--source",
            "codex",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--session-id",
            "codex-existing-thread",
            "--prompt",
            "resume",
            "--json",
        ])
        .output()
        .expect("run burn-chat source session continue");
    assert!(
        continue_output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&continue_output.stderr)
    );
    let continue_value: Value =
        serde_json::from_slice(&continue_output.stdout).expect("stdout JSON");
    assert_eq!(
        continue_value.pointer("/operation").and_then(Value::as_str),
        Some("continue")
    );
    assert_eq!(
        continue_value
            .pointer("/session_id")
            .and_then(Value::as_str),
        Some("codex-existing-thread")
    );

    let flaky_marker = unique_temp_path("burn-fake-codex-resume-fail-once");
    let flaky_continue_output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CODEX_BIN", &runner)
        .env("BURN_FAKE_CODEX_RESUME_FAIL_ONCE_FILE", &flaky_marker)
        .args([
            "source",
            "session",
            "continue",
            "--source",
            "codex",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--session-id",
            "codex-flaky-thread",
            "--prompt",
            "resume after transient not found",
            "--json",
        ])
        .output()
        .expect("run burn-chat source session continue with transient resume_not_found");
    assert!(
        flaky_continue_output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&flaky_continue_output.stderr)
    );
    let flaky_continue_value: Value =
        serde_json::from_slice(&flaky_continue_output.stdout).expect("stdout JSON");
    assert_eq!(
        flaky_continue_value
            .pointer("/session_id")
            .and_then(Value::as_str),
        Some("codex-flaky-thread")
    );
    assert!(flaky_marker.exists());
    let _ = fs::remove_file(&flaky_marker);

    let stream_output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CODEX_BIN", &runner)
        .args([
            "source",
            "session",
            "continue",
            "--source",
            "codex",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--session-id",
            "codex-existing-thread",
            "--prompt",
            "resume stream",
            "--json-stream",
            "--json",
        ])
        .output()
        .expect("run burn-chat source session continue json stream");
    let _ = fs::remove_file(&runner);
    let _ = fs::remove_dir_all(&dir);

    assert!(
        stream_output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&stream_output.stderr)
    );
    let stream_lines: Vec<Value> = String::from_utf8_lossy(&stream_output.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).expect("stream line JSON"))
        .collect();
    let handle_progress = stream_lines
        .iter()
        .find(|value| value.pointer("/turn_id").and_then(Value::as_str) == Some("turn-source-1"))
        .expect("turn_id progress line");
    assert_eq!(
        handle_progress
            .pointer("/session_id")
            .and_then(Value::as_str),
        Some("codex-existing-thread")
    );
    assert_eq!(
        handle_progress
            .pointer("/raw_json/params/turn/id")
            .and_then(Value::as_str),
        Some("turn-source-1")
    );
    assert!(stream_lines
        .iter()
        .any(|value| value.pointer("/schema").and_then(Value::as_str)
            == Some("burn.agent.turn.final.v1")));
}

#[test]
fn agent_source_cli_turn_start_runs_fake_claude_agent_sdk() {
    let dir = unique_temp_dir("burn-agent-source-claude");
    fs::create_dir(&dir).expect("create temp project dir");
    let runner = unique_temp_path("burn-fake-claude-agent-sdk-runner.mjs");
    fs::write(
        &runner,
        r#"
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  const session = request.resume || "claude-source-session";
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  emit({ type: "sdk_message", message: { type: "system", subtype: "init", session_id: session, model: request.sdkOptions?.model || "" } });
  emit({ type: "sdk_message", message: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "claude source fallback" }] } } });
  emit({ type: "sdk_message", message: { type: "result", subtype: "success", session_id: session, result: "claude source ok" } });
  emit({ type: "burn_result", reply: "claude source ok", session_id: session });
});
"#,
    )
    .expect("write fake claude runner");

    let output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &runner)
        .args([
            "source",
            "turn",
            "start",
            "--source",
            "claude",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--prompt",
            "hi",
            "--options-json",
            r#"{"maxTurns":1}"#,
            "--json",
        ])
        .output()
        .expect("run burn-chat source turn start");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("stdout JSON");
    assert_eq!(
        value.pointer("/chat/reply").and_then(Value::as_str),
        Some("claude source ok")
    );
    assert_eq!(
        value.pointer("/common/session_id").and_then(Value::as_str),
        Some("claude-source-session")
    );
    assert_eq!(
        value.pointer("/provider/runtime").and_then(Value::as_str),
        Some("claude-agent-sdk")
    );

    let create_output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &runner)
        .args([
            "source",
            "session",
            "create",
            "--source",
            "claude",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--prompt",
            "new",
            "--json",
        ])
        .output()
        .expect("run burn-chat source session create");
    assert!(
        create_output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&create_output.stderr)
    );
    let create_value: Value = serde_json::from_slice(&create_output.stdout).expect("stdout JSON");
    assert_eq!(
        create_value.pointer("/operation").and_then(Value::as_str),
        Some("create")
    );
    assert_eq!(
        create_value.pointer("/session_id").and_then(Value::as_str),
        Some("claude-source-session")
    );

    let continue_output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &runner)
        .args([
            "source",
            "session",
            "continue",
            "--source",
            "claude",
            "--project",
            dir.to_str().expect("temp dir should be utf8"),
            "--session-id",
            "claude-existing-session",
            "--prompt",
            "resume",
            "--json",
        ])
        .output()
        .expect("run burn-chat source session continue");
    let _ = fs::remove_file(&runner);
    let _ = fs::remove_dir_all(&dir);

    assert!(
        continue_output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&continue_output.stderr)
    );
    let continue_value: Value =
        serde_json::from_slice(&continue_output.stdout).expect("stdout JSON");
    assert_eq!(
        continue_value.pointer("/operation").and_then(Value::as_str),
        Some("continue")
    );
    assert_eq!(
        continue_value
            .pointer("/session_id")
            .and_then(Value::as_str),
        Some("claude-existing-session")
    );
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
