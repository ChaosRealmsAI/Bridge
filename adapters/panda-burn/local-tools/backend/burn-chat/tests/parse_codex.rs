use burn_chat::{
    error_response, parse_agent_display_from_jsonl, parse_codex_app_server_events,
    parse_codex_json, Agent,
};
use serde_json::json;

#[test]
fn parses_codex_summary_reply_and_session() {
    let value = json!({
        "summary": {
            "last_agent_message": "burn-chat-ok",
            "session_id": "codex-session-1"
        },
        "artifacts": {
            "transcript_path": "/tmp/codex.jsonl"
        }
    });

    let parsed = parse_codex_json(&value).expect("codex JSON should parse");

    assert_eq!(parsed.reply, "burn-chat-ok");
    assert_eq!(parsed.session_id.as_deref(), Some("codex-session-1"));
    assert_eq!(parsed.transcript_path.as_deref(), Some("/tmp/codex.jsonl"));
}

#[test]
fn parses_codex_direct_output_fallback() {
    let value = json!({
        "output": [
            {"type": "message", "content": "first"},
            {"type": "message", "content": "second"}
        ],
        "session": {"id": "codex-session-2"}
    });

    let parsed = parse_codex_json(&value).expect("codex output should parse");

    assert_eq!(parsed.reply, "first\nsecond");
    assert_eq!(parsed.session_id.as_deref(), Some("codex-session-2"));
}

#[test]
fn parses_codex_app_server_completed_agent_message() {
    let events = vec![
        json!({"method":"thread/started","params":{"thread":{"id":"thread-1","path":"/tmp/rollout.jsonl"}}}),
        json!({"method":"item/completed","params":{"threadId":"thread-1","item":{"type":"userMessage","text":"hello"}}}),
        json!({"method":"item/completed","params":{"threadId":"thread-1","item":{"type":"reasoning","summary":"checking"}}}),
        json!({"method":"item/completed","params":{"threadId":"thread-1","item":{"type":"functionCall","name":"apply_patch","input":{"path":"src/lib.rs"}}}}),
        json!({"method":"item/completed","params":{"threadId":"thread-1","item":{"type":"agentMessage","text":"app-server ok","phase":"final_answer"}}}),
        json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}),
    ];

    let parsed = parse_codex_app_server_events(
        &events,
        Some("thread-1".to_string()),
        Some("/tmp/rollout.jsonl".to_string()),
    )
    .expect("app-server events should parse");

    assert_eq!(parsed.reply, "app-server ok");
    assert_eq!(parsed.session_id.as_deref(), Some("thread-1"));
    assert_eq!(
        parsed.transcript_path.as_deref(),
        Some("/tmp/rollout.jsonl")
    );

    let contents = events
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .expect("serialize events")
        .join("\n");
    let display = parse_agent_display_from_jsonl(Agent::Codex, &contents, "app-server ok");
    assert!(display.blocks.iter().any(|block| block.kind == "thinking"));
    assert!(display.blocks.iter().any(|block| block.kind == "tool_call"));
    assert!(display
        .blocks
        .iter()
        .any(|block| block.kind == "assistant_text"));
}

#[test]
fn parses_codex_app_server_delta_fallback() {
    let events = vec![
        json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-2","itemId":"msg-1","delta":"partial "}}),
        json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-2","itemId":"msg-1","delta":"answer"}}),
        json!({"method":"turn/completed","params":{"threadId":"thread-2","turn":{"id":"turn-2","status":"completed"}}}),
    ];

    let parsed = parse_codex_app_server_events(&events, Some("thread-2".to_string()), None)
        .expect("delta fallback should parse");

    assert_eq!(parsed.reply, "partial answer");
    assert_eq!(parsed.session_id.as_deref(), Some("thread-2"));
}

#[test]
fn ignores_non_final_codex_app_server_agent_message_before_delta_fallback() {
    let events = vec![
        json!({"method":"item/completed","params":{"threadId":"thread-2b","item":{"type":"agentMessage","text":"working on it","phase":"commentary"}}}),
        json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-2b","itemId":"msg-final","delta":"final "}}),
        json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-2b","itemId":"msg-final","delta":"answer"}}),
        json!({"method":"turn/completed","params":{"threadId":"thread-2b","turn":{"id":"turn-2b","status":"completed"}}}),
    ];

    let parsed = parse_codex_app_server_events(&events, Some("thread-2b".to_string()), None)
        .expect("delta fallback should ignore non-final completed commentary");

    assert_eq!(parsed.reply, "final answer");
}

