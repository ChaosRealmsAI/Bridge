import path from "node:path";

import { EVENT_LIMIT, cleanText } from "./common.mjs";
import { ensureBurnBusinessStore, readJsonLines, writeJsonLines } from "./store.mjs";

export async function collectBurnSyncEvents(options = {}) {
  const { home } = await ensureBurnBusinessStore(options);
  const outbox = await readJsonLines(path.join(home, "outbox", "workspace.jsonl"));
  return outbox.slice(0, clampLimit(options.limit));
}

export async function ackBurnSyncEvents(input = {}, options = {}) {
  const { home } = await ensureBurnBusinessStore(options);
  const ids = Array.isArray(input.event_ids) ? input.event_ids : Array.isArray(input.eventIds) ? input.eventIds : [];
  const idSet = new Set(ids.map((id) => cleanText(id)).filter(Boolean));
  if (!idSet.size) return { ok: true, acked: 0 };
  const outboxFile = path.join(home, "outbox", "workspace.jsonl");
  const outbox = await readJsonLines(outboxFile);
  const remaining = outbox.filter((event) => !idSet.has(event.event_id));
  await writeJsonLines(outboxFile, remaining);
  return { ok: true, acked: outbox.length - remaining.length, remaining: remaining.length };
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return EVENT_LIMIT;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}
