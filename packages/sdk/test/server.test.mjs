import assert from "node:assert/strict";
import { createBridgeServerClient } from "../src/server.js";

const secret = "otherline-delegation-test-secret";
const timestamp = "2026-06-11T00:00:00.000Z";
const nonce = "nonce-test-1";

const calls = [];
const server = createBridgeServerClient({
  apiBase: "https://api.example.test",
  productId: "otherline",
  secret,
  timestamp,
  nonce,
  fetch: async (url, init) => {
    const parsed = new URL(url);
    calls.push({ path: `${parsed.pathname}${parsed.search}`, init });
    if (parsed.pathname.endsWith("/delegated/state")) {
      return jsonResponse({
        product: { id: "otherline" },
        accounts: [{
          account: { id: "acct_1", email: "owner@example.test" },
          authorization: { id: "auth_1", status: "active" },
          connected: true,
          current_device: { id: "dev_1", status: "online" },
        }],
        install: { version: "0.1.0" },
      });
    }
    const body = init.body ? JSON.parse(init.body) : {};
    return jsonResponse({
      authorization: { id: "auth_1", device_id: "dev_1", status: body.status || "active" },
      device: { id: "dev_1", status: "online" },
      cancelled_relay_envelopes: init.method === "DELETE" ? 1 : 0,
    });
  },
});

const state = await server.state({ userId: "user_1" });
assert.equal(state.product_id, "otherline");
assert.equal(state.ready, true);
assert.equal(state.accounts[0].authorization.status, "active");
assert.equal(state.accounts[0].connected, true);
assert.equal(calls[0].path, "/v1/products/otherline/delegated/state");

const listed = await server.authorization({ userId: "user_1", deviceId: "dev_1" });
assert.equal(listed.authorization.status, "active");
assert.equal(calls[1].path, "/v1/products/otherline/delegated/authorization?device_id=dev_1");
assert.equal(calls[1].init.method, "GET");

const paused = await server.authorization.pause({ userId: "user_1" });
assert.equal(paused.authorization.status, "paused");
assert.equal(calls[2].path, "/v1/products/otherline/delegated/authorization");
assert.equal(calls[2].init.method, "PATCH");
assert.deepEqual(JSON.parse(calls[2].init.body), { status: "paused" });

await server.authorization.resume({ userId: "user_1" });
assert.equal(calls[3].init.method, "PATCH");
assert.deepEqual(JSON.parse(calls[3].init.body), { status: "active" });

const removed = await server.authorization.remove({ userId: "user_1", deviceId: "dev_1" });
assert.equal(removed.cancelled_relay_envelopes, 1);
assert.equal(calls[4].path, "/v1/products/otherline/delegated/authorization?device_id=dev_1");
assert.equal(calls[4].init.method, "DELETE");

await server.createRelayEnvelope({
  userId: "user_1",
  deviceId: "dev_1",
  channelId: "chan_1",
  ciphertext: "base64:ciphertext",
  aad: "base64:aad",
  nonce: "base64:nonce",
  algorithm: "Noise_XX_25519_ChaChaPoly_BLAKE2s",
  senderKeyId: "product-key-1",
  recipientKeyId: "device-key-1",
});
assert.equal(calls[5].path, "/v1/products/otherline/delegated/relay/envelopes");
assert.equal(calls[5].init.method, "POST");
assert.equal(new Headers(calls[5].init.headers).get("x-panda-bridge-device-id"), "dev_1");
assert.equal(JSON.parse(calls[5].init.body).direction, "product_to_device");

await server.createConnectIntent({
  userId: "user_1",
  deviceId: "pending",
  deviceName: "Mac Studio",
  installId: "install_1",
  account: { id: "acct_1" },
  policy: { capabilities: ["relay.envelope"] },
});
assert.equal(calls[6].path, "/v1/products/otherline/delegated/connect-intents");
assert.equal(calls[6].init.method, "POST");
assert.deepEqual(JSON.parse(calls[6].init.body), {
  account: { id: "acct_1" },
  device_name: "Mac Studio",
  install_id: "install_1",
  policy: { capabilities: ["relay.envelope"] },
});

await server.bootstrapRelayKey({
  userId: "user_1",
  deviceId: "dev_1",
  relayKeyBootstrap: {
    key_id: "rkx_1",
    wrapped_key: { key_id: "rkx_1" },
  },
});
assert.equal(calls[7].path, "/v1/products/otherline/delegated/relay-key-bootstrap");
assert.equal(calls[7].init.method, "POST");
assert.equal(new Headers(calls[7].init.headers).get("x-panda-bridge-device-id"), "dev_1");
assert.deepEqual(JSON.parse(calls[7].init.body), {
  device_id: "dev_1",
  relay_key_bootstrap: {
    key_id: "rkx_1",
    wrapped_key: { key_id: "rkx_1" },
  },
});

