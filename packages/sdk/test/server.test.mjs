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
      cancelled_jobs: init.method === "DELETE" ? 1 : 0,
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
assert.equal(removed.cancelled_jobs, 1);
assert.equal(calls[4].path, "/v1/products/otherline/delegated/authorization?device_id=dev_1");
assert.equal(calls[4].init.method, "DELETE");

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
assert.equal(fallbackState.bridge_state, undefined);

console.log("[server.test] pass");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
