import { emit, isTerminal } from "./events.mjs";
import { updateBilling, usageSnapshot } from "./billing.mjs";

const allowedTools = new Set(["burn.context.snapshot", "ui.chat.prefill", "ui.chat.send"]);

export async function handleUserInput({ call, text, forceTool, billing, toolBackend, emitAsr = true, toolOnly = false, countInput = true, emitMockAudio = true }) {
  if (isTerminal(call) || !text.trim()) return;
  call.status = "thinking";
  if (emitAsr) {
    emit(call, "asr_partial", { text: text.slice(0, Math.min(text.length, 18)), role: "user" });
    emit(call, "asr_final", { text, role: "user" });
  }
  if (countInput) call.usage.input_chars += text.length;

  const toolName = forceTool || chooseTool(text);
  if (toolOnly && !toolName) return { handled: false };
  let toolSummary = "";
  let toolResult = null;
  if (toolName) {
    if (!allowedTools.has(toolName)) {
      const summary = `工具不在语音 allowlist: ${toolName}`;
      emit(call, "tool_denied", { name: toolName, ok: false, error: "tool_not_allowed", summary });
      return speakAndBill(call, billing, `这个工具不在语音 allowlist 里，我不能直接执行：${toolName}`, { emitMockAudio });
    }
    call.status = "tool";
    call.usage.tool_calls += 1;
    const input = toolInput(toolName, text, call);
    emit(call, "tool_call_started", { name: toolName, input });
    toolResult = await callToolSafely(toolBackend, toolName, input);
    toolSummary = toolResult.summary || JSON.stringify(toolResult.data || {}).slice(0, 160);
    emit(call, "tool_call_result", { name: toolName, ok: toolResult.ok !== false, result: toolResult });
  }

  const answer = answerForTool(toolName, toolResult, toolSummary, call.context);
  return { handled: true, toolName, ...speakAndBill(call, billing, answer, { emitMockAudio }) };
}

export function voiceToolIntent(text) {
  return chooseTool(text);
}

export function mockToolBackend(options = {}) {
  const calls = options.calls || [];
  const phoneUrl = options.phoneUrl || process.env.BURN_PHONE_ACTION_URL || "";
  const phoneToken = options.phoneToken || process.env.BURN_PHONE_ACTION_TOKEN || "";
  return {
    calls,
    async call(name, input) {
      calls.push({ name, input });
      if (!allowedTools.has(name)) {
        return { ok: false, error: "tool_not_allowed", summary: `工具不在 allowlist: ${name}` };
      }
      if (name === "burn.context.snapshot") {
        const context = input.context || {};
        const historyCount = Array.isArray(context.voice_history) ? context.voice_history.length : 0;
        return {
          ok: true,
          data: {
            project: context.project || "",
            chat_session_id: context.chat_session_id || context.session_id || "",
            source: context.source || context.agent || "",
            title: context.title || "",
            preview: context.preview || "",
            draft_present: Boolean(context.draft),
            chat_sending: Boolean(context.chat_sending),
            chat_message_count: Number(context.chat_message_count || 0),
            chat_summary: context.chat_summary || "",
            context_cursor: context.context_cursor || 0,
            voice_history: context.voice_history || [],
          },
          summary: `当前 ${context.source || context.agent || "agent"} 会话 ${context.chat_session_id || context.session_id || "(new)"}，最近摘要：${context.chat_summary || context.preview || "暂无摘要"}；相关语音历史 ${historyCount} 条`,
        };
      }
      if (name === "ui.chat.prefill" || name === "ui.chat.send") {
        if (phoneUrl && phoneToken) return callPhoneAction({ phoneUrl, phoneToken, actionId: name, input });
        return {
          ok: true,
          data: {
            action_id: name,
            project: input.project_path || input.project,
            session_id: input.session_id,
            source: input.source,
            draft_length: name === "ui.chat.prefill" ? String(input.text || "").length : 0,
            sent: name === "ui.chat.send",
          },
          summary: name === "ui.chat.prefill"
            ? `已写入当前输入框，${String(input.text || "").length} 字，等待用户确认发送`
            : "已从当前会话发出，等待 agent 继续回复",
        };
      }
      return { ok: false, error: "tool_not_allowed", summary: `工具不在 allowlist: ${name}` };
    },
  };
}

function speakAndBill(call, billing, answer, { emitMockAudio = true } = {}) {
  if (isTerminal(call)) return { answer: "" };
  call.status = "speaking";
  call.usage.output_chars += answer.length;
  emit(call, "assistant_text", { text: answer, role: "assistant" });
  if (emitMockAudio) emit(call, "assistant_audio_started", { codec: "mock-pcm", text: answer });
  updateBilling(call, billing);
  const record = billing.get(call.id);
  if (record) record.summary = answer.slice(0, 180);
  emit(call, "usage_delta", usageSnapshot(call, billing));
  call.status = "listening";
  return { answer };
}

async function callToolSafely(toolBackend, toolName, input) {
  try {
    const result = await toolBackend.call(toolName, input);
    if (result?.ok === false) return { ok: false, error: result.error || "tool_failed", summary: result.summary || result.error || "工具调用失败" };
    return result || { ok: true, data: {}, summary: "" };
  } catch (error) {
    const message = String(error?.message || error || "tool_backend_failed");
    return { ok: false, error: "tool_backend_failed", summary: `工具调用失败: ${message}` };
  }
}

