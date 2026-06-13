import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import worker from "../../apps/cloud-worker/src/index.js";

function makeEnv(overrides = {}) {
  return {
    BRIDGE_LOCAL_MEMORY: "1",
    BRIDGE_WEB_ORIGIN: "http://local.test",
    BRIDGE_RELAY_ENVELOPE_TTL_MS: "300000",
    BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({
      "panda-chat": ["http://local.test"],
      otherline: ["http://local.test"],
    }),
    ...overrides,
  };
}

function makeApi(env) {
  const jar = {};
  const tokenInstallIds = new Map();

  const apiRaw = async (method, path, body = null, token = "", extraHeaders = {}) => {
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
  };

  const api = async (method, path, body = null, token = "", extraHeaders = {}) => {
    const result = await apiRaw(method, path, body, token, extraHeaders);
    assert.ok(result.response.ok, `${method} ${path}: ${JSON.stringify(result.payload)}`);
    return result.payload;
  };

  const nativeClaimIntent = async (token, body, bearer = "") => {
    const installId = body.install_id;
    const result = await apiRaw("POST", `/v1/connect-intents/${encodeURIComponent(token)}/claim`, {
      install_id: installId,
      ...body,
    }, bearer, {
      origin: null,
      "x-panda-bridge-local-client": "desktop",
      "x-panda-bridge-install-id": installId,
    });
    assert.ok(result.response.ok, `claim intent: ${JSON.stringify(result.payload)}`);
    return result.payload;
  };

  return { api, apiRaw, nativeClaimIntent };
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
    meta: overrides.meta || { adapter_id: "relay-backpressure" },
    ...overrides,
  };
}

async function authorizeProduct(api, productId, label, bearer = "") {
  const intent = await api.api("POST", "/v1/connect-intents", {
    product_id: productId,
    device_name: `Relay Backpressure ${label}`,
    install_id: `install-${label}`,
  });
  return api.nativeClaimIntent(intent.token, {
    device_name: `Relay Backpressure ${label}`,
    install_id: `install-${label}`,
    capabilities: { relay: ["relay.envelope", "relay.ack"] },
  }, bearer);
}

async function createEnvelope(api, productId, deviceId, overrides = {}) {
  return api.api("POST", `/v1/products/${encodeURIComponent(productId)}/relay/envelopes`, relayEnvelope({
    device_id: deviceId,
    ...overrides,
  }));
}

async function expectLimit(api, productId, deviceId, error, overrides = {}) {
  const result = await api.apiRaw("POST", `/v1/products/${encodeURIComponent(productId)}/relay/envelopes`, relayEnvelope({
    device_id: deviceId,
    ...overrides,
  }));
  assert.equal(result.response.status, 429);
  assert.equal(result.payload.error, error);
  assert.equal(result.payload.queue.retry_after_ms, 3000);
  assert.ok(result.payload.queue.active >= 1);
  assert.ok(result.payload.queue.max_unacked >= 1);
  return result.payload;
}

async function expectConflict(api, productId, deviceId, overrides = {}) {
  const result = await api.apiRaw("POST", `/v1/products/${encodeURIComponent(productId)}/relay/envelopes`, relayEnvelope({
    device_id: deviceId,
    ...overrides,
  }));
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.error, "idempotency_key_conflict");
  return result.payload;
}

async function runDeviceLimit() {
  const env = makeEnv({
    BRIDGE_RELAY_DEVICE_MAX_UNACKED: "1",
    BRIDGE_RELAY_ACCOUNT_MAX_UNACKED: "10",
    BRIDGE_RELAY_PRODUCT_MAX_UNACKED: "10",
    BRIDGE_RELAY_CHANNEL_MAX_UNACKED: "10",
  });
  const api = makeApi(env);
  await api.api("POST", "/v1/sessions/guest", { display_name: "relay-device-limit" });
  const claim = await authorizeProduct(api, "panda-chat", "device-limit");
  await createEnvelope(api, "panda-chat", claim.device.id, { channel_id: "device-a", request_key: "device-1" });
  return expectLimit(api, "panda-chat", claim.device.id, "relay_device_queue_full", {
    channel_id: "device-b",
    request_key: "device-2",
  });
}

async function runChannelLimit() {
  const env = makeEnv({
    BRIDGE_RELAY_DEVICE_MAX_UNACKED: "10",
    BRIDGE_RELAY_ACCOUNT_MAX_UNACKED: "10",
    BRIDGE_RELAY_PRODUCT_MAX_UNACKED: "10",
    BRIDGE_RELAY_CHANNEL_MAX_UNACKED: "1",
  });
  const api = makeApi(env);
  await api.api("POST", "/v1/sessions/guest", { display_name: "relay-channel-limit" });
  const claim = await authorizeProduct(api, "panda-chat", "channel-limit");
  await createEnvelope(api, "panda-chat", claim.device.id, { channel_id: "channel-a", seq: 1, request_key: "channel-1" });
  return expectLimit(api, "panda-chat", claim.device.id, "relay_channel_queue_full", {
    channel_id: "channel-a",
    seq: 2,
    request_key: "channel-2",
  });
}

