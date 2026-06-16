import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import worker, { BridgeDeviceRoom, __bridgeTestConnectorRelayListPayload, __bridgeTestMemorySnapshot, __bridgeTestRelayEnvelopeMatches } from "../src/index.js";
import { RELAY_CAPABILITIES, assertRegistryWellFormed, scopeDangerMetadataFromCapabilities } from "../src/products.js";

const assetRequests = [];
const tokenInstallIds = new Map();
const env = {
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_WEB_ORIGIN: "http://local.test",
  BRIDGE_ALLOWED_ORIGINS: "http://local.test https://bridge.test.example https://syllo.test.example",
  BRIDGE_RELAY_ENVELOPE_TTL_MS: "300000",
  BRIDGE_PRODUCT_REGISTRY_MODE: "extend",
  BRIDGE_PRODUCT_REGISTRY_JSON: JSON.stringify({
    products: [
      {
        id: "panda-chat",
        name: "Test Chat Product",
        official_origin: "http://local.test",
        official_origins: ["http://local.test", "http://chat.local.test"],
      },
      {
        id: "panda-syllo",
        name: "Test Syllo Product",
        official_origin: "http://local.test",
        official_origins: ["http://local.test", "http://localhost:8790", "https://syllo.test.example"],
      },
      {
        id: "delegated-demo",
        name: "Delegated Test Product",
        official_origin: "https://delegated.example",
        official_origins: ["https://delegated.example", "http://local.test"],
      },
    ],
  }),
  BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({
    "panda-chat": ["http://local.test", "http://chat.local.test"],
    "panda-syllo": ["http://local.test", "http://localhost:8790", "https://syllo.test.example"],
    "delegated-demo": ["https://delegated.example", "http://local.test"],
  }),
  BRIDGE_DELEGATED_DEMO_DELEGATION_SECRET: "delegated-demo-delegation-test-secret",
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

async function nativeConfirmIntent(token, bearer, extraHeaders = {}) {
  const { response, payload } = await apiMissingOrigin("POST", `/v1/connect-intents/${encodeURIComponent(token)}/confirm`, {
    confirmed: true,
  }, bearer, {
    "x-panda-bridge-local-client": "desktop",
    ...extraHeaders,
  });
  assert.ok(response.ok, `confirm intent: ${JSON.stringify(payload)}`);
  return payload;
}

async function delegatedApiRaw(method, path, body, userId, deviceId, nonce = randomUUID()) {
  const bodyText = body == null ? "" : JSON.stringify(body);
  const bodyHash = createHash("sha256").update(bodyText).digest("hex");
  const timestamp = new Date().toISOString();
  const signingPayload = [
    method.toUpperCase(),
    path,
    "delegated-demo",
    userId,
    deviceId,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  const signature = createHmac("sha256", env.BRIDGE_DELEGATED_DEMO_DELEGATION_SECRET).update(signingPayload).digest("hex");
  return apiRaw(method, path, body, "", {
    "x-panda-bridge-product-id": "delegated-demo",
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

function authorizationPolicy(capabilities, root = "[local]/default") {
  return {
    version: "BRIDGE-RELAY-AUTH-v1",
    capabilities,
    source_origin: env.BRIDGE_WEB_ORIGIN,
    product_authorization: {
      owner: "test-product-adapter",
      enforcement: "test-product-adapter",
      control: "computer-control",
      label: `Authorized local control for ${root}`,
    },
  };
}

function b64Text(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function relayKeyBootstrapAadText(productId, deviceId, authorizationId, authorizationEpoch, keyId, wireVersion = "bridge-relay-key-bootstrap-v1") {
  return `${wireVersion}|${productId}|${deviceId}|${authorizationId}|${authorizationEpoch}|${keyId}`;
}

function relayEnvelopeAadText({ productId, deviceId, channelId, direction = "product_to_device", seq = 1, authorizationId, authorizationEpoch, keyId }) {
  return [
    `product:${productId}`,
    `device:${deviceId}`,
    `channel:${channelId}`,
    `direction:${direction}`,
    `seq:${seq}`,
    `authorization:${authorizationId}`,
    `epoch:${authorizationEpoch}`,
    `relay_key:${keyId}`,
  ].join("|");
}

const health = await api("GET", "/v1/health");
assert.equal(health.protocol, "panda-bridge-protocol-v0.2");
assert.equal(health.storage, "memory");
const bridgeTestCspResponse = await worker.fetch(new Request("http://local.test/v1/health", {
  headers: { origin: "https://bridge.test.example" },
}), env);
assert.equal(bridgeTestCspResponse.headers.get("access-control-allow-origin"), "https://bridge.test.example");
assert.match(bridgeTestCspResponse.headers.get("content-security-policy") || "", /https:\/\/api\.bridge\.test\.example/);

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
  assert.deepEqual(product.capabilities, RELAY_CAPABILITIES);
  assert.doesNotMatch(JSON.stringify({ ...product, capabilities: [] }), /codex\.|claude\.|shell\.run|fs\.|data\./);
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

const loginOnlyMissing = await apiRaw("POST", "/v1/sessions/password", {
  email: "missing-login-only@example.com",
  password: "secret-password",
  create: false,
});
assert.equal(loginOnlyMissing.response.status, 401);
assert.equal(loginOnlyMissing.payload.error, "invalid_credentials");
assert.equal(__bridgeTestMemorySnapshot().bridge_users.some((row) => row.email === "missing-login-only@example.com"), false);

const products = await api("GET", "/v1/products");
assert.ok(products.items.some((item) => item.id === "panda-chat"));
assert.ok(products.items.every((item) => item.capabilities.includes("relay.envelope")));
for (const product of products.items) {
  assert.deepEqual(product.capabilities, RELAY_CAPABILITIES);
  assert.doesNotMatch(JSON.stringify(product), /codex\.|claude\.|syllo\.chat|syllo\.sessions|syllo\.issue|syllo\.highlight|syllo\.doc|shell\.run|fs\.|data\./);
}

const invalidTokenClaim = await apiMissingOrigin("POST", "/v1/connect-intents/pbi_missing/claim", {
  install_id: "install-invalid-token",
  device_name: "Invalid Token Device",
}, "", {
  "x-panda-bridge-local-client": "desktop",
  "x-panda-bridge-install-id": "install-invalid-token",
});
assert.equal(invalidTokenClaim.response.status, 400);
assert.equal(invalidTokenClaim.payload.error, "token_invalid");

env.BRIDGE_CONNECT_INTENT_TTL_MS = "1";
const expiredIntent = await api("POST", "/v1/connect-intents", {
  product_id: "panda-chat",
  device_name: "Expired Token Device",
  install_id: "install-expired-token",
});
await new Promise((resolve) => setTimeout(resolve, 10));
const expiredTokenClaim = await apiMissingOrigin("POST", `/v1/connect-intents/${encodeURIComponent(expiredIntent.token)}/claim`, {
  install_id: "install-expired-token",
  device_name: "Expired Token Device",
}, "", {
  "x-panda-bridge-local-client": "desktop",
  "x-panda-bridge-install-id": "install-expired-token",
});
assert.equal(expiredTokenClaim.response.status, 400);
assert.equal(expiredTokenClaim.payload.error, "token_expired");
delete env.BRIDGE_CONNECT_INTENT_TTL_MS;

const legacyPolicyRejected = await apiRaw("POST", "/v1/connect-intents", {
  product_id: "panda-chat",
  device_name: "Legacy Policy Device",
  install_id: "install-legacy-policy",
  policy: {
    version: "AUTH-SCOPE-v2",
    capabilities: ["relay.envelope"],
    workspace_roots: [{ id: "default", path_display: "[local]/default" }],
    sandbox_floor: "danger-full-access",
    allow_developer_instructions: true,
  },
});
assert.equal(legacyPolicyRejected.response.status, 400);
assert.equal(legacyPolicyRejected.payload.error, "legacy_authorization_policy_forbidden");
assert.deepEqual(legacyPolicyRejected.payload.fields, [
  "workspace_roots",
  "sandbox_floor",
  "allow_developer_instructions",
]);

const customRegistryEnv = {
  ...env,
  BRIDGE_PRODUCT_REGISTRY_MODE: "replace",
  BRIDGE_PRODUCT_REGISTRY_JSON: JSON.stringify({
    products: [{
      id: "acme-demo",
      name: "Acme Demo",
      official_origin: "http://acme.local.test",
      web_url: "http://acme.local.test/app",
    }],
  }),
};
const customDiagnosticsResponse = await worker.fetch(new Request("http://local.test/v1/diagnostics", {
  headers: { origin: "http://acme.local.test" },
}), customRegistryEnv);
assert.equal(customDiagnosticsResponse.status, 200);
const customDiagnostics = await customDiagnosticsResponse.json();
assert.deepEqual(customDiagnostics.products.map((item) => item.id), ["acme-demo"]);
assert.equal(customDiagnostics.products[0].web_url, "http://acme.local.test/app");
assert.deepEqual(customDiagnostics.products[0].capabilities, ["relay.envelope", "relay.ack"]);
const customProductsResponse = await worker.fetch(new Request("http://local.test/v1/products", {
  headers: { origin: "http://acme.local.test" },
}), customRegistryEnv);
assert.equal(customProductsResponse.status, 200);
const customProducts = await customProductsResponse.json();
assert.deepEqual(customProducts.items.map((item) => item.id), ["acme-demo"]);
assert.equal(customProducts.items[0].origin, "http://acme.local.test");
const invalidRegistryResponse = await worker.fetch(new Request("http://local.test/v1/diagnostics"), {
  ...env,
  BRIDGE_PRODUCT_REGISTRY_MODE: "replace",
  BRIDGE_PRODUCT_REGISTRY_JSON: JSON.stringify({ products: [{ id: "../bad", official_origin: "http://bad.local.test" }] }),
});
assert.equal(invalidRegistryResponse.status, 500);
assert.equal((await invalidRegistryResponse.json()).error, "invalid_product_registry_config");
const invalidOriginRegistryResponse = await worker.fetch(new Request("http://local.test/v1/diagnostics"), {
  ...env,
  BRIDGE_PRODUCT_REGISTRY_MODE: "replace",
  BRIDGE_PRODUCT_REGISTRY_JSON: JSON.stringify({
    products: [{
      id: "acme-demo",
      official_origin: "http://acme.local.test",
      official_origins: ["not-a-url", "http://acme.local.test"],
    }],
  }),
});
assert.equal(invalidOriginRegistryResponse.status, 500);
assert.equal((await invalidOriginRegistryResponse.json()).error, "invalid_product_registry_config");
const invalidWebUrlRegistryResponse = await worker.fetch(new Request("http://local.test/v1/diagnostics"), {
  ...env,
  BRIDGE_PRODUCT_REGISTRY_MODE: "replace",
  BRIDGE_PRODUCT_REGISTRY_JSON: JSON.stringify({
    products: [{
      id: "acme-demo",
      official_origin: "http://acme.local.test",
      web_url: "notaurl",
    }],
  }),
});
assert.equal(invalidWebUrlRegistryResponse.status, 500);
assert.equal((await invalidWebUrlRegistryResponse.json()).error, "invalid_product_registry_config");
const extendOverrideRegistryResponse = await worker.fetch(new Request("http://local.test/v1/diagnostics"), {
  ...env,
  BRIDGE_PRODUCT_REGISTRY_MODE: "extend",
  BRIDGE_PRODUCT_REGISTRY_JSON: JSON.stringify({
    products: [{
      id: "bridge-demo",
      name: "Fake Panda",
      official_origin: "https://evil.example",
    }],
  }),
});
assert.equal(extendOverrideRegistryResponse.status, 500);
assert.equal((await extendOverrideRegistryResponse.json()).error, "invalid_product_registry_config");

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
assert.equal(claimed.authorization.status, "pending");
assert.equal(claimed.authorization.policy.version, "BRIDGE-RELAY-AUTH-v1");
assert.equal(claimed.device.status, "online");
assert.deepEqual(claimed.device.capabilities, {
  relay: ["relay.envelope", "relay.ack"],
  adapter_router: { mode: "external_http" },
});
assert.doesNotMatch(JSON.stringify(claimed.device), /codex|commands|workspaces|Users\/private|shell\.run|fs\.read|data\./);
const alreadyClaimed = await apiMissingOrigin("POST", `/v1/connect-intents/${encodeURIComponent(intent.token)}/claim`, {
  install_id: "install-relay-test-duplicate",
  device_name: "Duplicate Claim Device",
}, "", {
  "x-panda-bridge-local-client": "desktop",
  "x-panda-bridge-install-id": "install-relay-test-duplicate",
});
assert.equal(alreadyClaimed.response.status, 400);
assert.equal(alreadyClaimed.payload.error, "token_already_claimed");

const confirmed = await nativeConfirmIntent(intent.token, claimed.device_token, {
  "x-panda-bridge-install-id": "install-relay-test",
});
assert.equal(confirmed.authorization.status, "active");

const heartbeat = await api("POST", "/v1/connectors/heartbeat", {
  install_id: "install-relay-test",
  capabilities: { relay: ["relay.envelope", "relay.ack"], codex: ["codex.chat"] },
  local_state: {
    platform: "macos",
    commands: { codex: true },
    workspaces: { default: "/Users/private/heartbeat" },
    adapter_router: { configured: true },
  },
}, confirmed.device_token || claimed.device_token);
assert.equal(heartbeat.device.status, "online");
assert.doesNotMatch(JSON.stringify(heartbeat.device), /codex|commands|workspaces|Users\/private|shell\.run|fs\.read|data\./);

const readyState = await api("GET", "/v1/bridge/state?product_id=panda-chat");
assert.equal(readyState.accounts[0].authorization.status, "active");
assert.equal(readyState.connected, true);
assert.deepEqual(readyState.product.capabilities, ["relay.envelope", "relay.ack"]);
assert.deepEqual(readyState.authorization.policy.capabilities, ["relay.envelope", "relay.ack"]);
assert.doesNotMatch(JSON.stringify(readyState.authorization.policy), /Users\/private|commands|workspaces|shell\.run|fs\.read/);

const relayKeyExchange = {
  algorithm: "ECDH-P256+A256GCM",
  key_id: "rkx_test_chat",
  public_jwk: {
    kty: "EC",
    crv: "P-256",
    x: "f83OJ3D2xF4B2XIBm9W8GvROqVRsY6x1Z3xA4C7v3x8",
    y: "x_FEzRu9i85-Wz9rn8bL1XxVQwWxS4kVYzH8Y8rjWbs",
  },
};
const keyExchangeHeartbeat = await api("POST", "/v1/connectors/heartbeat", {
  install_id: "install-relay-test",
  capabilities: { relay: ["relay.envelope", "relay.ack"] },
  local_state: {
    platform: "macos",
    relay: { envelopes: true, ack: true },
    adapter_router: {
      configured: true,
      mode: "external_http",
      products: {
        "panda-chat": {
          configured: true,
          relay_key_exchange: relayKeyExchange,
        },
      },
    },
  },
}, confirmed.device_token || claimed.device_token);
assert.equal(keyExchangeHeartbeat.device.local_state.adapter_router.products["panda-chat"].relay_key_exchange.key_id, "rkx_test_chat");
const exchangeState = await api("GET", "/v1/bridge/state?product_id=panda-chat");
const exchangeDevice = exchangeState.devices.find((device) => device.id === claimed.device.id);
assert.equal(exchangeDevice.relay_key_exchange.key_id, "rkx_test_chat");

const relayKeyBootstrap = await api("POST", "/v1/products/panda-chat/relay-key-bootstrap", {
  device_id: claimed.device.id,
  relay_key_bootstrap: {
    algorithm: "ECDH-P256+A256GCM",
    key_id: "rkx_test_chat",
    wrapped_key: {
      algorithm: "ECDH-P256+A256GCM",
      key_id: "rkx_test_chat",
      app_public_jwk: {
        kty: "EC",
        crv: "P-256",
        x: "wWwQx5Dul2jDRdB7r6C5C5h6GdPK6eNi02T0tVPwBiY",
        y: "JL0C83dGqz1U3uc0GRQzZJslcF6ctvPd_EwFQ5QwdXg",
	      },
	      nonce_b64: "AAAAAAAAAAAAAAAA",
	      ciphertext_b64: "ZmFrZS13cmFwcGVkLWtleQ==",
	      aad_b64: b64Text(relayKeyBootstrapAadText(
	        "panda-chat",
	        claimed.device.id,
	        confirmed.authorization.id,
	        confirmed.authorization.epoch,
	        "rkx_test_chat",
	      )),
	    },
	  },
	});
assert.equal(relayKeyBootstrap.relay_key_bootstrap.status, "ready");
assert.equal(relayKeyBootstrap.relay_key_bootstrap.key_id, "rkx_test_chat");
assert.equal(relayKeyBootstrap.authorization.relay_key_bootstrap.status, "ready");
assert.doesNotMatch(JSON.stringify(relayKeyBootstrap), /relay_key_b64|relayKeyB64|key_b64|keyB64/);
assert.doesNotMatch(JSON.stringify(relayKeyBootstrap.authorization), /_relay_key_bootstrap/);

const connectorBootstrap = await api("GET", "/v1/connectors/products/panda-chat/relay-key-bootstrap", null, confirmed.device_token || claimed.device_token);
assert.equal(connectorBootstrap.relay_key_bootstrap.status, "ready");
assert.equal(connectorBootstrap.relay_key_bootstrap.wrapped_key.ciphertext_b64, "ZmFrZS13cmFwcGVkLWtleQ==");
assert.doesNotMatch(JSON.stringify(connectorBootstrap.authorization), /_relay_key_bootstrap/);

const plaintextBootstrapRejected = await apiRaw("POST", "/v1/products/panda-chat/relay-key-bootstrap", {
  device_id: claimed.device.id,
  relay_key_b64: "server-must-not-store-this",
  relay_key_bootstrap: { key_id: "rkx_test_chat" },
});
assert.equal(plaintextBootstrapRejected.response.status, 400);
assert.equal(plaintextBootstrapRejected.payload.error, "plaintext_relay_key_forbidden");
assert.deepEqual(plaintextBootstrapRejected.payload.plaintext_fields, ["relay_key_b64"]);

const mismatchBootstrapRejected = await apiRaw("POST", "/v1/products/panda-chat/relay-key-bootstrap", {
  device_id: claimed.device.id,
  relay_key_bootstrap: {
    algorithm: "ECDH-P256+A256GCM",
    key_id: "rkx_test_chat",
    wrapped_key: {
      algorithm: "ECDH-P256+A256GCM",
      key_id: "rkx_test_chat",
      app_public_jwk: {
        kty: "EC",
        crv: "P-256",
        x: "wWwQx5Dul2jDRdB7r6C5C5h6GdPK6eNi02T0tVPwBiY",
        y: "JL0C83dGqz1U3uc0GRQzZJslcF6ctvPd_EwFQ5QwdXg",
      },
      nonce_b64: "AAAAAAAAAAAAAAAA",
      ciphertext_b64: "ZmFrZS13cmFwcGVkLWtleQ==",
      aad_b64: b64Text("wrong-bootstrap-context"),
    },
  },
});
assert.equal(mismatchBootstrapRejected.response.status, 409);
assert.equal(mismatchBootstrapRejected.payload.error, "relay_key_bootstrap_aad_mismatch");

const secondIntent = await api("POST", "/v1/connect-intents", {
  product_id: "panda-chat",
  device_name: "Relay Test Device Two",
  install_id: "install-relay-test-two",
  policy: authorizationPolicy(["relay.envelope", "relay.ack"], "[local]/secondary"),
});
const secondClaim = await nativeClaimIntent(secondIntent.token, {
  device_name: "Relay Test Device Two",
  install_id: "install-relay-test-two",
  capabilities: { relay: ["relay.envelope", "relay.ack"] },
});
const secondConfirmed = await nativeConfirmIntent(secondIntent.token, secondClaim.device_token, {
  "x-panda-bridge-install-id": "install-relay-test-two",
});
assert.equal(secondConfirmed.authorization.status, "active");
const multiDeviceState = await api("GET", "/v1/bridge/state?product_id=panda-chat");
const authorizedDeviceRows = multiDeviceState.devices.filter((device) => device.authorization);
assert.ok(authorizedDeviceRows.length >= 2);
assert.ok(authorizedDeviceRows.every((device) => device.authorization.source_origin === "http://local.test"));
assert.ok(authorizedDeviceRows.every((device) => Array.isArray(device.authorization.policy.capabilities)));
assert.ok(authorizedDeviceRows.some((device) => JSON.stringify(device.authorization.policy).includes("[local]/secondary")));

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
assert.deepEqual(deviceInbox.cursor, {
  after_seq: 0,
  next_after_seq: 1,
  limit: 100,
  has_more: false,
  returned: 1,
  include_acked: false,
});
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
assert.equal(productInbox.cursor.next_after_seq, 2);
await api("POST", `/v1/products/panda-chat/relay/envelopes/${deviceReply.envelope.id}/ack`, {});
const productAckedInbox = await api("GET", `/v1/products/panda-chat/relay/envelopes?device_id=${encodeURIComponent(claimed.device.id)}&channel_id=chan_1&include_acked=true&limit=1&wait_ms=1`);
assert.equal(productAckedInbox.items.length, 1);
assert.equal(productAckedInbox.items[0].id, deviceReply.envelope.id);
assert.equal(productAckedInbox.items[0].delivery_status, "acked");
assert.deepEqual(productAckedInbox.cursor, {
  after_seq: 0,
  next_after_seq: 2,
  limit: 1,
  has_more: false,
  returned: 1,
  include_acked: true,
});
const normalizedInbox = await api("GET", `/v1/products/panda-chat/relay/envelopes?device_id=${encodeURIComponent(claimed.device.id)}&channel_id=chan_1&include_acked=true&after_seq=not-a-number&limit=9999&wait_ms=-10`);
assert.equal(normalizedInbox.items.length, 1);
assert.deepEqual(normalizedInbox.cursor, {
  after_seq: 0,
  next_after_seq: 2,
  limit: 500,
  has_more: false,
  returned: 1,
  include_acked: true,
});
const unscopedProductCursor = await apiRaw("GET", `/v1/products/panda-chat/relay/envelopes?device_id=${encodeURIComponent(claimed.device.id)}&after_seq=1`);
assert.equal(unscopedProductCursor.response.status, 400);
assert.equal(unscopedProductCursor.payload.error, "relay_cursor_requires_channel");
const unscopedConnectorCursor = await apiRaw("GET", "/v1/connectors/relay/envelopes?after_seq=1", null, claimed.device_token);
assert.equal(unscopedConnectorCursor.response.status, 400);
assert.equal(unscopedConnectorCursor.payload.error, "relay_cursor_requires_channel");
const claimedChatAuthorization = __bridgeTestMemorySnapshot().bridge_authorizations.find((row) => {
  return row.device_id === claimed.device.id && row.product_id === "panda-chat" && row.status === "active";
});
assert.ok(claimedChatAuthorization);
const connectorHasMoreAfterDeniedRows = await __bridgeTestConnectorRelayListPayload(env, [
  {
    id: "relay_has_more_deliverable",
    user_id: claimedChatAuthorization.user_id,
    device_id: claimed.device.id,
    product_id: "panda-chat",
    channel_id: "chan_has_more_active",
    direction: "product_to_device",
    seq: 3,
    request_key: "rq_has_more_active",
    ciphertext: "base64:active",
    aad: "base64:aad",
    nonce: "base64:nonce",
    algorithm: "Noise_XX_25519_ChaChaPoly_BLAKE2s",
    sender_key_id: "product-key-1",
    recipient_key_id: "device-key-1",
    expires_at: new Date(Date.now() + 300000).toISOString(),
    delivery_status: "queued",
    meta: {},
  },
  {
    id: "relay_has_more_denied",
    user_id: claimedChatAuthorization.user_id,
    device_id: claimed.device.id,
    product_id: "panda-dev",
    channel_id: "chan_has_more_denied",
    direction: "product_to_device",
    seq: 4,
    request_key: "rq_has_more_denied",
    ciphertext: "base64:denied",
    aad: "base64:aad",
    nonce: "base64:nonce",
    algorithm: "Noise_XX_25519_ChaChaPoly_BLAKE2s",
    sender_key_id: "product-key-1",
    recipient_key_id: "device-key-1",
    expires_at: new Date(Date.now() + 300000).toISOString(),
    delivery_status: "queued",
    meta: {},
  },
], { limit: 1 });
assert.equal(connectorHasMoreAfterDeniedRows.items.length, 1);
assert.equal(connectorHasMoreAfterDeniedRows.items[0].id, "relay_has_more_deliverable");
assert.equal(connectorHasMoreAfterDeniedRows.cursor.has_more, false);

const snapshot = __bridgeTestMemorySnapshot();
assert.equal(snapshot.bridge_relay_envelopes.length, 2);
assert.ok(snapshot.bridge_relay_envelopes.every((row) => row.ciphertext && row.aad && row.nonce));
assert.ok(snapshot.bridge_relay_envelopes.every((row) => row.idempotency_hash));
assert.doesNotMatch(JSON.stringify(snapshot.bridge_relay_envelopes), /prompt|stdout|stderr|"input"|"result"|"policy"|"kind"|"runtime"/);

const sylloIntent = await api("POST", "/v1/connect-intents", {
  product_id: "panda-syllo",
  device_name: "Syllo Full Device",
  install_id: "install-syllo-full",
  policy: {
    ...authorizationPolicy(RELAY_CAPABILITIES, "[local]/syllo"),
    product_authorization: {
      owner: "panda-syllo",
      enforcement: "syllo-product-adapter",
      control: "computer-control",
      label: "Coco authorized local adapter control",
    },
  },
});
const sylloClaim = await nativeClaimIntent(sylloIntent.token, {
  device_name: "Syllo Full Device",
  install_id: "install-syllo-full",
  capabilities: { relay: ["relay.envelope", "relay.ack"] },
});
const sylloConfirmed = await nativeConfirmIntent(sylloIntent.token, sylloClaim.device_token, {
  "x-panda-bridge-install-id": "install-syllo-full",
});
assert.equal(sylloConfirmed.authorization.status, "active");
const sylloRelayKeyExchange = {
  algorithm: "ECDH-P256+A256GCM",
  key_id: "rkx_test_syllo",
  public_jwk: {
    kty: "EC",
    crv: "P-256",
    x: "f83OJ3D2xF4B2XIBm9W8GvROqVRsY6x1Z3xA4C7v3x8",
    y: "x_FEzRu9i85-Wz9rn8bL1XxVQwWxS4kVYzH8Y8rjWbs",
  },
};
await api("POST", "/v1/connectors/heartbeat", {
  install_id: "install-syllo-full",
  capabilities: { relay: ["relay.envelope", "relay.ack"] },
  local_state: {
    relay: { envelopes: true, ack: true },
    adapter_router: {
      configured: true,
      mode: "external_http",
      products: {
        "panda-syllo": {
          configured: true,
          relay_key_exchange: sylloRelayKeyExchange,
        },
      },
    },
  },
}, sylloConfirmed.device_token || sylloClaim.device_token);
const sylloState = await api("GET", "/v1/bridge/state?product_id=panda-syllo");
const sylloStateDevice = sylloState.devices.find((device) => device.id === sylloClaim.device.id);
assert.equal(sylloStateDevice.relay_key_exchange.key_id, "rkx_test_syllo");
const sylloBootstrap = await api("POST", "/v1/products/panda-syllo/relay-key-bootstrap", {
  device_id: sylloClaim.device.id,
  relay_key_bootstrap: {
    algorithm: "ECDH-P256+A256GCM",
    key_id: "rkx_test_syllo",
    wrapped_key: {
      algorithm: "ECDH-P256+A256GCM",
      key_id: "rkx_test_syllo",
      app_public_jwk: {
        kty: "EC",
        crv: "P-256",
        x: "wWwQx5Dul2jDRdB7r6C5C5h6GdPK6eNi02T0tVPwBiY",
        y: "JL0C83dGqz1U3uc0GRQzZJslcF6ctvPd_EwFQ5QwdXg",
      },
      nonce_b64: "AAAAAAAAAAAAAAAA",
      ciphertext_b64: "ZmFrZS13cmFwcGVkLWtleQ==",
      aad_b64: b64Text(relayKeyBootstrapAadText(
        "panda-syllo",
        sylloClaim.device.id,
        sylloConfirmed.authorization.id,
        sylloConfirmed.authorization.epoch,
        "rkx_test_syllo",
      )),
    },
  },
});
assert.equal(sylloBootstrap.relay_key_bootstrap.status, "ready");
const sylloRelayMeta = {
  adapter_id: "panda-syllo",
  authorization_id: sylloConfirmed.authorization.id,
  authorization_epoch: sylloConfirmed.authorization.epoch,
  relay_key_id: "rkx_test_syllo",
};
assert.deepEqual(sylloConfirmed.authorization.policy.capabilities, RELAY_CAPABILITIES);
assert.deepEqual(sylloConfirmed.authorization.policy.product_authorization, {
  owner: "panda-syllo",
  enforcement: "syllo-product-adapter",
  control: "computer-control",
  label: "Coco authorized local adapter control",
});
const sylloChatEnvelope = await api("POST", "/v1/products/panda-syllo/relay/envelopes", relayEnvelope({
  product_id: "panda-syllo",
  device_id: sylloClaim.device.id,
  channel_id: "syllo_chat",
  direction: "product_to_device",
  request_key: "rq_syllo_chat",
  aad: b64Text(relayEnvelopeAadText({
    productId: "panda-syllo",
    deviceId: sylloClaim.device.id,
    channelId: "syllo_chat",
    authorizationId: sylloConfirmed.authorization.id,
    authorizationEpoch: sylloConfirmed.authorization.epoch,
    keyId: "rkx_test_syllo",
  })),
  meta: sylloRelayMeta,
}));
assert.equal(sylloChatEnvelope.envelope.delivery_status, "queued");
const sylloWrongRelayKey = await apiRaw("POST", "/v1/products/panda-syllo/relay/envelopes", relayEnvelope({
  product_id: "panda-syllo",
  device_id: sylloClaim.device.id,
  channel_id: "syllo_wrong_key",
  direction: "product_to_device",
  request_key: "rq_syllo_wrong_key",
  aad: b64Text(relayEnvelopeAadText({
    productId: "panda-syllo",
    deviceId: sylloClaim.device.id,
    channelId: "syllo_wrong_key",
    authorizationId: sylloConfirmed.authorization.id,
    authorizationEpoch: sylloConfirmed.authorization.epoch,
    keyId: "rkx_wrong",
  })),
  meta: { ...sylloRelayMeta, relay_key_id: "rkx_wrong" },
}));
assert.equal(sylloWrongRelayKey.response.status, 201);
assert.equal(sylloWrongRelayKey.payload.envelope.delivery_status, "queued");
const pausedSyllo = await api("PATCH", `/v1/products/panda-syllo/authorization?device_id=${encodeURIComponent(sylloClaim.device.id)}`, { status: "paused" });
assert.equal(pausedSyllo.authorization.status, "paused");
assert.equal(pausedSyllo.authorization.relay_key_bootstrap, undefined);
const resumedSyllo = await api("PATCH", `/v1/products/panda-syllo/authorization?device_id=${encodeURIComponent(sylloClaim.device.id)}`, { status: "active" });
assert.equal(resumedSyllo.authorization.status, "active");
assert.equal(resumedSyllo.authorization.relay_key_bootstrap, undefined);
const sylloOldEpochAfterResume = await apiRaw("POST", "/v1/products/panda-syllo/relay/envelopes", relayEnvelope({
  product_id: "panda-syllo",
  device_id: sylloClaim.device.id,
  channel_id: "syllo_stale_epoch",
  direction: "product_to_device",
  request_key: "rq_syllo_stale_epoch",
  aad: b64Text(relayEnvelopeAadText({
    productId: "panda-syllo",
    deviceId: sylloClaim.device.id,
    channelId: "syllo_stale_epoch",
    authorizationId: sylloConfirmed.authorization.id,
    authorizationEpoch: sylloConfirmed.authorization.epoch,
    keyId: "rkx_test_syllo",
  })),
  meta: sylloRelayMeta,
}));
assert.equal(sylloOldEpochAfterResume.response.status, 201);
assert.equal(sylloOldEpochAfterResume.payload.envelope.delivery_status, "queued");

const sylloRelayOnlyIntent = await api("POST", "/v1/connect-intents", {
  product_id: "panda-syllo",
  device_name: "Syllo Relay Only Device",
  install_id: "install-syllo-relay-only",
  policy: authorizationPolicy(RELAY_CAPABILITIES, "[local]/syllo-relay"),
});
const sylloRelayOnlyClaim = await nativeClaimIntent(sylloRelayOnlyIntent.token, {
  device_name: "Syllo Relay Only Device",
  install_id: "install-syllo-relay-only",
  capabilities: { relay: ["relay.envelope", "relay.ack"] },
});
const sylloRelayOnlyConfirmed = await nativeConfirmIntent(sylloRelayOnlyIntent.token, sylloRelayOnlyClaim.device_token, {
  "x-panda-bridge-install-id": "install-syllo-relay-only",
});
assert.equal(sylloRelayOnlyConfirmed.authorization.status, "active");
const sylloNoProductAuth = await apiRaw("POST", "/v1/products/panda-syllo/relay/envelopes", relayEnvelope({
  product_id: "panda-syllo",
  device_id: sylloRelayOnlyClaim.device.id,
  channel_id: "syllo_scope",
  request_key: "rq_syllo_scope",
  meta: { adapter_id: "panda-syllo" },
}));
assert.equal(sylloNoProductAuth.response.status, 201);
assert.equal(sylloNoProductAuth.payload.envelope.delivery_status, "queued");

const delegatedIntent = await api("POST", "/v1/connect-intents", {
  product_id: "delegated-demo",
  device_name: "Delegated Relay Device",
  install_id: "install-delegated-demo",
});
const delegatedClaim = await nativeClaimIntent(delegatedIntent.token, {
  device_name: "Delegated Relay Device",
  install_id: "install-delegated-demo",
  capabilities: { relay: ["relay.envelope", "relay.ack"] },
}, claimed.device_token);
assert.equal(delegatedClaim.authorization.status, "pending");
const delegatedConfirmed = await nativeConfirmIntent(delegatedIntent.token, delegatedClaim.device_token, {
  "x-panda-bridge-install-id": "install-delegated-demo",
});
assert.equal(delegatedConfirmed.authorization.status, "active");
const delegatedRelayKeyExchange = {
  algorithm: "ECDH-P256+A256GCM",
  key_id: "rkx_test_delegated_demo",
  public_jwk: {
    kty: "EC",
    crv: "P-256",
    x: "f83OJ3D2xF4B2XIBm9W8GvROqVRsY6x1Z3xA4C7v3x8",
    y: "x_FEzRu9i85-Wz9rn8bL1XxVQwWxS4kVYzH8Y8rjWbs",
  },
};
await api("POST", "/v1/connectors/heartbeat", {
  install_id: "install-delegated-demo",
  capabilities: { relay: ["relay.envelope", "relay.ack"] },
  local_state: {
    relay: { envelopes: true, ack: true },
    adapter_router: {
      configured: true,
      products: {
        "delegated-demo": {
          configured: true,
          relay_key_exchange: delegatedRelayKeyExchange,
        },
      },
    },
  },
}, delegatedConfirmed.device_token || delegatedClaim.device_token);
const delegatedBootstrap = await delegatedApi("POST", "/v1/products/delegated-demo/delegated/relay-key-bootstrap", {
  device_id: delegatedClaim.device.id,
  relay_key_bootstrap: {
    algorithm: "ECDH-P256+A256GCM",
    key_id: "rkx_test_delegated_demo",
    wrapped_key: {
      algorithm: "ECDH-P256+A256GCM",
      key_id: "rkx_test_delegated_demo",
      app_public_jwk: {
        kty: "EC",
        crv: "P-256",
        x: "wWwQx5Dul2jDRdB7r6C5C5h6GdPK6eNi02T0tVPwBiY",
        y: "JL0C83dGqz1U3uc0GRQzZJslcF6ctvPd_EwFQ5QwdXg",
      },
      nonce_b64: "AAAAAAAAAAAAAAAA",
      ciphertext_b64: "ZmFrZS13cmFwcGVkLWtleQ==",
      aad_b64: b64Text(relayKeyBootstrapAadText(
        "delegated-demo",
        delegatedClaim.device.id,
        delegatedConfirmed.authorization.id,
        delegatedConfirmed.authorization.epoch,
        "rkx_test_delegated_demo",
      )),
    },
  },
}, delegatedClaim.account.id, delegatedClaim.device.id);
assert.equal(delegatedBootstrap.relay_key_bootstrap.status, "ready");
assert.equal(delegatedBootstrap.relay_key_bootstrap.key_id, "rkx_test_delegated_demo");
assert.doesNotMatch(JSON.stringify(delegatedBootstrap), /relay_key_b64|relayKeyB64|key_b64|keyB64/);
const delegatedCreated = await delegatedApi("POST", "/v1/products/delegated-demo/delegated/relay/envelopes", relayEnvelope({
  product_id: "delegated-demo",
  device_id: delegatedClaim.device.id,
  channel_id: "delegated_chan",
  request_key: "rq_delegated",
}), delegatedClaim.account.id, delegatedClaim.device.id);
assert.equal(delegatedCreated.envelope.product_id, "delegated-demo");
const badDelegated = await delegatedApiRaw("POST", "/v1/products/delegated-demo/delegated/relay/envelopes", {
  ...relayEnvelope({ product_id: "delegated-demo", device_id: delegatedClaim.device.id, channel_id: "bad_delegated" }),
  payload: { text: "plaintext" },
}, delegatedClaim.account.id, delegatedClaim.device.id);
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

const revokeTarget = await api("POST", "/v1/products/panda-chat/relay/envelopes", relayEnvelope({
  device_id: claimed.device.id,
  channel_id: "revoke",
  request_key: "rq_revoke_cancel",
}));
assert.equal(revokeTarget.envelope.delivery_status, "queued");
const revokeInbox = await api("GET", `/v1/connectors/relay/envelopes?product_id=panda-chat&channel_id=revoke`, null, claimed.device_token);
assert.equal(revokeInbox.items.length, 1);
assert.equal(revokeInbox.items[0].id, revokeTarget.envelope.id);
assert.equal(revokeInbox.items[0].delivery_status, "delivered");
const revokeResult = await api("DELETE", `/v1/products/panda-chat/authorization?device_id=${encodeURIComponent(claimed.device.id)}`);
assert.equal(revokeResult.authorization.status, "revoked");
assert.equal(revokeResult.cancelled_relay_envelopes, 1);
const revokedSnapshot = __bridgeTestMemorySnapshot();
const cancelledEnvelope = revokedSnapshot.bridge_relay_envelopes.find((row) => row.id === revokeTarget.envelope.id);
assert.equal(cancelledEnvelope.delivery_status, "cancelled");
assert.equal(cancelledEnvelope.meta.cancelled_reason, "authorization_revoked");
const cancelledAck = await apiRaw("POST", `/v1/connectors/relay/envelopes/${encodeURIComponent(revokeTarget.envelope.id)}/ack`, {}, claimed.device_token);
assert.equal(cancelledAck.response.status, 409);
assert.equal(cancelledAck.payload.error, "relay_envelope_cancelled");
const revokedInbox = await api("GET", `/v1/connectors/relay/envelopes?product_id=panda-chat&channel_id=revoke`, null, claimed.device_token);
assert.equal(revokedInbox.items.some((item) => item.id === revokeTarget.envelope.id), false);
const revokedCreate = await apiRaw("POST", "/v1/products/panda-chat/relay/envelopes", relayEnvelope({
  device_id: claimed.device.id,
  channel_id: "revoke_after",
  request_key: "rq_after_revoke",
}));
assert.equal(revokedCreate.response.status, 403);
assert.equal(revokedCreate.payload.error, "authorization_revoked");

console.log("[worker.test] pass");