function chooseTool(text) {
  const raw = String(text || "");
  const explicitSend = /发出去|发送|发给|让.*(codex|claude|agent|它).*继续|继续对话|send\s*(it|this|that)?|submit|send\s+to\s+(codex|claude|agent)/i.test(raw);
  const holdDraft = /先不要发送|不要发送|先别发|不要发|do\s+not\s+send|don't\s+send|dont\s+send|not\s+send|without\s+sending/i.test(raw);
  if (explicitSend && !holdDraft) return "ui.chat.send";
  if (/写|输入框|草稿|提示词|write|draft|prompt|input\s*(box|field)|composer|prefill/i.test(raw)) return "ui.chat.prefill";
  if (/在哪|当前|会话|上下文|干啥|做什么|在做|current|context|what.*(doing|working)|where.*am/i.test(raw)) return "burn.context.snapshot";
  if (/任务|issue|文档|资料|项目|状态|task|issue|doc|document|project|status|workspace/i.test(raw)) return "burn.context.snapshot";
  return "";
}

function toolInput(name, text, call) {
  const context = call.context || {};
  const sessionId = context.chat_session_id || context.session_id || "";
  if (name === "ui.chat.prefill") {
    return {
      project_path: context.project,
      project: context.project,
      session_id: sessionId,
      chat_session_id: sessionId,
      source: context.source || context.agent,
      agent: context.agent,
      mode: "replace",
      text: draftPrompt(text, context),
    };
  }
  if (name === "ui.chat.send") {
    return {
      project_path: context.project,
      project: context.project,
      session_id: sessionId,
      chat_session_id: sessionId,
      source: context.source || context.agent,
      agent: context.agent,
    };
  }
  return { context: publicContext(context), query: text };
}

function draftPrompt(text, context) {
  const stripped = String(text || "")
    .replace(/.*[:：]\s*/, "")
    .replace(/帮我|请|写一个?|提示词|放到|输入框|草稿|先不要发送|不要发送|写入/g, "")
    .replace(/\b(please|can you|write|draft|prompt|put|insert|prefill|into|input|box|field|composer|do not|don't|dont|send|submit|yet|for me)\b/gi, "")
    .trim();
  if (stripped.length >= 8) return stripped;
  const base = context.chat_summary || context.preview || context.title || "当前会话";
  return `请基于当前会话继续处理：${base}`;
}

function publicContext(context) {
  return {
    project: context.project || "",
    session_id: context.session_id || "",
    chat_session_id: context.chat_session_id || context.session_id || "",
    source: context.source || context.agent || "",
    agent: context.agent || "",
    title: context.title || "",
    preview: context.preview || "",
    draft: context.draft ? "[draft-present]" : "",
    chat_summary: context.chat_summary || "",
    chat_message_count: Number(context.chat_message_count || 0),
    chat_sending: Boolean(context.chat_sending),
    context_cursor: context.context_cursor || 0,
    voice_history: Array.isArray(context.voice_history) ? context.voice_history : [],
  };
}

function answerForTool(toolName, result, summary, context) {
  if (!toolName) return `我在，直接说。当前会话是 ${context.source || context.agent || "agent"}。`;
  if (result?.ok === false) return `工具现在不可用：${summary}`;
  if (toolName === "ui.chat.prefill") return `我已写入输入框，你看一下。要发出去的话，你说“发送”。`;
  if (toolName === "ui.chat.send") return `已从当前会话发出，等 ${context.source || context.agent || "agent"} 继续回复。`;
  if (toolName === "burn.context.snapshot") return `我只看当前这个会话。${summary}`;
  return summary ? `我看到了：${summary}` : "已完成。";
}

async function callPhoneAction({ phoneUrl, phoneToken, actionId, input }) {
  const requestId = `voice_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const queued = await phoneJson(`${phoneUrl.replace(/\/$/, "")}/v1/phone-actions`, {
    method: "POST",
    token: phoneToken,
    body: {
      version: "burn-phone-action-v1",
      request_id: requestId,
      action_id: actionId,
      input,
      ttl_ms: 120000,
      created_at: new Date().toISOString(),
    },
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await phoneJson(`${phoneUrl.replace(/\/$/, "")}/v1/phone-actions/${encodeURIComponent(queued.id)}`, { method: "GET", token: phoneToken });
    if (["acked", "failed", "expired"].includes(current.status)) {
      if (current.status === "acked" && current.ok !== false) {
        return {
          ok: true,
          data: current.result || current,
          summary: actionId === "ui.chat.prefill"
            ? `已写入当前输入框，等待用户确认发送`
            : `已从当前会话发送`,
        };
      }
      return { ok: false, error: current.error || current.status, summary: current.error || current.status };
    }
    await sleep(250);
  }
  return { ok: false, error: "phone_action_ack_timeout", summary: "等待手机 App ACK 超时" };
}

async function phoneJson(url, { method, token, body }) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.code || payload.error || `http_${response.status}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
