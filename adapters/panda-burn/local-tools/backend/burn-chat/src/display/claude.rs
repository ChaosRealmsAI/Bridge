use serde_json::Value;

use super::blocks::{add_raw_if_useful, add_tool_call_block, add_tool_result_block};
use super::utils::{is_claude_metadata, summarize};
use super::DisplayBuilder;
use crate::{get_path, text_from_value};

pub(crate) fn add_claude_event_block(builder: &mut DisplayBuilder, value: &Value) {
    if is_claude_metadata(value) {
        builder.omitted += 1;
        return;
    }
    if let Some(error) = value.get("error").and_then(text_from_value) {
        builder.push(
            "error",
            "high",
            "错误",
            "Claude 错误",
            summarize(&error),
            false,
            Some(error),
            None,
            Vec::new(),
            None,
        );
        return;
    }

    let role = get_path(value, &["message", "role"]).and_then(Value::as_str);
    let content = get_path(value, &["message", "content"]).unwrap_or(&Value::Null);
    match (role, content) {
        (Some("assistant"), Value::Array(blocks)) => {
            for block in blocks {
                match block.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(text_from_value) {
                            builder.push(
                                "assistant_text",
                                "high",
                                "回复",
                                "Claude 回复",
                                summarize(&text),
                                false,
                                Some(text),
                                None,
                                Vec::new(),
                                None,
                            );
                        }
                    }
                    "thinking" => {
                        let text = block
                            .get("thinking")
                            .and_then(text_from_value)
                            .unwrap_or_else(|| "Claude thinking".to_string());
                        builder.push(
                            "thinking",
                            "low",
                            "思考",
                            "Claude 思考",
                            summarize(&text),
                            true,
                            Some(text),
                            None,
                            Vec::new(),
                            None,
                        );
                    }
                    "tool_use" => add_tool_call_block(builder, "Claude 工具调用", &block),
                    "fallback" => add_raw_if_useful(builder, "Claude fallback", &block),
                    _ => add_raw_if_useful(builder, "Claude 事件", &block),
                }
            }
        }
        (Some("user"), Value::Array(blocks)) => {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                    add_tool_result_block(builder, "Claude 工具结果", &block);
                } else {
                    builder.omitted += 1;
                }
            }
        }
        (Some("assistant"), _) => {
            if let Some(text) = text_from_value(content) {
                builder.push(
                    "assistant_text",
                    "high",
                    "回复",
                    "Claude 回复",
                    summarize(&text),
                    false,
                    Some(text),
                    None,
                    Vec::new(),
                    None,
                );
            }
        }
        _ => add_raw_if_useful(builder, "Claude 事件", value),
    }
}
