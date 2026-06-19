mod support;

use serde_json::Value;
use std::fs;
use std::process::{Command, Output};
use support::{unique_temp_dir, unique_temp_path};

#[test]
fn source_cli_rejects_unknown_sources() {
    let dir = unique_temp_dir("burn-agent-source-unknown");
    fs::create_dir(&dir).expect("create temp project dir");
    let project = dir.to_str().expect("temp dir should be utf8");
    let commands = [
        vec!["source", "capabilities", "--source", "llama", "--json"],
        vec![
            "source",
            "status",
            "--source",
            "llama",
            "--project",
            project,
            "--json",
        ],
        vec![
            "source",
            "turn",
            "start",
            "--source",
            "llama",
            "--project",
            project,
            "--prompt",
            "hi",
            "--json",
        ],
        vec![
            "source",
            "sessions",
            "list",
            "--source",
            "llama",
            "--project",
            project,
            "--json",
        ],
        vec![
            "source",
            "session",
            "show",
            "--source",
            "llama",
            "--project",
            project,
            "--session-id",
            "session-1",
            "--json",
        ],
        vec![
            "source",
            "session",
            "create",
            "--source",
            "llama",
            "--project",
            project,
            "--prompt",
            "hi",
            "--json",
        ],
        vec![
            "source",
            "session",
            "continue",
            "--source",
            "llama",
            "--project",
            project,
            "--session-id",
            "session-1",
            "--prompt",
            "hi",
            "--json",
        ],
        vec![
            "source",
            "turn",
            "interrupt",
            "--source",
            "llama",
            "--project",
            project,
            "--session-id",
            "session-1",
            "--json",
        ],
    ];

    for args in commands {
        let output = run_source(args);
        assert!(!output.status.success(), "unknown source must fail");
        let value = stderr_json(&output);
        assert_eq!(value.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            value.get("code").and_then(Value::as_str),
            Some("invalid_agent_source")
        );
        assert!(value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("llama"));
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn source_cli_rejects_invalid_project_without_runtime_success() {
    let missing = unique_temp_path("burn-agent-source-missing-project");
    let project = missing.to_str().expect("temp path should be utf8");
    let commands = [
        vec![
            "source",
            "status",
            "--source",
            "codex",
            "--project",
            project,
            "--json",
        ],
        vec![
            "source",
            "status",
            "--source",
            "claude",
            "--project",
            project,
            "--json",
        ],
        vec![
            "source",
            "turn",
            "start",
            "--source",
            "codex",
            "--project",
            project,
            "--prompt",
            "hi",
            "--json",
        ],
        vec![
            "source",
            "turn",
            "start",
            "--source",
            "claude",
            "--project",
            project,
            "--prompt",
            "hi",
            "--json",
        ],
        vec![
            "source",
            "sessions",
            "list",
            "--source",
            "codex",
            "--project",
            project,
            "--json",
        ],
        vec![
            "source",
            "session",
            "show",
            "--source",
            "claude",
            "--project",
            project,
            "--session-id",
            "session-1",
            "--json",
        ],
        vec![
            "source",
            "session",
            "create",
            "--source",
            "codex",
            "--project",
            project,
            "--prompt",
            "hi",
            "--json",
        ],
        vec![
            "source",
            "session",
            "continue",
            "--source",
            "claude",
            "--project",
            project,
            "--session-id",
            "session-1",
            "--prompt",
            "hi",
            "--json",
        ],
        vec![
            "source",
            "turn",
            "interrupt",
            "--source",
            "codex",
            "--project",
            project,
            "--session-id",
            "session-1",
            "--json",
        ],
    ];

    for args in commands {
        let output = run_source(args);
        assert!(!output.status.success(), "invalid project must fail");
        assert!(
            output.stdout.is_empty(),
            "invalid project must not produce success stdout: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let value = stderr_json(&output);
        assert_eq!(value.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            value.get("code").and_then(Value::as_str),
            Some("project_unavailable")
        );
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(
            message.contains("project does not exist"),
            "message: {message}"
        );
        assert!(!message.contains("reply"));
        assert!(!message.contains("session_id"));
    }
}

#[test]
fn source_cli_rejects_empty_session_id_for_session_commands() {
    let dir = unique_temp_dir("burn-agent-source-empty-session");
    fs::create_dir(&dir).expect("create temp project dir");
    let project = dir.to_str().expect("temp dir should be utf8");
    let commands = [
        vec![
            "source",
            "session",
            "show",
            "--source",
            "claude",
            "--project",
            project,
            "--session-id",
            "",
            "--json",
        ],
        vec![
            "source",
            "session",
            "continue",
            "--source",
            "claude",
            "--project",
            project,
            "--session-id",
            "",
            "--prompt",
            "hi",
            "--json",
        ],
        vec![
            "source",
            "turn",
            "interrupt",
            "--source",
            "claude",
            "--project",
            project,
            "--session-id",
            "",
            "--json",
        ],
    ];

    for args in commands {
        let output = run_source(args);
        assert!(!output.status.success(), "empty session id must fail");
        let value = stderr_json(&output);
        assert_eq!(
            value.get("code").and_then(Value::as_str),
            Some("invalid_source_options")
        );
        assert!(value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("session_id is required"));
    }
    let _ = fs::remove_dir_all(&dir);
}

fn run_source(args: Vec<&str>) -> Output {
    Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .args(args)
        .output()
        .expect("run burn-chat source command")
}

fn stderr_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stderr).unwrap_or_else(|err| {
        panic!(
            "stderr should be JSON: {err}\n{}",
            String::from_utf8_lossy(&output.stderr)
        )
    })
}
