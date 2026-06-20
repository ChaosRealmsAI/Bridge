#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import worker, { BridgeTestStore } from "../../apps/cloud-worker/src/index.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const runId = process.env.BRIDGE_DURABLE_RESTART_RUN_ID || "20260619T231014Z";
const outDir = resolve(root, "spec/L4/evidence/bridge-connectivity-selfhost-quality-umbrella", runId, "selfhost-durable-restart");
mkdirSync(outDir, { recursive: true });

const origin = "http://durable-selfhost.test";
const productOrigin = "https://token-burn.com";
const productId = "panda-burn";
const installId = "install-durable-restart";
const adminToken = "selfhost-durable-admin-test";
const namespace = durableNamespace();
const jar = {};
let runtimeLabel = "runtime-a";

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
  const health = await api("GET", "/v1/health");
  assert.equal(health.ok, true);
  assert.equal(health.storage, "durable");
  assert.equal(health.storage_configured, true);
  summary.storage = { kind: health.storage, configured: health.storage_configured };

  const diagnostics = await api("GET", "/v1/diagnostics");
  assert.equal(diagnostics.storage, "durable");
  assert.equal(diagnostics.storage_configured, true);

  const pairing = await api("POST", "/v1/selfhost/pairing-token", {
    device_name: "Durable Restart Desktop",
  }, "", { "x-panda-bridge-selfhost-admin-token": adminToken });
  assert.match(pairing.token, /^[A-Z0-9]{4}-[A-Z0-9]{4,6}$/);
  summary.pairing.generated = true;
  summary.pairing.token_not_stored_in_plaintext = !storeText().includes(pairing.token);
  assert.equal(summary.pairing.token_not_stored_in_plaintext, true);

  restart("runtime-b-before-pair-claim");
  const pairClaim = await desktopApi("POST", "/v1/connectors/claim", {
    code: pairing.token,
    install_id: installId,
    device_name: "Durable Restart Desktop",
    capabilities: { relay: ["relay.envelope", "relay.ack"] },
    local_state: { device_info: safeDeviceInfo() },
  }, "", { "x-panda-bridge-install-id": installId });
  assert.match(pairClaim.device_token, /^pbd_/);
  assert.equal(pairClaim.devices.some((item) => item.id === pairClaim.device.id), true);
  summary.pairing.claim_survived_restart = true;
  summary.pairing.consumed = true;

  restart("runtime-c-before-authorization");
  await api("POST", "/v1/sessions/guest", { display_name: "Durable Restart Tester" }, "", { origin: productOrigin });
  const intent = await api("POST", "/v1/connect-intents", {
    product_id: productId,
    device_name: "Durable Restart Desktop",
    install_id: installId,
  }, "", { origin: productOrigin });
  const claimed = await desktopApi("POST", `/v1/connect-intents/${encodeURIComponent(intent.token)}/claim`, {
    install_id: installId,
    device_name: "Durable Restart Desktop",
    capabilities: { relay: ["relay.envelope", "relay.ack"] },
    local_state: { device_info: safeDeviceInfo() },
  }, "", { "x-panda-bridge-install-id": installId });
  const confirmed = await desktopApi("POST", `/v1/connect-intents/${encodeURIComponent(intent.token)}/confirm`, {
    confirmed: true,
  }, claimed.device_token, { "x-panda-bridge-install-id": installId });
  const deviceToken = confirmed.device_token || claimed.device_token;
  assert.equal(confirmed.authorization.status, "active");
  const heartbeat = await desktopApi("POST", "/v1/connectors/heartbeat", {
    install_id: installId,
    capabilities: { relay: ["relay.envelope", "relay.ack"] },
    local_state: { device_info: safeDeviceInfo() },
  }, deviceToken, { "x-panda-bridge-install-id": installId });
  assert.equal(heartbeat.device.status, "online");
  summary.authorization.confirmed = true;

  restart("runtime-d-before-state-read");
  const state = await api("GET", `/v1/bridge/state?product_id=${encodeURIComponent(productId)}`, null, deviceToken, { "x-panda-bridge-install-id": installId });
  const stateDevice = state.devices.find((item) => item.id === claimed.device.id);
  assert.equal(stateDevice.id, claimed.device.id);
  assert.equal(state.product.id, productId);
  assert.equal(state.authorization.status, "active");
  summary.authorization.state_survived_restart = true;

  const envelope = relayEnvelope({ device_id: claimed.device.id });
  const created = await api("POST", `/v1/products/${productId}/relay/envelopes`, envelope, "", { origin: productOrigin });
  assert.equal(created.envelope.device_id, claimed.device.id);
  summary.relay.created = true;

  restart("runtime-e-before-relay-list");
  const inbox = await desktopApi("GET", "/v1/connectors/relay/envelopes", null, deviceToken, { "x-panda-bridge-install-id": installId });
  assert.equal(inbox.items.some((item) => item.id === created.envelope.id), true);
  await desktopApi("POST", `/v1/connectors/relay/envelopes/${created.envelope.id}/ack`, {}, deviceToken, { "x-panda-bridge-install-id": installId });
  summary.relay.list_survived_restart = true;
  summary.relay.ack_after_restart = true;

  const leaked = forbiddenEvidenceLeaks(JSON.stringify({ summary, store: namespace.snapshot() }));
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
}

