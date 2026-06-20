import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { emit, isTerminal } from "./events.mjs";

export function endCall(call, billing) {
  if (isTerminal(call)) return;
  call.status = "ended";
  call.endedAt = new Date().toISOString();
  updateBilling(call, billing);
  const record = billing.get(call.id);
  if (record.reconciliation_status === "in_progress") record.reconciliation_status = "pending_reconciliation";
  emit(call, "billing_settled", { record });
  emit(call, "ended", { reason: "client_hangup", status: call.status });
}

export function reconcileCall(call, billing, body) {
  const record = billing.get(call.id);
  const nextCost = money(Number(body.provider_cost_cny ?? record.estimated_cost_cny));
  const nextRefs = providerRefsFrom(body, record.provider_refs);
  if (record.reconciliation_status === "reconciled") {
    const sameCost = record.provider_cost_cny === nextCost;
    const sameRefs = sameStringArray(record.provider_refs, nextRefs);
    if (sameCost && sameRefs) return { ok: true, duplicate: true, billing: record };
    const conflict = {
      ok: false,
      error: "reconcile_conflict",
      message: "call already reconciled with different provider settlement",
      billing: record,
    };
    emit(call, "billing_reconcile_conflict", { requested: { provider_cost_cny: nextCost, provider_refs: nextRefs }, record });
    return conflict;
  }
  record.provider_cost_cny = nextCost;
  record.provider_refs = nextRefs;
  record.reconciliation_status = "reconciled";
  emit(call, "billing_settled", { record });
  return { ok: true, duplicate: false, billing: record };
}

export function updateBilling(call, billing) {
  const record = billing.get(call.id);
  record.ended_at = call.endedAt;
  record.duration_ms = (call.endedAt ? Date.parse(call.endedAt) : Date.now()) - Date.parse(call.startedAt);
  record.input_chars = call.usage.input_chars;
  record.output_chars = call.usage.output_chars;
  record.audio_bytes = call.audioBytes;
  record.tool_call_count = call.usage.tool_calls;
  record.estimated_cost_cny = money(0.002 + record.input_chars * 0.00001 + record.output_chars * 0.00002 + record.tool_call_count * 0.003 + record.audio_bytes * 0.00000001);
}

export function usageSnapshot(call, billing) {
  const record = billing.get(call.id);
  return {
    call_id: call.id,
    input_chars: call.usage.input_chars,
    output_chars: call.usage.output_chars,
    audio_bytes: call.audioBytes,
    tool_calls: call.usage.tool_calls,
    estimated_cost_cny: record.estimated_cost_cny,
    reconciliation_status: record.reconciliation_status,
  };
}

export async function loadLedger(path, billing) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    for (const record of parsed.records || []) billing.set(record.call_id, record);
  } catch {
    // No previous ledger is fine for dev/test.
  }
}

export async function persistLedger(path, billing) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ records: [...billing.values()] }, null, 2)}\n`);
}

function money(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function providerRefsFrom(body, fallback = []) {
  if (Array.isArray(body.provider_refs)) return body.provider_refs.map(String);
  if (body.provider_ref) return [String(body.provider_ref)];
  return [...fallback];
}

function sameStringArray(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}
