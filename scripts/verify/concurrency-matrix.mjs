#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";

const jobCount = boundedInteger(process.env.PANDA_BRIDGE_CONCURRENCY_JOBS, 100, 50, 1000);
const crossAccountCount = boundedInteger(process.env.PANDA_BRIDGE_CROSS_ACCOUNT_JOBS, 40, 10, 500);
const duplicateCount = boundedInteger(process.env.PANDA_BRIDGE_DUPLICATE_JOBS, 20, 5, 200);
const evidenceDir = resolve("spec/evidence/concurrency-matrix");
mkdirSync(evidenceDir, { recursive: true });

const env = {
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_WEB_ORIGIN: "http://bridge.local.test",
  BRIDGE_ALLOWED_ORIGINS: "http://chat.local.test http://dev.local.test http://spec.local.test",
  BRIDGE_DEVICE_MAX_QUEUED_JOBS: String(jobCount + duplicateCount + 20),
  BRIDGE_ACCOUNT_MAX_ACTIVE_JOBS: String(jobCount + duplicateCount + 20),
  BRIDGE_PRODUCT_MAX_ACTIVE_JOBS: String(jobCount + duplicateCount + 20),
  SESSION_COOKIE_NAME: "pb_session",
};

const owner = jar();
const other = jar();
const startedAt = Date.now();

const ownerEmail = `concurrency-owner-${Date.now()}@bridge.otherline.cc`;
const otherEmail = `concurrency-other-${Date.now()}@bridge.otherline.cc`;
const password = "PandaConcurrency-2026-0604!";

await api(owner, "POST", "/v1/sessions/password", { email: ownerEmail, password }, "http://chat.local.test");
const chatIntent = await api(owner, "POST", "/v1/connect-intents", {
  product_id: "panda-chat",
  device_name: "Concurrency Matrix Device",
}, "http://chat.local.test");
assert.equal(chatIntent.connect_intent.source_origin, "http://chat.local.test");
const chatClaim = await api(owner, "POST", `/v1/connect-intents/${encodeURIComponent(chatIntent.token)}/claim`, {
  device_name: "Concurrency Matrix Device",
  install_id: "concurrency-install",
  capabilities: { codex: ["codex.chat", "codex.run", "codex.rpc"] },
}, "http://chat.local.test", { authorization: "" });
const deviceId = chatClaim.device.id;
const deviceToken = chatClaim.device_token;

const devIntent = await api(owner, "POST", "/v1/connect-intents", {
  product_id: "panda-dev",
  device_name: "Concurrency Matrix Device",
}, "http://dev.local.test");
await api(owner, "POST", `/v1/connect-intents/${encodeURIComponent(devIntent.token)}/claim`, {
  device_name: "Concurrency Matrix Device",
  install_id: "concurrency-install",
  capabilities: { codex: ["codex.chat", "codex.run", "codex.rpc"] },
}, "http://dev.local.test", {
  authorization: `Bearer ${deviceToken}`,
  "x-panda-bridge-install-id": "concurrency-install",
});

const createStartedAt = Date.now();
const created = await Promise.all(Array.from({ length: jobCount }, (_, index) => {
  const isDev = index % 2 === 1;
  const product = isDev ? "panda-dev" : "panda-chat";
  const origin = isDev ? "http://dev.local.test" : "http://chat.local.test";
  return raw(owner, "POST", `/v1/products/${product}/jobs`, {
    kind: "codex.run",
    device_id: deviceId,
    product_id: product,
    workspace_ref: "default",
    input: { prompt: `concurrency ${product} ${index}` },
    request_key: `concurrency-${product}-${index}`,
    policy: { token_budget: 1000, timeout_ms: 60000 },
  }, origin);
}));
const createDurationMs = Date.now() - createStartedAt;
assert.ok(created.every((item) => item.response.ok), JSON.stringify(created.filter((item) => !item.response.ok).slice(0, 3).map((item) => item.payload)));
const jobs = created.map((item) => item.payload.job);
assert.equal(new Set(jobs.map((job) => job.id)).size, jobCount);
assert.equal(jobs.filter((job) => job.product_id === "panda-chat").length, Math.ceil(jobCount / 2));
assert.equal(jobs.filter((job) => job.product_id === "panda-dev").length, Math.floor(jobCount / 2));
assert.ok(jobs.every((job) => job.status === "queued"));
assert.ok(jobs.every((job) => job.source_origin === (job.product_id === "panda-dev" ? "http://dev.local.test" : "http://chat.local.test")));

const duplicateKey = `duplicate-${Date.now()}`;
const duplicates = await Promise.all(Array.from({ length: duplicateCount }, () => raw(owner, "POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: deviceId,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "duplicate" },
  request_key: duplicateKey,
  policy: { token_budget: 1000, timeout_ms: 60000 },
}, "http://chat.local.test")));
assert.ok(duplicates.every((item) => item.response.ok));
const duplicateIds = new Set(duplicates.map((item) => item.payload.job.id));
assert.equal(duplicateIds.size, 1);
assert.ok(duplicates.filter((item) => item.payload.reused === true).length >= duplicateCount - 1);

