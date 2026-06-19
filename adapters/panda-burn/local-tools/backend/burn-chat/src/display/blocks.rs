use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

use super::utils::{
    collect_paths, compact_json, is_important_tool, looks_like_test_result, raw_event_is_useful,
    summarize,
};
use super::DisplayBuilder;
use crate::{find_text_by_key, tail_text, text_from_value};

pub(crate) fn ensure_final_reply(builder: &mut DisplayBuilder, reply: &str) {
    if reply.trim().is_empty() {
        return;
    }
    let has_final = builder.blocks.iter().any(|block| {
        (block.kind == "final_text" || block.kind == "assistant_text")
            && block.text.as_deref().map(str::trim) == Some(reply.trim())
    });
    if !has_final {
        builder.push(
            "final_text",
            "high",
            "最终",
            "最终回复",
            summarize(reply),
            false,
            Some(reply.to_string()),
            None,
            Vec::new(),
            None,
        );
    }
}

pub(crate) fn add_tool_call_block(builder: &mut DisplayBuilder, title: &str, value: &Value) {
    builder.collect_paths(value);
    let name = value
        .get("name")
        .or_else(|| value.get("tool"))
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let detail = value
        .get("input")
        .or_else(|| value.get("arguments"))
        .or_else(|| value.get("args"))
        .map(compact_json)
        .unwrap_or_else(|| summarize(&compact_json(value)));
    let important = is_important_tool(name, &detail);
    builder.push(
        "tool_call",
        if important { "normal" } else { "low" },
        "工具",
        &format!("{title}: {name}"),
        summarize(&detail),
        !important,
        None,
        Some(detail),
        Vec::new(),
        None,
    );
}

pub(crate) fn add_reasoning_block(builder: &mut DisplayBuilder, value: &Value) {
    let Some(text) = find_text_by_key(value, &["text", "content", "message", "summary", "output"])
    else {
        builder.omitted += 1;
        return;
    };
    builder.push(
        "thinking",
        "low",
        "推理",
        "Codex 推理",
        summarize(&text),
        true,
        Some(text),
        None,
        Vec::new(),
        None,
    );
}

pub(crate) fn add_tool_result_block(builder: &mut DisplayBuilder, title: &str, value: &Value) {
    builder.collect_paths(value);
    let is_error = value
        .get("is_error")
        .or_else(|| value.get("error"))
        .and_then(Value::as_bool)
        .unwrap_or_else(|| value.get("error").is_some());
    let text = text_from_value(value).unwrap_or_else(|| compact_json(value));
    let kind = if looks_like_test_result(&text) {
        "test_result"
    } else {
        "tool_result"
    };
    builder.push(
        kind,
        if is_error { "high" } else { "normal" },
        if kind == "test_result" {
            "测试"
        } else {
            "结果"
        },
        title,
        summarize(&text),
        !is_error,
        Some(text),
        None,
        Vec::new(),
        None,
    );
}

pub(crate) fn add_file_change_block(builder: &mut DisplayBuilder, value: &Value) {
    let mut files = Vec::new();
    if let Some(changes) = value.get("changes").and_then(Value::as_array) {
        for change in changes {
            let Some(path) = change.get("path").and_then(Value::as_str) else {
                continue;
            };
            let status = find_text_by_key(change, &["status", "type", "kind"])
                .filter(|status| !status.trim().is_empty());
            files.push(match status {
                Some(status) => format!("{status} {path}"),
                None => path.to_string(),
            });
        }
    }
    if files.is_empty() {
        let mut paths = BTreeSet::new();
        collect_paths(value, None, &mut paths);
        files = paths.into_iter().collect();
    }
    files.sort();
    files.dedup();
    if files.is_empty() {
        add_raw_if_useful(builder, "Codex 文件变更", value);
        return;
    }
    let shown = files.iter().take(4).cloned().collect::<Vec<_>>();
    let summary = if files.len() > shown.len() {
        format!("{} 个文件：{} 等", files.len(), shown.join(", "))
    } else {
        format!("{} 个文件：{}", files.len(), shown.join(", "))
    };
    builder.push(
        "file_changes",
        "high",
        "文件",
        "Codex 文件变更",
        summary,
        true,
        None,
        Some(compact_json(value)),
        files,
        None,
    );
}

pub(crate) fn add_raw_if_useful(builder: &mut DisplayBuilder, title: &str, value: &Value) {
    if !raw_event_is_useful(value) {
        builder.omitted += 1;
        return;
    }
    builder.collect_paths(value);
    let raw = compact_json(value);
    builder.push(
        "raw_json",
        "low",
        "原始",
        title,
        summarize(&raw),
        true,
        None,
        None,
        Vec::new(),
        Some(tail_text(&raw, 2_000)),
    );
}

pub(crate) fn add_file_changes(
    builder: &mut DisplayBuilder,
    git_before: Option<&HashMap<String, String>>,
    git_after: Option<&HashMap<String, String>>,
) {
    let mut files: Vec<String> = match (git_before, git_after) {
        (Some(before), Some(after)) => after
            .iter()
            .filter(|(path, status)| before.get(*path) != Some(*status))
            .map(|(path, status)| format!("{status} {path}"))
            .collect(),
        _ => builder.paths.iter().cloned().collect(),
    };
    files.sort();
    files.dedup();
    if files.is_empty() {
        return;
    }
    let shown = files.iter().take(4).cloned().collect::<Vec<_>>();
    let summary = if files.len() > shown.len() {
        format!("{} 个文件：{} 等", files.len(), shown.join(", "))
    } else {
        format!("{} 个文件：{}", files.len(), shown.join(", "))
    };
    builder.push_at_start(
        "file_changes",
        "high",
        "文件",
        "本轮改动文件",
        &summary,
        true,
        None,
        None,
        files,
        None,
    );
}
