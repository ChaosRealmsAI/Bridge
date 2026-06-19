use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::agent_session::{AgentSessionMessage, AgentSessionMessageBlock, AgentSessionSummary};
use crate::agent_source_catalog::provider_metadata;
use crate::json_text::{find_string_by_paths, find_text_by_key, text_from_value};
use crate::{compact_json, Agent};

pub(crate) fn codex_thread_summary(
    thread: &Value,
    project: &Path,
    provider: Value,
) -> AgentSessionSummary {
    let id = find_string_by_paths(thread, &[&["id"], &["sessionId"]])
        .unwrap_or_else(|| "unknown-codex-thread".to_string());
    let status = find_string_by_paths(thread, &[&["status"], &["status", "state"]])
        .or_else(|| thread.get("status").map(compact_json))
        .unwrap_or_else(|| "unknown".to_string());
    AgentSessionSummary {
        id: id.clone(),
        source: Agent::Codex,
        project: find_string_by_paths(thread, &[&["cwd"]])
            .unwrap_or_else(|| project.to_string_lossy().to_string()),
        title: find_string_by_paths(thread, &[&["name"], &["preview"]])
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| id.clone()),
        started_at: scalar_to_string(thread.get("createdAt")),
        last_activity: scalar_to_string(thread.get("updatedAt")),
        running: status.to_ascii_lowercase().contains("running")
            || status.to_ascii_lowercase().contains("inprogress"),
        status,
        transcript_path: find_string_by_paths(thread, &[&["path"], &["rolloutPath"]]),
        last_message_preview: find_string_by_paths(thread, &[&["preview"]]).unwrap_or_default(),
        provider,
    }
}

pub(crate) fn codex_thread_messages(thread: &Value) -> Vec<AgentSessionMessage> {
    let Some(turns) = thread.get("turns").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut messages = Vec::new();
    for turn in turns {
        if let Some(items) = turn.get("items").and_then(Value::as_array) {
            for item in items {
                if let Some(message) = generic_message_from_value(messages.len(), item) {
                    messages.push(message);
                }
            }
        } else if let Some(message) = generic_message_from_value(messages.len(), turn) {
            messages.push(message);
        }
    }
    messages
}

pub(crate) fn session_value_belongs_to_project(value: &Value, project: &Path) -> bool {
    let project = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    project_locator_values(value)
        .into_iter()
        .any(|locator| locator_matches_project(&locator, &project))
}

#[derive(Debug, Clone)]
pub(crate) struct SessionMessagePage {
    pub messages: Vec<AgentSessionMessage>,
    pub cursor: usize,
    pub next_cursor: Option<usize>,
    pub prev_cursor: Option<usize>,
    pub scanned: usize,
    pub valid: usize,
    pub total_messages: usize,
    pub end_of_history: bool,
    pub order: &'static str,
}

pub(crate) fn page_session_messages_with_mode(
    messages: Vec<AgentSessionMessage>,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> SessionMessagePage {
    let capped_limit = limit.clamp(1, 200);
    let total_messages = messages.len();
    let start = if latest {
        total_messages.saturating_sub(capped_limit)
    } else {
        cursor.min(total_messages)
    };
    let end = (start + capped_limit).min(messages.len());
    let next_cursor = (end < messages.len()).then_some(end);
    let prev_cursor = if start > 0 {
        Some(start.saturating_sub(capped_limit))
    } else {
        None
    };
    let page = messages[start..end].to_vec();
    let count = page.len();
    SessionMessagePage {
        messages: page,
        cursor: start,
        next_cursor,
        prev_cursor,
        scanned: count,
        valid: count,
        total_messages,
        end_of_history: start == 0,
        order: if latest { "latest" } else { "cursor" },
    }
}

pub(crate) fn generic_session_summary(
    source: Agent,
    project: &Path,
    session: &Value,
    provider: Value,
) -> AgentSessionSummary {
    let id = find_string_by_paths(
        session,
        &[&["id"], &["session_id"], &["sessionId"], &["session", "id"]],
    )
    .unwrap_or_else(|| "unknown-session".to_string());
    let status = find_string_by_paths(session, &[&["status"], &["state"]])
        .unwrap_or_else(|| "history".to_string());
    AgentSessionSummary {
        id: id.clone(),
        source,
        project: find_string_by_paths(session, &[&["project"], &["cwd"]])
            .unwrap_or_else(|| project.to_string_lossy().to_string()),
        title: find_string_by_paths(session, &[&["title"], &["name"], &["preview"]])
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| id.clone()),
        started_at: find_string_by_paths(
            session,
            &[&["started_at"], &["createdAt"], &["created_at"]],
        )
        .unwrap_or_default(),
        last_activity: find_string_by_paths(
            session,
            &[&["last_activity"], &["updatedAt"], &["updated_at"]],
        )
        .unwrap_or_default(),
        running: session
            .get("running")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| status.to_ascii_lowercase().contains("running")),
        status,
        transcript_path: find_string_by_paths(
            session,
            &[&["transcript_path"], &["transcriptPath"], &["path"]],
        ),
        last_message_preview: find_string_by_paths(
            session,
            &[
                &["last_message_preview"],
                &["preview"],
                &["lastMessagePreview"],
            ],
        )
        .unwrap_or_default(),
        provider,
    }
}