await api(other, "POST", "/v1/sessions/password", { email: otherEmail, password }, "http://chat.local.test");
const crossCreates = await Promise.all(Array.from({ length: crossAccountCount }, (_, index) => raw(other, "POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: deviceId,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: `cross ${index}` },
  request_key: `cross-${index}`,
  policy: { token_budget: 1000, timeout_ms: 60000 },
}, "http://chat.local.test")));
assert.ok(crossCreates.every((item) => item.response.status === 404 && item.payload.error === "device_not_found"));

const sampleJob = jobs[0];
const crossGet = await raw(other, "GET", `/v1/jobs/${encodeURIComponent(sampleJob.id)}`, null, "http://chat.local.test");
const crossEvents = await raw(other, "GET", `/v1/jobs/${encodeURIComponent(sampleJob.id)}/events`, null, "http://chat.local.test");
const crossCancel = await raw(other, "POST", `/v1/jobs/${encodeURIComponent(sampleJob.id)}/cancel`, {}, "http://chat.local.test");
assert.equal(crossGet.response.status, 404);
assert.equal(crossEvents.response.status, 404);
assert.equal(crossCancel.response.status, 404);

const eventSamples = [];
for (const job of jobs.slice(0, 5)) {
  await apiToken("POST", `/v1/connectors/jobs/${encodeURIComponent(job.id)}/accept`, { transport: "poll" }, deviceToken);
  await apiToken("POST", `/v1/connectors/jobs/${encodeURIComponent(job.id)}/events`, { type: "started", payload: { sample: true } }, deviceToken);
  await apiToken("POST", `/v1/connectors/jobs/${encodeURIComponent(job.id)}/events`, { type: "text_delta", payload: { delta: "ok" } }, deviceToken);
  await apiToken("POST", `/v1/connectors/jobs/${encodeURIComponent(job.id)}/ack`, { status: "succeeded", result: { ok: true, reply: "ok" } }, deviceToken);
  const events = await api(owner, "GET", `/v1/jobs/${encodeURIComponent(job.id)}/events`, null, "http://chat.local.test");
  const seqs = events.items.map((item) => item.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.ok(events.items.some((item) => item.type === "claimed"));
  assert.ok(events.items.some((item) => item.type === "started"));
  assert.ok(events.items.some((item) => item.type === "text_delta"));
  assert.ok(events.items.some((item) => item.type === "completed"));
  eventSamples.push({ job_id: job.id, event_count: events.items.length, event_types: events.items.map((item) => item.type) });
}

const totalDurationMs = Date.now() - startedAt;
const summary = {
  ok: true,
  api_level_only: true,
  concurrent_job_target: jobCount,
  concurrent_jobs_created: jobs.length,
  create_duration_ms: createDurationMs,
  create_jobs_per_second: Math.round((jobs.length / Math.max(1, createDurationMs)) * 100000) / 100,
  duplicate_request_count: duplicateCount,
  duplicate_unique_job_count: duplicateIds.size,
  duplicate_reused_count: duplicates.filter((item) => item.payload.reused === true).length,
  cross_account_attempts: crossAccountCount,
  cross_account_denied: crossCreates.length,
  cross_account_get_denied: crossGet.response.status === 404,
  cross_account_events_denied: crossEvents.response.status === 404,
  cross_account_cancel_denied: crossCancel.response.status === 404,
  products: {
    "panda-chat": jobs.filter((job) => job.product_id === "panda-chat").length,
    "panda-dev": jobs.filter((job) => job.product_id === "panda-dev").length,
  },
  source_origins: [...new Set(jobs.map((job) => job.source_origin))],
  event_samples: eventSamples,
  per_device_local_codex_policy: "API accepts concurrent submissions; one desktop should execute local Codex jobs predictably through its queue until parallel local execution is explicitly proven safe.",
  total_duration_ms: totalDurationMs,
  evidence_dir: evidenceDir,
  checked_at: new Date().toISOString(),
};
writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));

function jar() {
  return { cookie: "" };
}

async function api(jarRef, method, path, body, origin, extraHeaders = {}) {
  const { response, payload } = await raw(jarRef, method, path, body, origin, extraHeaders);
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function raw(jarRef, method, path, body, origin, extraHeaders = {}) {
  const headers = new Headers({ accept: "application/json" });
  if (origin) headers.set("origin", origin);
  if (body) headers.set("content-type", "application/json");
  if (jarRef.cookie) headers.set("cookie", jarRef.cookie);
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value) headers.set(key, value);
  }
  const started = Date.now();
  const response = await worker.fetch(new Request(`http://bridge.local.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) jarRef.cookie = setCookie.split(";")[0];
  const payload = JSON.parse(await response.text());
  return { response, payload, duration_ms: Date.now() - started };
}

async function apiToken(method, path, body, token) {
  const { response, payload } = await raw({ cookie: "" }, method, path, body, "", {
    authorization: `Bearer ${token}`,
    "x-panda-bridge-install-id": "concurrency-install",
  });
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}
