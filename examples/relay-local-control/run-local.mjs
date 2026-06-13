#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";
import {
  decryptResponseEnvelope,
  encryptCommandEnvelope,
  startRelayLocalControlAdapter,
} from "./adapter.mjs";

const evidenceDir = resolve("spec/verification/evidence/relay-local-control");
mkdirSync(evidenceDir, { recursive: true });

const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-relay-local-control-"));
const statePath = resolve(temp, "desktop-state.json");
const workerServer = await startLocalWorker();
const adapter = await startRelayLocalControlAdapter({ root: process.cwd() });
const apiBase = workerServer.apiBase;
const serverVisibleChecks = [];

try {
  const bridge = createBridgeClient({ apiBase, productId: "panda-chat", fetch: fetchWithJar(apiBase) });
  const session = await bridge.auth.guest("Relay Local Control");
  assert.equal(session.authenticated, true);
  const intent = await bridge.connect.createIntent({ deviceName: "Relay Local Control Device" });
  const connected = await runDesktop([
    "headless-connect",
    "--api",
    apiBase,
    "--intent",
    intent.token,
    "--device-name",
    "Relay Local Control Device",
  ]);
  assert.equal(connected.status, 0, childMessage(connected));
  const claim = JSON.parse(connected.stdout);
  assert.ok(claim.device_id, "headless-connect must return device_id");

  const pwd = await runCommandThroughBridge(bridge, claim.device_id, "chan_1", 1, { op: "pwd" }, {
    failFirstConnectorAck: true,
  });
  assert.equal(pwd.ok, true);
  assert.equal(pwd.op, "pwd");
  assert.equal(pwd.stdout, process.cwd());

  const ls = await runCommandThroughBridge(bridge, claim.device_id, "chan_2", 10, { op: "ls", path: "." });
  assert.equal(ls.ok, true);
  assert.equal(ls.op, "ls");
  assert.ok(ls.entries.some((item) => item.name === "package.json"), "ls result must include repo package.json");

  const legacyJobs = await fetch(`${apiBase}/v1/products/panda-chat/jobs`, {
    method: "POST",
    headers: { origin: apiBase, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ kind: "shell.run", input: { command: "pwd" } }),
  });
  const legacyPayload = await legacyJobs.json();
  assert.equal(legacyJobs.status, 410);
  assert.equal(legacyPayload.error, "legacy_runtime_api_removed");

  const summary = {
    ok: true,
    api_base: apiBase,
    adapter_url: adapter.url,
    desktop_state_path: statePath,
    device_id: claim.device_id,
    commands: {
      pwd: { ok: pwd.ok, stdout: pwd.stdout },
      ls: { ok: ls.ok, count: ls.entries.length, includes_package_json: true },
    },
    adapter_calls: adapter.calls,
    adapter_executions: adapter.executions,
    legacy_jobs: { status: legacyJobs.status, error: legacyPayload.error },
    server_visible_plaintext: serverVisibleChecks.some((item) => item.leaked),
    server_visible_checks: serverVisibleChecks,
    checked_at: new Date().toISOString(),
  };
  assert.equal(summary.server_visible_plaintext, false, "server-visible relay fields leaked product plaintext");
  writeFileSync(resolve(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await adapter.close();
  await workerServer.close();
}

async function runCommandThroughBridge(bridge, deviceId, channelId, seq, command, options = {}) {
  const requestKey = `relay-local-control-${seq}-${Date.now()}`;
  const envelope = await encryptCommandEnvelope(command, adapter.keyBytes, {
    product_id: "panda-chat",
    device_id: deviceId,
    channel_id: channelId,
    seq,
    request_key: requestKey,
  });
  const created = await bridge.relay.create(envelope);
  assert.equal(created.envelope.direction, "product_to_device");
  recordNoServerVisiblePlaintext(`${command.op}:request`, created.envelope, plaintextTokensFor(command));

  if (options.failFirstConnectorAck) {
    workerServer.failNextConnectorAckFor(created.envelope.id);
    const failedPoll = await runDesktop(["headless-poll"]);
    assert.notEqual(failedPoll.status, 0, "first poll should fail after response upload when connector ack is fault-injected");
    assert.equal(executionsFor(created.envelope.id), 1, "first delivery should execute exactly once");
    const retried = await runDesktop(["headless-poll"]);
    assertPollProcessed(retried);
    assert.equal(executionsFor(created.envelope.id), 1, "retry must reuse cached response without re-running local command");
    assert.equal(callsFor(created.envelope.id), 2, "retry should call adapter once for replay");
    assert.equal(adapter.calls.some((item) => item.envelope_id === created.envelope.id && item.replay === true), true);
  } else {
    assertPollProcessed(await runDesktop(["headless-poll"]));
  }

  const responseEnvelope = await bridge.relay.wait({ deviceId, channelId, afterSeq: seq, timeoutMs: 10000, intervalMs: 250 });
  assert.equal(responseEnvelope.direction, "device_to_product");
  const result = await decryptResponseEnvelope(responseEnvelope, adapter.keyBytes);
  recordNoServerVisiblePlaintext(`${command.op}:response`, responseEnvelope, plaintextTokensFor(command, result));
  await bridge.relay.ack(responseEnvelope.id, { status: "acked" });
  return result;
}

async function startLocalWorker() {
  const env = {
    BRIDGE_LOCAL_MEMORY: "1",
    BRIDGE_WEB_ORIGIN: "http://127.0.0.1:0",
    BRIDGE_PUBLIC_API_BASE: "http://127.0.0.1:0",
    SESSION_COOKIE_NAME: "pb_session",
  };
  const failConnectorAckOnce = new Set();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await readIncoming(incoming);
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}${incoming.url}`;
      const parsed = new URL(url);
      const connectorAckMatch = parsed.pathname.match(/^\/v1\/connectors\/relay\/envelopes\/([^/]+)\/ack$/);
      if (incoming.method === "POST" && connectorAckMatch) {
        const envelopeId = decodeURIComponent(connectorAckMatch[1]);
        if (failConnectorAckOnce.delete(envelopeId)) {
          outgoing.writeHead(503, { "content-type": "application/json; charset=utf-8" });
          outgoing.end(JSON.stringify({ error: "fault_injected_connector_ack_failed", envelope_id: envelopeId }));
          return;
        }
      }
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
        }),
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      outgoing.end(JSON.stringify({ error: "relay_local_control_proxy_error", message: error.message || String(error) }));
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    failNextConnectorAckFor: (envelopeId) => failConnectorAckOnce.add(String(envelopeId || "")),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function assertPollProcessed(child) {
  assert.equal(child.status, 0, childMessage(child));
  const pollPayload = JSON.parse(child.stdout);
  assert.equal(pollPayload.ok, true);
  assert.ok(pollPayload.count >= 1, "headless-poll must process at least one relay envelope");
  return pollPayload;
}

function executionsFor(envelopeId) {
  return adapter.executions.filter((item) => item.envelope_id === envelopeId).length;
}

function callsFor(envelopeId) {
  return adapter.calls.filter((item) => item.envelope_id === envelopeId).length;
}

function plaintextTokensFor(command, result = {}) {
  return [
    command.op,
    command.path && command.path !== "." ? command.path : "",
    result.op,
    result.stdout,
    process.cwd(),
  ].filter((value) => typeof value === "string" && value.length > 1);
}

function recordNoServerVisiblePlaintext(label, envelope, tokens) {
  const values = serverVisibleStringValues(envelope);
  const leaks = tokens.filter((token) => values.some((value) => value.includes(token)));
  const check = { label, leaked: leaks.length > 0, leaks };
  serverVisibleChecks.push(check);
  assert.deepEqual(leaks, [], `${label} leaked product plaintext into server-visible fields`);
}

function serverVisibleStringValues(input, key = "") {
  if (input == null) return [];
  if (["ciphertext", "aad", "nonce"].includes(key)) return [];
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.flatMap((item) => serverVisibleStringValues(item));
  if (typeof input === "object") {
    return Object.entries(input).flatMap(([nextKey, value]) => serverVisibleStringValues(value, nextKey));
  }
  return [];
}

function fetchWithJar(origin) {
  let cookie = "";
  return async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", origin);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  };
}

function runDesktop(args) {
  return new Promise((resolve) => {
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
      env: {
        ...process.env,
        PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1",
        PANDA_BRIDGE_DESKTOP_STATE: statePath,
        PANDA_BRIDGE_ADAPTER_PANDA_CHAT_URL: adapter.url,
        PANDA_BRIDGE_SKIP_KEYCHAIN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function childMessage(child) {
  return JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr });
}

async function readIncoming(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function incomingHeaders(headers) {
  const next = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) next.set(key, value.join(", "));
    else if (value != null) next.set(key, String(value));
  }
  return next;
}
