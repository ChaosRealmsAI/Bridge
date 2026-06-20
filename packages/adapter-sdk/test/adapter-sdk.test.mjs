import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  bridgeAdapterAuthorizationContextDenial,
  bridgeAuthorizationContextFromMirror,
  bridgeProductAuthorizationCapabilities,
  bridgeRelayContextFromEnvelope,
  bridgeRelayKeyForEnvelope,
  bridgeRelayKeyScope,
  createBridgeAdapterResponseCache,
  createBridgeProductAdapterRuntime,
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

test("product adapter runtime handles envelope dispatch, progress, and replay without product business", async () => {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  let dispatchCount = 0;
  const runtime = await createBridgeProductAdapterRuntime({
    productId: "product-a",
    schemaId: "product-relay-v1",
    keyBytes: key,
    async dispatch(command, context) {
      dispatchCount += 1;
      await context.emitProgress({ ok: true, progress: true, step: "seen" });
      return { ok: true, echo: command };
    },
  });

  try {
    const request = await encryptBridgeRelayEnvelope({ type: "product.echo", input: { value: 1 } }, key, {
      product_id: "product-a",
      device_id: "dev_1",
      channel_id: "chan_runtime",
      seq: 1,
      request_key: "runtime_req_1",
      adapter_id: "product-a",
      schema_id: "product-relay-v1",
    });
    const response = await postJson(runtime.url, request);
    assert.equal(response.ok, true);
    assert.equal(response.progress_envelopes.length, 1);
    assert.equal((await decryptBridgeRelayEnvelope(response.progress_envelopes[0], key)).step, "seen");
    assert.deepEqual(await decryptBridgeRelayEnvelope(response.response_envelope, key), {
      ok: true,
      echo: { type: "product.echo", input: { value: 1 } },
    });
    assert.equal(dispatchCount, 1);

    const replay = await postJson(runtime.url, request);
    assert.equal(replay.replay, true);
    assert.equal(dispatchCount, 1);
    assert.equal(runtime.executions.length, 1);
    assert.equal(runtime.calls.length, 2);
  } finally {
    await runtime.close();
  }
});

test("product adapter runtime keeps relay authorization contexts scoped across bootstraps", async () => {
  const seen = [];
  const runtime = await createBridgeProductAdapterRuntime({
    productId: "product-a",
    schemaId: "product-relay-v1",
    async dispatch(command, context) {
      seen.push({
        type: command.type,
        device_id: context.activeRelayContext?.device_id,
        authorization_id: context.activeRelayContext?.authorization_id,
      });
      return {
        ok: true,
        type: command.type,
        device_id: context.activeRelayContext?.device_id,
        authorization_id: context.activeRelayContext?.authorization_id,
      };
    },
  });

  try {
    const first = await bootstrapRelayKey(runtime, {
      deviceId: "dev_scope_1",
      authorizationId: "auth_scope_1",
      authorizationEpoch: "2",
    });
    const second = await bootstrapRelayKey(runtime, {
      deviceId: "dev_scope_2",
      authorizationId: "auth_scope_2",
      authorizationEpoch: "3",
    });

    const firstRequest = await scopedRelayEnvelope(first, {
      channelId: "chan_scope_1",
      requestKey: "req_scope_1",
      type: "product.first",
    });
    const firstResponse = await postJson(runtime.url, firstRequest);
    assert.deepEqual(await decryptBridgeRelayEnvelope(firstResponse.response_envelope, first.key), {
      ok: true,
      type: "product.first",
      device_id: "dev_scope_1",
      authorization_id: "auth_scope_1",
    });

    const secondRequest = await scopedRelayEnvelope(second, {
      channelId: "chan_scope_2",
      requestKey: "req_scope_2",
      type: "product.second",
    });
    const secondResponse = await postJson(runtime.url, secondRequest);
    assert.deepEqual(await decryptBridgeRelayEnvelope(secondResponse.response_envelope, second.key), {
      ok: true,
      type: "product.second",
      device_id: "dev_scope_2",
      authorization_id: "auth_scope_2",
    });

    assert.deepEqual(seen.map((item) => item.authorization_id), ["auth_scope_1", "auth_scope_2"]);

    const wrongContext = await encryptBridgeRelayEnvelope({ type: "product.wrong" }, first.key, {
      product_id: "product-a",
      device_id: "dev_scope_1",
      channel_id: "chan_wrong",
      seq: 1,
      request_key: "req_wrong",
      authorization_id: "auth_scope_wrong",
      authorization_epoch: "2",
      relay_key_id: first.relayKeyId,
      adapter_id: "product-a",
      schema_id: "product-relay-v1",
    });
    const rejected = await postRaw(runtime.url, wrongContext);
    assert.equal(rejected.status, 400);
    assert.match(JSON.stringify(rejected.payload), /relay_key_missing|authorization_context_mismatch|relay_key_context_mismatch|adapter_denied/);
  } finally {
    await runtime.close();
  }
});

