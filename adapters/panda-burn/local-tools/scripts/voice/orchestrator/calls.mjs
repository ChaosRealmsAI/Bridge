import { emit } from "./events.mjs";

export function createCall({ body, provider, calls, billing }) {
  const id = body.call_id || `call_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const now = new Date().toISOString();
  const chatSessionId = body.chat_session_id || body.session_id || body.resume_session_id || "";
  const source = body.source || body.agent || "codex";
  const voiceHistory = [...billing.values()]
    .filter((record) => record.chat_session_id && record.chat_session_id === chatSessionId)
    .filter((record) => !body.project || record.project === body.project)
    .slice(-5)
    .map((record) => ({
      call_id: record.call_id,
      started_at: record.started_at,
      duration_ms: record.duration_ms,
      tool_call_count: record.tool_call_count,
      estimated_cost_cny: record.estimated_cost_cny,
      reconciliation_status: record.reconciliation_status,
      summary: record.summary || "",
    }));
  const call = {
    id,
    provider,
    status: "listening",
    seq: 0,
    events: [],
    audioBytes: 0,
    autoAudioHandled: false,
    context: {
      project: body.project || "",
      session_id: chatSessionId,
      chat_session_id: chatSessionId,
      raw_id: body.raw_id || "",
      source,
      agent: body.agent || source,
      title: body.title || "",
      preview: body.preview || "",
      draft: body.draft || "",
      chat_summary: body.chat_summary || "",
      chat_message_count: Number(body.chat_message_count || 0),
      chat_sending: Boolean(body.chat_sending),
      context_cursor: body.context_cursor || 0,
      voice_history: voiceHistory,
      account: body.account || "",
      device_id: body.device_id || "",
    },
    startedAt: now,
    endedAt: null,
    usage: { input_chars: 0, output_chars: 0, tool_calls: 0, audio_bytes: 0 },
  };
  calls.set(id, call);
  billing.set(id, {
    call_id: id,
    provider,
    started_at: now,
    ended_at: null,
    duration_ms: 0,
    project: call.context.project,
    session_id: call.context.session_id,
    chat_session_id: call.context.chat_session_id,
    source: call.context.source,
    title: call.context.title,
    agent: call.context.agent,
    input_chars: 0,
    output_chars: 0,
    audio_bytes: 0,
    tool_call_count: 0,
    estimated_cost_cny: 0,
    provider_cost_cny: null,
    reconciliation_status: "in_progress",
    provider_refs: [],
    summary: "",
  });
  emit(call, "call_started", { provider, status: call.status, context: call.context });
  return call;
}
