use serde_json::Value;

use super::blocks::{
    add_file_change_block, add_plan_block, add_raw_if_useful, add_reasoning_block,
    add_tool_call_block, add_tool_result_block,
};
use super::utils::{compact_json, summarize};
use super::DisplayBuilder;
use crate::{text_from_value, turn_error_message};

pub(crate) fn add_codex_event_block(builder: &mut DisplayBuilder, value: &Value) {
    if let Some(method) = value.get("method").and_then(Value::as_str) {
        add_codex_app_server_event_block(builder, value, method);
        return;
    }

    let event = value
        .get("payload")
        .and_then(|payload| {
            payload
                .get("item")
                .or_else(|| payload.get("event"))
                .or(Some(payload))
        })
        .unwrap_or(value);
    let event_type = value
        .get("payload")
        .and_then(|payload| payload.get("type"))
        .or_else(|| event.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");

    match event_type {
        "token_count" | "turn_context" | "context_compacted" | "compacted" => builder.omitted += 1,
        "agent_message" | "message" => {
            let role = event.get("role").and_then(Value::as_str).unwrap_or("");
            if role == "user" || event_type == "user_message" {
                builder.omitted += 1;
                return;
            }
            if let Some(text) = text_from_value(event) {
                builder.push(
                    "assistant_text",
                    "high",
                    "回复",
                    "Codex 回复",
                    summarize(&text),
                    false,
                    Some(text),
                    None,
                    Vec::new(),
                    None,
                );
            } else {
                add_raw_if_useful(builder, "Codex 消息", event);
            }
        }
        "user_message" => builder.omitted += 1,
        "reasoning" => {
            add_reasoning_block(builder, event);
        }
        "function_call" | "custom_tool_call" | "web_search_call" | "tool_search_call" => {
            // update_plan -> structured plan block; otherwise a normal tool call.
            if event.get("name").and_then(Value::as_str) == Some("update_plan")
                && add_plan_block(builder, event)
            {
            } else {
                add_tool_call_block(builder, "Codex 工具调用", event)
            }
        }
        "function_call_output"
        | "custom_tool_call_output"
        | "patch_apply_end"
        | "mcp_tool_call_end"
        | "web_search_end"
        | "tool_search_output" => add_tool_result_block(builder, "Codex 工具结果", event),
        "task_complete" => {
            let text = text_from_value(event).unwrap_or_else(|| "任务完成".to_string());
            builder.push(
                "status",
                "normal",
                "完成",
                "Codex 完成",
                summarize(&text),
                true,
                Some(text),
                None,
                Vec::new(),
                None,
            );
        }
        "turn_aborted" | "thread_rolled_back" => {
            add_tool_result_block(builder, "Codex 状态", event)
        }
        _ => add_raw_if_useful(builder, "Codex 事件", event),
    }
}

fn add_codex_app_server_event_block(builder: &mut DisplayBuilder, value: &Value, method: &str) {
    match method {
        "thread/started"
        | "thread/status/changed"
        | "thread/tokenUsage/updated"
        | "account/rateLimits/updated"
        | "mcpServer/startupStatus/updated"
        | "remoteControl/status/changed"
        | "turn/started"
        | "item/started"
        | "item/agentMessage/delta"
        | "reasoning/text/delta"
        | "reasoning/summaryText/delta" => {
            builder.omitted += 1;
        }
        "item/completed" => {
            let item = value.pointer("/params/item").unwrap_or(&Value::Null);
            match item.get("type").and_then(Value::as_str).unwrap_or("") {
                "userMessage" => builder.omitted += 1,
                "agentMessage" => {
                    if let Some(text) = text_from_value(item).filter(|text| !text.trim().is_empty())
                    {
                        match item.get("phase").and_then(Value::as_str) {
                            Some("final_answer") | None => {
                                builder.push(
                                    "assistant_text",
                                    "high",
                                    "回复",
                                    "Codex 回复",
                                    summarize(&text),
                                    false,
                                    Some(text),
                                    None,
                                    Vec::new(),
                                    None,
                                );
                            }
                            Some(_) => {
                                builder.push(
                                    "status",
                                    "low",
                                    "过程",
                                    "Codex 消息",
                                    summarize(&text),
                                    true,
                                    Some(text),
                                    None,
                                    Vec::new(),
                                    None,
                                );
                            }
                        }
                    } else {
                        builder.omitted += 1;
                    }
                }
                "reasoning" => {
                    add_reasoning_block(builder, item);
                }
                "functionCall" | "customToolCall" | "webSearchCall" | "toolSearchCall" => {
                    if item.get("name").and_then(Value::as_str) == Some("update_plan")
                        && add_plan_block(builder, item)
                    {
                    } else {
                        add_tool_call_block(builder, "Codex 工具调用", item)
                    }
                }
                "fileChange" => add_file_change_block(builder, item),
                "functionCallOutput"
                | "customToolCallOutput"
                | "commandExecution"
                | "mcpToolCall"
                | "webSearch"
                | "toolSearchOutput" => add_tool_result_block(builder, "Codex 工具结果", item),
                _ => add_raw_if_useful(builder, "Codex 事件", item),
            }
        }
        "commandExecution/outputDelta"
        | "fileChange/outputDelta"
        | "reasoning/summaryPartAdded"
        | "plan/delta" => add_raw_if_useful(builder, "Codex 事件", value),
        "turn/completed" => {
            let turn = value.pointer("/params/turn").unwrap_or(&Value::Null);
            let status = turn
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if status == "completed" {
                builder.omitted += 1;
            } else {
                let text = turn_error_message(turn, status);
                builder.push(
                    "error",
                    "high",
                    "错误",
                    "Codex 回合失败",
                    summarize(&text),
                    false,
                    Some(text),
                    None,
                    Vec::new(),
                    None,
                );
            }
        }
        "error" => {
            let text = text_from_value(value).unwrap_or_else(|| compact_json(value));
            builder.push(
                "error",
                "high",
                "错误",
                "Codex 错误",
                summarize(&text),
                false,
                Some(text),
                None,
                Vec::new(),
                None,
            );
        }
        _ => add_raw_if_useful(builder, "Codex app-server 事件", value),
    }
}