test("relay key lookup supports scoped and default adapter keys", () => {
  const key = Buffer.alloc(32, 4);
  const relayKeys = new Map();
  relayKeys.set(bridgeRelayKeyScope("product-a", "dev_1", "auth_1", "2", "rk_1"), key);
  const envelope = {
    product_id: "product-a",
    device_id: "dev_1",
    meta: { authorization_id: "auth_1", authorization_epoch: "2", relay_key_id: "rk_1" },
  };
  assert.equal(bridgeRelayKeyForEnvelope(envelope, relayKeys), key);
  assert.equal(bridgeRelayKeyForEnvelope({ product_id: "product-b", device_id: "dev_2" }, new Map(), key), key);
});

async function bootstrapRelayKey(runtime, input) {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  const exchange = runtime.relayKeyExchange;
  const relayKeyId = exchange.key_id;
  const aadText = [
    "bridge-relay-key-bootstrap-v1",
    "product-a",
    input.deviceId,
    input.authorizationId,
    input.authorizationEpoch,
    relayKeyId,
  ].join("|");
  const wrapped = await wrapRelayKeyForDesktop(key, exchange, aadText);
  const bootstrap = {
    status: "ready",
    product_id: "product-a",
    device_id: input.deviceId,
    authorization_id: input.authorizationId,
    authorization_epoch: input.authorizationEpoch,
    key_id: relayKeyId,
    algorithm: "ECDH-P256+A256GCM",
    wrapped_key: wrapped,
    authorization_mirror: {
      status: "active",
      product_id: "product-a",
      authorization_epoch: Number(input.authorizationEpoch),
      authorization_context: {
        product_id: "product-a",
        device_id: input.deviceId,
        authorization_id: input.authorizationId,
        authorization_epoch: input.authorizationEpoch,
        relay_key_id: relayKeyId,
      },
      policy: { capabilities: ["relay.envelope", "relay.ack"] },
    },
  };
  await postJson(runtime.url.replace(/\/v1\/relay-envelope$/, "/v1/relay-key/bootstrap"), bootstrap);
  return { ...input, key, relayKeyId };
}

async function scopedRelayEnvelope(scope, input) {
  return encryptBridgeRelayEnvelope({ type: input.type }, scope.key, {
    product_id: "product-a",
    device_id: scope.deviceId,
    channel_id: input.channelId,
    seq: 1,
    request_key: input.requestKey,
    authorization_id: scope.authorizationId,
    authorization_epoch: scope.authorizationEpoch,
    relay_key_id: scope.relayKeyId,
    adapter_id: "product-a",
    schema_id: "product-relay-v1",
  });
}

async function wrapRelayKeyForDesktop(relayKey, exchange, aadText) {
  const desktopPublicKey = await webcrypto.subtle.importKey(
    "jwk",
    { ...exchange.public_jwk, ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const appKeyPair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const appPublicJwk = await webcrypto.subtle.exportKey("jwk", appKeyPair.publicKey);
  const shared = new Uint8Array(await webcrypto.subtle.deriveBits(
    { name: "ECDH", public: desktopPublicKey },
    appKeyPair.privateKey,
    256,
  ));
  const aad = new TextEncoder().encode(aadText);
  const version = new TextEncoder().encode("bridge-relay-key-bootstrap-v1");
  const material = new Uint8Array(shared.length + version.length + aad.length);
  material.set(shared, 0);
  material.set(version, shared.length);
  material.set(aad, shared.length + version.length);
  const wrappingKeyBytes = new Uint8Array(await webcrypto.subtle.digest("SHA-256", material));
  const wrappingKey = await webcrypto.subtle.importKey("raw", wrappingKeyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    wrappingKey,
    relayKey,
  ));
  return {
    algorithm: "ECDH-P256+A256GCM",
    key_id: exchange.key_id,
    app_public_jwk: {
      kty: "EC",
      crv: "P-256",
      x: appPublicJwk.x,
      y: appPublicJwk.y,
    },
    nonce_b64: Buffer.from(nonce).toString("base64"),
    ciphertext_b64: Buffer.from(ciphertext).toString("base64"),
    aad_b64: Buffer.from(aad).toString("base64"),
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

async function postRaw(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}
