import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
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
    calls.push({ url, init });
    return new Response(JSON.stringify({ authorization: { status: "active" }, device: { id: "dev_1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});

await server.authorization({ userId: "user_1", deviceId: "dev_1" });
const authCall = calls[0];
const authPath = "/v1/products/otherline/delegated/authorization?device_id=dev_1";
const emptyHash = createHash("sha256").update("").digest("hex");
const authSigningPayload = [
  "GET",
  authPath,
  "otherline",
  "user_1",
  "dev_1",
  timestamp,
  nonce,
  emptyHash,
].join("\n");
assert.equal(authCall.url, `https://api.example.test${authPath}`);
assert.equal(authCall.init.headers["x-panda-bridge-body-sha256"], emptyHash);
assert.equal(
  authCall.init.headers["x-panda-bridge-signature"],
  createHmac("sha256", secret).update(authSigningPayload).digest("hex"),
);

const jobCalls = [];
const jobServer = createBridgeServerClient({
  apiBase: "https://api.example.test",
  productId: "otherline",
  secret,
  timestamp,
  nonce,
  fetch: async (url, init) => {
    jobCalls.push({ url, init });
    return new Response(JSON.stringify({ job: { id: "job_1", status: "queued" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  },
});
await jobServer.createJob({
  userId: "user_1",
  deviceId: "dev_1",
  kind: "codex.chat",
  payload: { prompt: "hello" },
  policy: { timeout_ms: 1000 },
  requestKey: "rk_1",
});
const bodyText = jobCalls[0].init.body;
const bodyHash = createHash("sha256").update(bodyText).digest("hex");
const jobSigningPayload = [
  "POST",
  "/v1/products/otherline/delegated/jobs",
  "otherline",
  "user_1",
  "dev_1",
  timestamp,
  nonce,
  bodyHash,
].join("\n");
assert.equal(jobCalls[0].init.headers["x-panda-bridge-body-sha256"], bodyHash);
assert.equal(
  jobCalls[0].init.headers["x-panda-bridge-signature"],
  createHmac("sha256", secret).update(jobSigningPayload).digest("hex"),
);

const stateCalls = [];
const stateServer = createBridgeServerClient({
  apiBase: "https://api.example.test",
  productId: "otherline",
  secret,
  timestamp,
  nonce,
  fetch: async (url) => {
    stateCalls.push(new URL(url).pathname);
    if (stateCalls.length === 1) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      devices: [{ id: "dev_1", device_name: "Mac Studio", status: "online" }],
      authorized_devices: [{ id: "dev_1", device_name: "Mac Studio", status: "online" }],
      authorizations: [{ id: "auth_1", device_id: "dev_1", status: "active" }],
      selected_device: { id: "dev_1", device_name: "Mac Studio", status: "online" },
      authorization: { id: "auth_1", device_id: "dev_1", status: "active" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
const fallbackState = await stateServer.state({ userId: "user_1" });
assert.deepEqual(stateCalls, [
  "/v1/products/otherline/delegated/state",
  "/v1/products/otherline/delegated/status",
]);
assert.equal(fallbackState.bridge_state, "ready");
assert.equal(fallbackState.devices[0].current, true);

console.log("[server.test] pass");
