use serde_json::Value;

pub(crate) fn tail_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let len = trimmed.chars().count();
    if len <= max_chars {
        return trimmed.to_string();
    }

    let mut chars: Vec<char> = trimmed.chars().rev().take(max_chars).collect();
    chars.reverse();
    format!("...{}", chars.into_iter().collect::<String>())
}

pub(crate) fn find_text_by_paths(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths
        .iter()
        .filter_map(|path| get_path(value, path).and_then(text_from_value))
        .find(|text| !text.trim().is_empty())
}

pub(crate) fn find_text_by_key(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(text) = map.get(*key).and_then(text_from_value) {
                    if !text.trim().is_empty() {
                        return Some(text);
                    }
                }
            }
            map.values().find_map(|child| find_text_by_key(child, keys))
        }
        Value::Array(values) => values
            .iter()
            .find_map(|child| find_text_by_key(child, keys)),
        _ => None,
    }
}

pub(crate) fn text_from_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.to_string()),
        Value::Array(values) => {
            let parts: Vec<String> = values.iter().filter_map(text_from_value).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(map) => {
            for key in [
                "text",
                "content",
                "message",
                "reply",
                "last_agent_message",
                "output",
            ] {
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

pub(crate) fn find_session_id(value: &Value) -> Option<String> {
    find_string_by_paths(
        value,
        &[
            &["session_id"],
            &["sessionId"],
            &["session", "id"],
            &["summary", "session_id"],
            &["summary", "sessionId"],
            &["summary", "session", "id"],
            &["payload", "session_id"],
            &["payload", "sessionId"],
            &["payload", "session", "id"],
            &["result", "session_id"],
            &["result", "sessionId"],
            &["result", "session", "id"],
        ],
    )
    .or_else(|| find_string_by_key(value, &["session_id", "sessionId", "session"]))
}

pub(crate) fn find_transcript_path(value: &Value) -> Option<String> {
    find_string_by_paths(
        value,
        &[
            &["transcript_path"],
            &["event_log"],
            &["artifacts", "transcript_path"],
            &["artifacts", "transcript"],
            &["artifacts", "event_log"],
            &["summary", "transcript_path"],
            &["summary", "event_log"],
        ],
    )
    .or_else(|| find_string_by_key(value, &["transcript_path", "transcript", "event_log"]))
}

pub(crate) fn find_string_by_paths(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths
        .iter()
        .filter_map(|path| get_path(value, path).and_then(string_from_value))
        .find(|text| !text.trim().is_empty())
}

fn find_string_by_key(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(text) = map.get(*key).and_then(string_from_value) {
                    if !text.trim().is_empty() {
                        return Some(text);
                    }
                }
            }
            map.values()
                .find_map(|child| find_string_by_key(child, keys))
        }
        Value::Array(values) => values
            .iter()
            .find_map(|child| find_string_by_key(child, keys)),
        _ => None,
    }
}

fn string_from_value(value: &Value) -> Option<String> {
    value.as_str().map(|text| text.trim().to_string())
}

pub(crate) fn get_path<'a>(mut value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    for segment in path {
        value = value.get(*segment)?;
    }
    Some(value)
}
