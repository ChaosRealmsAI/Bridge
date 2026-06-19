use serde_json::Value;
use std::collections::BTreeSet;

use crate::{find_text_by_key, get_path, tail_text, Agent};

pub(crate) fn is_user_prompt_event(agent: Agent, value: &Value) -> bool {
    match agent {
        Agent::Claude => {
            if value.get("type").and_then(Value::as_str) != Some("user") {
                return false;
            }
            let content = get_path(value, &["message", "content"]).unwrap_or(&Value::Null);
            match content {
                Value::String(_) => true,
                Value::Array(items) => items.iter().any(|item| {
                    matches!(
                        item.get("type").and_then(Value::as_str),
                        Some("text") | Some("image")
                    )
                }),
                _ => false,
            }
        }
        Agent::Codex => {
            if matches!(
                value.get("method").and_then(Value::as_str),
                Some("item/started" | "item/completed")
            ) {
                return value.pointer("/params/item/type").and_then(Value::as_str)
                    == Some("userMessage");
            }
            let payload = value.get("payload").unwrap_or(value);
            if payload.get("type").and_then(Value::as_str) == Some("user_message") {
                return true;
            }
            let item = payload.get("item").unwrap_or(payload);
            item.get("role").and_then(Value::as_str) == Some("user")
                || item.get("type").and_then(Value::as_str) == Some("user_message")
        }
    }
}

pub(crate) fn is_claude_metadata(value: &Value) -> bool {
    matches!(
        value.get("type").and_then(Value::as_str),
        Some(
            "last-prompt"
                | "mode"
                | "permission-mode"
                | "ai-title"
                | "custom-title"
                | "file-history-snapshot"
                | "queue-operation"
                | "bridge-session"
                | "agent-name"
                | "attachment"
                | "system"
                | "result"
        )
    )
}

pub(crate) fn is_important_tool(name: &str, detail: &str) -> bool {
    let lower = format!("{} {}", name, detail).to_ascii_lowercase();
    [
        "write", "edit", "patch", "apply", "bash", "test", "build", "cargo", "gradle",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub(crate) fn looks_like_test_result(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "test",
        "passed",
        "failed",
        "cargo test",
        "gradle",
        "pytest",
        "jest",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub(crate) fn raw_event_is_useful(value: &Value) -> bool {
    value.get("error").is_some()
        || value.get("message").is_some()
        || value.get("tool").is_some()
        || value.get("name").is_some()
        || value.get("delta").is_some()
        || find_text_by_key(value, &["text", "content", "output", "summary", "item"]).is_some()
}

pub(crate) fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("{value:?}"))
}

pub(crate) fn summarize(text: &str) -> String {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= 140 {
        clean
    } else {
        let mut summary = clean.chars().take(140).collect::<String>();
        summary.push_str("...");
        summary
    }
}

pub(crate) fn collect_paths(value: &Value, key_hint: Option<&str>, paths: &mut BTreeSet<String>) {
    match value {
        Value::String(text) => {
            if key_hint.map(is_path_key).unwrap_or(false) || looks_like_path(text) {
                paths.insert(tail_text(text, 240));
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_paths(item, key_hint, paths);
            }
        }
        Value::Object(map) => {
            for (key, child) in map {
                collect_paths(child, Some(key), paths);
            }
        }
        _ => {}
    }
}

fn is_path_key(key: &str) -> bool {
    matches!(
        key,
        "path" | "file" | "filename" | "rel_path" | "absolute_path" | "cwd"
    )
}

fn looks_like_path(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.len() > 240 || trimmed.contains('\n') || trimmed.contains('{') {
        return false;
    }
    let has_sep = trimmed.contains('/') || trimmed.contains('\\');
    let has_extension = trimmed
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit('.').next())
        .map(|ext| (1..=8).contains(&ext.len()))
        .unwrap_or(false);
    has_sep && has_extension
}
