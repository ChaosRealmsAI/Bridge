#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

const appUrl = (process.env.PANDA_BRIDGE_APP_URL || "https://bridge.otherline.cc").replace(/\/$/, "");
const evidenceDir = resolve("spec/evidence/real-codex-queue");
const productId = process.env.PANDA_BRIDGE_REAL_QUEUE_PRODUCT_ID || process.env.PANDA_BRIDGE_PRODUCT_ID || "panda-chat";
const productOrigin = process.env.PANDA_BRIDGE_REAL_QUEUE_ORIGIN || (productId === "otherline" ? "https://test.otherline.cc" : "https://bridge.otherline.cc");
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-real-queue-"));
const desktopState = resolve(temp, "desktop-state.json");
const controlState = resolve(temp, "verify-control.json");
const appExecutable = resolve(homedir(), "Applications", "Panda Bridge.app", "Contents", "MacOS", "Panda Bridge");
const testEmail = process.env.PANDA_BRIDGE_TEST_EMAIL || `real-queue-${Date.now()}@bridge.otherline.cc`;
const testPassword = process.env.PANDA_BRIDGE_TEST_PASSWORD || "PandaQueue-2026-0604!";
const deviceName = `Real Codex Queue ${Date.now()}`;
const jobCount = boundedInteger(process.env.PANDA_BRIDGE_REAL_QUEUE_JOBS, 3, 3, 5);

mkdirSync(evidenceDir, { recursive: true });
for (const name of [
  "summary.json",
  "desktop-events.json",
  "desktop-stdout.log",
  "desktop-stderr.log",
  "desktop-initial.png",
  "desktop-final.png",
  ...Array.from({ length: 5 }, (_, index) => `job-${index + 1}-events.json`),
]) rmSync(resolve(evidenceDir, name), { force: true });

run("npm", ["run", "desktop:install:mac"]);
stopDesktop();

