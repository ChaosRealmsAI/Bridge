#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

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
      BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({
        "panda-chat": [`http://127.0.0.1:${port}`],
        "panda-dev": [`http://127.0.0.1:${port}`],
        "panda-spec": [`http://127.0.0.1:${port}`],
      }),
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ error: "desktop_lite_proxy_error", message: error.message || String(error) }));
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const apiBase = `http://127.0.0.1:${server.address().port}`;
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-desktop-lite-"));
const statePath = resolve(temp, "desktop.json");
const evidenceDir = resolve("spec/verification/evidence/desktop-lite-smoke");
mkdirSync(evidenceDir, { recursive: true });

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
  const bridge = createBridgeClient({ apiBase, productId: "panda-chat", fetch: fetchJar });
  const session = await bridge.auth.guest("Desktop Lite Smoke");
  assert.equal(session.authenticated, true);

  const intent = await bridge.connect.createIntent({ deviceName: "Desktop Lite Smoke Device" });
  const connected = await runDesktop(["headless-connect", "--api", apiBase, "--intent", intent.token, "--device-name", "Desktop Lite Smoke Device"], {
    PANDA_BRIDGE_DESKTOP_STATE: statePath,
    PANDA_BRIDGE_FAKE_CODEX: "1",
  });
  assert.equal(connected.status, 0, childMessage(connected));

  const devices = await bridge.devices.list();
  const device = devices.items.find((item) => item.device_name === "Desktop Lite Smoke Device");
  assert.ok(device, "desktop-lite claimed device was not listed");

  const share = await bridge.auth.share();
  let mobileCookie = "";
  const mobileFetch = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", apiBase);
    if (mobileCookie) headers.set("cookie", mobileCookie);
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) mobileCookie = setCookie.split(";")[0];
    return response;
  };
  const mobile = createBridgeClient({ apiBase, productId: "panda-chat", fetch: mobileFetch });
  await mobile.auth.join(share.token);
  const mobileDevices = await mobile.devices.list();
  assert.ok(mobileDevices.items.some((item) => item.id === device.id), "mobile session did not see desktop device");

  const created = await mobile.codex.run({
    deviceId: device.id,
    prompt: "hello from mobile",
    requestKey: "desktop-lite-mobile-1",
    tokenBudget: 1000,
    timeoutMs: 60000,
  });
  assert.equal(created.job.status, "queued");

  const polled = await runDesktop(["headless-poll"], {
    PANDA_BRIDGE_DESKTOP_STATE: statePath,
    PANDA_BRIDGE_FAKE_CODEX: "1",
  });
  assert.equal(polled.status, 0, childMessage(polled));

  const final = await mobile.jobs.wait(created.job.id, { timeoutMs: 30000, intervalMs: 500 });
  assert.equal(final.status, "succeeded");
  assert.match(final.result.reply, /hello from mobile/);
  const events = await mobile.jobs.events(created.job.id);
  assert.ok(events.items.length >= 3);

  const summary = {
    ok: true,
    api_base: apiBase,
    desktop_state_path: statePath,
    session_user_id: session.user.id,
    mobile_joined: true,
    device_id: device.id,
    job_id: created.job.id,
    final_status: final.status,
    event_count: events.items.length,
    checked_at: new Date().toISOString(),
  };
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

function runDesktop(args, extraEnv = {}) {
  return new Promise((resolveChild) => {
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
      env: { ...process.env, PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1", ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    let error = null;
    const timer = setTimeout(() => {
      error = new Error("desktop-lite child timed out");
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
