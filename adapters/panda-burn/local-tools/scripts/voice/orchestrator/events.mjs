export function isTerminal(call) {
  return call.status === "ended" || Boolean(call.endedAt);
}

export function publicCall(call) {
  return {
    call_id: call.id,
    provider: call.provider,
    status: call.status,
    context: call.context,
    started_at: call.startedAt,
    ended_at: call.endedAt,
  };
}

export function emit(call, type, payload = {}) {
  call.seq += 1;
  const event = { seq: call.seq, at: new Date().toISOString(), call_id: call.id, type, ...payload };
  call.events.push(event);
  if (call.events.length > 400) call.events.splice(0, call.events.length - 400);
  return event;
}
