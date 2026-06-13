import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import worker, { BridgeDeviceRoom, __bridgeTestMemorySnapshot, __bridgeTestRelayEnvelopeMatches } from "../src/index.js";
import { assertRegistryWellFormed, scopeDangerMetadataFromCapabilities } from "../src/products.js";

const assetRequests = [];
const tokenInstallIds = new Map();
const env = {
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_WEB_ORIGIN: "http://local.test",
  BRIDGE_RELAY_ENVELOPE_TTL_MS: "300000",
  BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({
    "panda-chat": ["http://local.test", "http://chat.local.test"],
    otherline: ["https://otherline.cc", "http://local.test"],
  }),
  BRIDGE_OTHERLINE_DELEGATION_SECRET: "otherline-delegation-test-secret",
  ASSETS: {
    fetch: async (request) => {
      const url = new URL(request.url);
      assetRequests.push({ method: request.method, pathname: url.pathname });
      return new Response(request.method === "HEAD" ? null : "asset", {
        status: 200,
        headers: { "content-type": url.pathname.endsWith(".dmg") ? "application/octet-stream" : "text/html; charset=utf-8" },
      });
    },
  },
};
const jar = {};

async function apiRaw(method, path, body, token = "", extraHeaders = {}) {
  const headers = new Headers({ accept: "application/json" });
  if (body != null) headers.set("content-type", "application/json");
  if (jar.cookie) headers.set("cookie", jar.cookie);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (token && tokenInstallIds.has(token) && !Object.hasOwn(extraHeaders, "x-panda-bridge-install-id")) {
    headers.set("x-panda-bridge-install-id", tokenInstallIds.get(token));
  }
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value != null) headers.set(key, value);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("origin") && !Object.hasOwn(extraHeaders, "origin")) {
    headers.set("origin", env.BRIDGE_WEB_ORIGIN);
  }
  const response = await worker.fetch(new Request(`http://local.test${path}`, {
    method,
    headers,
    body: body != null && method !== "GET" && method !== "HEAD" ? JSON.stringify(body) : undefined,
  }), env);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) jar.cookie = setCookie.split(";")[0];
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (payload?.device_token) {
    const installId = body?.install_id || extraHeaders["x-panda-bridge-install-id"] || tokenInstallIds.get(token);
    if (installId) tokenInstallIds.set(payload.device_token, installId);
  }
  return { response, payload };
}

async function apiMissingOrigin(method, path, body = null, token = "", extraHeaders = {}) {
  return apiRaw(method, path, body, token, { ...extraHeaders, origin: null });
}

