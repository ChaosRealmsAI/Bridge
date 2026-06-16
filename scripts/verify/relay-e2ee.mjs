import assert from "node:assert/strict";

import { relayEnvelopeRecord, validateRelayEnvelope } from "../../packages/protocol/src/index.js";

const crypto = globalThis.crypto;
assert.ok(crypto?.subtle, "WebCrypto subtle API is required");

const encoder = new TextEncoder();
const plaintext = encoder.encode(JSON.stringify({ prompt: "never leaves endpoint before encryption" }));
const aad = encoder.encode("product:acme-demo|device:dev_1|channel:chan_1|seq:1");
const iv = crypto.getRandomValues(new Uint8Array(12));
const key = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 },
  true,
  ["encrypt", "decrypt"],
);
const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext));
const packedCiphertext = Buffer.from(ciphertext).toString("base64");
const packedAad = Buffer.from(aad).toString("base64");
const packedIv = Buffer.from(iv).toString("base64");

const envelope = validateRelayEnvelope({
  productId: "acme-demo",
  deviceId: "dev_1",
  channelId: "chan_1",
  direction: "product_to_device",
  seq: 1,
  ciphertext: packedCiphertext,
  aad: packedAad,
  nonce: packedIv,
  algorithm: "AES-GCM-256",
  senderKeyId: "product-key-1",
  recipientKeyId: "device-key-1",
});
assert.equal(envelope.ok, true);

const record = relayEnvelopeRecord(envelope.envelope, { userId: "user_1" });
for (const forbidden of ["prompt", "input", "payload", "stdout", "stderr", "result", "response"]) {
  assert.equal(Object.hasOwn(record, forbidden), false, `relay record must not contain ${forbidden}`);
}

const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ciphertext);
assert.deepEqual(new Uint8Array(opened), plaintext);

const tampered = new Uint8Array(ciphertext);
tampered[0] = tampered[0] ^ 1;
await assert.rejects(
  () => crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, tampered),
  { name: "OperationError" },
);

console.log("[relay-e2ee] pass");
