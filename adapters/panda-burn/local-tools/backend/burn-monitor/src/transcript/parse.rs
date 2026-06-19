use super::blocks::{
    blocks_from_value, normalized_role_opt, string_path, text_from_value, timestamp,
    timestamp_from_millis,
};
use super::types::{MessageBlock, TranscriptMessage};
use serde_json::Value;

pub(super) fn codex_line(
    value: &Value,
    session_id: &str,
    line_no: usize,
) -> Option<TranscriptMessage> {
    let ts = timestamp(value);
    let payload = value.get("payload").unwrap_or(value);
    let item = payload.get("item").unwrap_or(payload);
    let raw_type = string_path(item, &["type"])
        .or_else(|| string_path(payload, &["type"]))
        .or_else(|| string_path(value, &["type"]))?;

    match raw_type {
        "session_meta" => None,
        "user_message" => simple_message(value, payload, session_id, line_no, "user", ts),
        "agent_message" => simple_message(value, payload, session_id, line_no, "assistant", ts),
        "message" => {
            let role = normalized_role_opt(string_path(item, &["role"])?)?;
            let blocks = blocks_from_value(item.get("content")?, role);
            message_if_blocks(value, item, session_id, line_no, role, ts, blocks)
        }
        "function_call" | "tool_call" => {
            let name = string_path(item, &["name"]).unwrap_or("tool").to_owned();
            let input = item
                .get("arguments")
                .or_else(|| item.get("input"))
                .cloned()
                .unwrap_or(Value::Null);
            message_if_blocks(
                value,
                item,
                session_id,
                line_no,
                "assistant",
                ts,
                vec![MessageBlock::tool_call(name, input)],
            )
        }
        "function_call_output" | "tool_result" => {
            let output = item
                .get("output")
                .or_else(|| item.get("content"))
                .cloned()
                .unwrap_or(Value::Null);
            message_if_blocks(
                value,
                item,
                session_id,
                line_no,
                "tool",
                ts,
                vec![MessageBlock::tool_result(
                    true,
                    text_from_value(&output),
                    Some(output),
                )],
            )
        }
        "reasoning" => {
            let text = item
                .get("summary")
                .or_else(|| item.get("text"))
                .and_then(text_from_value)?;
            message_if_blocks(
                value,
                item,
                session_id,
                line_no,
                "assistant",
                ts,
                vec![MessageBlock::thinking(text)],
            )
        }
        _ => None,
    }
}

pub(super) fn claude_line(
    value: &Value,
    session_id: &str,
    line_no: usize,
) -> Option<TranscriptMessage> {
    let message = value.get("message")?;
    let ts = timestamp(value);
    let role = string_path(message, &["role"])
        .or_else(|| string_path(value, &["type"]))
        .and_then(normalized_role_opt)?;
    let blocks = blocks_from_value(message.get("content")?, role);
    let role = if blocks.iter().all(|block| block.block_type == "tool_result") {
        "tool"
    } else {
        role
    };
    message_if_blocks(value, message, session_id, line_no, role, ts, blocks)
}

pub(super) fn pandacode_log_line(
    value: &Value,
    session_id: &str,
    line_no: usize,
) -> Option<TranscriptMessage> {
    let msg = value.get("msg")?;
    let ts = value
        .get("ms")
        .and_then(Value::as_u64)
        .and_then(timestamp_from_millis);
    match string_path(msg, &["method"])? {
        "turn/start" => {
            let input = msg.get("params")?.get("input")?;
            let blocks = blocks_from_value(input, "user");
            message_if_blocks(value, msg, session_id, line_no, "user", ts, blocks)
        }
        "item/completed" => pandacode_completed_item(value, msg, session_id, line_no, ts),
        _ => None,
    }
}

fn pandacode_completed_item(
    value: &Value,
    msg: &Value,
    session_id: &str,
    line_no: usize,
    ts: Option<String>,
) -> Option<TranscriptMessage> {
    let item = msg.get("params")?.get("item")?;
    match string_path(item, &["type"])? {
        "userMessage" => {
            let blocks = blocks_from_value(item.get("content")?, "user");
            message_if_blocks(value, item, session_id, line_no, "user", ts, blocks)
        }
        "agentMessage" => {
            let text = string_path(item, &["text"])?.trim().to_owned();
            (!text.is_empty()).then(|| {
                message_if_blocks(
                    value,
                    item,
                    session_id,
                    line_no,
                    "assistant",
                    ts,
                    vec![MessageBlock::text(text, "assistant")],
                )
            })?
        }
        "functionCall" => {
            let name = string_path(item, &["name"]).unwrap_or("tool").to_owned();
            let input = item.get("arguments").cloned().unwrap_or(Value::Null);
            message_if_blocks(
                value,
                item,
                session_id,
                line_no,
                "assistant",
                ts,
                vec![MessageBlock::tool_call(name, input)],
            )
        }
        "functionCallOutput" => {
            let output = item.get("output").cloned().unwrap_or(Value::Null);
            message_if_blocks(
                value,
                item,
                session_id,
                line_no,
                "tool",
                ts,
                vec![MessageBlock::tool_result(
                    true,
                    text_from_value(&output),
                    Some(output),
                )],
            )
        }
        _ => None,
    }
}

fn simple_message(
    root: &Value,
    value: &Value,
    session_id: &str,
    line_no: usize,
    role: &str,
    ts: Option<String>,
) -> Option<TranscriptMessage> {
    let text = value
        .get("message")
        .or_else(|| value.get("text"))
        .and_then(text_from_value)?;
    message_if_blocks(
        root,
        value,
        session_id,
        line_no,
        role,
        ts,
        vec![MessageBlock::text(text, role)],
    )
}

fn message_if_blocks(
    root: &Value,
    value: &Value,
    session_id: &str,
    line_no: usize,
    role: &str,
    ts: Option<String>,
    blocks: Vec<MessageBlock>,
) -> Option<TranscriptMessage> {
    (!blocks.is_empty()).then(|| TranscriptMessage {
        id: message_id(root, value, session_id, line_no),
        role: role.to_owned(),
        ts,
        blocks,
    })
}

fn message_id(root: &Value, value: &Value, session_id: &str, line_no: usize) -> String {
    for candidate in [
        string_path(value, &["id"]),
        string_path(value, &["uuid"]),
        string_path(root, &["id"]),
        string_path(root, &["uuid"]),
        string_path(root, &["requestId"]),
        string_path(root, &["message", "id"]),
    ] {
        if let Some(id) = candidate {
            if !id.trim().is_empty() {
                return id.to_owned();
            }
        }
    }
    format!("{session_id}:{line_no}")
}

pub(super) fn is_bootstrap_context_message(message: &TranscriptMessage) -> bool {
    message.role == "user"
        && !message.blocks.is_empty()
        && message.blocks.iter().all(|block| {
            block
                .text
                .as_deref()
                .map(|text| {
                    let trimmed = text.trim_start();
                    trimmed.starts_with("# AGENTS.md instructions")
                        || trimmed.starts_with("<environment_context>")
                })
                .unwrap_or(false)
        })
}

pub(super) fn message_signature(message: &TranscriptMessage) -> String {
    let mut parts = vec![message.role.clone(), message.ts.clone().unwrap_or_default()];
    for block in &message.blocks {
        parts.push(block.block_type.clone());
        parts.push(
            block
                .text
                .as_deref()
                .or(block.html.as_deref())
                .or(block.name.as_deref())
                .unwrap_or("")
                .chars()
                .take(300)
                .collect(),
        );
    }
    parts.join("\u{1f}")
}
