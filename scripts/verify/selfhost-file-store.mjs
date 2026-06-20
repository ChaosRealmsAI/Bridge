#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const runId = process.env.BRIDGE_FILE_STORE_RUN_ID || "20260619T231014Z";
const outDir = resolve(root, "spec/L4/evidence/bridge-connectivity-selfhost-quality-umbrella", runId, "selfhost-file-store");
mkdirSync(outDir, { recursive: true });

const tempDir = mkdtempSync(resolve(tmpdir(), "panda-bridge-file-store-"));
const storePath = resolve(tempDir, "bridge-store.json");
const adminToken = "selfhost-file-store-admin-test";
const installId = "install-file-store-test";
const productId = "panda-burn";
const productOrigin = "https://token-burn.com";
const jar = {};
let generatedPairingToken = "";
let server = null;
let origin = "";

const summary = {
  ok: false,
  checked_at: new Date().toISOString(),
  run_id: runId,
  storage: null,
  restart_boundaries: [],
  pairing: {},
  authorization: {},
  relay: {},
  redaction: {},
};

try {
  await restart("runtime-a-initial");
  const health = await api("GET", "/v1/health");
  assert.equal(health.ok, true);
  assert.equal(health.storage, "durable");
  assert.equal(health.storage_configured, true);
  summary.storage = { kind: health.storage, configured: health.storage_configured };

  const diagnostics = await api("GET", "/v1/diagnostics");
  assert.equal(diagnostics.storage, "durable");
  assert.equal(diagnostics.storage_configured, true);

  const pairing = await api("POST", "/v1/selfhost/pairing-token", {
    device_name: "File Store Desktop",
  }, "", { "x-panda-bridge-selfhost-admin-token": adminToken, origin: null });
  assert.match(pairing.token, /^[A-Z0-9]{4}-[A-Z0-9]{4,6}$/);
  generatedPairingToken = pairing.token;
  summary.pairing.generated = true;

  await restart("runtime-b-before-pair-claim");
  const pairClaim = await desktopApi("POST", "/v1/connectors/claim", {
    code: pairing.token,
    install_id: installId,
    device_name: "File Store Desktop",
    capabilities: { relay: ["relay.envelope", "relay.ack"] },
    local_state: { device_info: safeDeviceInfo() },
  }, "", { "x-panda-bridge-install-id": installId });
  assert.match(pairClaim.device_token, /^pbd_/);
  assert.equal(pairClaim.devices.some((item) => item.id === pairClaim.device.id), true);
  summary.pairing.claim_survived_process_restart = true;

  await restart("runtime-c-before-authorization");
  await api("POST", "/v1/sessions/guest", { display_name: "File Store Tester" }, "", { origin: productOrigin });
  const intent = await api("POST", "/v1/connect-intents", {
    product_id: productId,
    device_name: "File Store Desktop",
    install_id: installId,
  }, "", { origin: productOrigin });
  const claimed = await desktopApi("POST", `/v1/connect-intents/${encodeURIComponent(intent.token)}/claim`, {
    install_id: installId,
    device_name: "File Store Desktop",
    capabilities: { relay: ["relay.envelope", "relay.ack"] },
    local_state: { device_info: safeDeviceInfo() },
  }, "", { "x-panda-bridge-install-id": installId });
  const confirmed = await desktopApi("POST", `/v1/connect-intents/${encodeURIComponent(intent.token)}/confirm`, {
    confirmed: true,
  }, claimed.device_token, { "x-panda-bridge-install-id": installId });
  const deviceToken = confirmed.device_token || claimed.device_token;
  assert.equal(confirmed.authorization.status, "active");
  await desktopApi("POST", "/v1/connectors/heartbeat", {
    install_id: installId,
    capabilities: { relay: ["relay.envelope", "relay.ack"] },
    local_state: { device_info: safeDeviceInfo() },
  }, deviceToken, { "x-panda-bridge-install-id": installId });
  summary.authorization.confirmed = true;

  await restart("runtime-d-before-state-read");
  const state = await api("GET", `/v1/bridge/state?product_id=${encodeURIComponent(productId)}`, null, deviceToken, { "x-panda-bridge-install-id": installId });
  assert.equal(state.product.id, productId);
  assert.equal(state.authorization.status, "active");
  assert.equal(state.devices.some((item) => item.id === claimed.device.id), true);
  summary.authorization.state_survived_process_restart = true;

  const created = await api("POST", `/v1/products/${productId}/relay/envelopes`, relayEnvelope({ device_id: claimed.device.id }), "", { origin: productOrigin });
  assert.equal(created.envelope.device_id, claimed.device.id);
  summary.relay.created = true;

  await restart("runtime-e-before-relay-list");
  const inbox = await desktopApi("GET", "/v1/connectors/relay/envelopes", null, deviceToken, { "x-panda-bridge-install-id": installId });
  assert.equal(inbox.items.some((item) => item.id === created.envelope.id), true);
  await desktopApi("POST", `/v1/connectors/relay/envelopes/${created.envelope.id}/ack`, {}, deviceToken, { "x-panda-bridge-install-id": installId });
  summary.relay.list_survived_process_restart = true;
  summary.relay.ack_after_process_restart = true;

  const concurrentCreated = await Promise.all(
    Array.from({ length: 8 }, (_, index) => api("POST", `/v1/products/${productId}/relay/envelopes`, relayEnvelope({
      device_id: claimed.device.id,
      channel_id: `file-store-concurrent-${index}`,
      seq: index + 2,
      ciphertext: `base64:file-store-concurrent-ciphertext-${index}`,
      aad: `base64:file-store-concurrent-aad-${index}`,
      nonce: `base64:file-store-concurrent-nonce-${index}`,
    }), "", { origin: productOrigin })),
  );
  const concurrentIds = concurrentCreated.map((item) => item.envelope.id);
  assert.equal(new Set(concurrentIds).size, concurrentIds.length);
  summary.relay.concurrent_created = concurrentIds.length;

  await restart("runtime-f-before-concurrent-relay-list");
  const concurrentInbox = await desktopApi("GET", "/v1/connectors/relay/envelopes", null, deviceToken, { "x-panda-bridge-install-id": installId });
  const inboxIds = new Set(concurrentInbox.items.map((item) => item.id));
  assert.deepEqual(concurrentIds.filter((id) => !inboxIds.has(id)), []);
  summary.relay.concurrent_writes_survived_process_restart = true;

  summary.storage.file_size_bytes = statSync(storePath).size;
  assert.ok(summary.storage.file_size_bytes > 0);

  const leaked = forbiddenEvidenceLeaks(`${JSON.stringify(summary)}\n${readFileSync(storePath, "utf8")}`);
  assert.deepEqual(leaked, []);
  summary.redaction.forbidden_leaks = leaked;
  summary.ok = true;
  writeSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.error = String(error?.message || error);
  writeSummary(summary);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await stopServer();
  rmSync(tempDir, { recursive: true, force: true });
}