const waitCalls = [];
const waitServer = createBridgeServerClient({
  apiBase: "https://api.example.test",
  productId: "otherline",
  secret,
  timestamp,
  nonce,
  fetch: async (url, init) => {
    const parsed = new URL(url);
    waitCalls.push({ path: `${parsed.pathname}${parsed.search}`, init });
    if (parsed.pathname.endsWith("/ack")) {
      return jsonResponse({ acked: true });
    }
    return jsonResponse({
      items: [{
        id: "env_reply_1",
        device_id: "dev_1",
        channel_id: "chan_1",
        direction: "device_to_product",
        seq: 2,
        ciphertext: "base64:reply",
      }],
    });
  },
});
const waited = await waitServer.waitForResponse({
  userId: "user_1",
  deviceId: "dev_1",
  channelId: "chan_1",
  afterSeq: 1,
  intervalMs: 1,
  timeoutMs: 20,
});
assert.equal(waited.envelope.id, "env_reply_1");
assert.equal(waitCalls[0].path, "/v1/products/otherline/delegated/relay/envelopes?device_id=dev_1&channel_id=chan_1&after_seq=1");
assert.equal(waitCalls[0].init.method, "GET");
assert.equal(new Headers(waitCalls[0].init.headers).get("x-panda-bridge-device-id"), "dev_1");
await waited.ack();
assert.equal(waitCalls[1].path, "/v1/products/otherline/delegated/relay/envelopes/env_reply_1/ack");
assert.equal(waitCalls[1].init.method, "POST");

await waitServer.listRelayEnvelopes({
  userId: "user_1",
  deviceId: "dev_1",
  channelId: "chan_1",
  afterSeq: 2,
  limit: 25,
  waitMs: 5000,
  includeAcked: true,
});
assert.equal(waitCalls[2].path, "/v1/products/otherline/delegated/relay/envelopes?device_id=dev_1&channel_id=chan_1&after_seq=2&limit=25&wait_ms=5000&include_acked=true");
assert.equal(waitCalls[2].init.method, "GET");

const fallbackCalls = [];
const fallbackServer = createBridgeServerClient({
  apiBase: "https://api.example.test",
  productId: "otherline",
  secret,
  timestamp,
  nonce,
  fetch: async (url) => {
    const parsed = new URL(url);
    fallbackCalls.push(parsed.pathname);
    if (fallbackCalls.length === 1) {
      return jsonResponse({ error: "not_found" }, 404);
    }
    return jsonResponse({
      devices: [{ id: "dev_1", device_name: "Mac Studio", status: "online" }],
      authorized_devices: [{ id: "dev_1", device_name: "Mac Studio", status: "online" }],
      authorizations: [{ id: "auth_1", device_id: "dev_1", status: "active" }],
      selected_device: { id: "dev_1", device_name: "Mac Studio", status: "online" },
      authorization: { id: "auth_1", device_id: "dev_1", status: "active" },
    });
  },
});

const fallbackState = await fallbackServer.state({ userId: "user_1" });
assert.deepEqual(fallbackCalls, [
  "/v1/products/otherline/delegated/state",
  "/v1/products/otherline/delegated/status",
]);
assert.equal(fallbackState.ready, true);
assert.equal(fallbackState.accounts[0].current_device.id, "dev_1");
assert.equal(fallbackState.bridge_state, "ready");

// Account-level pause/resume/remove sign the "account" placeholder device id, so
// the signing path carries no concrete device and the worker resolves it.
const accountLevelCalls = [];
const accountLevelServer = createBridgeServerClient({
  apiBase: "https://api.example.test",
  productId: "otherline",
  secret,
  timestamp,
  nonce,
  fetch: async (url, init) => {
    const parsed = new URL(url);
    accountLevelCalls.push({ path: `${parsed.pathname}${parsed.search}`, method: init.method, deviceHeader: new Headers(init.headers).get("x-panda-bridge-device-id") });
    if (init.method === "DELETE") {
      return jsonResponse({ authorization: { id: "auth_1", device_id: "dev_1", status: "revoked" }, device: { id: "dev_1", status: "online" }, cancelled_relay_envelopes: 2 });
    }
    const body = init.body ? JSON.parse(init.body) : {};
    return jsonResponse({ authorization: { id: "auth_1", device_id: "dev_1", status: body.status || "active" }, device: { id: "dev_1", status: "online" } });
  },
});
const acctPaused = await accountLevelServer.authorization.pause({ userId: "user_1" });
assert.equal(acctPaused.authorization.status, "paused");
const acctResumed = await accountLevelServer.authorization.resume({ userId: "user_1" });
assert.equal(acctResumed.authorization.status, "active");
const acctRemoved = await accountLevelServer.authorization.remove({ userId: "user_1" });
assert.equal(acctRemoved.cancelled_relay_envelopes, 2);
// No concrete device_id in the path; the "account" placeholder rides in the signed header only.
assert.deepEqual(accountLevelCalls.map((c) => [c.method, c.path]), [
  ["PATCH", "/v1/products/otherline/delegated/authorization"],
  ["PATCH", "/v1/products/otherline/delegated/authorization"],
  ["DELETE", "/v1/products/otherline/delegated/authorization"],
]);
assert.ok(accountLevelCalls.every((c) => c.deviceHeader === "account"), "account-level calls sign the account placeholder device id");

// BridgeError fills a human-readable message when the worker returns only a code.
const erroringServer = createBridgeServerClient({
  apiBase: "https://api.example.test",
  productId: "otherline",
  secret,
  timestamp,
  nonce: () => `nonce-${Math.random()}`,
  fetch: async () => jsonResponse({ error: "product_not_authorized" }, 403),
});
await assert.rejects(
  () => erroringServer.authorization.pause({ userId: "user_1" }),
  (error) => {
    assert.equal(error.code, "product_not_authorized");
    assert.notEqual(error.message, "product_not_authorized");
    assert.match(error.message, /授权/);
    assert.equal(error.status, 403);
    return true;
  },
);

console.log("[server.test] pass");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
