import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  bridgeRelayEnvelopeAadText,
  bridgeRelayKeyBootstrapAadText,
} from "../../packages/sdk/src/index.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const android = read("packages/native/android/src/main/java/cc/pandabridge/sdk/BridgeRelaySdk.kt");
const ios = read("packages/native/ios/Sources/PandaBridgeKit/BridgeRelay.swift");

const envelopeAad = bridgeRelayEnvelopeAadText({
  productId: "panda-burn",
  deviceId: "dev_1",
  channelId: "chan_1",
  direction: "product_to_device",
  seq: 1,
  authorizationId: "auth_1",
  authorizationEpoch: 3,
  relayKeyId: "rk_1",
});
assert.equal(
  envelopeAad,
  "product:panda-burn|device:dev_1|channel:chan_1|direction:product_to_device|seq:1|authorization:auth_1|epoch:3|relay_key:rk_1",
);

const bootstrapAad = bridgeRelayKeyBootstrapAadText({
  productId: "panda-burn",
  deviceId: "dev_1",
  authorizationId: "auth_1",
  authorizationEpoch: 3,
  relayKeyId: "rk_1",
});
assert.equal(bootstrapAad, "bridge-relay-key-bootstrap-v1|panda-burn|dev_1|auth_1|3|rk_1");

for (const [name, text] of [["Android", android], ["iOS", ios]]) {
  for (const marker of [
    "direction:",
    "authorization:",
    "epoch:",
    "relay_key:",
    "bridge-relay-key-bootstrap-v1",
    "product_to_device",
    "device_to_product",
    "after_seq",
    "wait_ms",
  ]) {
    assert.ok(text.includes(marker), `${name} native SDK missing relay parity marker ${marker}`);
  }
  const hasAckPath = text.includes("/ack") || text.includes("appendPathComponent(\"ack\")");
  assert.ok(hasAckPath, `${name} native SDK missing relay parity marker ack path`);
  for (const productMarker of [/\bburn\b/i, /\bcodex\b/i, /\bclaude\b/i]) {
    assert.equal(productMarker.test(text), false, `${name} native SDK must stay product-neutral: ${productMarker}`);
  }
}

console.log("[native-sdk-parity] pass");

function read(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}
