#!/usr/bin/env node
// Minimal Panda Bridge caller — runnable locally against the in-memory Worker.
//
// Demonstrates the v2 account-level flow end to end:
//   1. SERVER  creates a connect intent (delegated, HMAC-signed by the SDK)
//   2. DESKTOP claims the intent (simulates the user approving on their Mac)
//   3. FRONT   reads account-level state and shows authorization + connection
//   4. SERVER  runs codex.chat once the account is active + connected
//
// No external server is started: the Worker fetch handler runs in-process.
// Run with:  node examples/minimal-caller/run-local.mjs

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeServerClient } from "../../packages/sdk/src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const apiBase = "http://minimal-caller.local";
const productId = "otherline";
const delegationSecret = "minimal-caller-otherline-secret";

// Worker env: in-memory storage + this product's delegation secret + allowed origin.
const env = {
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_WEB_ORIGIN: apiBase,
  BRIDGE_PUBLIC_API_BASE: apiBase,
  SESSION_COOKIE_NAME: "pb_session",
  BRIDGE_OTHERLINE_DELEGATION_SECRET: delegationSecret,
  BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({ [productId]: [apiBase] }),
};

// Drives the Worker in-process. The SDK only sees a normal fetch.
async function workerFetch(url, init = {}) {
  const method = init.method || "GET";
  const request = new Request(url, {
    method,
    headers: new Headers(init.headers || {}),
    body: init.body != null && method !== "GET" && method !== "HEAD" ? init.body : undefined,
  });
  return worker.fetch(request, env);
}

// ---- Backend caller: this is all the product's server needs. ------------------
const bridge = createBridgeServerClient({
  apiBase,
  productId,
  secret: delegationSecret,
  fetch: workerFetch,
});

const userId = `minimal-caller-user-${Date.now()}`;

// 1) SERVER: empty to start — no account is authorized yet.
const initialState = await bridge.state({ userId });
assert.equal(initialState.ready, false);
assert.deepEqual(initialState.accounts, []);
console.log("1. state(): no account yet, ready =", initialState.ready);

// 2) SERVER: create a connect intent. The SDK signs the request for you.
const intent = await bridge.createConnectIntent({
  userId,
  account: { display_name: "Minimal Caller User" },
  deviceName: "Minimal Caller Mac",
});
assert.match(intent.token, /^pbi_/);
console.log("2. createConnectIntent(): token =", `${intent.token.slice(0, 12)}…`);
console.log("   front-end opens intent.deep_link to launch Panda Bridge Desktop");

// 3) DESKTOP: the user approves on their Mac. The desktop app natively claims the
//    intent (browsers can NEVER claim — that returns desktop_claim_required).
const claim = await desktopClaim(intent.token, {
  device_name: "Minimal Caller Mac",
  install_id: "minimal-caller-install-id",
});
const deviceId = claim.device.id;
const deviceToken = claim.device_token;
console.log("3. desktop claimed the intent → account authorized + device online");

// 4) FRONT: re-read account-level state. Authorization is active, connection is
//    automatic — the caller only reads the `connected` boolean.
const state = await bridge.state({ userId });
const account = state.current_account;
assert.equal(account.authorization.status, "active");
assert.equal(account.connected, true);
assert.equal(state.ready, true);
console.log("4. state(): account =", account.account?.display_name,
  "| authorization =", account.authorization.status,
  "| connected =", account.connected);

// 5) SERVER: run codex.chat now that the account is active + connected.
const job = await bridge.createJob({
  userId,
  deviceId,
  kind: "codex.chat",
  input: { prompt: "只回复 OK" },
  requestKey: `minimal-caller-${Date.now()}`,
});
console.log("5. createJob(codex.chat): job =", job.job.id, "status =", job.job.status);

// The desktop connector executes the job locally and reports the result back.
// (In production this is the real desktop app running Codex; here we fulfil it.)
await connectorComplete(deviceToken, "Panda Bridge minimal caller reply: OK");

const events = await bridge.jobEvents(job.job.id, { userId, deviceId });
const types = new Set(events.items.map((item) => item.type));
assert.equal(types.has("completed"), true);
console.log("   job events:", [...types].join(", "));

console.log("\nDONE — server-created intent → desktop approval → codex.chat round trip.");

// ---- Helpers that stand in for the native desktop app + local connector. ------
// These are NOT part of the product caller's responsibility; the real desktop
// app does them. They use the public connector API only.

async function desktopClaim(token, body) {
  const path = `/v1/connect-intents/${encodeURIComponent(token)}/claim`;
  const response = await workerFetch(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-panda-bridge-local-client": "connector-cli",
      "x-panda-bridge-install-id": body.install_id,
    },
    body: JSON.stringify({
      device_name: body.device_name,
      install_id: body.install_id,
      app_version: "minimal-caller-v0.1",
      capabilities: { codex: ["codex.chat"] },
      local_state: { platform: "local-fixture" },
    }),
  });
  const payload = JSON.parse(await response.text());
  assert.ok(response.ok, `claim failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function connectorComplete(deviceToken, reply) {
  const list = await connector(deviceToken, "GET", "/v1/connectors/jobs");
  assert.ok(list.items.length > 0, "expected a queued connector job");
  for (const item of list.items) {
    await connector(deviceToken, "POST", `/v1/connectors/jobs/${encodeURIComponent(item.id)}/events`, {
      type: "started",
      payload: { kind: item.kind },
    });
    await connector(deviceToken, "POST", `/v1/connectors/jobs/${encodeURIComponent(item.id)}/ack`, {
      status: "succeeded",
      result: { ok: true, reply, fixture: true },
    });
  }
}

async function connector(deviceToken, method, path, body = null) {
  const response = await workerFetch(`${apiBase}${path}`, {
    method,
    headers: {
      accept: "application/json",
      origin: apiBase,
      authorization: `Bearer ${deviceToken}`,
      "x-panda-bridge-install-id": "minimal-caller-install-id",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = JSON.parse(await response.text());
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

void repoRoot;