const desktop = spawn(appExecutable, [], {
  env: {
    ...process.env,
    PANDA_BRIDGE_VERIFY: "1",
    PANDA_BRIDGE_DESKTOP_STATE: desktopState,
    PANDA_BRIDGE_VERIFY_CONTROL_STATE: controlState,
    PANDA_BRIDGE_TOKEN_ROTATION_INTERVAL_SECONDS: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let desktopStdout = "";
let desktopStderr = "";
desktop.stdout.on("data", (chunk) => {
  desktopStdout += String(chunk);
});
desktop.stderr.on("data", (chunk) => {
  desktopStderr += String(chunk);
});

const sessionJar = { cookie: "" };
let control = null;
let deviceId = null;
let createdJobs = [];
try {
  const controlInfo = await waitForControl(controlState);
  hideDesktop();
  control = makeControlClient(controlInfo);
  const status = await control("GET", "/v1/status");
  assert.equal(status.codex_available, true, "desktop did not detect codex command");
  copyEvidenceFile((await control("GET", "/v1/screenshot")).path, "desktop-initial.png");

  const login = await api("POST", "/v1/sessions/password", {
    email: testEmail,
    password: testPassword,
    display_name: testEmail,
  });
  assert.equal(login.authenticated, true);
  const intent = await api("POST", "/v1/connect-intents", {
    product_id: productId,
    device_name: deviceName,
  });
  assert.ok(intent.token);
  assert.equal(intent.connect_intent.source_origin, productOrigin);

  const claimed = await control("POST", "/v1/actions", {
    action: "claim_intent",
    api: appUrl,
    intent: intent.token,
    device_name: deviceName,
  });
  assert.equal(claimed.device_name, deviceName);
  deviceId = claimed.device_id;
  assert.ok(deviceId);
  await waitFor(async () => (await control("GET", "/v1/status")).worker_running === true, "desktop worker did not start");
  await waitForDesktopEvent(control, "device_token_rotated", 30000);
  await waitForDesktopEvent(control, "codex_warmed", 120000);

  const createStartedAt = Date.now();
  const jobInputs = Array.from({ length: jobCount }, (_, index) => {
    const expected = `PB_QUEUE_OK_${index + 1}_${Date.now()}`;
    return {
      index: index + 1,
      expected,
      prompt: `请只回复这一段文本，不要解释：${expected}`,
      request_key: `real-queue-${Date.now()}-${index + 1}`,
    };
  });
  createdJobs = (await Promise.all(jobInputs.map((input) => api("POST", `/v1/products/${encodeURIComponent(productId)}/jobs`, {
    kind: "codex.chat",
    device_id: deviceId,
    product_id: productId,
    workspace_ref: "default",
    input: { prompt: input.prompt },
    request_key: input.request_key,
    policy: { token_budget: 20000, timeout_ms: 240000 },
  })))).map((payload, index) => ({
    ...jobInputs[index],
    job_id: payload.job.id,
    created_at: payload.job.created_at,
    source_origin: payload.job.source_origin,
  }));
  const createDurationMs = Date.now() - createStartedAt;
  assert.equal(new Set(createdJobs.map((item) => item.job_id)).size, jobCount);
  assert.ok(createdJobs.every((item) => item.source_origin === productOrigin));

  const completed = [];
  for (const job of createdJobs) {
    const final = await waitForJobSucceeded(job.job_id, job.expected, 420000);
    const events = await fetchEvents(job.job_id);
    writeFileSync(resolve(evidenceDir, `job-${job.index}-events.json`), JSON.stringify(events, null, 2) + "\n");
    const eventTypes = events.items.map((item) => item.type);
    assertJobEvents(events.items, job.expected, `job-${job.index}`);
    completed.push({
      ...job,
      final_status: final.job.status,
      reply: final.job.result?.reply || "",
      timing: final.job.timing,
      accepted_at: final.job.accepted_at,
      started_at: final.job.started_at,
      completed_at: final.job.completed_at,
      acked_at: final.job.acked_at,
      event_types: eventTypes,
      event_count: eventTypes.length,
      stream_metrics: streamingMetrics(events.items),
    });
  }

  const queueOrder = [...completed].sort(compareJobsByQueueOrder);
  for (let index = 1; index < queueOrder.length; index += 1) {
    const previous = queueOrder[index - 1];
    const current = queueOrder[index];
    const previousCompletedAt = Date.parse(previous.completed_at || previous.acked_at || "");
    const currentAcceptedAt = Date.parse(current.accepted_at || "");
    assert.ok(
      Number.isFinite(previousCompletedAt) && Number.isFinite(currentAcceptedAt) && currentAcceptedAt >= previousCompletedAt,
      `job-${current.index} accepted before earlier queued job-${previous.index} completed`,
    );
  }

  copyEvidenceFile((await control("GET", "/v1/screenshot")).path, "desktop-final.png");
  const desktopEvents = await control("GET", "/v1/events");
  writeFileSync(resolve(evidenceDir, "desktop-events.json"), JSON.stringify(desktopEvents, null, 2) + "\n");
  const realtimeJobs = (desktopEvents.items || []).filter((item) => item.type === "realtime_job").map((item) => item.payload?.job_id);
  assert.ok(createdJobs.every((job) => realtimeJobs.includes(job.job_id)), "desktop did not receive every queue job over realtime");

  const summary = {
    ok: true,
    app_url: appUrl,
    product_id: productId,
    product_origin: productOrigin,
    app_executable: appExecutable,
    test_email: testEmail,
    device_name: deviceName,
    device_id: deviceId,
    job_count: jobCount,
    jobs: completed,
    queue_order: queueOrder.map((job) => ({ index: job.index, job_id: job.job_id, created_at: job.created_at, accepted_at: job.accepted_at, completed_at: job.completed_at })),
    create_duration_ms: createDurationMs,
    queue_policy: {
      device_max_running_jobs: 1,
      device_max_queued_jobs: 150,
    },
    sequential_local_execution: true,
    no_mixed_event_streams: true,
    realtime_job_count: realtimeJobs.length,
    real_codex: true,
    evidence_dir: evidenceDir,
    checked_at: new Date().toISOString(),
  };
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify({
    ok: false,
    app_url: appUrl,
    product_id: productId,
    product_origin: productOrigin,
    test_email: testEmail,
    device_name: deviceName,
    device_id: deviceId,
    created_jobs: createdJobs,
    error: error?.message || String(error),
    evidence_dir: evidenceDir,
    checked_at: new Date().toISOString(),
  }, null, 2) + "\n");
  throw error;
} finally {
  if (control) {
    const events = await control("GET", "/v1/events").catch(() => null);
    if (events) writeFileSync(resolve(evidenceDir, "desktop-events.json"), JSON.stringify(events, null, 2) + "\n");
  }
  desktop.kill("SIGTERM");
  writeFileSync(resolve(evidenceDir, "desktop-stdout.log"), desktopStdout);
  writeFileSync(resolve(evidenceDir, "desktop-stderr.log"), desktopStderr);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

function stopDesktop() {
  spawnSync("osascript", ["-e", "tell application \"Panda Bridge\" to quit"], { stdio: "ignore" });
  spawnSync("pkill", ["-f", "/Applications/Panda Bridge.app/Contents/MacOS/Panda Bridge"], { stdio: "ignore" });
  spawnSync("pkill", ["-f", `${homedir()}/Applications/Panda Bridge.app/Contents/MacOS/Panda Bridge`], { stdio: "ignore" });
}

function hideDesktop() {
  spawnSync("osascript", ["-e", "tell application \"Panda Bridge\" to hide"], { stdio: "ignore" });
}

async function waitForControl(path) {
  return waitFor(() => {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  }, "verify control file was not created", 30000);
}

function makeControlClient(info) {
  return async (method, path, body = null) => {
    const response = await fetch(`${info.base_url}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "x-panda-bridge-verify-token": info.token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
    return payload;
  };
}

async function api(method, path, body = null) {
  const response = await fetch(`${appUrl}${path}`, {
    method,
    headers: {
      accept: "application/json",
      origin: productOrigin,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(sessionJar.cookie ? { cookie: sessionJar.cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) sessionJar.cookie = setCookie.split(";")[0];
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForJobSucceeded(jobId, expected, timeoutMs) {
  return waitFor(async () => {
    const payload = await api("GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
    if (payload.job?.status === "failed" || payload.job?.status === "cancelled") {
      throw new Error(`job ${jobId} ended as ${payload.job.status}: ${JSON.stringify(payload.job.result || {})}`);
    }
    if (payload.job?.status === "succeeded" && String(payload.job.result?.reply || "").includes(expected)) return payload;
    return null;
  }, `job ${jobId} did not complete with expected reply`, timeoutMs);
}

async function fetchEvents(jobId) {
  return api("GET", `/v1/jobs/${encodeURIComponent(jobId)}/events`);
}

function assertJobEvents(events, expected, label) {
  assert.ok(events.every((item) => item.job_id === events[0].job_id), `${label} mixed job ids`);
  const eventTypes = events.map((item) => item.type);
  for (const type of ["queued", "claimed", "started", "text_delta", "completed"]) {
    assert.ok(eventTypes.includes(type), `${label} missing ${type}: ${eventTypes.join(",")}`);
  }
  const streamText = events.filter((item) => item.type === "text_delta").map((item) => item.payload?.delta || "").join("");
  const completed = events.find((item) => item.type === "completed");
  assert.ok(streamText.includes(expected), `${label} stream text did not include expected token`);
  assert.ok(String(completed?.payload?.reply || "").includes(expected), `${label} completed reply did not include expected token`);
}

async function waitForDesktopEvent(control, eventType, timeout = 90000) {
  await waitFor(async () => {
    const events = await control("GET", "/v1/events");
    return (events.items || []).some((item) => item.type === eventType);
  }, `desktop event ${eventType} did not appear`, timeout);
}

async function waitFor(fn, message, timeoutMs = 90000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${message}${last ? `: ${JSON.stringify(last)}` : ""}`);
}

function streamingMetrics(events) {
  const textDeltas = events.filter((event) => event.type === "text_delta");
  const text = textDeltas.map((event) => event.payload?.delta || "").join("");
  const deltaTimes = textDeltas.map((event) => Date.parse(event.created_at || "")).filter(Number.isFinite);
  const gaps = [];
  for (let index = 1; index < deltaTimes.length; index += 1) gaps.push(deltaTimes[index] - deltaTimes[index - 1]);
  return {
    text_delta_count: textDeltas.length,
    text_delta_chars: text.length,
    text_delta_gap_max_ms: gaps.length ? Math.max(...gaps) : null,
  };
}

function copyEvidenceFile(source, name) {
  if (source && existsSync(source)) copyFileSync(source, resolve(evidenceDir, name));
}

function compareJobsByQueueOrder(left, right) {
  const leftTime = Date.parse(left.created_at || "");
  const rightTime = Date.parse(right.created_at || "");
  if (leftTime !== rightTime) return leftTime - rightTime;
  return String(left.job_id || "").localeCompare(String(right.job_id || ""));
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}