pub(crate) fn generic_message_from_value(
    index: usize,
    value: &Value,
) -> Option<AgentSessionMessage> {
    let text = find_text_by_key(
        value,
        &["text", "content", "message", "result", "input", "payload"],
    )
    .or_else(|| text_from_value(value))
    .filter(|text| !text.trim().is_empty())?;
    Some(AgentSessionMessage {
        id: find_string_by_paths(
            value,
            &[&["id"], &["uuid"], &["message", "id"], &["item", "id"]],
        )
        .unwrap_or_else(|| format!("message-{index}")),
        role: message_role(value),
        ts: find_string_by_paths(
            value,
            &[&["timestamp"], &["created_at"], &["createdAt"], &["ts"]],
        )
        .unwrap_or_default(),
        blocks: vec![AgentSessionMessageBlock {
            kind: find_string_by_paths(value, &[&["type"], &["kind"]])
                .unwrap_or_else(|| "markdown".to_string()),
            text,
        }],
    })
}

pub(crate) fn provider_metadata_with_history(source: Agent, history_source: &str) -> Value {
    let mut provider = provider_metadata(source);
    if let Value::Object(map) = &mut provider {
        map.insert(
            "history_source".to_string(),
            Value::String(history_source.to_string()),
        );
    }
    provider
}

pub(crate) fn trim_preview(text: &str, max_chars: usize) -> String {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = clean.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn message_role(value: &Value) -> String {
    if let Some(role) = find_string_by_paths(value, &[&["role"], &["message", "role"]]) {
        return normalize_role(&role);
    }
    let kind = find_string_by_paths(value, &[&["type"], &["kind"]]).unwrap_or_default();
    normalize_role(&kind)
}

fn normalize_role(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("user") || lower.contains("human") {
        "user".to_string()
    } else if lower.contains("assistant") || lower.contains("agent") {
        "assistant".to_string()
    } else if lower.contains("tool") {
        "tool".to_string()
    } else {
        "assistant".to_string()
    }
}

fn scalar_to_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(other) => compact_json(other),
        None => String::new(),
    }
}

fn project_locator_values(value: &Value) -> Vec<String> {
    [
        "cwd",
        "project",
        "projectRoot",
        "project_root",
        "workspace",
        "workspaceRoot",
        "workspace_root",
        "transcript_path",
        "transcriptPath",
        "path",
        "rolloutPath",
    ]
    .into_iter()
    .filter_map(|key| value.get(key).and_then(Value::as_str))
    .filter(|value| !value.trim().is_empty())
    .map(ToOwned::to_owned)
    .collect()
}

fn locator_matches_project(locator: &str, project: &Path) -> bool {
    let path = PathBuf::from(locator);
    let path = if path.is_absolute() {
        std::fs::canonicalize(&path).unwrap_or(path)
    } else {
        path
    };
    if path == project || path.starts_with(project) {
        return true;
    }
    let project_text = project.to_string_lossy();
    locator == project_text.as_ref() || locator.starts_with(&format!("{project_text}/"))
}
