import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  bridgeAdapterAuthorizationContextDenial,
  bridgeAuthorizationContextFromMirror,
  bridgeProductAuthorizationCapabilities,
  bridgeRelayContextFromEnvelope,
  createBridgeAdapterResponseCache,
  decryptBridgeRelayEnvelope,
  encryptBridgeRelayEnvelope,
  encryptBridgeRelayResponseEnvelope,
  envelopeReplayKey,
  keyBytesFromBase64,
} from "../src/index.js";

test("authorization mirror helpers stay product-generic", () => {
  const mirror = {
    status: "active",
    policy: {
      product_authorization: {
        capabilities: ["product.chat", "product.sessions"],
        authorization_context: {
          product_id: "product-a",
          device_id: "dev_1",
          authorization_id: "auth_1",
          authorization_epoch: 3,
          relay_key_id: "rk_1",
        },
      },
      capabilities: ["relay.envelope"],
    },
  };

  assert.deepEqual(bridgeProductAuthorizationCapabilities(mirror), ["product.chat", "product.sessions"]);
  assert.deepEqual(bridgeAuthorizationContextFromMirror(mirror), {
    product_id: "product-a",
    device_id: "dev_1",
    authorization_id: "auth_1",
    authorization_epoch: "3",
    relay_key_id: "rk_1",
  });
  assert.equal(bridgeAdapterAuthorizationContextDenial({
    product_id: "product-a",
    device_id: "dev_1",
    authorization_id: "auth_1",
    authorization_epoch: "3",
    relay_key_id: "rk_1",
  }, mirror), null);
  assert.equal(bridgeAdapterAuthorizationContextDenial({
    product_id: "product-a",
    device_id: "dev_2",
    authorization_id: "auth_1",
    authorization_epoch: "3",
    relay_key_id: "rk_1",
  }, mirror)?.error, "authorization_context_mismatch");
});

test("AES-GCM envelopes use Bridge AAD and support encrypted responses", async () => {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  const request = await encryptBridgeRelayEnvelope({ type: "product.echo", input: { ok: true } }, key, {
    product_id: "product-a",
    device_id: "dev_1",
    channel_id: "chan_1",
    seq: 7,
    request_key: "req_1",
    authorization_id: "auth_1",
    authorization_epoch: 3,
    relay_key_id: "rk_1",
    adapter_id: "product-a",
    schema_id: "product-relay-v1",
  });

  assert.equal(request.direction, "product_to_device");
  assert.equal(request.meta.authorization_id, "auth_1");
  assert.ok(Buffer.from(request.aad, "base64").toString("utf8").includes("authorization:auth_1"));
  assert.deepEqual(await decryptBridgeRelayEnvelope(request, key), { type: "product.echo", input: { ok: true } });
  assert.deepEqual(bridgeRelayContextFromEnvelope(request), {
    product_id: "product-a",
    device_id: "dev_1",
    authorization_id: "auth_1",
    authorization_epoch: "3",
    relay_key_id: "rk_1",
  });

  const response = await encryptBridgeRelayResponseEnvelope(request, { ok: true }, key);
  assert.equal(response.direction, "device_to_product");
  assert.equal(response.seq, 8);
  assert.equal(response.request_key, "req_1:response");
  assert.deepEqual(await decryptBridgeRelayEnvelope(response, key), { ok: true });
});

test("response cache deduplicates repeated envelope delivery", () => {
  const cache = createBridgeAdapterResponseCache({ maxEntries: 1 });
  const envelope = { id: "env_1", request_key: "req_1" };
  const first = { id: "response_1" };
  assert.equal(envelopeReplayKey(envelope), "env_1");
  assert.equal(cache.get(envelope), null);
  assert.equal(cache.set(envelope, first), first);
  assert.equal(cache.get(envelope), first);
  const second = { id: "response_2" };
  const reused = cache.getOrSet(envelope, () => second);
  assert.equal(reused, first);
  cache.set({ id: "env_2" }, second);
  assert.equal(cache.get(envelope), null);
});

test("concurrent envelope operations stay isolated and bounded", async () => {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  const started = Date.now();
  const count = 50;
  const requests = await Promise.all(Array.from({ length: count }, (_, index) => encryptBridgeRelayEnvelope({
    type: "product.concurrent",
    input: { index, marker: `marker-${index}` },
  }, key, {
    product_id: "product-a",
    device_id: "dev_1",
    channel_id: "chan_concurrent",
    seq: index + 1,
    request_key: `req_${index}`,
    authorization_id: "auth_1",
    authorization_epoch: 3,
    relay_key_id: "rk_1",
  })));

  assert.equal(new Set(requests.map((item) => item.request_key)).size, count);
  const opened = await Promise.all(requests.map((request) => decryptBridgeRelayEnvelope(request, key)));
  opened.forEach((payload, index) => {
    assert.deepEqual(payload, { type: "product.concurrent", input: { index, marker: `marker-${index}` } });
  });

  const cache = createBridgeAdapterResponseCache({ maxEntries: 25 });
  const responses = await Promise.all(requests.map(async (request, index) => {
    const response = await encryptBridgeRelayResponseEnvelope(request, { ok: true, index }, key);
    return cache.getOrSet(request, () => response);
  }));
  assert.equal(new Set(responses.map((item) => item.request_key)).size, count);
  assert.equal(cache.size(), 25);
  assert.equal(requests.filter((request) => cache.get(request)).length, 25);
  assert(Date.now() - started < 5000, "50 concurrent envelope roundtrips should stay under 5s on local CI");
});

test("response cache deduplicates concurrent duplicate delivery in-flight", async () => {
  const cache = createBridgeAdapterResponseCache({ maxEntries: 10 });
  let executions = 0;
  const envelope = { id: "env_concurrent", request_key: "req_concurrent" };
  const factory = async () => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { id: "response_concurrent" };
  };

  const [first, second, third] = await Promise.all([
    cache.getOrSetAsync(envelope, factory),
    cache.getOrSetAsync(envelope, factory),
    cache.getOrSetAsync(envelope, factory),
  ]);
  assert.equal(executions, 1);
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(cache.pendingSize(), 0);
  assert.equal(cache.get(envelope), first);
});

test("keyBytesFromBase64 validates 32 byte relay keys", () => {
  const key = Buffer.alloc(32, 7);
  assert.equal(keyBytesFromBase64(key.toString("base64")).length, 32);
  assert.throws(() => keyBytesFromBase64(Buffer.alloc(16).toString("base64")), /relay_key_must_be_32_bytes/);
});
