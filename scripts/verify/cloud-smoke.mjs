#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

const apiBase = (process.env.PANDA_BRIDGE_API_BASE || "https://api.bridge.otherline.cc").replace(/\/$/, "");
const productId = process.env.PANDA_BRIDGE_PRODUCT_ID || "panda-chat";
const productOrigin = process.env.PANDA_BRIDGE_PRODUCT_ORIGIN || (productId === "panda-dev" ? "https://dev.otherline.cc" : "https://bridge.otherline.cc");
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-cloud-smoke-"));
const statePath = resolve(temp, "connector.json");
const evidenceDir = resolve("spec/verification/evidence/cloud-smoke");
mkdirSync(evidenceDir, { recursive: true });

let cookie = "";
const fetchJar = async (url, init = {}) => {
  const headers = new Headers(init.headers || {});
  headers.set("origin", productOrigin);
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(url, { ...init, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return response;
};

const bridge = createBridgeClient({ apiBase, productId, fetch: fetchJar });
const session = await bridge.auth.guest("Cloud Smoke");
assert.equal(session.authenticated, true);

const intent = await bridge.connect.createIntent({ deviceName: "Cloud Smoke Connector" });
const claim = await runCli([
  "apps/connector-cli/src/cli.mjs",
  "connect",
  "--api",
  apiBase,
  "--intent",
  intent.token,
  "--device-name",
  "Cloud Smoke Connector",
  "--state",
  statePath,
  "--yes",
]);
assert.equal(claim.status, 0, childMessage(claim));

const devices = await bridge.devices.list();
const device = devices.items.find((item) => item.device_name === "Cloud Smoke Connector");
assert.ok(device, "claimed cloud smoke connector was not listed");
await bridge.products.requestAuthorization(device.id);

const created = await bridge.codex.run({
  deviceId: device.id,
  prompt: "hello production cloud smoke",
  requestKey: `cloud-smoke-${Date.now()}`,
  tokenBudget: 1000,
  timeoutMs: 60000,
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
assert.match(final.job.result.reply, /hello production cloud smoke/);
const events = await bridge.jobs.events(created.job.id);
assert.ok(events.items.length >= 3);

const summary = {
  ok: true,
  api_base: apiBase,
  product_id: productId,
  session_user_id: session.user.id,
  device_id: device.id,
  job_id: created.job.id,
  final_status: final.job.status,
  event_count: events.items.length,
  checked_at: new Date().toISOString(),
};
writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));

function runCli(args, options = {}) {
  return new Promise((resolveChild) => {
    const child = spawn("node", args, {
      env: process.env,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    let error = null;
    const timer = setTimeout(() => {
      error = new Error("child process timed out");
      child.kill("SIGTERM");
    }, 30000);
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
