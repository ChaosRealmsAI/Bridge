use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::SystemTime;

const HEAD_BYTES: u64 = 64 * 1024;
const HEAD_LINES: usize = 200;
const TAIL_BYTES: u64 = 64 * 1024;

pub fn head_bytes_limit() -> u64 {
    HEAD_BYTES
}

pub fn head_lines_limit() -> usize {
    HEAD_LINES
}

pub fn tail_bytes_limit() -> u64 {
    TAIL_BYTES
}

pub fn read_head_lines(path: &Path) -> std::io::Result<Vec<String>> {
    let file = File::open(path)?;
    let mut buf = Vec::new();
    file.take(HEAD_BYTES).read_to_end(&mut buf)?;

    Ok(String::from_utf8_lossy(&buf)
        .lines()
        .take(HEAD_LINES)
        .map(str::to_owned)
        .collect())
}

pub fn read_tail_lines(path: &Path) -> std::io::Result<Vec<String>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;

    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    let mut lines: Vec<String> = String::from_utf8_lossy(&buf)
        .lines()
        .map(str::to_owned)
        .collect();

    if start > 0 && !buf.starts_with(b"\n") && !lines.is_empty() {
        lines.remove(0);
    }
    Ok(lines)
}

pub fn parse_json(line: &str) -> Option<Value> {
    serde_json::from_str(line).ok()
}

pub fn string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

pub fn parse_time(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|time| time.with_timezone(&Utc))
}

pub fn format_time(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn system_time(time: SystemTime) -> DateTime<Utc> {
    DateTime::<Utc>::from(time)
}

pub fn file_created_or_modified(path: &Path) -> Option<SystemTime> {
    let metadata = fs::metadata(path).ok()?;
    metadata.created().or_else(|_| metadata.modified()).ok()
}

pub fn first_text_by_role(lines: &[String], role: &str) -> String {
    lines
        .iter()
        .filter_map(|line| parse_json(line))
        .filter_map(|value| {
            (role_of(&value) == Some(role))
                .then(|| extract_text(&value))
                .flatten()
        })
        .find_map(|text| meaningful_text(&text))
        .unwrap_or_default()
}

pub fn last_text_by_role(lines: &[String], role: &str) -> String {
    lines
        .iter()
        .rev()
        .filter_map(|line| parse_json(line))
        .filter_map(|value| {
            (role_of(&value) == Some(role))
                .then(|| extract_text(&value))
                .flatten()
        })
        .find_map(|text| meaningful_text(&text))
        .unwrap_or_default()
}

pub fn last_meaningful_text(lines: &[String]) -> String {
    lines
        .iter()
        .rev()
        .filter_map(|line| parse_json(line))
        .filter(|value| role_of(value).is_some())
        .filter_map(|value| extract_text(&value))
        .find_map(|text| meaningful_text(&text))
        .unwrap_or_default()
}

fn role_of(value: &Value) -> Option<&'static str> {
    if let Some(role) = value.get("role").and_then(Value::as_str).and_then(map_role) {
        return Some(role);
    }
    if let Some(role) = value.get("type").and_then(Value::as_str).and_then(map_role) {
        return Some(role);
    }

    ["message", "payload", "item", "event"]
        .iter()
        .filter_map(|key| value.get(*key))
        .find_map(role_of)
}

fn map_role(raw: &str) -> Option<&'static str> {
    match raw.to_ascii_lowercase().as_str() {
        "user" | "human" | "user_message" | "user_input" => Some("user"),
        "assistant" | "agent_message" | "assistant_message" => Some("assistant"),
        _ => None,
    }
}

fn extract_text(value: &Value) -> Option<String> {
    let mut parts = Vec::new();
    collect_text(value, &mut parts);
    let text = parts.join("\n").trim().to_owned();
    (!text.is_empty()).then_some(text)
}

fn collect_text(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::String(text) => push_clean(text, parts),
        Value::Array(items) => items.iter().for_each(|item| collect_text(item, parts)),
        Value::Object(map) => {
            for key in [
                "text", "message", "content", "input", "prompt", "payload", "item",
            ] {
                if let Some(child) = map.get(key) {
                    collect_text(child, parts);
                }
            }
        }
        _ => {}
    }
}

fn push_clean(text: &str, parts: &mut Vec<String>) {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if !clean.is_empty() {
        parts.push(clean);
    }
}

fn meaningful_text(text: &str) -> Option<String> {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() || is_machine_context_text(&clean) {
        return None;
    }
    Some(truncate(&clean, 80))
}

fn is_machine_context_text(text: &str) -> bool {
    let decoded = text
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .to_ascii_lowercase();
    let trimmed = decoded.trim_start();
    trimmed.starts_with("<environment_context")
        || trimmed.starts_with("<cwd>")
        || trimmed.starts_with("<system_context")
}

pub fn truncate(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}
