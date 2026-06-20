import path from "node:path";

import { EVENT_LIMIT, cleanText } from "./common.mjs";
import { ensureBurnBusinessStore, readJsonLines, writeJsonLines } from "./store.mjs";

export async function collectBurnSyncEvents(options = {}) {
  const { home } = await ensureBurnBusinessStore(options);
  const outbox = await readJsonLines(path.join(home, "outbox", "workspace.jsonl"));
  return outbox.slice(0, clampLimit(options.limit));
}

export async function listBurnSyncEvents(input = {}, options = {}) {
  const events = await collectBurnSyncEvents({ ...options, ...input });
  return burnSyncEnvelope(events);
}

export async function ackBurnSyncEvents(input = {}, options = {}) {
  const { home } = await ensureBurnBusinessStore(options);
  const ids = Array.isArray(input.event_ids) ? input.event_ids : Array.isArray(input.eventIds) ? input.eventIds : [];
  const idSet = new Set(ids.map((id) => cleanText(id)).filter(Boolean));
  if (!idSet.size) return { ok: true, schema: "burn.business.sync.ack.v1", acked: 0, remaining: 0 };
  const outboxFile = path.join(home, "outbox", "workspace.jsonl");
  const outbox = await readJsonLines(outboxFile);
  const remaining = outbox.filter((event) => !idSet.has(event.event_id));
  await writeJsonLines(outboxFile, remaining);
  return { ok: true, schema: "burn.business.sync.ack.v1", acked: outbox.length - remaining.length, remaining: remaining.length };
}

export function burnSyncEnvelope(events = []) {
  const rows = Array.isArray(events) ? events : [];
  return {
    schema: "burn.sync.response.v1",
    project: rows[0]?.project || "burn-app",
    channel: "burn-business",
    events: rows,
    cursor: {
      stream_id: rows.at(-1)?.stream_id || "",
      seq: rows.at(-1)?.seq || 0,
    },
    ack_type: "burn.business.sync.ack",
  };
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return EVENT_LIMIT;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}
