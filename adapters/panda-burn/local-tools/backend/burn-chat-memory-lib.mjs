import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultBurnHome, initBurnStore, stableHash } from "./burn-store-lib.mjs";

export const BURN_CHAT_MEMORY_EVENT_SCHEMA = "burn.chat-memory.event.v1";
export const BURN_CHAT_MEMORY_SESSION_SCHEMA = "burn.chat-memory.session.v1";
export const BURN_CHAT_MEMORY_INDEX_SCHEMA = "burn.chat-memory.index.v1";
const memoryWriteQueues = new Map();

export async function appendChatMemoryEvent(input = {}) {
  const home = path.resolve(input.home || defaultBurnHome());
  const project = path.resolve(input.project || process.cwd());
  return enqueueMemoryWrite(home, async () => {
    await initBurnStore({ home, project });
    const record = normalizeMemoryRecord(input, project);
    const paths = chatMemoryPaths(home, record);
    await fs.mkdir(path.dirname(paths.jsonl), { recursive: true });
    await fs.appendFile(paths.jsonl, `${JSON.stringify(record)}\n`, "utf8");
    const session = await updateSessionSnapshot(paths, record);
    await updateMemoryIndex(home, paths, session);
    return {
      ok: true,
      event_id: record.event_id,
      session_key: record.session_key,
      jsonl_path: paths.jsonl,
      session_path: paths.session,
      index_path: paths.index,
    };
  });
}

export function chatMemoryPaths(home, record) {
  const projectHash = record.project_hash || stableHash(record.project);
  const sessionHash = stableHash(`${record.source}:${record.session_key}`);
  const safeSource = safeSegment(record.source || "agent");
  const relativeDir = path.join("chat-memory", "projects", projectHash, "sessions");
  const name = `${safeSource}-${sessionHash}`;
  return {
    projectHash,
    sessionHash,
    relativeJsonl: path.join(relativeDir, `${name}.jsonl`),
    relativeSession: path.join(relativeDir, `${name}.json`),
    jsonl: path.join(home, relativeDir, `${name}.jsonl`),
    session: path.join(home, relativeDir, `${name}.json`),
    index: path.join(home, "chat-memory", "index.json"),
    project: path.join(home, "chat-memory", "projects", projectHash, "project.json"),
  };
}

function normalizeMemoryRecord(input, project) {
  const now = new Date().toISOString();
  const source = clean(input.source) || clean(input.agent) || "agent";
  const commandId = clean(input.command_id || input.commandId);
  const sessionId = clean(input.session_id || input.sessionId);
  const sessionKey = clean(input.session_key || input.sessionKey) || sessionId || commandId || randomUUID();
  const eventType = clean(input.event_type || input.eventType) || "event";
  const role = clean(input.role) || roleFor(eventType);
  const status = clean(input.status) || statusFor(eventType);
  const payload = objectOrNull(input.payload);
  const block = objectOrNull(input.block);
  const rawJson = objectOrNull(input.raw_json || input.rawJson);
  const text = clean(input.text) || inferText(payload, block);
  return {
    schema: BURN_CHAT_MEMORY_EVENT_SCHEMA,
    event_id: clean(input.event_id || input.eventId) || `cm_${Date.now()}_${randomUUID()}`,
    created_at: clean(input.created_at || input.createdAt) || now,
    event_type: eventType,
    role,
    status,
    source,
    project,
    project_hash: stableHash(project),
    session_key: sessionKey,
    session_id: sessionId,
    command_id: commandId,
    seq: Number.isFinite(Number(input.seq)) ? Number(input.seq) : null,
    text,
    block,
    raw_json: rawJson,
    payload,
    meta: objectOrNull(input.meta) || {},
  };
}

async function updateSessionSnapshot(paths, record) {
  const previous = await readJson(paths.session);
  const latest = Array.isArray(previous.latest_events) ? previous.latest_events : [];
  latest.push(eventSummary(record));
  const session = {
    schema: BURN_CHAT_MEMORY_SESSION_SCHEMA,
    project: record.project,
    project_hash: record.project_hash,
    source: record.source,
    session_key: record.session_key,
    session_id: record.session_id || previous.session_id || "",
    command_ids: unique([...(previous.command_ids || []), record.command_id].filter(Boolean)),
    status: record.status,
    first_event_at: previous.first_event_at || record.created_at,
    updated_at: record.created_at,
    event_count: Number(previous.event_count || 0) + 1,
    last_user_prompt: record.event_type === "user_prompt" ? record.text : previous.last_user_prompt || "",
    last_assistant_text: record.event_type === "assistant_final" && record.text ? record.text : previous.last_assistant_text || "",
    jsonl_path: paths.relativeJsonl,
    latest_events: latest.slice(-20),
  };
  await writeJson(paths.session, session);
  await writeJson(paths.project, {
    schema: "burn.chat-memory.project.v1",
    project: record.project,
    project_hash: record.project_hash,
    updated_at: record.created_at,
  });
  return session;
}

async function updateMemoryIndex(home, paths, session) {
  const index = await readJson(paths.index);
  const sessions = Array.isArray(index.sessions) ? index.sessions : [];
  const key = `${session.project_hash}:${session.source}:${session.session_key}`;
  const next = {
    key,
    project: session.project,
    project_hash: session.project_hash,
    source: session.source,
    session_key: session.session_key,
    session_id: session.session_id,
    command_ids: session.command_ids,
    status: session.status,
    updated_at: session.updated_at,
    event_count: session.event_count,
    jsonl_path: paths.relativeJsonl,
    session_path: paths.relativeSession,
  };
  const filtered = sessions.filter((item) => item?.key !== key);
  filtered.unshift(next);
  await writeJson(paths.index, {
    schema: BURN_CHAT_MEMORY_INDEX_SCHEMA,
    app_home: home,
    updated_at: session.updated_at,
    sessions: filtered.slice(0, 500),
  });
}

function eventSummary(record) {
  return {
    event_id: record.event_id,
    created_at: record.created_at,
    event_type: record.event_type,
    role: record.role,
    status: record.status,
    seq: record.seq,
    command_id: record.command_id,
    session_id: record.session_id,
    text: record.text.slice(0, 300),
    block_kind: record.block?.kind || "",
    block_title: record.block?.title || record.block?.summary || "",
  };
}

function inferText(payload, block) {
  if (payload?.reply) return clean(payload.reply);
  if (payload?.data?.reply) return clean(payload.data.reply);
  if (payload?.summary?.title) return clean(payload.summary.title);
  if (block?.text) return clean(block.text);
  if (block?.summary) return clean(block.summary);
  return "";
}

function roleFor(eventType) {
  if (eventType === "user_prompt") return "user";
  if (eventType === "agent_failed") return "system";
  return "assistant";
}

function statusFor(eventType) {
  if (eventType === "user_prompt") return "pending";
  if (eventType === "agent_progress") return "streaming";
  if (eventType === "assistant_final") return "final";
  if (eventType === "agent_failed") return "failed";
  return "event";
}

async function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function clean(value) {
  return String(value || "").trim();
}

function safeSegment(value) {
  return clean(value).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "item";
}

function unique(items) {
  return [...new Set(items)];
}

function enqueueMemoryWrite(home, operation) {
  const previous = memoryWriteQueues.get(home) || Promise.resolve();
  const run = previous.catch(() => {}).then(operation);
  const slot = run.catch(() => {});
  memoryWriteQueues.set(home, slot);
  slot.finally(() => {
    if (memoryWriteQueues.get(home) === slot) memoryWriteQueues.delete(home);
  });
  return run;
}
