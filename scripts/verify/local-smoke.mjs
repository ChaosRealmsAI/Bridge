#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

const env = {
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_WEB_ORIGIN: "http://127.0.0.1:0",
  SESSION_COOKIE_NAME: "pb_session",
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const body = await readIncoming(incoming);
    const url = `http://127.0.0.1:${server.address().port}${incoming.url}`;
    const request = new Request(url, {
      method: incoming.method,
      headers: incomingHeaders(incoming.headers),
      body: shouldSendBody(incoming.method, body) ? body : undefined,
    });
    const port = server.address().port;
    const response = await worker.fetch(request, {
      ...env,
      BRIDGE_WEB_ORIGIN: `http://127.0.0.1:${port}`,
      BRIDGE_PUBLIC_API_BASE: `http://127.0.0.1:${port}`,
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ error: "local_smoke_proxy_error", message: error.message || String(error) }));
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const apiBase = `http://127.0.0.1:${server.address().port}`;
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-smoke-"));
const statePath = resolve(temp, "connector.json");
const evidenceDir = resolve("spec/verification/evidence/local-smoke");
const v2EvidenceDir = resolve("spec/verification/evidence/v2-invocation-diagnostics");
const v3EvidenceDir = resolve("spec/verification/evidence/v3-request-safety-boundaries");
const v4EvidenceDir = resolve("spec/verification/evidence/v4-queue-performance-observability");
const v5EvidenceDir = resolve("spec/verification/evidence/v5-sdk-readiness-preflight");
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(v2EvidenceDir, { recursive: true });
mkdirSync(v3EvidenceDir, { recursive: true });
mkdirSync(v4EvidenceDir, { recursive: true });
mkdirSync(v5EvidenceDir, { recursive: true });

