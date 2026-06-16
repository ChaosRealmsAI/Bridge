#!/usr/bin/env node
// Minimal Panda Bridge caller — runnable locally against the in-memory Worker.
//
// Demonstrates the current product server SDK flow end to end:
//   1. SERVER  creates a connect intent (delegated, HMAC-signed by the SDK)
//   2. DESKTOP claims and confirms the intent
//   3. SERVER  reads account-level state
//   4. SERVER  bootstraps product-owned relay key wrapping metadata
//   5. SERVER  sends an opaque relay envelope
//   6. DESKTOP reads, ACKs, and replies with an opaque relay envelope
//   7. SERVER  waits for and ACKs the reply
//
// No external server is started: the Worker fetch handler runs in-process.
// Run with:  node examples/minimal-caller/run-local.mjs

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeServerClient } from "../../packages/sdk/src/server.js";

const apiBase = "http://minimal-caller.local";
const productId = "otherline";
const delegationSecret = "minimal-caller-otherline-secret";
const installId = "minimal-caller-install-id";
const relayKeyId = "rkx_minimal_caller";

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
const account = { id: userId, display_name: "Minimal Caller User" };

// 1) SERVER: empty to start — no account is authorized yet.
const initialState = await bridge.state({ userId });
assert.equal(initialState.ready, false);
assert.deepEqual(initialState.accounts, []);
console.log("1. state(): no account yet, ready =", initialState.ready);

// 2) SERVER: create a connect intent. The SDK signs the delegated request.
const intent = await bridge.createConnectIntent({
  userId,
  account,
  deviceName: "Minimal Caller Mac",
  installId,
  policy: bridgePolicy(),
});
assert.match(intent.token, /^pbi_/);
console.log("2. createConnectIntent(): token =", `${intent.token.slice(0, 12)}...`);
console.log("   front-end opens intent.deep_link to launch Panda Bridge Desktop");

// 3) DESKTOP: the user approves on their Mac. The desktop app natively claims
//    then confirms the intent. Browsers can never claim.
const claim = await desktopClaim(intent.token, {
  device_name: "Minimal Caller Mac",
  install_id: installId,
});
assert.equal(claim.authorization.status, "pending");
const confirmed = await desktopConfirm(intent.token, claim.device_token, installId);
assert.equal(confirmed.authorization.status, "active");
const deviceId = confirmed.device?.id || claim.device.id;
const deviceToken = confirmed.device_token || claim.device_token;
console.log("3. desktop claimed + confirmed the intent -> account active + device online");

// The real desktop periodically sends heartbeat. This fixture advertises the
// product-scoped relay-key exchange so the server can bootstrap key wrapping.
await connectorHeartbeat(deviceToken);

// 4) SERVER: re-read account-level state.
const state = await bridge.state({ userId });
const current = state.current_account;
assert.equal(current.authorization.status, "active");
assert.equal(current.connected, true);
assert.equal(state.ready, true);
console.log("4. state(): account =", current.account?.display_name,
  "| authorization =", current.authorization.status,
  "| connected =", current.connected);

// 5) SERVER: bootstrap relay key metadata. The SDK owns HMAC headers; product
//    code owns key wrapping and ciphertext generation.
const bootstrap = await bridge.bootstrapRelayKey({
  userId,
  deviceId,
  relayKeyBootstrap: {
    algorithm: "ECDH-P256+A256GCM",
    key_id: relayKeyId,
    wrapped_key: {
      algorithm: "ECDH-P256+A256GCM",
      key_id: relayKeyId,
      app_public_jwk: appPublicJwk(),
      nonce_b64: "AAAAAAAAAAAAAAAA",
      ciphertext_b64: b64Text("fake-wrapped-relay-key"),
      aad_b64: b64Text(relayKeyBootstrapAadText(
        productId,
        deviceId,
        confirmed.authorization.id,
        confirmed.authorization.epoch,
        relayKeyId,
      )),
    },
  },
});
assert.equal(bootstrap.relay_key_bootstrap.status, "ready");
console.log("5. bootstrapRelayKey(): key =", bootstrap.relay_key_bootstrap.key_id);

// 6) SERVER: send one opaque relay envelope.
const channelId = `minimal-caller-${Date.now()}`;
const requestKey = `${channelId}:request`;
const created = await bridge.createRelayEnvelope({
  userId,
  deviceId,
  channelId,
  seq: 1,
  requestKey,
  ciphertext: b64Text("encrypted product request: reply OK"),
  aad: b64Text(`aad:${channelId}:request`),
  nonce: b64Text("nonce-request"),
  algorithm: "Noise_XX_25519_ChaChaPoly_BLAKE2s",
  senderKeyId: "product-key-1",
  recipientKeyId: relayKeyId,
  meta: {
    adapter_id: productId,
    schema_id: "minimal-caller-relay-v1",
    trace_id: channelId,
  },
});
assert.equal(created.envelope.direction, "product_to_device");
console.log("6. createRelayEnvelope(): envelope =", created.envelope.id);

