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
fn agent_source_cli_turn_start_runs_fake_codex_app_server() {
    let dir = unique_temp_dir("burn-agent-source-codex");
    fs::create_dir(&dir).expect("create temp project dir");
    let runner = unique_temp_path("burn-fake-codex-app-server.mjs");
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
        Some("codex-existing-thread")
    );
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