async function runProductLimit() {
  const env = makeEnv({
    BRIDGE_RELAY_DEVICE_MAX_UNACKED: "10",
    BRIDGE_RELAY_ACCOUNT_MAX_UNACKED: "10",
    BRIDGE_RELAY_PRODUCT_MAX_UNACKED: "1",
    BRIDGE_RELAY_CHANNEL_MAX_UNACKED: "10",
  });
  const api = makeApi(env);
  await api.api("POST", "/v1/sessions/guest", { display_name: "relay-product-limit" });
  const claim = await authorizeProduct(api, "panda-chat", "product-limit");
  await createEnvelope(api, "panda-chat", claim.device.id, { channel_id: "product-a", request_key: "product-1" });
  return expectLimit(api, "panda-chat", claim.device.id, "relay_product_queue_full", {
    channel_id: "product-b",
    request_key: "product-2",
  });
}

async function runAccountLimit() {
  const env = makeEnv({
    BRIDGE_RELAY_DEVICE_MAX_UNACKED: "10",
    BRIDGE_RELAY_ACCOUNT_MAX_UNACKED: "1",
    BRIDGE_RELAY_PRODUCT_MAX_UNACKED: "10",
    BRIDGE_RELAY_CHANNEL_MAX_UNACKED: "10",
  });
  const api = makeApi(env);
  await api.api("POST", "/v1/sessions/guest", { display_name: "relay-account-limit" });
  const first = await authorizeProduct(api, "panda-chat", "account-limit-a");
  await createEnvelope(api, "panda-chat", first.device.id, { channel_id: "account-a", request_key: "account-1" });
  const second = await authorizeProduct(api, "otherline", "account-limit-b", first.device_token);
  return expectLimit(api, "otherline", second.device.id, "relay_account_queue_full", {
    channel_id: "account-b",
    request_key: "account-2",
  });
}

async function runIdempotencyUnderFullQueue() {
  const env = makeEnv({
    BRIDGE_RELAY_DEVICE_MAX_UNACKED: "1",
    BRIDGE_RELAY_ACCOUNT_MAX_UNACKED: "10",
    BRIDGE_RELAY_PRODUCT_MAX_UNACKED: "10",
    BRIDGE_RELAY_CHANNEL_MAX_UNACKED: "10",
  });
  const api = makeApi(env);
  await api.api("POST", "/v1/sessions/guest", { display_name: "relay-idempotency-full" });
  const claim = await authorizeProduct(api, "panda-chat", "idempotency-full");
  const originalInput = {
    channel_id: "idempotency-a",
    seq: 7,
    request_key: "idempotency-1",
    ttl_ms: 300000,
    meta: { adapter_id: "relay-backpressure", trace_id: "idempotency-full" },
  };
  const original = await createEnvelope(api, "panda-chat", claim.device.id, originalInput);
  const retry = await api.apiRaw("POST", "/v1/products/panda-chat/relay/envelopes", relayEnvelope({
    device_id: claim.device.id,
    ...originalInput,
  }));
  assert.equal(retry.response.status, 200);
  assert.equal(retry.payload.reused, true);
  assert.equal(retry.payload.envelope.id, original.envelope.id);
  const limit = await expectLimit(api, "panda-chat", claim.device.id, "relay_device_queue_full", {
    channel_id: "idempotency-b",
    seq: 8,
    request_key: "idempotency-2",
  });
  const conflicts = {};
  for (const [field, overrides] of Object.entries({
    seq: { seq: 8 },
    algorithm: { algorithm: "X25519-AES-GCM-v2" },
    ttl_ms: { ttl_ms: 299000 },
    meta: { meta: { adapter_id: "relay-backpressure", trace_id: "changed" } },
    envelope_version: { envelope_version: "relay-envelope-v2" },
  })) {
    conflicts[field] = await expectConflict(api, "panda-chat", claim.device.id, {
      ...originalInput,
      ...overrides,
    });
  }
  return {
    reused: retry.payload.reused,
    reused_envelope_id: retry.payload.envelope.id,
    full_queue_limit: limit,
    conflicts,
  };
}

async function runDirectionSharedDeviceLimit() {
  const env = makeEnv({
    BRIDGE_RELAY_DEVICE_MAX_UNACKED: "1",
    BRIDGE_RELAY_ACCOUNT_MAX_UNACKED: "10",
    BRIDGE_RELAY_PRODUCT_MAX_UNACKED: "10",
    BRIDGE_RELAY_CHANNEL_MAX_UNACKED: "10",
  });
  const api = makeApi(env);
  await api.api("POST", "/v1/sessions/guest", { display_name: "relay-direction-shared-limit" });
  const claim = await authorizeProduct(api, "panda-chat", "direction-shared");
  await createEnvelope(api, "panda-chat", claim.device.id, {
    channel_id: "direction-a",
    request_key: "direction-1",
  });
  const result = await api.apiRaw("POST", "/v1/connectors/relay/envelopes", relayEnvelope({
    product_id: "panda-chat",
    device_id: claim.device.id,
    channel_id: "direction-b",
    seq: 2,
    request_key: "direction-2",
    ciphertext: "base64:reply",
    sender_key_id: "device-key-1",
    recipient_key_id: "product-key-1",
  }), claim.device_token);
  assert.equal(result.response.status, 429);
  assert.equal(result.payload.error, "relay_device_queue_full");
  assert.equal(result.payload.queue.scope, "device");
  return result.payload;
}

const results = {
  device: await runDeviceLimit(),
  channel: await runChannelLimit(),
  product: await runProductLimit(),
  account: await runAccountLimit(),
  idempotency: await runIdempotencyUnderFullQueue(),
  direction_shared_device: await runDirectionSharedDeviceLimit(),
};

const evidenceDir = resolve("spec/verification/evidence/relay-backpressure");
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(resolve(evidenceDir, "summary.json"), `${JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  limits: results,
}, null, 2)}\n`);

console.log("[relay-backpressure] pass");
