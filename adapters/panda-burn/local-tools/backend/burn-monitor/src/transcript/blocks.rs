use super::types::MessageBlock;
use crate::parser;
use serde_json::Value;
use std::time::{Duration, SystemTime};

pub(super) fn blocks_from_value(value: &Value, role: &str) -> Vec<MessageBlock> {
    match value {
        Value::String(text) => clean_text(text)
            .map(|text| vec![MessageBlock::text(text, role)])
            .unwrap_or_default(),
        Value::Array(items) => items
            .iter()
            .flat_map(|item| blocks_from_value(item, role))
            .collect(),
        Value::Object(map) => blocks_from_object(map, role),
        _ => Vec::new(),
    }
}

fn blocks_from_object(map: &serde_json::Map<String, Value>, role: &str) -> Vec<MessageBlock> {
    match map.get("type").and_then(Value::as_str).unwrap_or("") {
        "text" | "input_text" | "output_text" => map
            .get("text")
            .and_then(text_from_value)
            .map(|text| vec![MessageBlock::text(text, role)])
            .unwrap_or_default(),
        "html" => map
            .get("html")
            .or_else(|| map.get("text"))
            .and_then(text_from_value)
            .map(|html| vec![MessageBlock::html(html)])
            .unwrap_or_default(),
        "thinking" | "reasoning" => map
            .get("thinking")
            .or_else(|| map.get("text"))
            .and_then(text_from_value)
            .map(|text| vec![MessageBlock::thinking(text)])
            .unwrap_or_default(),
        "tool_use" | "function_call" | "tool_call" => {
            let name = map
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_owned();
            let input = map
                .get("input")
                .or_else(|| map.get("arguments"))
                .cloned()
                .unwrap_or(Value::Null);
            vec![MessageBlock::tool_call(name, input)]
        }
        "tool_result" | "function_call_output" => {
            let ok = !map
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let output = map
                .get("content")
                .or_else(|| map.get("output"))
                .cloned()
                .unwrap_or(Value::Null);
            vec![MessageBlock::tool_result(
                ok,
                text_from_value(&output),
                Some(output),
            )]
        }
        _ => map
            .get("content")
            .or_else(|| map.get("message"))
            .or_else(|| map.get("text"))
            .map(|child| blocks_from_value(child, role))
            .unwrap_or_default(),
    }
}

pub(super) fn text_from_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => clean_text(text),
        Value::Array(items) => {
            let parts = items.iter().filter_map(text_from_value).collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        Value::Object(map) => {
            for key in ["text", "content", "message", "output"] {
                if let Some(text) = map.get(key).and_then(text_from_value) {
                    if !text.trim().is_empty() {
                        return Some(text);
                    }
                }
            }
            None
        }
        _ => None,
    }
}

pub(super) fn clean_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

pub(super) fn timestamp(value: &Value) -> Option<String> {
    string_path(value, &["timestamp"])
        .or_else(|| string_path(value, &["payload", "timestamp"]))
        .or_else(|| string_path(value, &["message", "timestamp"]))
        .map(str::to_owned)
}

pub(super) fn timestamp_from_millis(ms: u64) -> Option<String> {
    let time = SystemTime::UNIX_EPOCH.checked_add(Duration::from_millis(ms))?;
    Some(parser::format_time(parser::system_time(time)))
}

pub(super) fn normalized_role_opt(raw: &str) -> Option<&'static str> {
    match raw.to_ascii_lowercase().as_str() {
        "user" | "human" | "user_message" | "user_input" => Some("user"),
        "assistant" | "agent_message" | "assistant_message" => Some("assistant"),
        "tool" | "tool_result" | "function_call_output" => Some("tool"),
        _ => None,
    }
}

pub(super) fn string_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_str()
}
