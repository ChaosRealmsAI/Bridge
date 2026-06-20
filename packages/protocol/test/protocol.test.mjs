import assert from "node:assert/strict";
import * as protocol from "../src/index.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  RELAY_ENVELOPE_VERSION,
  forbiddenPlaintextFields,
  invalidRelayMetaFields,
  publicRelayEnvelope,
  relayEnvelopeRecord,
  validateRelayEnvelope,
} from "../src/index.js";

assert.equal(BRIDGE_PROTOCOL_VERSION, "bridge-protocol-v0.2");
assert.equal(Object.hasOwn(protocol, "validateBridgeJob"), false);
assert.equal(Object.hasOwn(protocol, "normalizeBridgeJob"), false);

const validRelay = validateRelayEnvelope({
  envelopeVersion: RELAY_ENVELOPE_VERSION,
  productId: "bridge-demo",
  deviceId: "dev_1",
  channelId: "chan_1",
  direction: "product_to_device",
  seq: 1,
  requestKey: "rq_1",
  ciphertext: "base64:ciphertext",
  aad: "base64:aad",
  nonce: "base64:nonce",
  algorithm: "Noise_XX_25519_ChaChaPoly_BLAKE2s",
  senderKeyId: "product-key-1",
  recipientKeyId: "device-key-1",
  ttlMs: 30_000,
  meta: { trace_id: "trace_1", adapter_id: "acme-adapter", schema_id: "acme-relay-v1" },
});
assert.equal(validRelay.ok, true);
assert.equal(validRelay.envelope.product_id, "bridge-demo");
assert.equal(validRelay.envelope.envelope_version, RELAY_ENVELOPE_VERSION);
assert.equal(validRelay.envelope.meta.schema_id, "acme-relay-v1");

const record = relayEnvelopeRecord(validRelay.envelope, { userId: "user_1", queuedAt: "2026-06-13T00:00:00.000Z" });
assert.equal(record.user_id, "user_1");
assert.equal(record.delivery_status, "queued");
assert.equal(record.expires_at, "2026-06-13T00:00:30.000Z");
assert.deepEqual(publicRelayEnvelope({ id: "env_1", ...record }), {
  id: "env_1",
  product_id: "bridge-demo",
  device_id: "dev_1",
  channel_id: "chan_1",
  direction: "product_to_device",
  seq: 1,
  request_key: "rq_1",
  ciphertext: "base64:ciphertext",
  aad: "base64:aad",
  nonce: "base64:nonce",
  algorithm: "Noise_XX_25519_ChaChaPoly_BLAKE2s",
  sender_key_id: "product-key-1",
  recipient_key_id: "device-key-1",
  meta: { trace_id: "trace_1", adapter_id: "acme-adapter", schema_id: "acme-relay-v1" },
  delivery_status: "queued",
  queued_at: "2026-06-13T00:00:00.000Z",
  delivered_at: null,
  acked_at: null,
  expires_at: "2026-06-13T00:00:30.000Z",
  created_at: "2026-06-13T00:00:00.000Z",
  updated_at: "2026-06-13T00:00:00.000Z",
});

const plaintext = validateRelayEnvelope({
  productId: "bridge-demo",
  deviceId: "dev_1",
  channelId: "chan_1",
  direction: "product_to_device",
  ciphertext: "base64:ciphertext",
  aad: "base64:aad",
  nonce: "base64:nonce",
  algorithm: "AES-GCM",
  senderKeyId: "product-key-1",
  recipientKeyId: "device-key-1",
  input: { prompt: "hello", nested: { stdout: "leak" } },
});
assert.equal(plaintext.ok, false);
assert.ok(plaintext.errors.includes("plaintext_fields_forbidden"));
assert.deepEqual(plaintext.plaintext_fields, ["input"]);
assert.deepEqual(forbiddenPlaintextFields({ nested: { result: "leak" }, meta: { payload: "not allowed metadata label" } }), ["meta.payload", "nested.result"]);
assert.deepEqual(invalidRelayMetaFields({ trace_id: "trace_1", payload: "leak" }), ["payload"]);

const metaPlaintext = validateRelayEnvelope({
  productId: "bridge-demo",
  deviceId: "dev_1",
  channelId: "chan_1",
  direction: "product_to_device",
  ciphertext: "base64:ciphertext",
  aad: "base64:aad",
  nonce: "base64:nonce",
  algorithm: "AES-GCM",
  senderKeyId: "product-key-1",
  recipientKeyId: "device-key-1",
  meta: { message: "leak", response: "leak", path: "/tmp/project" },
});
assert.equal(metaPlaintext.ok, false);
assert.ok(metaPlaintext.errors.includes("plaintext_fields_forbidden"));
assert.ok(metaPlaintext.errors.includes("invalid_meta"));
assert.deepEqual(metaPlaintext.plaintext_fields, ["meta.message", "meta.path", "meta.response"]);
assert.deepEqual(metaPlaintext.invalid_meta_fields, ["message", "path", "response"]);

console.log("[protocol.test] pass");