try {
  let cookie = "";
  const fetchJar = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", apiBase);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  };

  const invalidContentType = await fetch(`${apiBase}/v1/sessions/guest`, {
    method: "POST",
    headers: { "content-type": "text/plain", origin: apiBase },
    body: JSON.stringify({ display_name: "Bad Type" }),
  });
  const invalidContentTypePayload = await invalidContentType.json();
  assert.equal(invalidContentType.status, 415);
  assert.equal(invalidContentTypePayload.error, "invalid_content_type");

  const malformedJson = await fetch(`${apiBase}/v1/sessions/guest`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: apiBase },
    body: "{\"display_name\":",
  });
  const malformedJsonPayload = await malformedJson.json();
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJsonPayload.error, "invalid_json");
  assert.equal("message" in malformedJsonPayload, false);

  env.BRIDGE_MAX_JSON_BODY_BYTES = "1024";
  const oversizedBody = JSON.stringify({ display_name: "x".repeat(1400) });
  const oversized = await fetch(`${apiBase}/v1/sessions/guest`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: apiBase },
    body: oversizedBody,
  });
  const oversizedPayload = await oversized.json();
  assert.equal(oversized.status, 413);
  assert.equal(oversizedPayload.error, "request_body_too_large");
  assert.equal(oversizedPayload.limit_bytes, 1024);
  delete env.BRIDGE_MAX_JSON_BODY_BYTES;

  writeFileSync(resolve(v3EvidenceDir, "request-safety.json"), JSON.stringify({
    checked_at: new Date().toISOString(),
    invalid_content_type: { status: invalidContentType.status, payload: invalidContentTypePayload },
    malformed_json: { status: malformedJson.status, payload: malformedJsonPayload },
    oversized_body: { status: oversized.status, payload: oversizedPayload },
  }, null, 2) + "\n");

  const bridge = createBridgeClient({ apiBase, productId: "panda-chat", fetch: fetchJar });
  const unauthenticatedPreflight = await bridge.preflight();
  assert.equal(unauthenticatedPreflight.ready, false);
  assert.equal(unauthenticatedPreflight.authenticated, false);
  assert.equal(unauthenticatedPreflight.issues.some((item) => item.code === "not_authenticated"), true);
  assert.equal(unauthenticatedPreflight.actions.some((item) => item.code === "login"), true);

  const diagnostics = await bridge.diagnostics();
  assert.equal(diagnostics.ok, true);
  assert.ok(diagnostics.products.some((item) => item.id === "panda-chat"));
  assert.ok(diagnostics.jobs.supported_kinds.includes("codex.chat"));
  writeFileSync(resolve(v2EvidenceDir, "sdk-diagnostics.json"), JSON.stringify({
    checked_at: new Date().toISOString(),
    diagnostics,
  }, null, 2) + "\n");

  const session = await bridge.auth.guest("Local Smoke");
  assert.equal(session.authenticated, true);

  const intent = await bridge.connect.createIntent({ deviceName: "Local Smoke Connector" });
  const claim = await runCli([
    "apps/connector-cli/src/cli.mjs",
    "connect",
    "--api",
    apiBase,
    "--intent",
    intent.token,
    "--device-name",
    "Local Smoke Connector",
    "--state",
    statePath,
    "--yes",
  ]);
  assert.equal(claim.status, 0, childMessage(claim));

  const doctor = await runCli([
    "apps/connector-cli/src/cli.mjs",
    "doctor",
    "--api",
    apiBase,
    "--state",
    statePath,
    "--fake-codex",
  ], {
    env: { ...process.env, PANDA_BRIDGE_FAKE_CODEX: "1" },
  });
  assert.equal(doctor.status, 0, childMessage(doctor));
  const doctorPayload = JSON.parse(doctor.stdout);
  assert.equal(doctorPayload.ok, true);
  assert.equal(doctorPayload.cloud.health_ok, true);
  assert.equal(doctorPayload.cloud.diagnostics_ok, true);
  assert.equal(doctorPayload.state.token_present, true);
  assert.equal(doctorPayload.local.fixture_mode, true);
  assert.equal(doctorPayload.local.codex_ready, true);
  assert.equal(JSON.stringify(doctorPayload).includes("device_token"), false);
  writeFileSync(resolve(v2EvidenceDir, "cli-doctor.json"), JSON.stringify({
    checked_at: new Date().toISOString(),
    doctor: doctorPayload,
  }, null, 2) + "\n");

  const devices = await bridge.devices.list();
  assert.equal(devices.items.length, 1);
  const device = devices.items[0];
  assert.equal(doctorPayload.state.device_id, device.id);
  await bridge.products.requestAuthorization(device.id);

  const created = await bridge.codex.run({
    deviceId: device.id,
    prompt: "hello local smoke",
    requestKey: "local-smoke-1",
  });
  assert.equal(created.job.status, "queued");

  const poll = await runCli([
    "apps/connector-cli/src/cli.mjs",
    "poll",
    "--api",
    apiBase,
    "--state",
    statePath,
    "--fake-codex",
  ], {
    env: { ...process.env, PANDA_BRIDGE_FAKE_CODEX: "1" },
  });
  assert.equal(poll.status, 0, childMessage(poll));

  const final = await bridge.jobs.get(created.job.id);
  assert.equal(final.job.status, "succeeded");
  assert.match(final.job.result.reply, /hello local smoke/);
  const events = await bridge.jobs.events(created.job.id);
  assert.ok(events.items.length >= 3);
  const queueSummary = await bridge.queue.summary();
  assert.equal(queueSummary.counts.total, 1);
  assert.equal(queueSummary.counts.succeeded, 1);
  assert.equal(queueSummary.counts.active, 0);
  assert.equal(queueSummary.products["panda-chat"].succeeded, 1);
  assert.equal(queueSummary.devices.length, 1);
  assert.equal(queueSummary.devices[0].device.id, device.id);
  assert.equal(queueSummary.devices[0].queue.max_running, 1);
  assert.equal(queueSummary.devices[0].queue.max_queued, 150);
  assert.equal(queueSummary.timing.completed_count, 1);
  assert.ok(Number.isFinite(queueSummary.timing.average_ms.queued_to_claimed_ms));
  assert.ok(Number.isFinite(queueSummary.timing.average_ms.total_job_ms));

  let otherCookie = "";
  const otherFetchJar = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", apiBase);
    if (otherCookie) headers.set("cookie", otherCookie);
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) otherCookie = setCookie.split(";")[0];
    return response;
  };
  const otherBridge = createBridgeClient({ apiBase, productId: "panda-chat", fetch: otherFetchJar });
  await otherBridge.auth.guest("Local Smoke Other");
  const otherQueueSummary = await otherBridge.queue.summary();
  assert.equal(otherQueueSummary.counts.total, 0);
  assert.equal(otherQueueSummary.devices.some((item) => item.device.id === device.id), false);
  const queueSummaryEvidence = {
    checked_at: new Date().toISOString(),
    summary: queueSummary,
    cross_account_summary: otherQueueSummary,
    source_access: "API-as-user and SDK-as-user local operation",
  };
  const queueSummaryText = JSON.stringify(queueSummaryEvidence);
  assert.equal(queueSummaryText.includes("device_token"), false);
  assert.equal(queueSummaryText.includes("pb_session"), false);
  writeFileSync(resolve(v4EvidenceDir, "queue-summary.json"), JSON.stringify(queueSummaryEvidence, null, 2) + "\n");
  const readyPreflight = await bridge.preflight({ deviceId: device.id });
  assert.equal(readyPreflight.ready, true);
  assert.equal(readyPreflight.authenticated, true);
  assert.equal(readyPreflight.selected_device.id, device.id);
  assert.equal(readyPreflight.authorized_devices.some((item) => item.id === device.id), true);
  assert.equal(readyPreflight.queue.counts.succeeded, 1);
  assert.deepEqual(readyPreflight.issues, []);
  const preflightEvidence = {
    checked_at: new Date().toISOString(),
    unauthenticated: unauthenticatedPreflight,
    ready: readyPreflight,
    source_access: "SDK-as-user local operation",
  };
  const preflightText = JSON.stringify(preflightEvidence);
  assert.equal(/"device_token"\s*:/.test(preflightText), false);
  assert.equal(preflightText.includes("pb_session"), false);
  writeFileSync(resolve(v5EvidenceDir, "preflight.json"), JSON.stringify(preflightEvidence, null, 2) + "\n");

  const summary = {
    ok: true,
    api_base: apiBase,
    session_user_id: session.user.id,
    device_id: device.id,
    job_id: created.job.id,
    final_status: final.job.status,
    event_count: events.items.length,
    diagnostics_ok: diagnostics.ok,
    doctor_ok: doctorPayload.ok,
    diagnostics_evidence: "spec/verification/evidence/v2-invocation-diagnostics/sdk-diagnostics.json",
    doctor_evidence: "spec/verification/evidence/v2-invocation-diagnostics/cli-doctor.json",
    safety_evidence: "spec/verification/evidence/v3-request-safety-boundaries/request-safety.json",
    queue_summary_evidence: "spec/verification/evidence/v4-queue-performance-observability/queue-summary.json",
    preflight_evidence: "spec/verification/evidence/v5-sdk-readiness-preflight/preflight.json",
    checked_at: new Date().toISOString(),
  };
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

function runCli(args, options = {}) {
  return new Promise((resolveChild) => {
    const child = spawn("node", args, {
      env: process.env,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    let error = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      error = new Error("child process timed out");
      child.kill("SIGTERM");
    }, 20000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (nextError) => {
      error = nextError;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolveChild({ status, signal, stdout, stderr, error: timedOut ? error : error });
    });
  });
}

function childMessage(result) {
  return [
    `status=${result.status}`,
    result.signal ? `signal=${result.signal}` : "",
    result.error ? `error=${result.error.message}` : "",
    result.stderr ? `stderr=${result.stderr}` : "",
    result.stdout ? `stdout=${result.stdout}` : "",
  ].filter(Boolean).join("\n");
}

function readIncoming(incoming) {
  return new Promise((resolveRead, reject) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => resolveRead(Buffer.concat(chunks)));
    incoming.on("error", reject);
  });
}

function incomingHeaders(raw) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw || {})) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value != null) headers.set(key, String(value));
  }
  return headers;
}

function shouldSendBody(method, body) {
  return body.length > 0 && method !== "GET" && method !== "HEAD";
}
