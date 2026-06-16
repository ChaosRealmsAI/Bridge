import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createBridgeServerClient } from "../src/server.js";

const secret = "example-product-delegation-test-secret";
const timestamp = "2026-06-11T00:00:00.000Z";
const nonce = "nonce-test-1";
const calls = [];
const server = createBridgeServerClient({
  apiBase: "https://api.example.test",
  productId: "example-product",
  secret,
  timestamp,
  nonce,
  fetch: async (url, init) => {
    const parsed = new URL(url);
    calls.push({ path: `${parsed.pathname}${parsed.search}`, init });
    return new Response(JSON.stringify({
      authorization: { status: init.method === "PATCH" ? JSON.parse(init.body).status : "revoked" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});

await server.authorization.pause({ userId: "user_1" });
const pausePath = "/v1/products/example-product/delegated/authorization";
const pauseBody = JSON.stringify({ status: "paused" });
assert.equal(calls[0].path, pausePath);
assert.equal(calls[0].init.body, pauseBody);
assertSignedExactly(calls[0], {
  method: "PATCH",
  path: pausePath,
  userId: "user_1",
  deviceId: "account",
  bodyText: pauseBody,
});

await server.authorization.remove({ userId: "user_1", deviceId: "dev_1" });
const removePath = "/v1/products/example-product/delegated/authorization?device_id=dev_1";
assert.equal(calls[1].path, removePath);
assert.equal(calls[1].init.body, undefined);
assertSignedExactly(calls[1], {
  method: "DELETE",
  path: removePath,
  userId: "user_1",
  deviceId: "dev_1",
  bodyText: "",
});

console.log("[worker.test] pass");

function assertSignedExactly(call, input) {
  const bodyHash = createHash("sha256").update(input.bodyText).digest("hex");
  const signingPayload = [
    input.method,
    input.path,
    "example-product",
    input.userId,
    input.deviceId,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  assert.equal(call.init.headers["x-panda-bridge-product-id"], "example-product");
  assert.equal(call.init.headers["x-panda-bridge-user-id"], input.userId);
  assert.equal(call.init.headers["x-panda-bridge-device-id"], input.deviceId);
  assert.equal(call.init.headers["x-panda-bridge-request-timestamp"], timestamp);
  assert.equal(call.init.headers["x-panda-bridge-request-nonce"], nonce);
  assert.equal(call.init.headers["x-panda-bridge-body-sha256"], bodyHash);
  assert.equal(
    call.init.headers["x-panda-bridge-signature"],
    createHmac("sha256", secret).update(signingPayload).digest("hex"),
  );
}