async function restart(label) {
  await stopServer();
  server = await startServer();
  origin = server.origin;
  summary.restart_boundaries.push(label);
}

async function startServer() {
  const child = spawn(process.execPath, ["scripts/selfhost/bridge-server.mjs", "serve", "--host", "127.0.0.1", "--port", "0", "--no-startup-pair"], {
    cwd: root,
    env: {
      ...process.env,
      BRIDGE_SELFHOST_ADMIN_TOKEN: adminToken,
      BRIDGE_SERVER_STARTUP_PAIR: "0",
      BRIDGE_FILE_STORE_PATH: storePath,
      BRIDGE_LOCAL_MEMORY: "",
      BRIDGE_ENV: "selfhost",
      BRIDGE_WEB_ORIGIN: productOrigin,
      BRIDGE_ALLOWED_ORIGINS: productOrigin,
      BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({ [productId]: [productOrigin] }),
      BRIDGE_PRODUCT_REGISTRY_MODE: "builtin",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const ready = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`bridge-server start timed out: ${stderr}`)), 8000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolveReady(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      rejectReady(new Error(`bridge-server exited before ready: code=${code} signal=${signal} stderr=${stderr}`));
    });
  });
  return { child, origin: ready };
}

async function stopServer() {
  if (!server?.child) return;
  const child = server.child;
  server = null;
  if (child.exitCode != null) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

async function api(method, path, body = null, bearer = "", extraHeaders = {}) {
  const { response, payload } = await apiRaw(method, path, body, bearer, extraHeaders);
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function desktopApi(method, path, body = null, bearer = "", extraHeaders = {}) {
  return await api(method, path, body, bearer, {
    origin: null,
    "x-panda-bridge-local-client": "desktop",
    ...extraHeaders,
  });
}

async function apiRaw(method, path, body = null, bearer = "", extraHeaders = {}) {
  const headers = new Headers({ accept: "application/json" });
  if (body != null) headers.set("content-type", "application/json");
  if (jar.cookie) headers.set("cookie", jar.cookie);
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value != null) headers.set(key, value);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("origin") && !("origin" in extraHeaders)) {
    headers.set("origin", origin);
  }
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body != null && method !== "GET" && method !== "HEAD" ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) jar.cookie = setCookie.split(";")[0];
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : {} };
}

function relayEnvelope(overrides = {}) {
  return {
    device_id: overrides.device_id,
    channel_id: "file-store-channel",
    seq: 1,
    request_key: null,
    ciphertext: "base64:file-store-ciphertext",
    aad: "base64:file-store-aad",
    nonce: "base64:file-store-nonce",
    algorithm: "Noise_XX_25519_ChaChaPoly_BLAKE2s",
    sender_key_id: "product-key-1",
    recipient_key_id: "device-key-1",
    ttl_ms: 300000,
    meta: { adapter_id: productId },
    ...overrides,
  };
}

function safeDeviceInfo() {
  return {
    display_name: "File Store Mac",
    model: "MacBookPro18,3",
    os: "macos",
    arch: "arm64",
    fingerprint: "PB-FILE1234",
    identity_source: "local_install",
  };
}

function forbiddenEvidenceLeaks(text) {
  const checks = [
    [/\bpbd_[A-Za-z0-9._~-]+/g, "device token"],
    [/\bpbi_[A-Za-z0-9._~-]+/g, "intent token"],
    [new RegExp(adminToken, "g"), "admin token"],
    [/\/Users\/[A-Za-z0-9._-]+/g, "user path"],
    [/\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168|169\.254)\.\d{1,3}\.\d{1,3}\b/g, "private ip"],
    [/\b[A-F0-9]{2}(?::[A-F0-9]{2}){5}\b/gi, "mac"],
  ];
  if (generatedPairingToken) checks.push([new RegExp(escapeRegExp(generatedPairingToken), "g"), "pairing token"]);
  return checks.flatMap(([pattern, label]) => [...text.matchAll(pattern)].map((match) => `${label}: ${match[0]}`));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeSummary(value) {
  writeFileSync(resolve(outDir, "summary.json"), `${JSON.stringify(value, null, 2)}\n`);
}