// The real desktop connector owns local execution. Here it receives the opaque
// request, ACKs it, and sends an opaque response through public connector APIs.
await connectorReadAndReply(deviceToken, { channelId });

const waited = await bridge.waitForResponse({
  userId,
  deviceId,
  channelId,
  afterSeq: 1,
  timeoutMs: 5000,
  intervalMs: 50,
});
assert.equal(waited.envelope.direction, "device_to_product");
assert.equal(waited.envelope.seq, 2);
await waited.ack();
console.log("7. waitForResponse(): response =", waited.envelope.id, "acked = true");

console.log("\nDONE — server-created intent -> desktop approval -> relay envelope round trip.");

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
      app_version: "minimal-caller-v0.2",
      capabilities: { relay: ["relay.envelope", "relay.ack"] },
      local_state: relayReadyLocalState(),
    }),
  });
  const payload = JSON.parse(await response.text());
  assert.ok(response.ok, `claim failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function desktopConfirm(token, bearer, installIdValue) {
  const path = `/v1/connect-intents/${encodeURIComponent(token)}/confirm`;
  const response = await workerFetch(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
      "x-panda-bridge-local-client": "connector-cli",
      "x-panda-bridge-install-id": installIdValue,
    },
    body: JSON.stringify({ confirmed: true }),
  });
  const payload = JSON.parse(await response.text());
  assert.ok(response.ok, `confirm failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function connectorHeartbeat(deviceToken) {
  const payload = await connector(deviceToken, "POST", "/v1/connectors/heartbeat", {
    install_id: installId,
    capabilities: { relay: ["relay.envelope", "relay.ack"] },
    local_state: relayReadyLocalState(),
  });
  assert.equal(payload.device.status, "online");
  return payload;
}

async function connectorReadAndReply(deviceToken, { channelId }) {
  const inbox = await connector(deviceToken, "GET", `/v1/connectors/relay/envelopes?product_id=${encodeURIComponent(productId)}&channel_id=${encodeURIComponent(channelId)}`);
  assert.equal(inbox.items.length, 1);
  const request = inbox.items[0];
  assert.equal(request.direction, "product_to_device");
  assert.equal(request.channel_id, channelId);

  await connector(deviceToken, "POST", `/v1/connectors/relay/envelopes/${encodeURIComponent(request.id)}/ack`, {});
  const response = await connector(deviceToken, "POST", "/v1/connectors/relay/envelopes", {
    product_id: productId,
    channel_id: channelId,
    seq: 2,
    request_key: `${channelId}:response`,
    ciphertext: b64Text("encrypted desktop response: OK"),
    aad: b64Text(`aad:${channelId}:response`),
    nonce: b64Text("nonce-response"),
    algorithm: "Noise_XX_25519_ChaChaPoly_BLAKE2s",
    sender_key_id: relayKeyId,
    recipient_key_id: "product-key-1",
    meta: {
      adapter_id: productId,
      schema_id: "minimal-caller-relay-v1",
      trace_id: channelId,
    },
  });
  assert.equal(response.envelope.direction, "device_to_product");
  return response;
}

async function connector(deviceToken, method, path, body = null) {
  const response = await workerFetch(`${apiBase}${path}`, {
    method,
    headers: {
      accept: "application/json",
      origin: apiBase,
      authorization: `Bearer ${deviceToken}`,
      "x-panda-bridge-install-id": installId,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = JSON.parse(await response.text());
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

function bridgePolicy() {
  return {
    version: "AUTH-SCOPE-v2",
    capabilities: ["relay.envelope", "relay.ack"],
    workspace_roots: [{ id: "default", path_display: "Minimal Caller workspace" }],
    source_origin: apiBase,
  };
}

function relayReadyLocalState() {
  return {
    platform: "local-fixture",
    relay: { envelopes: true, ack: true },
    adapter_router: {
      configured: true,
      mode: "external_http",
      products: {
        [productId]: {
          configured: true,
          relay_key_exchange: {
            algorithm: "ECDH-P256+A256GCM",
            key_id: relayKeyId,
            public_jwk: devicePublicJwk(),
          },
        },
      },
    },
  };
}

function relayKeyBootstrapAadText(product, device, authorization, epoch, keyId) {
  return ["bridge-relay-key-bootstrap-v1", product, device, authorization, String(epoch), keyId].join("|");
}

function b64Text(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function devicePublicJwk() {
  return {
    kty: "EC",
    crv: "P-256",
    x: "f83OJ3D2xF4B2XIBm9W8GvROqVRsY6x1Z3xA4C7v3x8",
    y: "x_FEzRu9i85-Wz9rn8bL1XxVQwWxS4kVYzH8Y8rjWbs",
  };
}

function appPublicJwk() {
  return {
    kty: "EC",
    crv: "P-256",
    x: "wWwQx5Dul2jDRdB7r6C5C5h6GdPK6eNi02T0tVPwBiY",
    y: "JL0C83dGqz1U3uc0GRQzZJslcF6ctvPd_EwFQ5QwdXg",
  };
}
