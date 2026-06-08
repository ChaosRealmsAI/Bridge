#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

const VERSION = "v9-authorization-logout-boundary";
const evidenceDir = resolve("spec/verification/evidence", VERSION);
mkdirSync(evidenceDir, { recursive: true });

const env = {
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_WEB_ORIGIN: "http://127.0.0.1:0",
  BRIDGE_PUBLIC_API_BASE: "http://127.0.0.1:0",
  SESSION_COOKIE_NAME: "pb_session",
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const body = await readIncoming(incoming);
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}${incoming.url}`;
    const request = new Request(url, {
      method: incoming.method,
      headers: incomingHeaders(incoming.headers),
      body: body.length && incoming.method !== "GET" && incoming.method !== "HEAD" ? body : undefined,
    });
    const response = await worker.fetch(request, {
      ...env,
      BRIDGE_WEB_ORIGIN: `http://127.0.0.1:${port}`,
      BRIDGE_PUBLIC_API_BASE: `http://127.0.0.1:${port}`,
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ error: "authorization_logout_proxy_error", message: error.message || String(error) }));
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const apiBase = `http://127.0.0.1:${server.address().port}`;
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-authz-logout-"));
const statePath = resolve(temp, "desktop.json");

try {
  let cookie = "";
  const fetchJar = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  };
  const bridge = createBridgeClient({ apiBase, productId: "panda-chat", fetch: fetchJar });

  const session = await bridge.auth.guest("Authorization Logout Boundary");
  assert.equal(session.authenticated, true);

  const firstIntent = await bridge.connect.createIntent({ deviceName: "Authorization Logout Boundary Device" });
  const firstConnect = await runDesktop(["headless-connect", "--api", apiBase, "--intent", firstIntent.token, "--device-name", "Authorization Logout Boundary Device"]);
  assert.equal(firstConnect.status, 0, childMessage(firstConnect));

  const devices = await bridge.devices.list();
  const device = devices.items.find((item) => item.device_name === "Authorization Logout Boundary Device");
  assert.ok(device, "authorized desktop device was not visible");

  const statusBefore = await desktopJson(["headless-status"]);
  assert.ok(statusBefore.authorized_products.some((item) => item.id === "panda-chat"), "desktop status did not show panda-chat before revoke");
  const readyBefore = await bridge.preflight({ deviceId: device.id });
  assert.equal(readyBefore.ready, true);

  const queuedBeforeRevoke = await bridge.codex.run({
    deviceId: device.id,
    prompt: "queued before authorization logout",
    requestKey: "v9-queued-before-logout",
    tokenBudget: 1000,
    timeoutMs: 60000,
  });
  assert.equal(queuedBeforeRevoke.job.status, "queued");

  const revokeResult = await desktopJson(["headless-revoke-authorization", "--product-id", "panda-chat"]);
  assert.equal(revokeResult.ok, true);
  assert.equal(revokeResult.authorization.status, "revoked");
  assert.equal(revokeResult.cancelled_jobs, 1);

  const statusAfterRevoke = await desktopJson(["headless-status"]);
  assert.equal(statusAfterRevoke.authorized_products.some((item) => item.id === "panda-chat"), false);
  assert.equal(statusAfterRevoke.product_id, null);

  const cancelledQueued = await bridge.jobs.get(queuedBeforeRevoke.job.id);
  assert.equal(cancelledQueued.job.status, "cancelled");
  assert.equal(cancelledQueued.job.result.error, "product_not_authorized");

  const preflightAfterRevoke = await bridge.preflight({ deviceId: device.id });
  assert.equal(preflightAfterRevoke.ready, false);
  assert.equal(preflightAfterRevoke.issues.some((item) => item.code === "product_not_authorized"), true);

  const pollAfterRevoke = await desktopJson(["headless-poll"]);
  assert.equal(pollAfterRevoke.ok, true);
  assert.equal(pollAfterRevoke.count, 0);
  const statusAfterHeartbeat = await desktopJson(["headless-status"]);
  assert.equal(statusAfterHeartbeat.authorized_products.some((item) => item.id === "panda-chat"), false);

  await expectSdkError(
    () => bridge.codex.run({
      deviceId: device.id,
      prompt: "must fail after logout",
      requestKey: "v9-after-logout-must-fail",
      tokenBudget: 1000,
      timeoutMs: 60000,
    }),
    403,
    "product_not_authorized",
  );

  const reconnectIntent = await bridge.connect.createIntent({ deviceName: "Authorization Logout Boundary Device" });
  const reconnect = await runDesktop(["headless-connect", "--api", apiBase, "--intent", reconnectIntent.token, "--device-name", "Authorization Logout Boundary Device"]);
  assert.equal(reconnect.status, 0, childMessage(reconnect));

  const statusAfterReconnect = await desktopJson(["headless-status"]);
  assert.ok(statusAfterReconnect.authorized_products.some((item) => item.id === "panda-chat"), "explicit reconnect did not restore local authorization");
  const preflightAfterReconnect = await bridge.preflight({ deviceId: device.id });
  assert.equal(preflightAfterReconnect.ready, true);

  const restoredJob = await bridge.codex.run({
    deviceId: device.id,
    prompt: "authorization logout restored",
    requestKey: "v9-after-explicit-reconnect",
    tokenBudget: 1000,
    timeoutMs: 60000,
  });
  assert.equal(restoredJob.job.status, "queued");
  const pollAfterReconnect = await desktopJson(["headless-poll"]);
  assert.equal(pollAfterReconnect.ok, true);
  assert.equal(pollAfterReconnect.count, 1);
  const final = await bridge.jobs.wait(restoredJob.job.id, { timeoutMs: 30000, intervalMs: 500 });
  assert.equal(final.status, "succeeded");
  assert.match(final.result.reply, /authorization logout restored/);

  const summary = redact({
    ok: true,
    version: VERSION,
    api_base: apiBase,
    session_user_id: session.user.id,
    device_id: device.id,
    state_path: statePath,
    before: {
      desktop_authorized: statusBefore.authorized_products.map((item) => item.id),
      preflight_ready: readyBefore.ready,
    },
    revoked: {
      desktop_authorized: statusAfterRevoke.authorized_products.map((item) => item.id),
      preflight_ready: preflightAfterRevoke.ready,
      preflight_issues: preflightAfterRevoke.issues.map((item) => item.code),
      queued_job_status: cancelledQueued.job.status,
      heartbeat_poll_count: pollAfterRevoke.count,
      sdk_job_error: "product_not_authorized",
      cancelled_jobs: revokeResult.cancelled_jobs,
    },
    reconnected: {
      desktop_authorized: statusAfterReconnect.authorized_products.map((item) => item.id),
      preflight_ready: preflightAfterReconnect.ready,
      restored_job_id: restoredJob.job.id,
      final_status: final.status,
    },
    source_access: "Desktop headless operation surface plus SDK-as-user calls; no storage or implementation state reads.",
    checked_at: new Date().toISOString(),
  });
  writeFileSync(resolve(evidenceDir, "authorization-logout-boundary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function desktopJson(args) {
  const result = await runDesktop(args);
  assert.equal(result.status, 0, childMessage(result));
  return JSON.parse(result.stdout);
}

function runDesktop(args) {
  return new Promise((resolveChild) => {
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
      env: {
        ...process.env,
        PANDA_BRIDGE_DESKTOP_STATE: statePath,
        PANDA_BRIDGE_FAKE_CODEX: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let error = null;
    const timer = setTimeout(() => {
      error = new Error("desktop child timed out");
      child.kill("SIGTERM");
    }, 60000);
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
      resolveChild({ status, signal, stdout, stderr, error });
    });
  });
}

async function expectSdkError(operation, status, errorCode) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.status, status);
    assert.equal(error.payload?.error, errorCode);
    return;
  }
  assert.fail(`Expected SDK error ${status} ${errorCode}`);
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

function redact(value) {
  const text = JSON.stringify(value, (key, item) => {
    if (/token|cookie|authorization/i.test(key)) return "[redacted]";
    return item;
  });
  return JSON.parse(text);
}