function restart(label) {
  runtimeLabel = label;
  summary.restart_boundaries.push(label);
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
  const response = await worker.fetch(new Request(`${origin}${path}`, {
    method,
    headers,
    body: body != null && method !== "GET" && method !== "HEAD" ? JSON.stringify(body) : undefined,
  }), makeEnv());
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) jar.cookie = setCookie.split(";")[0];
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : {} };
}

function makeEnv() {
  return {
    BRIDGE_ENV: "selfhost",
    BRIDGE_STORAGE_BACKEND: "durable",
    BRIDGE_LOCAL_MEMORY: "",
    BRIDGE_TEST_STORE: namespace,
    BRIDGE_WEB_ORIGIN: productOrigin,
    BRIDGE_PUBLIC_API_BASE: origin,
    BRIDGE_ALLOWED_ORIGINS: `${origin} ${productOrigin}`,
    BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({ [productId]: [productOrigin, origin] }),
    BRIDGE_PRODUCT_REGISTRY_MODE: "builtin",
    BRIDGE_SELFHOST_ADMIN_TOKEN: adminToken,
    SESSION_COOKIE_NAME: "pb_session",
    BRIDGE_TEST_RUNTIME_LABEL: runtimeLabel,
  };
}

function durableNamespace() {
  const states = new Map();
  return {
    idFromName(name) {
      return `durable:${name}`;
    },
    get(id) {
      if (!states.has(id)) states.set(id, durableState());
      const store = new BridgeTestStore(states.get(id), {});
      return {
        fetch(input, init) {
          return store.fetch(input instanceof Request ? input : new Request(input, init));
        },
      };
    },
    snapshot() {
      return Object.fromEntries([...states.entries()].map(([id, state]) => [id, state.snapshot()]));
    },
  };
}

function durableState() {
  const data = new Map();
  return {
    storage: {
      async get(key) {
        return structuredClone(data.get(key));
      },
      async put(key, value) {
        data.set(key, structuredClone(value));
      },
    },
    snapshot() {
      return Object.fromEntries([...data.entries()]);
    },
  };
}

function relayEnvelope(overrides = {}) {
  return {
    device_id: overrides.device_id,
    channel_id: "durable-restart-channel",
    seq: 1,
    request_key: null,
    ciphertext: "base64:durable-ciphertext",
    aad: "base64:durable-aad",
    nonce: "base64:durable-nonce",
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
    display_name: "Durable Restart Mac",
    model: "MacBookPro18,3",
    os: "macos",
    arch: "arm64",
    fingerprint: "PB-DURABLE1234",
    identity_source: "local_install",
  };
}

function storeText() {
  return JSON.stringify(namespace.snapshot());
}

function forbiddenEvidenceLeaks(text) {
  const checks = [
    [/\bpbd_[A-Za-z0-9._~-]+/g, "device token"],
    [/\bpbi_[A-Za-z0-9._~-]+/g, "intent token"],
    [new RegExp(adminToken, "g"), "admin token"],
    [/\/Users\/[A-Za-z0-9._-]+/g, "user path"],
    [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "raw ip"],
    [/\b[A-F0-9]{2}(?::[A-F0-9]{2}){5}\b/gi, "mac"],
  ];
  return checks.flatMap(([pattern, label]) => [...text.matchAll(pattern)].map((match) => `${label}: ${match[0]}`));
}

function writeSummary(value) {
  writeFileSync(resolve(outDir, "summary.json"), `${JSON.stringify(value, null, 2)}\n`);
}
