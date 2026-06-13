import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BRIDGE_RUNTIME_CAPABILITIES,
  PRODUCT_REGISTRY,
  RELAY_CAPABILITIES,
} from "../../apps/cloud-worker/src/products.js";
import * as protocol from "../../packages/protocol/src/index.js";
import { validateRelayEnvelope } from "../../packages/protocol/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

const verticalKinds = [
  "codex.",
  "claude.",
  "syllo.",
  "shell.run",
  "fs.read",
  "fs.write",
  "data.",
];

assert.deepEqual(BRIDGE_RUNTIME_CAPABILITIES, RELAY_CAPABILITIES);
assert.equal(Object.hasOwn(protocol, "validateBridgeJob"), false, "protocol root must not expose validateBridgeJob");
assert.equal(Object.hasOwn(protocol, "normalizeBridgeJob"), false, "protocol root must not expose normalizeBridgeJob");
for (const product of Object.values(PRODUCT_REGISTRY)) {
  assert.deepEqual(product.capabilities, RELAY_CAPABILITIES, `${product.id} must expose relay-only capabilities`);
  const serialized = JSON.stringify(product);
  for (const marker of verticalKinds) {
    assert.equal(serialized.includes(marker), false, `${product.id} still exposes ${marker}`);
  }
}

const calls = [];
const fakeFetch = async (url, options = {}) => {
  calls.push({
    url,
    method: options.method,
    body: options.body ? JSON.parse(options.body) : null,
  });
  return {
    ok: true,
    status: 201,
    text: async () => JSON.stringify({ envelope: { id: "env_1" } }),
  };
};

const client = createBridgeClient({
  apiBase: "https://bridge.example.test",
  productId: "panda-syllo",
  fetch: fakeFetch,
});
assert.equal(Object.hasOwn(client, "codex"), false, "SDK must not expose client.codex");
assert.equal(Object.hasOwn(client, "data"), false, "SDK must not expose client.data");
assert.equal(Object.hasOwn(client, "jobs"), false, "SDK must not expose client.jobs");
assert.equal(typeof client.relay.create, "function");

await client.relay.create({
  deviceId: "dev_1",
  channelId: "chan_1",
  seq: 1,
  ciphertext: "base64:ciphertext",
  aad: "base64:aad",
  nonce: "base64:nonce",
  algorithm: "X25519-AES-GCM",
  senderKeyId: "product-key-1",
  recipientKeyId: "device-key-1",
});
assert.equal(calls[0].method, "POST");
assert.equal(calls[0].url, "https://bridge.example.test/v1/products/panda-syllo/relay/envelopes");
assert.equal(calls[0].body.direction, "product_to_device");
assert.equal(calls[0].body.product_id, "panda-syllo");

const plaintext = validateRelayEnvelope({
  productId: "panda-syllo",
  deviceId: "dev_1",
  channelId: "chan_1",
  direction: "product_to_device",
  seq: 1,
  ciphertext: "base64:ciphertext",
  aad: "base64:aad",
  nonce: "base64:nonce",
  algorithm: "X25519-AES-GCM",
  senderKeyId: "product-key-1",
  recipientKeyId: "device-key-1",
  input: { prompt: "visible business data" },
});
assert.equal(plaintext.ok, false);
assert.ok(plaintext.errors.includes("plaintext_fields_forbidden"));

const metaPlaintext = validateRelayEnvelope({
  productId: "panda-syllo",
  deviceId: "dev_1",
  channelId: "chan_1",
  direction: "product_to_device",
  seq: 1,
  ciphertext: "base64:ciphertext",
  aad: "base64:aad",
  nonce: "base64:nonce",
  algorithm: "X25519-AES-GCM",
  senderKeyId: "product-key-1",
  recipientKeyId: "device-key-1",
  meta: { payload: "visible business data", message: "hello", path: "/secret" },
});
assert.equal(metaPlaintext.ok, false);
assert.deepEqual(metaPlaintext.plaintext_fields, ["meta.message", "meta.path", "meta.payload"]);

const desktopMain = readFileSync(new URL("../../apps/desktop/src/main.rs", import.meta.url), "utf8");
assert.ok(desktopMain.includes("/v1/connectors/relay/envelopes"), "Desktop must poll relay envelope endpoint");
assert.ok(desktopMain.includes("route_relay_envelope_to_adapter"), "Desktop must route relay envelopes to AdapterRouter");
assert.ok(desktopMain.includes("PANDA_BRIDGE_ADAPTER_URL"), "Desktop must use product adapter endpoint env");
assert.ok(desktopMain.includes("Ok(ConnectorRegistry::new())"), "non-test execution registry must be empty");
const localStateStart = desktopMain.indexOf("fn local_state() -> Value");
const localStateEnd = desktopMain.indexOf("fn low_tier_capabilities", localStateStart);
const localState = desktopMain.slice(localStateStart, localStateEnd);
assert.equal(localState.includes("commands"), false, "local_state must not publish commands");
assert.equal(localState.includes("workspaces"), false, "local_state must not publish workspaces");
assert.equal(localState.includes("codex"), false, "local_state must not publish codex state");

console.log("[relay-boundary] pass");
