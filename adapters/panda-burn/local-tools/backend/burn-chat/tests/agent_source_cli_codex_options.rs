mod support;

use serde_json::Value;
use std::fs;
use std::process::Command;
use support::{unique_temp_dir, unique_temp_path};

#[test]
fn source_cli_protects_codex_routing_fields_and_passes_provider_options() {
    let dir = unique_temp_dir("burn-agent-source-codex-options");
    fs::create_dir(&dir).expect("create temp project dir");
    let runner = unique_temp_path("burn-fake-codex-options.mjs");
    fs::write(
        &runner,
        r#"#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const log = (value) => {
  if (process.env.BURN_FAKE_PROVIDER_LOG) fs.appendFileSync(process.env.BURN_FAKE_PROVIDER_LOG, JSON.stringify(value) + "\n");
};
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") emit({ id: msg.id, result: { serverInfo: { name: "fake" }, capabilities: {} } });
  else if (msg.method === "thread/start" || msg.method === "thread/resume") {
    log({ method: msg.method, params: msg.params });
    emit({ id: msg.id, result: { thread: { id: msg.params?.threadId || "thread-ok" } } });
  }
  else if (msg.method === "turn/start") {
    log({ method: msg.method, params: msg.params });
    emit({ id: msg.id, result: { turn: { id: "turn-ok", status: "inProgress" } } });
    emit({ method: "item/completed", params: { threadId: msg.params.threadId, item: { type: "agentMessage", text: "ok", phase: "final_answer" } } });
    emit({ method: "turn/completed", params: { threadId: msg.params.threadId, turn: { id: "turn-ok", status: "completed" } } });
  }
});
"#,
    )
    .expect("write fake codex runner");
    make_executable(&runner);

    let project = dir.to_str().expect("temp dir should be utf8");
    let spawn_log = unique_temp_path("burn-fake-codex-options-spawn.log");
    assert_codex_rejects_routing_options(&runner, project, &spawn_log);
    assert_codex_passes_provider_options(&runner, project, &spawn_log);
    let _ = fs::remove_file(&runner);
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_file(&spawn_log);
}

fn assert_codex_rejects_routing_options(
    runner: &std::path::Path,
    project: &str,
    spawn_log: &std::path::Path,
) {
    let rejected = [
        (
            r#"{"cwd":"/tmp/other"}"#,
            "controlled by Burn session routing",
        ),
        (
            r#"{"threadId":"thread-other"}"#,
            "controlled by Burn session routing",
        ),
        (
            r#"{"input":[{"type":"text","text":"bad"}]}"#,
            "controlled by Burn session routing",
        ),
        (
            r#"{"thread":{"threadId":"thread-other"}}"#,
            "controlled by Burn session routing",
        ),
    ];
    for (options, expected_message) in rejected {
        let _ = fs::remove_file(&spawn_log);
        let output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
            .env("BURN_CODEX_BIN", &runner)
            .env("BURN_FAKE_PROVIDER_LOG", &spawn_log)
            .args([
                "source",
                "turn",
                "start",
                "--source",
                "codex",
                "--project",
                project,
                "--prompt",
                "hi",
                "--options-json",
                options,
                "--json",
            ])
            .output()
            .expect("run burn-chat source command");

        assert!(
            !output.status.success(),
            "codex routing options must fail loudly"
        );
        let value = stderr_json(&output);
        assert_eq!(value.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            value.get("code").and_then(Value::as_str),
            Some("invalid_source_options")
        );
        assert!(value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains(expected_message));
        assert!(
            !spawn_log.exists(),
            "rejected codex routing options must not start app-server"
        );
    }
}

fn assert_codex_passes_provider_options(
    runner: &std::path::Path,
    project: &str,
    spawn_log: &std::path::Path,
) {
    let _ = fs::remove_file(&spawn_log);
    let allowed_output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CODEX_BIN", &runner)
        .env("BURN_FAKE_PROVIDER_LOG", &spawn_log)
        .args([
            "source",
            "turn",
            "start",
            "--source",
            "codex",
            "--project",
            project,
            "--prompt",
            "hi",
            "--options-json",
            r#"{"approvalPolicy":"on-request","dangerouslyBypassApprovalsAndSandbox":true,"thread":{"approvalPolicy":"on-failure"},"turn":{"sandboxMode":"workspace-write"}}"#,
            "--json",
        ])
        .output()
        .expect("run burn-chat source command");

    assert!(
        allowed_output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&allowed_output.stderr)
    );
    let allowed_value: Value =
        serde_json::from_slice(&allowed_output.stdout).expect("allowed output JSON");
    assert_eq!(
        allowed_value
            .pointer("/common/provider_turn_id")
            .and_then(Value::as_str),
        Some("turn-ok")
    );
    assert_eq!(
        allowed_value
            .pointer("/chat/provider_turn_id")
            .and_then(Value::as_str),
        Some("turn-ok")
    );
    assert!(
        spawn_log.exists(),
        "provider codex options should start app-server"
    );
    let raw_log = fs::read_to_string(&spawn_log).expect("read fake provider log");
    let events: Vec<Value> = raw_log
        .lines()
        .map(|line| serde_json::from_str(line).expect("provider log JSON"))
        .collect();
    let thread = events
        .iter()
        .find(|event| event.get("method").and_then(Value::as_str) == Some("thread/start"))
        .expect("thread/start log");
    assert_eq!(
        thread
            .pointer("/params/approvalPolicy")
            .and_then(Value::as_str),
        Some("on-failure")
    );
    let turn = events
        .iter()
        .find(|event| event.get("method").and_then(Value::as_str) == Some("turn/start"))
        .expect("turn/start log");
    assert_eq!(
        turn.pointer("/params/approvalPolicy")
            .and_then(Value::as_str),
        Some("on-request")
    );
    assert_eq!(
        turn.pointer("/params/sandboxMode").and_then(Value::as_str),
        Some("workspace-write")
    );
    assert_eq!(
        turn.pointer("/params/dangerouslyBypassApprovalsAndSandbox")
            .and_then(Value::as_bool),
        Some(true)
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

fn stderr_json(output: &std::process::Output) -> Value {
    serde_json::from_slice(&output.stderr).unwrap_or_else(|err| {
        panic!(
            "stderr should be JSON: {err}\n{}",
            String::from_utf8_lossy(&output.stderr)
        )
    })
}
