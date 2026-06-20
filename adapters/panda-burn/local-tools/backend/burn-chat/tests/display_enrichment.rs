// Regression guard for the unified-merge enrichment (block_id / provider /
// origin) that the phone reconciles interface-live vs JSONL-truth by.
// Verified end-to-end against real Codex & Claude turns; this locks the
// field-level contract so a future/concurrent change can't silently drop it.
use burn_chat::{parse_agent_display_from_jsonl, Agent};
use serde_json::json;

fn jsonl(values: &[serde_json::Value]) -> String {
    values
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .expect("serialize fixture")
        .join("\n")
}

#[test]
fn codex_blocks_carry_provider_origin_and_call_id() {
    let events = [
        json!({"method":"item/completed","params":{"threadId":"t1","item":{
            "type":"functionCall","name":"apply_patch",
            "input":{"path":"src/lib.rs"},"callId":"call_ABC"}}}),
        json!({"method":"item/completed","params":{"threadId":"t1","item":{
            "type":"agentMessage","text":"done","phase":"final_answer"}}}),
    ];
    let display = parse_agent_display_from_jsonl(Agent::Codex, &jsonl(&events), "done");

    assert!(!display.blocks.is_empty());
    // Every block tagged with provider + origin=truth (JSONL/truth path).
    assert!(
        display
            .blocks
            .iter()
            .all(|b| b.provider.as_deref() == Some("codex")),
        "all codex blocks carry provider=codex"
    );
    assert!(
        display
            .blocks
            .iter()
            .all(|b| b.origin.as_deref() == Some("truth")),
        "JSONL path tags origin=truth"
    );
    // The tool_call block carries the codex call_id as its reconciliation key.
    let tool = display
        .blocks
        .iter()
        .find(|b| b.kind == "tool_call")
        .expect("a tool_call block");
    assert_eq!(tool.block_id.as_deref(), Some("call_ABC"));
}

#[test]
fn codex_update_plan_becomes_plan_block_not_tool_call() {
    // Confirmed rollout shape: function_call name=update_plan, arguments JSON
    // string with {plan:[{step,status}]}. Should become a `plan` block, not a
    // generic tool_call.
    let line = json!({"type":"response_item","payload":{
        "type":"function_call","name":"update_plan","call_id":"call_P",
        "arguments":"{\"plan\":[{\"step\":\"Inspect scope\",\"status\":\"in_progress\"},{\"step\":\"Verify build\",\"status\":\"pending\"}]}"}});
    let display = parse_agent_display_from_jsonl(Agent::Codex, &jsonl(&[line]), "");

    let plan = display
        .blocks
        .iter()
        .find(|b| b.kind == "plan")
        .expect("a plan block");
    assert_eq!(plan.items.len(), 2);
    assert!(plan.items[0].contains("Inspect scope"));
    assert!(plan.items[0].starts_with("in_progress"));
    // update_plan must NOT also surface as a raw tool_call.
    assert!(!display.blocks.iter().any(|b| b.kind == "tool_call"));
}

#[test]
fn claude_tool_call_and_result_share_tool_use_id() {
    let lines = [
        json!({"type":"assistant","message":{"role":"assistant","content":[
            {"type":"tool_use","id":"toolu_X","name":"Bash","input":{"command":"echo hi"}}]}}),
        json!({"type":"user","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"toolu_X","content":"hi"}]}}),
        json!({"type":"assistant","message":{"role":"assistant","content":[
            {"type":"text","text":"done"}]}}),
    ];
    let display = parse_agent_display_from_jsonl(Agent::Claude, &jsonl(&lines), "done");

    assert!(!display.blocks.is_empty());
    assert!(
        display
            .blocks
            .iter()
            .all(|b| b.provider.as_deref() == Some("claude")),
        "all claude blocks carry provider=claude"
    );
    // tool_use and its result share the same toolu id -> phone pairs them.
    let call = display
        .blocks
        .iter()
        .find(|b| b.kind == "tool_call")
        .expect("a tool_call block");
    let result = display
        .blocks
        .iter()
        .find(|b| b.kind == "tool_result" || b.kind == "test_result")
        .expect("a tool_result block");
    assert_eq!(call.block_id.as_deref(), Some("toolu_X"));
    assert_eq!(result.block_id.as_deref(), Some("toolu_X"));
}