#[test]
fn displays_delta_reply_when_non_final_codex_message_exists() {
    let contents = r#"{"method":"item/completed","params":{"threadId":"thread-2d","item":{"type":"userMessage","text":"work"}}}
{"method":"item/completed","params":{"threadId":"thread-2d","item":{"type":"agentMessage","text":"working on it","phase":"commentary"}}}
{"method":"item/agentMessage/delta","params":{"threadId":"thread-2d","itemId":"msg-final","delta":"final "}}
{"method":"item/agentMessage/delta","params":{"threadId":"thread-2d","itemId":"msg-final","delta":"answer"}}
{"method":"turn/completed","params":{"threadId":"thread-2d","turn":{"id":"turn-2d","status":"completed"}}}"#;

    let display = parse_agent_display_from_jsonl(Agent::Codex, contents, "final answer");

    assert!(display.blocks.iter().any(|block| {
        (block.kind == "final_text" || block.kind == "assistant_text")
            && block.text.as_deref() == Some("final answer")
    }));
    assert!(!display.blocks.iter().any(|block| {
        block.kind == "assistant_text" && block.text.as_deref() == Some("working on it")
    }));
}

#[test]
fn counts_bad_codex_app_server_display_lines_as_skipped() {
    let contents = r#"{"method":"item/completed","params":{"threadId":"thread-2e","item":{"type":"agentMessage","text":"done","phase":"final_answer"}}}
not-json
{"method":"turn/completed","params":{"threadId":"thread-2e","turn":{"id":"turn-2e","status":"completed"}}}"#;

    let display = parse_agent_display_from_jsonl(Agent::Codex, contents, "done");

    assert_eq!(display.skipped, 1);
    assert!(display
        .blocks
        .iter()
        .any(|block| block.kind == "assistant_text" && block.text.as_deref() == Some("done")));
}

#[test]
fn rejects_codex_app_server_completed_without_reply() {
    let events = vec![
        json!({"method":"turn/completed","params":{"threadId":"thread-2c","turn":{"id":"turn-2c","status":"completed"}}}),
    ];

    let err = parse_codex_app_server_events(&events, Some("thread-2c".to_string()), None)
        .expect_err("completed turn without reply should fail");

    assert!(err
        .to_string()
        .contains("completed without a final agent message"));
}

#[test]
fn rejects_codex_app_server_failed_turn() {
    let events = vec![
        json!({"method":"item/completed","params":{"threadId":"thread-3","item":{"type":"agentMessage","text":"partial","phase":"final_answer"}}}),
        json!({"method":"turn/completed","params":{"threadId":"thread-3","turn":{"id":"turn-3","status":"failed","error":"not logged in"}}}),
    ];

    let err = parse_codex_app_server_events(&events, Some("thread-3".to_string()), None)
        .expect_err("failed turn should not parse as success");

    assert!(err.to_string().contains("not logged in"));
}

#[test]
fn maps_codex_missing_rollout_to_resume_not_found() {
    let error = error_response("no rollout found for thread id 00000000-0000");

    assert_eq!(error.code, "resume_not_found");
}

#[test]
fn displays_codex_app_server_file_change_items() {
    let contents = r#"{"method":"item/completed","params":{"threadId":"thread-4","item":{"type":"userMessage","text":"edit"}}}
{"method":"item/completed","params":{"threadId":"thread-4","item":{"type":"fileChange","changes":[{"path":"src/lib.rs","status":"modified"},{"path":"README.md","status":"created"}]}}}
{"method":"item/completed","params":{"threadId":"thread-4","item":{"type":"agentMessage","text":"done","phase":"final_answer"}}}
{"method":"turn/completed","params":{"threadId":"thread-4","turn":{"id":"turn-4","status":"completed"}}}"#;

    let display = parse_agent_display_from_jsonl(Agent::Codex, contents, "done");
    let block = display
        .blocks
        .iter()
        .find(|block| block.kind == "file_changes")
        .expect("fileChange item should become file_changes block");

    assert!(block.items.iter().any(|item| item.contains("src/lib.rs")));
    assert!(block.items.iter().any(|item| item.contains("README.md")));
}

#[test]
fn omits_empty_codex_reasoning_instead_of_placeholder() {
    let contents = r#"{"method":"item/completed","params":{"threadId":"thread-5","item":{"type":"userMessage","text":"think"}}}
{"method":"item/completed","params":{"threadId":"thread-5","item":{"type":"reasoning"}}}
{"method":"item/completed","params":{"threadId":"thread-5","item":{"type":"agentMessage","text":"done","phase":"final_answer"}}}
{"method":"turn/completed","params":{"threadId":"thread-5","turn":{"id":"turn-5","status":"completed"}}}"#;

    let display = parse_agent_display_from_jsonl(Agent::Codex, contents, "done");

    assert!(!display.blocks.iter().any(|block| {
        block.kind == "thinking"
            && block
                .text
                .as_deref()
                .map(|text| text == "Codex reasoning")
                .unwrap_or(false)
    }));
    assert!(display.omitted > 0);
}
