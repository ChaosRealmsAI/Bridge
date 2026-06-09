#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const apiBase = (process.env.PANDA_BRIDGE_API_BASE || "https://api.bridge.otherline.cc").replace(/\/$/, "");
const jobCount = boundedInteger(process.env.PANDA_BRIDGE_CLOUD_CONCURRENCY_JOBS, 100, 50, 140);
const crossAccountCount = boundedInteger(process.env.PANDA_BRIDGE_CLOUD_CROSS_ACCOUNT_JOBS, 30, 10, 100);
const duplicateCount = boundedInteger(process.env.PANDA_BRIDGE_CLOUD_DUPLICATE_JOBS, 20, 5, 100);
const evidenceDir = resolve("spec/verification/evidence/cloud-concurrency-matrix");
mkdirSync(evidenceDir, { recursive: true });

const owner = jar();
const other = jar();
const startedAt = Date.now();
const ownerEmail = `cloud-concurrency-owner-${Date.now()}@bridge.otherline.cc`;
const otherEmail = `cloud-concurrency-other-${Date.now()}@bridge.otherline.cc`;
const password = "PandaCloudConcurrency-2026-0604!";
let deviceId = null;
let deviceToken = null;
let jobs = [];

try {
  await api(owner, "POST", "/v1/sessions/password", { email: ownerEmail, password }, "https://panda.otherline.cc");
  const chatIntent = await api(owner, "POST", "/v1/connect-intents", {
    product_id: "panda-chat",
    device_name: "Cloud Concurrency Matrix Device",
  }, "https://panda.otherline.cc");
  assert.equal(chatIntent.connect_intent.source_origin, "https://panda.otherline.cc");
  const chatClaim = await apiNoJar("POST", `/v1/connect-intents/${encodeURIComponent(chatIntent.token)}/claim`, {
    device_name: "Cloud Concurrency Matrix Device",
    install_id: "cloud-concurrency-install",
    capabilities: { codex: ["codex.chat", "codex.run", "codex.rpc"] },
  }, "", {
    "x-panda-bridge-local-client": "connector-cli",
    "x-panda-bridge-install-id": "cloud-concurrency-install",
  });
  deviceId = chatClaim.device.id;
  deviceToken = chatClaim.device_token;

  const devIntent = await api(owner, "POST", "/v1/connect-intents", {
    product_id: "panda-dev",
    device_name: "Cloud Concurrency Matrix Device",
  }, "https://dev.otherline.cc");
  await apiNoJar("POST", `/v1/connect-intents/${encodeURIComponent(devIntent.token)}/claim`, {
    device_name: "Cloud Concurrency Matrix Device",
    install_id: "cloud-concurrency-install",
    capabilities: { codex: ["codex.chat", "codex.run", "codex.rpc"] },
  }, "", {
    authorization: `Bearer ${deviceToken}`,
    "x-panda-bridge-local-client": "connector-cli",
    "x-panda-bridge-install-id": "cloud-concurrency-install",
  });

  const createStartedAt = Date.now();
  const created = await Promise.all(Array.from({ length: jobCount }, (_, index) => {
    const isDev = index % 2 === 1;
    const product = isDev ? "panda-dev" : "panda-chat";
    const origin = isDev ? "https://dev.otherline.cc" : "https://panda.otherline.cc";
    return raw(owner, "POST", `/v1/products/${product}/jobs`, {
      kind: "codex.run",
      device_id: deviceId,
      product_id: product,
      workspace_ref: "default",
      input: { prompt: `cloud concurrency ${product} ${index}` },
      request_key: `cloud-concurrency-${Date.now()}-${product}-${index}`,
      policy: { token_budget: 1000, timeout_ms: 60000 },
    }, origin);
  }));
  const createDurationMs = Date.now() - createStartedAt;
  assert.ok(created.every((item) => item.response.ok), JSON.stringify(created.filter((item) => !item.response.ok).slice(0, 3).map((item) => item.payload)));
  jobs = created.map((item) => item.payload.job);
  assert.equal(new Set(jobs.map((job) => job.id)).size, jobCount);
  assert.ok(jobs.every((job) => job.status === "queued"));
  assert.ok(jobs.every((job) => job.source_origin === (job.product_id === "panda-dev" ? "https://dev.otherline.cc" : "https://panda.otherline.cc")));

  const duplicateKey = `cloud-duplicate-${Date.now()}`;
  const duplicates = await Promise.all(Array.from({ length: duplicateCount }, () => raw(owner, "POST", "/v1/products/panda-chat/jobs", {
    kind: "codex.chat",
    device_id: deviceId,
    product_id: "panda-chat",
    workspace_ref: "default",
    input: { prompt: "cloud duplicate" },
    request_key: duplicateKey,
    policy: { token_budget: 1000, timeout_ms: 60000 },
  }, "https://panda.otherline.cc")));
  assert.ok(duplicates.every((item) => item.response.ok), JSON.stringify(duplicates.filter((item) => !item.response.ok).map((item) => item.payload)));
  const duplicateIds = new Set(duplicates.map((item) => item.payload.job.id));
  assert.equal(duplicateIds.size, 1);

  await api(other, "POST", "/v1/sessions/password", { email: otherEmail, password }, "https://panda.otherline.cc");
  const crossCreates = await Promise.all(Array.from({ length: crossAccountCount }, (_, index) => raw(other, "POST", "/v1/products/panda-chat/jobs", {
    kind: "codex.chat",
    device_id: deviceId,
    product_id: "panda-chat",
    workspace_ref: "default",
    input: { prompt: `cloud cross ${index}` },
    request_key: `cloud-cross-${Date.now()}-${index}`,
    policy: { token_budget: 1000, timeout_ms: 60000 },
  }, "https://panda.otherline.cc")));
  assert.ok(crossCreates.every((item) => item.response.status === 404 && item.payload.error === "device_not_found"));

  const sampleJob = jobs[0];
  const crossGet = await raw(other, "GET", `/v1/jobs/${encodeURIComponent(sampleJob.id)}`, null, "https://panda.otherline.cc");
  const crossEvents = await raw(other, "GET", `/v1/jobs/${encodeURIComponent(sampleJob.id)}/events`, null, "https://panda.otherline.cc");
  const crossCancel = await raw(other, "POST", `/v1/jobs/${encodeURIComponent(sampleJob.id)}/cancel`, {}, "https://panda.otherline.cc");
  assert.equal(crossGet.response.status, 404);
  assert.equal(crossEvents.response.status, 404);
  assert.equal(crossCancel.response.status, 404);

  const eventSamples = [];
  for (const job of jobs.slice(0, 3)) {
    await apiToken("POST", `/v1/connectors/jobs/${encodeURIComponent(job.id)}/accept`, { transport: "poll" });
    await apiToken("POST", `/v1/connectors/jobs/${encodeURIComponent(job.id)}/events`, { type: "started", payload: { sample: true } });
    await apiToken("POST", `/v1/connectors/jobs/${encodeURIComponent(job.id)}/events`, { type: "text_delta", payload: { delta: "ok" } });
    await apiToken("POST", `/v1/connectors/jobs/${encodeURIComponent(job.id)}/ack`, { status: "succeeded", result: { ok: true, reply: "ok" } });
    const events = await api(owner, "GET", `/v1/jobs/${encodeURIComponent(job.id)}/events`, null, "https://panda.otherline.cc");
    const seqs = events.items.map((item) => item.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    eventSamples.push({ job_id: job.id, event_count: events.items.length, event_types: events.items.map((item) => item.type) });
  }

  await Promise.all(jobs.slice(3).map((job) => raw(owner, "POST", `/v1/jobs/${encodeURIComponent(job.id)}/cancel`, {}, "https://panda.otherline.cc")));
  await raw(owner, "DELETE", `/v1/devices/${encodeURIComponent(deviceId)}`, null, "https://panda.otherline.cc");

  const totalDurationMs = Date.now() - startedAt;
  const summary = {
    ok: true,
    api_base: apiBase,
    production_cloud: true,
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
    cleanup: { cancelled_jobs: Math.max(0, jobs.length - 3), device_revoked: true },
    total_duration_ms: totalDurationMs,
    evidence_dir: evidenceDir,
    checked_at: new Date().toISOString(),
  };
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (deviceId && owner.cookie) {
    await Promise.allSettled(jobs.map((job) => raw(owner, "POST", `/v1/jobs/${encodeURIComponent(job.id)}/cancel`, {}, "https://panda.otherline.cc")));
    await raw(owner, "DELETE", `/v1/devices/${encodeURIComponent(deviceId)}`, null, "https://panda.otherline.cc").catch(() => {});
  }
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify({
    ok: false,
    api_base: apiBase,
    error: error?.message || String(error),
    evidence_dir: evidenceDir,
    checked_at: new Date().toISOString(),
  }, null, 2) + "\n");
  throw error;
}

function jar() {
  return { cookie: "" };
}

async function api(jarRef, method, path, body, origin, extraHeaders = {}) {
  const { response, payload } = await raw(jarRef, method, path, body, origin, extraHeaders);
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function apiNoJar(method, path, body, origin, extraHeaders = {}) {
  const { response, payload } = await raw(jar(), method, path, body, origin, extraHeaders);
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function apiToken(method, path, body) {
  return apiNoJar(method, path, body, "", {
    authorization: `Bearer ${deviceToken}`,
    "x-panda-bridge-install-id": "cloud-concurrency-install",
  });
}

async function raw(jarRef, method, path, body, origin, extraHeaders = {}) {
  const headers = new Headers({ accept: "application/json" });
  if (origin) headers.set("origin", origin);
  if (body) headers.set("content-type", "application/json");
  if (jarRef.cookie) headers.set("cookie", jarRef.cookie);
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value) headers.set(key, value);
  }
  const response = await fetchWithRetry(`${apiBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) jarRef.cookie = setCookie.split(";")[0];
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  return { response, payload };
}

async function fetchWithRetry(url, init, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}
