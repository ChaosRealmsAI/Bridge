mod support;

use burn_chat::{parse_agent_display_from_jsonl, validate_project_dir, Agent};
use std::fs;
use std::process::Command;
use support::{unique_temp_dir, unique_temp_path};

#[test]
fn parses_claude_jsonl_into_prioritized_display_blocks() {
    let contents = r#"{"type":"user","sessionId":"s1","message":{"role":"user","content":"do it"}}
{"type":"assistant","sessionId":"s1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"checking files"},{"type":"tool_use","name":"Edit","input":{"file_path":"src/lib.rs","old_string":"a","new_string":"b"}},{"type":"text","text":"done"}]}}
{"type":"user","sessionId":"s1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}}
{"type":"mode","sessionId":"s1","mode":"default"}"#;

    let display = parse_agent_display_from_jsonl(Agent::Claude, contents, "done");

    assert!(display
        .blocks
        .iter()
        .any(|block| block.kind == "thinking" && block.default_collapsed));
    assert!(display.blocks.iter().any(|block| block.kind == "tool_call"));
    assert!(display
        .blocks
        .iter()
        .any(|block| block.kind == "assistant_text"));
    assert_eq!(display.omitted, 1);
}

#[test]
fn parses_codex_jsonl_into_tool_and_reasoning_blocks() {
    let contents = r#"{"type":"response_item","payload":{"type":"user_message","item":{"type":"message","role":"user","content":[{"type":"input_text","text":"change file"}]}}}
{"type":"event_msg","payload":{"type":"reasoning","summary":"checking approach"}}
{"type":"response_item","payload":{"type":"function_call","name":"apply_patch","arguments":{"path":"src/main.rs"}}}
{"type":"response_item","payload":{"type":"function_call_output","output":"Done"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Implemented."}}
{"type":"event_msg","payload":{"type":"token_count","total":100}}"#;

    let display = parse_agent_display_from_jsonl(Agent::Codex, contents, "Implemented.");

    assert!(display
        .blocks
        .iter()
        .any(|block| block.kind == "thinking" && block.marker_label == "推理"));
    assert!(display.blocks.iter().any(|block| block.kind == "tool_call"));
    assert!(display
        .blocks
        .iter()
        .any(|block| block.kind == "tool_result"));
    assert!(display
        .blocks
        .iter()
        .any(|block| block.kind == "assistant_text"));
    assert_eq!(display.omitted, 1);
}

#[test]
fn validates_project_directory() {
    let dir = unique_temp_dir("burn-chat-project");
    fs::create_dir(&dir).expect("create temp project dir");

    let canonical = validate_project_dir(&dir).expect("directory should validate");
    let _ = fs::remove_dir(&dir);

    assert!(canonical.is_absolute());
}

#[test]
fn rejects_project_file() {
    let file = unique_temp_path("burn-chat-project-file");
    fs::write(&file, "not a directory").expect("write temp file");

    let err = validate_project_dir(&file).expect_err("file should be rejected");
    let _ = fs::remove_file(&file);

    assert!(err.to_string().contains("project is not a directory"));
}

#[test]
fn cli_rejects_unknown_agent_with_stable_code() {
    let dir = unique_temp_dir("burn-chat-unknown-agent");
    fs::create_dir(&dir).expect("create temp project dir");

    let output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .args([
            "send",
            "--agent",
            "llama",
            "--project",
            dir.to_str().expect("temp dir path should be utf8"),
            "--prompt",
            "hi",
            "--json",
        ])
        .output()
        .expect("run burn-chat");
    let _ = fs::remove_dir(&dir);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    let value: serde_json::Value =
        serde_json::from_str(&stderr).expect("stderr should be JSON error");
    assert_eq!(
        value.get("ok").and_then(serde_json::Value::as_bool),
        Some(false)
    );
    assert_eq!(
        value.get("code").and_then(serde_json::Value::as_str),
        Some("invalid_chat_agent")
    );
    assert_eq!(
        value.get("error").and_then(serde_json::Value::as_str),
        Some("invalid_chat_agent")
    );
}

#[test]
fn cli_runs_claude_agent_sdk_through_fake_runner() {
    let dir = unique_temp_dir("burn-chat-claude-sdk");
    fs::create_dir(&dir).expect("create temp project dir");
    let runner = unique_temp_path("burn-chat-fake-claude-sdk-runner.mjs");
    fs::write(
        &runner,
        r#"
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  const session = request.resume || "sdk-fake-session";
  const permission = request.sdkOptions?.permissionMode || "default";
  const maxTurns = request.sdkOptions?.maxTurns || 0;
  const reply = `fake sdk reply permission=${permission} maxTurns=${maxTurns}`;
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  emit({type:"sdk_message", message:{type:"system", subtype:"init", session_id:session, model:request.sdkOptions?.model || "", permissionMode:permission}});
  emit({type:"sdk_message", message:{type:"assistant", message:{role:"assistant", content:[{type:"thinking", thinking:"fake think"}, {type:"text", text:reply}]}}});
  emit({type:"sdk_message", message:{type:"result", subtype:"success", session_id:session, result:reply, usage:{input_tokens:1, output_tokens:2}}});
  emit({type:"burn_result", reply, session_id:session});
});
"#,
    )
    .expect("write fake runner");

    let output = Command::new(env!("CARGO_BIN_EXE_burn-chat"))
        .env("BURN_CLAUDE_AGENT_SDK_RUNNER", &runner)
        .args([
            "send",
            "--agent",
            "claude",
            "--project",
            dir.to_str().expect("temp dir path should be utf8"),
            "--prompt",
            "hi",
            "--mode",
            "plan",
            "--sdk-options-json",
            r#"{"maxTurns":1}"#,
            "--json",
        ])
        .output()
        .expect("run burn-chat");
    let _ = fs::remove_file(&runner);
    let _ = fs::remove_dir_all(&dir);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout should be JSON success");
    assert_eq!(
        value.get("ok").and_then(serde_json::Value::as_bool),
        Some(true)
    );
    assert_eq!(
        value.get("session_id").and_then(serde_json::Value::as_str),
        Some("sdk-fake-session")
    );
    assert_eq!(
        value.get("reply").and_then(serde_json::Value::as_str),
        Some("fake sdk reply permission=plan maxTurns=1")
    );
    assert!(value
        .get("transcript_path")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .contains(".burn/chat/claude-agent-sdk/events/sdk-fake-session.jsonl"));
    let empty_blocks = Vec::new();
    let blocks = value
        .pointer("/display/blocks")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty_blocks);
    assert!(blocks.iter().any(
        |block| block.get("kind").and_then(serde_json::Value::as_str) == Some("assistant_text")
    ));
}