async function api(method, path, body = null, token = "", extraHeaders = {}) {
  const { response, payload } = await apiRaw(method, path, body, token, extraHeaders);
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function nativeClaimIntent(token, body, bearer = "", extraHeaders = {}) {
  const installId = body?.install_id || "install-test";
  const { response, payload } = await apiMissingOrigin("POST", `/v1/connect-intents/${encodeURIComponent(token)}/claim`, {
    install_id: installId,
    ...body,
  }, bearer, {
    "x-panda-bridge-local-client": "desktop",
    "x-panda-bridge-install-id": installId,
    ...extraHeaders,
  });
  assert.ok(response.ok, `claim intent: ${JSON.stringify(payload)}`);
  return payload;
}

async function delegatedApiRaw(method, path, body, userId, deviceId, nonce = randomUUID()) {
  const bodyText = body == null ? "" : JSON.stringify(body);
  const bodyHash = createHash("sha256").update(bodyText).digest("hex");
  const timestamp = new Date().toISOString();
  const signingPayload = [
    method.toUpperCase(),
    path,
    "otherline",
    userId,
    deviceId,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  const signature = createHmac("sha256", env.BRIDGE_OTHERLINE_DELEGATION_SECRET).update(signingPayload).digest("hex");
  return apiRaw(method, path, body, "", {
    "x-panda-bridge-product-id": "otherline",
    "x-panda-bridge-user-id": userId,
    "x-panda-bridge-device-id": deviceId,
    "x-panda-bridge-request-timestamp": timestamp,
    "x-panda-bridge-request-nonce": nonce,
    "x-panda-bridge-body-sha256": bodyHash,
    "x-panda-bridge-signature": signature,
  });
}

async function delegatedApi(method, path, body, userId, deviceId, nonce = randomUUID()) {
  const { response, payload } = await delegatedApiRaw(method, path, body, userId, deviceId, nonce);
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

function relayEnvelope(overrides = {}) {
  return {
    device_id: overrides.device_id || "dev-placeholder",
    channel_id: overrides.channel_id || "chan_1",
    seq: overrides.seq || 1,
    request_key: overrides.request_key || null,
    ciphertext: overrides.ciphertext || "base64:ciphertext",
    aad: overrides.aad || "base64:aad",
    nonce: overrides.nonce || "base64:nonce",
    algorithm: overrides.algorithm || "Noise_XX_25519_ChaChaPoly_BLAKE2s",
    sender_key_id: overrides.sender_key_id || "product-key-1",
    recipient_key_id: overrides.recipient_key_id || "device-key-1",
    ttl_ms: overrides.ttl_ms || 300000,
    meta: overrides.meta || { adapter_id: "panda-syllo" },
    ...overrides,
  };
}

const health = await api("GET", "/v1/health");
assert.equal(health.protocol, "panda-bridge-protocol-v0.2");
assert.equal(health.storage, "memory");

const diagnostics = await api("GET", "/v1/diagnostics");
assert.equal(diagnostics.protocol, "panda-bridge-protocol-v0.2");
assert.equal(diagnostics.relay.stores_plaintext, false);
assert.equal(diagnostics.relay.envelope_ttl_ms, 300000);
assert.deepEqual(diagnostics.relay.queue_limits, {
  device_max_unacked: 150,
  account_max_unacked: 500,
  product_max_unacked: 300,
  channel_max_unacked: 50,
  retry_after_ms: 3000,
});
assert.equal(diagnostics.legacy_runtime_api.removed, true);
assert.equal("jobs" in diagnostics, false);
for (const product of diagnostics.products) {
  assert.deepEqual(product.capabilities, ["relay.envelope", "relay.ack"]);
  assert.doesNotMatch(JSON.stringify(product), /codex\.|claude\.|syllo\.|shell\.run|fs\.|data\./);
}
assert.equal(assertRegistryWellFormed(), true);
assert.throws(() => assertRegistryWellFormed({
  "relay.envelope": { domain: "relay", verb: "typo", danger: "low", boundary_type: "relay_channel" },
}, {}), /invalid capability registry key/);
assert.deepEqual(scopeDangerMetadataFromCapabilities(["relay.envelope"]), {
  danger_tiers: {
    low: { granted: true, domains: ["relay"] },
    medium: { granted: false, domains: [] },
    high: { granted: false, domains: [] },
    critical: { granted: false, domains: [] },
  },
  domain_boundaries: {
    relay: { granted: true, danger: "low", boundary_type: "relay_channel" },
  },
});

const room = new BridgeDeviceRoom(null, env);
const desktopMessages = [];
const webMessages = [];
room.desktop = { socket: { send: (text) => desktopMessages.push(JSON.parse(text)) }, meta: { id: "desktop_1", role: "desktop", deviceId: "dev_1" } };
room.webs.set("web_1", { socket: { send: (text) => webMessages.push(JSON.parse(text)) }, meta: { id: "web_1", role: "web" } });
const relayNotify = room.notify({ type: "relay.envelope", envelope: { id: "env_1" }, sent_at: "2026-06-13T00:00:00.000Z" });
assert.equal(relayNotify.desktop_delivered, true);
assert.equal(relayNotify.web_delivered, 1);
assert.deepEqual(desktopMessages[0], { type: "relay.envelope", envelope: { id: "env_1" }, sent_at: "2026-06-13T00:00:00.000Z" });
assert.deepEqual(webMessages[0], { type: "relay.envelope.created", envelope: { id: "env_1" }, sent_at: "2026-06-13T00:00:00.000Z" });

const assetHead = await worker.fetch(new Request("http://local.test/downloads/panda-bridge-macos.dmg", { method: "HEAD" }), env);
assert.equal(assetHead.status, 200);
assert.deepEqual(assetRequests.at(-1), { method: "HEAD", pathname: "/downloads/panda-bridge-macos.dmg" });

const guestLogin = await apiRaw("POST", "/v1/sessions/guest", { display_name: "Tester" });
assert.ok(guestLogin.response.ok);
assert.match(jar.cookie, /^pb_session=/);

const products = await api("GET", "/v1/products");
assert.ok(products.items.some((item) => item.id === "panda-chat"));
assert.ok(products.items.every((item) => item.capabilities.includes("relay.envelope")));
assert.doesNotMatch(JSON.stringify(products), /codex\.|claude\.|syllo\.|shell\.run|fs\.|data\./);

const intent = await api("POST", "/v1/connect-intents", {
  product_id: "panda-chat",
  device_name: "Relay Test Device",
  install_id: "install-relay-test",
});
const claimed = await nativeClaimIntent(intent.token, {
  device_name: "Relay Test Device",
  install_id: "install-relay-test",
  capabilities: { relay: ["relay.envelope", "relay.ack"], codex: ["codex.chat"] },
  local_state: {
    platform: "macos",
    commands: { codex: true },
    workspaces: { default: "/Users/private/project" },
    adapter_router: { configured: true },
  },
});
assert.deepEqual(claimed.authorization.policy.capabilities, ["relay.envelope", "relay.ack"]);
assert.equal(claimed.authorization.policy.domain_boundaries.relay.boundary_type, "relay_channel");
assert.equal(claimed.device.status, "online");
assert.deepEqual(claimed.device.capabilities, {
  relay: ["relay.envelope", "relay.ack"],
  adapter_router: { mode: "external_http" },
});
assert.doesNotMatch(JSON.stringify(claimed.device), /codex|commands|workspaces|Users\/private|shell\.run|fs\.read|data\./);

const heartbeat = await api("POST", "/v1/connectors/heartbeat", {
  install_id: "install-relay-test",
  capabilities: { relay: ["relay.envelope", "relay.ack"], codex: ["codex.chat"] },
  local_state: {
    platform: "macos",
    commands: { codex: true },
    workspaces: { default: "/Users/private/heartbeat" },
    adapter_router: { configured: true },
  },
}, claimed.device_token);
assert.equal(heartbeat.device.status, "online");
assert.doesNotMatch(JSON.stringify(heartbeat.device), /codex|commands|workspaces|Users\/private|shell\.run|fs\.read|data\./);

const readyState = await api("GET", "/v1/bridge/state?product_id=panda-chat");
assert.equal(readyState.accounts[0].authorization.status, "active");
assert.equal(readyState.connected, true);
assert.equal("capabilities" in readyState.product, false);
assert.equal("policy" in readyState.authorization, false);

const plaintextRejected = await apiRaw("POST", "/v1/products/panda-chat/relay/envelopes", {
  ...relayEnvelope({ device_id: claimed.device.id }),
  input: { prompt: "server must not see this" },
});
assert.equal(plaintextRejected.response.status, 400);
assert.equal(plaintextRejected.payload.error, "plaintext_fields_forbidden");
assert.deepEqual(plaintextRejected.payload.plaintext_fields, ["input"]);

const metaPlaintextRejected = await apiRaw("POST", "/v1/products/panda-chat/relay/envelopes", {
  ...relayEnvelope({
    device_id: claimed.device.id,
    meta: { adapter_id: "panda-syllo", payload: "server must not store this", message: "hello" },
  }),
});
assert.equal(metaPlaintextRejected.response.status, 400);
assert.equal(metaPlaintextRejected.payload.error, "plaintext_fields_forbidden");
assert.deepEqual(metaPlaintextRejected.payload.plaintext_fields, ["meta.message", "meta.payload"]);

const created = await api("POST", "/v1/products/panda-chat/relay/envelopes", relayEnvelope({
  device_id: claimed.device.id,
  request_key: "rq_product_to_device",
}));
assert.equal(created.envelope.delivery_status, "queued");
assert.equal(created.envelope.direction, "product_to_device");
assert.equal(created.envelope.ciphertext, "base64:ciphertext");
assert.equal(created.envelope.meta.adapter_id, "panda-syllo");
assert.equal("input" in created.envelope, false);
assert.equal("result" in created.envelope, false);

const duplicate = await api("POST", "/v1/products/panda-chat/relay/envelopes", relayEnvelope({
  device_id: claimed.device.id,
  request_key: "rq_product_to_device",
}));
assert.equal(duplicate.reused, true);
assert.equal(duplicate.envelope.id, created.envelope.id);
const legacyNoHashRow = { ...created.envelope };
delete legacyNoHashRow.idempotency_hash;
assert.equal(__bridgeTestRelayEnvelopeMatches(legacyNoHashRow, relayEnvelope({
  product_id: "panda-chat",
  device_id: claimed.device.id,
  direction: "product_to_device",
  request_key: "rq_product_to_device",
}), 300000), true);
for (const [field, overrides] of [
  ["seq", { seq: 99 }],
  ["algorithm", { algorithm: "X25519-AES-GCM-v2" }],
  ["ttl_ms", { ttl_ms: 299000 }],
  ["meta", { meta: { adapter_id: "panda-syllo", priority: "high" } }],
  ["envelope_version", { envelope_version: "relay-envelope-v2" }],
]) {
  assert.equal(__bridgeTestRelayEnvelopeMatches(legacyNoHashRow, relayEnvelope({
    product_id: "panda-chat",
    device_id: claimed.device.id,
    direction: "product_to_device",
    request_key: "rq_product_to_device",
    ...overrides,
  }), 300000), false, `legacy no-hash ${field} conflict must fail closed`);
}

const conflict = await apiRaw("POST", "/v1/products/panda-chat/relay/envelopes", relayEnvelope({
  device_id: claimed.device.id,
  request_key: "rq_product_to_device",
  ciphertext: "base64:different",
}));
assert.equal(conflict.response.status, 409);
assert.equal(conflict.payload.error, "idempotency_key_conflict");
for (const [field, overrides] of [
  ["seq", { seq: 99 }],
  ["algorithm", { algorithm: "X25519-AES-GCM-v2" }],
  ["ttl_ms", { ttl_ms: 299000 }],
  ["meta", { meta: { adapter_id: "panda-syllo", priority: "high" } }],
  ["envelope_version", { envelope_version: "relay-envelope-v2" }],
]) {
  const changed = await apiRaw("POST", "/v1/products/panda-chat/relay/envelopes", relayEnvelope({
    device_id: claimed.device.id,
    request_key: "rq_product_to_device",
    ...overrides,
  }));
  assert.equal(changed.response.status, 409, `${field} conflict must fail closed`);
  assert.equal(changed.payload.error, "idempotency_key_conflict");
}

const legacyJobCreate = await apiRaw("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: claimed.device.id,
  input: { prompt: "legacy" },
});
assert.equal(legacyJobCreate.response.status, 410);
assert.equal(legacyJobCreate.payload.error, "legacy_runtime_api_removed");
assert.equal((await apiRaw("GET", "/v1/connectors/jobs", null, claimed.device_token)).response.status, 410);
const legacyQueueSummary = await apiRaw("GET", "/v1/queue/summary");
assert.equal(legacyQueueSummary.response.status, 410);
assert.equal(legacyQueueSummary.payload.error, "legacy_runtime_api_removed");

const deviceInbox = await api("GET", "/v1/connectors/relay/envelopes", null, claimed.device_token);
assert.equal(deviceInbox.items.length, 1);
assert.equal(deviceInbox.items[0].id, created.envelope.id);
assert.equal(deviceInbox.items[0].delivery_status, "delivered");
const redeliveredInbox = await api("GET", "/v1/connectors/relay/envelopes", null, claimed.device_token);
assert.equal(redeliveredInbox.items.length, 1);
assert.equal(redeliveredInbox.items[0].id, created.envelope.id);
assert.equal(redeliveredInbox.items[0].delivery_status, "delivered");
await api("POST", `/v1/connectors/relay/envelopes/${created.envelope.id}/ack`, {}, claimed.device_token);

const deviceReply = await api("POST", "/v1/connectors/relay/envelopes", relayEnvelope({
  product_id: "panda-chat",
  device_id: claimed.device.id,
  channel_id: "chan_1",
  seq: 2,
  request_key: "rq_device_to_product",
  ciphertext: "base64:reply",
  sender_key_id: "device-key-1",
  recipient_key_id: "product-key-1",
}), claimed.device_token);
assert.equal(deviceReply.envelope.direction, "device_to_product");
assert.equal(deviceReply.envelope.ciphertext, "base64:reply");

const productInbox = await api("GET", `/v1/products/panda-chat/relay/envelopes?device_id=${encodeURIComponent(claimed.device.id)}&channel_id=chan_1`);
assert.equal(productInbox.items.length, 1);
assert.equal(productInbox.items[0].id, deviceReply.envelope.id);
assert.equal(productInbox.items[0].ciphertext, "base64:reply");
await api("POST", `/v1/products/panda-chat/relay/envelopes/${deviceReply.envelope.id}/ack`, {});

const snapshot = __bridgeTestMemorySnapshot();
assert.equal(snapshot.bridge_relay_envelopes.length, 2);
assert.ok(snapshot.bridge_relay_envelopes.every((row) => row.ciphertext && row.aad && row.nonce));
assert.ok(snapshot.bridge_relay_envelopes.every((row) => row.idempotency_hash));
assert.doesNotMatch(JSON.stringify(snapshot.bridge_relay_envelopes), /prompt|stdout|stderr|"input"|"result"|"policy"|"kind"|"runtime"/);

const otherlineIntent = await api("POST", "/v1/connect-intents", {
  product_id: "otherline",
  device_name: "Otherline Relay Device",
  install_id: "install-otherline",
});
const otherlineClaim = await nativeClaimIntent(otherlineIntent.token, {
  device_name: "Otherline Relay Device",
  install_id: "install-otherline",
  capabilities: { relay: ["relay.envelope", "relay.ack"] },
}, claimed.device_token);
const delegatedCreated = await delegatedApi("POST", "/v1/products/otherline/delegated/relay/envelopes", relayEnvelope({
  product_id: "otherline",
  device_id: otherlineClaim.device.id,
  channel_id: "delegated_chan",
  request_key: "rq_delegated",
}), otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedCreated.envelope.product_id, "otherline");
const badDelegated = await delegatedApiRaw("POST", "/v1/products/otherline/delegated/relay/envelopes", {
  ...relayEnvelope({ product_id: "otherline", device_id: otherlineClaim.device.id, channel_id: "bad_delegated" }),
  payload: { text: "plaintext" },
}, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(badDelegated.response.status, 400);
assert.equal(badDelegated.payload.error, "plaintext_fields_forbidden");

env.BRIDGE_RELAY_ENVELOPE_TTL_MS = "1000";
const expiring = await api("POST", "/v1/products/panda-chat/relay/envelopes", relayEnvelope({
  device_id: claimed.device.id,
  channel_id: "ttl",
  request_key: "rq_ttl",
  ttl_ms: 1000,
}));
await new Promise((resolve) => setTimeout(resolve, 1100));
await worker.scheduled({}, env, {});
assert.equal(__bridgeTestMemorySnapshot().bridge_relay_envelopes.some((row) => row.id === expiring.envelope.id), false);

console.log("[worker.test] pass");
