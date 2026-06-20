import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { defaultBurnHome, initBurnStore } from "../burn-store-lib.mjs";
import {
  nowIso,
  safeFileName,
} from "./common.mjs";

export async function ensureBurnBusinessStore(options = {}) {
  const home = path.resolve(options.home || defaultBurnHome());
  await initBurnStore({ home, project: options.root || process.cwd(), accountId: options.accountId, deviceId: options.deviceId });
  for (const dir of ["projects", "projects/public", "preferences", "events", "outbox", "read-model"]) {
    await fs.mkdir(path.join(home, dir), { recursive: true });
  }
  await readProjectIndex(home);
  await readPreferences(home, "projects");
  await readPreferences(home, "sessions");
  return { home };
}

export async function readProjectIndex(home) {
  const file = path.join(home, "projects", "index.json");
  const data = await readJson(file, null);
  const normalized = data && Array.isArray(data.projects)
    ? data
    : { schema: "burn.projects.index.v1", projects: [], updated_at: nowIso() };
  if (!data) await writeJson(file, normalized);
  return normalized;
}

export async function writeProjectIndex(home, value) {
  value.schema = "burn.projects.index.v1";
  value.updated_at = nowIso();
  await writeJson(path.join(home, "projects", "index.json"), value);
}

export async function readPreferences(home, name) {
  const file = path.join(home, "preferences", `${name}.json`);
  const fallback = name === "sessions"
    ? { schema: "burn.session-preferences.v1", sessions: {}, updated_at: nowIso() }
    : { schema: "burn.project-preferences.v1", projects: {}, updated_at: nowIso() };
  const data = await readJson(file, null);
  const normalized = data || fallback;
  if (name === "sessions") normalized.sessions = normalized.sessions || {};
  else normalized.projects = normalized.projects || {};
  if (!data) await writeJson(file, normalized);
  return normalized;
}

export async function writePreferences(home, name, value) {
  value.updated_at = nowIso();
  await writeJson(path.join(home, "preferences", `${name}.json`), value);
}

export async function emitBurnEvent(home, event) {
  const streamId = event.streamId || "burn:workspace";
  const seq = await nextSeq(home, streamId);
  const payload = { ...(event.payload || {}), _sync_op: event.op || "upsert", _sync_project: event.project || "" };
  const row = {
    event_id: `evt_${randomUUID()}`,
    stream_id: streamId,
    seq,
    kind: "burn.business",
    op: event.op || "upsert",
    entity_type: event.entityType,
    entity_id: event.entityId,
    project: event.project || "",
    payload,
    created_at: nowIso(),
  };
  await appendJsonLine(path.join(home, "events", "workspace.jsonl"), row);
  await appendJsonLine(path.join(home, "outbox", "workspace.jsonl"), row);
  await persistReadModel(home, event.entityType, event.entityId, payload);
  return row;
}

export async function persistReadModel(home, entityType, entityId, payload) {
  if (!entityType || !entityId) return;
  await writeJson(path.join(home, "read-model", entityType, `${safeFileName(entityId)}.json`), payload);
}

export async function nextSeq(home, streamId) {
  const file = path.join(home, "events", "cursors.json");
  const cursors = await readJson(file, {});
  const next = Number(cursors[streamId] || 0) + 1;
  cursors[streamId] = next;
  await writeJson(file, cursors);
  return next;
}

export async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

export async function appendJsonLine(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readJsonLines(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function writeJsonLines(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}
