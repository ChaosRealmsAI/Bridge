import { createHash, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync, gunzipSync } from "node:zlib";

import { bridgeRelayEnvelopeAadText, bridgeRelayKeyBootstrapAadText } from "@panda-bridge/sdk";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function normalizeBridgeAuthorizationContext(input = {}) {
  const source = objectValue(input);
  return {
    product_id: cleanScalar(source.product_id || source.productId || source.product),
    device_id: cleanScalar(source.device_id || source.deviceId || source.device),
    authorization_id: cleanScalar(source.authorization_id || source.authorizationId || source.authorization || source.id),
    authorization_epoch: cleanScalar(source.authorization_epoch ?? source.authorizationEpoch ?? source.epoch),
    relay_key_id: cleanScalar(source.relay_key_id || source.relayKeyId || source.key_id || source.keyId),
  };
}

export function bridgeAuthorizationContextFromMirror(mirror = {}) {
  const authorization = objectValue(mirror);
  const policy = objectValue(authorization.policy);
  const productAuthorization = objectValue(policy.product_authorization || policy.productAuthorization);
  const mirrorProductAuthorization = objectValue(authorization.product_authorization || authorization.productAuthorization);
  const nested = [
    authorization.authorization_context,
    authorization.authorizationContext,
    policy.authorization_context,
    policy.authorizationContext,
    productAuthorization.authorization_context,
    productAuthorization.authorizationContext,
    mirrorProductAuthorization.authorization_context,
    mirrorProductAuthorization.authorizationContext,
  ].map(objectValue).filter((value) => Object.keys(value).length > 0);
  const sources = [
    ...nested,
    productAuthorization,
    mirrorProductAuthorization,
    policy,
    authorization,
  ];
  return normalizeBridgeAuthorizationContext({
    product_id: firstValue(sources, ["product_id", "productId", "product"]),
    device_id: firstValue(sources, ["device_id", "deviceId", "device"]),
    authorization_id: firstValue(sources, ["authorization_id", "authorizationId", "authorization", "id"]),
    authorization_epoch: firstValue(sources, ["authorization_epoch", "authorizationEpoch", "epoch"]),
    relay_key_id: firstValue(sources, ["relay_key_id", "relayKeyId", "key_id", "keyId"]),
  });
}

export function bridgeProductAuthorizationCapabilities(mirror = {}) {
  const authorization = objectValue(mirror);
  const policy = objectValue(authorization.policy);
  const productAuthorization = objectValue(policy.product_authorization || policy.productAuthorization);
  const mirrorProductAuthorization = objectValue(authorization.product_authorization || authorization.productAuthorization);
  for (const value of [
    productAuthorization.capabilities,
    productAuthorization.permissions,
    mirrorProductAuthorization.capabilities,
    mirrorProductAuthorization.permissions,
  ]) {
    if (Array.isArray(value)) return value.map(cleanScalar).filter(Boolean);
  }
  return [];
}

export function bridgeAdapterAuthorizationContextDenial(context, mirror, activeRelayContext = null) {
  if (!mirror) return null;
  const expected = bridgeAuthorizationContextFromMirror(mirror);
  const required = ["product_id", "device_id", "authorization_id", "authorization_epoch"];
  const missing = required.filter((field) => !expected[field]);
  if (missing.length > 0) {
    return denial("authorization_context_missing", `${missing[0]}_missing`, missing[0]);
  }
  const actual = normalizeBridgeAuthorizationContext(context);
  for (const field of required) {
    if (actual[field] !== expected[field]) return denial("authorization_context_mismatch", `${field}_mismatch`, field);
  }
  if (activeRelayContext) {
    const active = normalizeBridgeAuthorizationContext(activeRelayContext);
    for (const field of [...required, "relay_key_id"]) {
      if (active[field] && actual[field] !== active[field]) {
        return denial("relay_key_context_mismatch", `${field}_mismatch`, field);
      }
    }
  }
  return null;
}

export function bridgeRelayContextFromEnvelope(envelope = {}) {
  const meta = objectValue(envelope.meta);
  return normalizeBridgeAuthorizationContext({
    product_id: envelope.product_id || envelope.productId,
    device_id: envelope.device_id || envelope.deviceId,
    authorization_id: meta.authorization_id || meta.authorizationId,
    authorization_epoch: meta.authorization_epoch ?? meta.authorizationEpoch,
    relay_key_id: meta.relay_key_id || meta.relayKeyId || meta.key_id || meta.keyId,
  });
}

export async function decryptBridgeRelayEnvelope(envelope, keyBytes) {
  assertRelayEnvelope(envelope);
  const opened = await webcrypto.subtle.decrypt({
    name: "AES-GCM",
    iv: unb64(envelope.nonce),
    additionalData: unb64(envelope.aad),
  }, await aesKey(keyBytes, ["decrypt"]), unb64(envelope.ciphertext));
  return decodeJsonPayload(opened, envelope);
}

export async function encryptBridgeRelayEnvelope(payload, keyBytes, fields = {}) {
  const seq = Number(fields.seq || 1);
  const direction = cleanScalar(fields.direction) || "product_to_device";
  const aadText = bridgeRelayEnvelopeAadText({
    product_id: fields.product_id || fields.productId,
    device_id: fields.device_id || fields.deviceId,
    channel_id: fields.channel_id || fields.channelId || "bridge-relay-v1",
    direction,
    seq,
    authorization_id: fields.authorization_id || fields.authorizationId,
    authorization_epoch: fields.authorization_epoch ?? fields.authorizationEpoch,
    relay_key_id: fields.relay_key_id || fields.relayKeyId,
  });
  return encryptEnvelopePayload(payload, keyBytes, {
    ...fields,
    seq,
    direction,
    aadText,
    request_key: fields.request_key || fields.requestKey || `bridge-${Date.now()}`,
  });
}

export async function encryptBridgeRelayResponseEnvelope(requestEnvelope, payload, keyBytes, fields = {}) {
  const relayContext = bridgeRelayContextFromEnvelope(requestEnvelope);
  const seq = Number(fields.seq || fields.response_seq || fields.responseSeq || Number(requestEnvelope.seq || 0) + 1);
  const aadText = bridgeRelayEnvelopeAadText({
    product_id: requestEnvelope.product_id,
    device_id: requestEnvelope.device_id,
    channel_id: requestEnvelope.channel_id,
    direction: "device_to_product",
    seq,
    authorization_id: relayContext.authorization_id,
    authorization_epoch: relayContext.authorization_epoch,
    relay_key_id: relayContext.relay_key_id,
  });
  return encryptEnvelopePayload(payload, keyBytes, {
    product_id: requestEnvelope.product_id,
    device_id: requestEnvelope.device_id,
    channel_id: requestEnvelope.channel_id,
    direction: "device_to_product",
    seq,
    request_key: `${requestEnvelope.request_key || requestEnvelope.id || "bridge"}:response`,
    sender_key_id: requestEnvelope.recipient_key_id || fields.sender_key_id || "adapter",
    recipient_key_id: requestEnvelope.sender_key_id || fields.recipient_key_id || "product",
    ttl_ms: fields.ttl_ms || requestEnvelope.ttl_ms,
    adapter_id: fields.adapter_id || requestEnvelope.meta?.adapter_id,
    schema_id: fields.schema_id || requestEnvelope.meta?.schema_id,
    trace_id: fields.trace_id || requestEnvelope.meta?.trace_id,
    aadText,
    authorization_id: relayContext.authorization_id,
    authorization_epoch: relayContext.authorization_epoch,
    relay_key_id: relayContext.relay_key_id,
  });
}

export function createBridgeAdapterResponseCache(options = {}) {
  const maxEntries = Math.max(1, Number(options.maxEntries || options.max_entries || 500));
  const map = new Map();
  const inFlight = new Map();
  const cache = {
    get(envelope) {
      return map.get(envelopeReplayKey(envelope)) || null;
    },
    set(envelope, responseEnvelope) {
      const key = envelopeReplayKey(envelope);
      if (!key) return responseEnvelope;
      map.set(key, responseEnvelope);
      while (map.size > maxEntries) map.delete(map.keys().next().value);
      return responseEnvelope;
    },
    getOrSet(envelope, factory) {
      const existing = this.get(envelope);
      if (existing) return existing;
      const response = factory();
      this.set(envelope, response);
      return response;
    },
    async getOrSetAsync(envelope, factory) {
      const key = envelopeReplayKey(envelope);
      if (!key) return factory();
      const existing = map.get(key);
      if (existing) return existing;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const promise = Promise.resolve()
        .then(factory)
        .then((response) => cache.set(envelope, response))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },
    size() {
      return map.size;
    },
    pendingSize() {
      return inFlight.size;
    },
    clear() {
      map.clear();
      inFlight.clear();
    },
  };
  return cache;
}

export function envelopeReplayKey(envelope = {}) {
  return cleanScalar(envelope.id || envelope.request_key || envelope.requestKey);
}

export function keyBytesFromBase64(value, label = "relay_key") {
  if (!value) throw new Error(`missing_${label}`);
  const key = unb64(value);
  if (key.length !== 32) throw new Error(`${label}_must_be_32_bytes`);
  return key;
}

export async function createBridgeRelayKeyState(input = {}) {
  const storedPrivateJwk = input.private_jwk || input.privateJwk;
  const storedPublicJwk = input.public_jwk || input.publicJwk;
  const keyPair = storedPrivateJwk
    ? await importRelayKeyPair(storedPrivateJwk, storedPublicJwk)
    : await webcrypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateJwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicStateJwk = publicRelayKeyJwk(publicJwk);
  return {
    keyPair,
    state_jwk: {
      private_jwk: privateJwk,
      public_jwk: publicStateJwk,
    },
    exchange: {
      status: "available",
      algorithm: "ECDH-P256+A256GCM",
      key_id: relayKeyExchangeId(publicJwk),
      public_jwk: publicStateJwk,
      created_at: new Date().toISOString(),
    },
  };
}

export async function importBridgeRelayKeyBootstrap(bootstrap, privateKey) {
  const wrapped = objectValue(bootstrap?.wrapped_key || bootstrap?.wrappedKey);
  if ((bootstrap?.status || "ready") !== "ready") throw new Error("relay_key_bootstrap_not_ready");
  const productId = cleanScalar(bootstrap?.product_id || bootstrap?.productId);
  const deviceId = cleanScalar(bootstrap?.device_id || bootstrap?.deviceId);
  const authorizationId = cleanScalar(bootstrap?.authorization_id || bootstrap?.authorizationId);
  const authorizationEpoch = cleanScalar(bootstrap?.authorization_epoch ?? bootstrap?.authorizationEpoch);
  const keyId = cleanScalar(bootstrap?.key_id || bootstrap?.keyId || wrapped.key_id || wrapped.keyId);
  if (!productId || !deviceId || !authorizationId || !authorizationEpoch || !keyId) {
    throw new Error("invalid_relay_key_bootstrap");
  }
  if ((wrapped.algorithm || bootstrap?.algorithm) !== "ECDH-P256+A256GCM") {
    throw new Error("unsupported_relay_key_bootstrap_algorithm");
  }
  const appPublicJwk = wrapped.app_public_jwk || wrapped.appPublicJwk || wrapped.sender_public_jwk || wrapped.senderPublicJwk;
  const publicKey = await webcrypto.subtle.importKey("jwk", appPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const aad = unb64(wrapped.aad_b64 || wrapped.aadB64);
  const expectedAad = bridgeRelayKeyBootstrapAadText({
    product_id: productId,
    device_id: deviceId,
    authorization_id: authorizationId,
    authorization_epoch: authorizationEpoch,
    relay_key_id: keyId,
  });
  if (decoder.decode(aad) !== expectedAad) throw new Error("relay_key_bootstrap_aad_mismatch");
  const wrappingKey = await deriveRelayWrappingKey(privateKey, publicKey, aad);
  const plaintext = new Uint8Array(await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(wrapped.nonce_b64 || wrapped.nonceB64), additionalData: aad },
    wrappingKey,
    unb64(wrapped.ciphertext_b64 || wrapped.ciphertextB64),
  ));
  if (plaintext.length !== 32) throw new Error("relay_key_must_be_32_bytes");
  return {
    product_id: productId,
    device_id: deviceId,
    authorization_id: authorizationId,
    authorization_epoch: authorizationEpoch,
    key_id: keyId,
    relay_key_id: keyId,
    keyBytes: plaintext,
  };
}

export function bridgeRelayKeyContextFromEnvelope(envelope = {}) {
  const meta = objectValue(envelope.meta);
  return {
    authorization_id: cleanScalar(meta.authorization_id || meta.authorizationId),
    authorization_epoch: cleanScalar(meta.authorization_epoch ?? meta.authorizationEpoch),
    relay_key_id: cleanScalar(meta.relay_key_id || meta.relayKeyId || meta.key_id || meta.keyId),
  };
}

export function bridgeRelayKeyScope(productId, deviceId, authorizationId = "", authorizationEpoch = "", keyId = "") {
  return [
    cleanScalar(productId),
    cleanScalar(deviceId),
    cleanScalar(authorizationId),
    cleanScalar(authorizationEpoch),
    cleanScalar(keyId),
  ].join(":");
}

export function bridgeRelayKeyForEnvelope(envelope, relayKeys, defaultKeyBytes = null) {
  const context = bridgeRelayKeyContextFromEnvelope(envelope);
  const scoped = relayKeys?.get?.(bridgeRelayKeyScope(
    envelope?.product_id,
    envelope?.device_id,
    context.authorization_id,
    context.authorization_epoch,
    context.relay_key_id,
  ));
  const product = relayKeys?.get?.(bridgeRelayKeyScope(
    envelope?.product_id,
    "",
    context.authorization_id,
    context.authorization_epoch,
    context.relay_key_id,
  ));
  const keyBytes = scoped || product || defaultKeyBytes;
  if (!keyBytes) throw new Error("relay_key_missing");
  return keyBytes;
}

export async function createBridgeProductAdapterRuntime(options = {}) {
  const productId = cleanScalar(options.productId || options.product_id);
  if (!productId) throw new Error("product_id_required");
  if (typeof options.dispatch !== "function") throw new Error("dispatch_required");

  const schemaId = cleanScalar(options.schemaId || options.schema_id || "bridge-adapter-v1");
  const host = cleanScalar(options.host || "127.0.0.1");
  const port = Number(options.port || 0);
  const defaultKeyBytes = options.keyBytes || (options.keyB64 ? keyBytesFromBase64(options.keyB64, "adapter_key") : null);
  const relayKeys = options.relayKeys || new Map();
  const relayKeyState = options.relayKeyState || await createBridgeRelayKeyState(options.relayKeyJwk || options.relayKeyJWK || {});
  const responseCache = options.responseCache || createBridgeAdapterResponseCache({ maxEntries: options.responseCacheEntries || 500 });
  const calls = [];
  const executions = [];
  const errors = [];
  let authorizationMirror = normalizeAuthorizationMirror(options.authorizationMirror);
  let activeRelayContext = null;
  if ((options.requireAuthorizationMirror || false) && !authorizationMirror) {
    throw new Error("authorization_mirror_required");
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://bridge-adapter.local");
      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
        return writeJson(response, 200, { ok: true, product_id: productId, status: "ready" });
      }
      if (request.method === "GET" && url.pathname === "/v1/relay-key/public") {
        return writeJson(response, 200, {
          ok: true,
          product_id: productId,
          relay_key_exchange: relayKeyState.exchange,
          ...relayKeyState.exchange,
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/relay-key/bootstrap") {
        const bootstrap = await readJson(request);
        const imported = await importBridgeRelayKeyBootstrap(bootstrap, relayKeyState.keyPair.privateKey);
        const bootstrapMirror = authorizationMirrorFromBootstrap(bootstrap, imported);
        const contextMirror = mirrorHasCompleteAuthorizationContext(authorizationMirror) ? authorizationMirror : bootstrapMirror;
        const contextDenial = bridgeAdapterAuthorizationContextDenial(imported, contextMirror);
        if (contextDenial) throw new Error(contextDenial.error);
        authorizationMirror = selectRuntimeAuthorizationMirror(options, authorizationMirror, bootstrapMirror, imported);
        relayKeys.set(bridgeRelayKeyScope(
          imported.product_id,
          imported.device_id,
          imported.authorization_id,
          imported.authorization_epoch,
          imported.key_id,
        ), imported.keyBytes);
        activeRelayContext = imported;
        return writeJson(response, 200, {
          ok: true,
          status: "ready",
          product_id: imported.product_id,
          device_id: imported.device_id,
          authorization_id: imported.authorization_id,
          authorization_epoch: imported.authorization_epoch,
          key_id: imported.key_id,
        });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/relay-envelope") {
        return writeJson(response, 404, { ok: false, error: "not_found" });
      }

      const envelope = await readJson(request);
      const contextDenial = bridgeAdapterAuthorizationContextDenial(bridgeRelayContextFromEnvelope(envelope), authorizationMirror, activeRelayContext);
      if (contextDenial) throw new Error(contextDenial.error);
      const keyBytes = bridgeRelayKeyForEnvelope(envelope, relayKeys, defaultKeyBytes);
      const cached = responseCache.get(envelope);
      if (cached) {
        calls.push({ envelope_id: envelope.id || null, type: cached.type, ok: cached.ok, replay: true });
        return writeJson(response, 200, {
          ok: true,
          response_envelope: cached.response_envelope,
          progress_envelopes: cached.progress_envelopes || [],
          replay: true,
        });
      }

      let produced = false;
      const item = await responseCache.getOrSetAsync(envelope, async () => {
        produced = true;
        const command = await decryptBridgeRelayEnvelope(envelope, keyBytes);
        const progressEnvelopes = [];
        let responseSeq = Number(envelope.seq || 1) + 1;
        const emitProgress = async (payload) => {
          const progressEnvelope = await encryptBridgeRelayResponseEnvelope(envelope, payload, keyBytes, {
            seq: responseSeq++,
            adapter_id: productId,
            schema_id: schemaId,
          });
          progressEnvelopes.push(progressEnvelope);
          return progressEnvelope;
        };
        const payload = await options.dispatch(command, {
          ...(options.dispatchContext || {}),
          envelope,
          keyBytes,
          authorizationMirror,
          activeRelayContext,
          emitProgress,
        });
        const responseEnvelope = await encryptBridgeRelayResponseEnvelope(envelope, payload, keyBytes, {
          seq: responseSeq++,
          adapter_id: productId,
          schema_id: schemaId,
        });
        return {
          type: command?.type || command?.op || "unknown",
          ok: payload?.ok === true,
          response_envelope: responseEnvelope,
          progress_envelopes: progressEnvelopes,
        };
      });
      calls.push({ envelope_id: envelope.id || null, type: item.type, ok: item.ok, replay: !produced });
      if (produced) executions.push({ envelope_id: envelope.id || null, type: item.type, ok: item.ok });
      return writeJson(response, 200, {
        ok: true,
        response_envelope: item.response_envelope,
        progress_envelopes: item.progress_envelopes || [],
        ...(produced ? {} : { replay: true }),
      });
    } catch (error) {
      errors.push({ at: new Date().toISOString(), error: String(error?.message || error).slice(0, 1000) });
      const payload = typeof options.errorResponse === "function"
        ? options.errorResponse(error)
        : { ok: false, error: "adapter_denied", reason: String(error?.message || error) };
      return writeJson(response, 400, payload);
    }
  });

  await new Promise((resolveListen) => server.listen(port, host, resolveListen));
  const address = server.address();
  return {
    productId,
    schemaId,
    keyBytes: defaultKeyBytes,
    calls,
    executions,
    errors,
    responseCache,
    relayKeys,
    relayKeyState,
    relayKeyExchange: relayKeyState.exchange,
    get authorizationMirror() {
      return authorizationMirror;
    },
    setAuthorizationMirror(next) {
      authorizationMirror = normalizeAuthorizationMirror(next);
    },
    get activeRelayContext() {
      return activeRelayContext;
    },
    url: `http://${address.address}:${address.port}/v1/relay-envelope`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function encryptEnvelopePayload(payload, keyBytes, fields) {
  const aad = encoder.encode(fields.aadText);
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const encoded = encodeJsonPayload(payload, { gzipAboveBytes: Number(fields.gzip_above_bytes ?? fields.gzipAboveBytes ?? 16 * 1024) });
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: aad,
  }, await aesKey(keyBytes, ["encrypt"]), encoded.bytes));
  return {
    product_id: cleanScalar(fields.product_id || fields.productId),
    device_id: cleanScalar(fields.device_id || fields.deviceId),
    channel_id: cleanScalar(fields.channel_id || fields.channelId || "bridge-relay-v1"),
    direction: cleanScalar(fields.direction),
    seq: Number(fields.seq || 1),
    request_key: cleanScalar(fields.request_key || fields.requestKey),
    ciphertext: b64(ciphertext),
    aad: b64(aad),
    nonce: b64(nonce),
    algorithm: "AES-GCM-256",
    sender_key_id: cleanScalar(fields.sender_key_id || fields.senderKeyId || "product"),
    recipient_key_id: cleanScalar(fields.recipient_key_id || fields.recipientKeyId || "adapter"),
    ttl_ms: Number(fields.ttl_ms || fields.ttlMs || 300000),
    meta: {
      adapter_id: cleanScalar(fields.adapter_id || fields.adapterId),
      trace_id: cleanScalar(fields.trace_id || fields.traceId || `trace-${Date.now()}`),
      schema_id: cleanScalar(fields.schema_id || fields.schemaId || "bridge-adapter-v1"),
      content_type: "application/json",
      ...(fields.authorization_id || fields.authorizationId ? { authorization_id: cleanScalar(fields.authorization_id || fields.authorizationId) } : {}),
      ...(fields.authorization_epoch || fields.authorizationEpoch ? { authorization_epoch: cleanScalar(fields.authorization_epoch ?? fields.authorizationEpoch) } : {}),
      ...(fields.relay_key_id || fields.relayKeyId ? { relay_key_id: cleanScalar(fields.relay_key_id || fields.relayKeyId) } : {}),
      ...(encoded.content_encoding ? { content_encoding: encoded.content_encoding } : {}),
    },
  };
}

function assertRelayEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") throw new Error("missing_envelope");
  for (const field of ["ciphertext", "nonce", "aad", "algorithm"]) {
    if (!envelope[field]) throw new Error(`missing_${field}`);
  }
  if (envelope.algorithm !== "AES-GCM-256") throw new Error("unsupported_algorithm");
}

function encodeJsonPayload(payload, options = {}) {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  if (raw.length > Number(options.gzipAboveBytes || Number.POSITIVE_INFINITY)) {
    return { bytes: gzipSync(raw), content_encoding: "gzip" };
  }
  return { bytes: raw };
}

function decodeJsonPayload(opened, envelope) {
  const bytes = Buffer.from(opened);
  const encoding = cleanScalar(envelope?.meta?.content_encoding).toLowerCase();
  const jsonBytes = encoding === "gzip" ? gunzipSync(bytes) : bytes;
  return JSON.parse(decoder.decode(jsonBytes));
}

async function aesKey(keyBytes, keyUsages) {
  const bytes = keyBytes instanceof Uint8Array ? keyBytes : new Uint8Array(keyBytes);
  if (bytes.length !== 32) throw new Error("relay_key_must_be_32_bytes");
  return webcrypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, keyUsages);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstValue(sources, keys) {
  for (const source of sources) {
    const object = objectValue(source);
    for (const key of keys) {
      const value = object[key];
      if (value && typeof value === "object" && "id" in value) {
        const id = cleanScalar(value.id);
        if (id) return id;
      }
      const scalar = cleanScalar(value);
      if (scalar) return scalar;
    }
  }
  return "";
}

function cleanScalar(value) {
  if (value && typeof value === "object" && "id" in value) return cleanScalar(value.id);
  return String(value ?? "").trim();
}

function denial(error, message, contextField) {
  return { error, code: error, message: message || error, context_field: contextField || "" };
}

async function importRelayKeyPair(privateJwk, publicJwk) {
  const normalizedPublicJwk = publicJwk || publicRelayKeyJwk(privateJwk);
  const privateKey = await webcrypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKey = await webcrypto.subtle.importKey(
    "jwk",
    normalizedPublicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  return { privateKey, publicKey };
}

function publicRelayKeyJwk(jwk) {
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    ext: true,
    key_ops: ["deriveBits"],
  };
}

function relayKeyExchangeId(jwk) {
  const digest = createHash("sha256")
    .update(`${jwk.kty || "EC"}:${jwk.crv || "P-256"}:${jwk.x || ""}:${jwk.y || ""}`)
    .digest("base64url");
  return `rkx_${digest.slice(0, 24)}`;
}

async function deriveRelayWrappingKey(privateKey, publicKey, aad) {
  const bits = await webcrypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = concatBytes(new Uint8Array(bits), encoder.encode("bridge-relay-key-bootstrap-v1"), aad);
  const digest = await webcrypto.subtle.digest("SHA-256", material);
  return webcrypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
}

function concatBytes(...chunks) {
  const total = chunks.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of chunks) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

function normalizeAuthorizationMirror(input) {
  if (!input) return null;
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (typeof input === "object") return input;
  return null;
}

function authorizationMirrorFromBootstrap(bootstrap, relayContext) {
  const explicit = normalizeAuthorizationMirror(bootstrap?.authorization_mirror || bootstrap?.authorizationMirror);
  if (explicit) return bindRelayAuthorizationContext(explicit, relayContext);
  const policy = bootstrap?.authorization_policy || bootstrap?.authorizationPolicy || bootstrap?.policy;
  const productAuthorization = bootstrap?.product_authorization || bootstrap?.productAuthorization || policy?.product_authorization || policy?.productAuthorization;
  if (!policy && !productAuthorization) return null;
  return bindRelayAuthorizationContext({
    status: bootstrap?.authorization_status || bootstrap?.authorizationStatus || bootstrap?.status || "active",
    source_origin: bootstrap?.source_origin || bootstrap?.sourceOrigin || policy?.source_origin || policy?.sourceOrigin,
    policy: policy || {},
    ...(productAuthorization ? { product_authorization: productAuthorization } : {}),
  }, relayContext);
}

function selectRuntimeAuthorizationMirror(options, current, bootstrapMirror, relayContext) {
  if (typeof options.selectAuthorizationMirror === "function") {
    return normalizeAuthorizationMirror(options.selectAuthorizationMirror({
      current,
      bootstrap: bootstrapMirror,
      relayContext,
      bindRelayAuthorizationContext,
    }));
  }
  if (bootstrapMirror) return bootstrapMirror;
  return current ? bindRelayAuthorizationContext(cloneObject(current), relayContext) : null;
}

function mirrorHasCompleteAuthorizationContext(mirror) {
  if (!mirror) return false;
  const context = bridgeAuthorizationContextFromMirror(mirror);
  return ["product_id", "device_id", "authorization_id", "authorization_epoch"].every((field) => Boolean(context[field]));
}

function bindRelayAuthorizationContext(input, relayContext) {
  const mirror = objectValue(input) === input ? input : {};
  const context = {
    product_id: relayContext.product_id,
    device_id: relayContext.device_id,
    authorization_id: relayContext.authorization_id,
    authorization_epoch: relayContext.authorization_epoch,
    relay_key_id: relayContext.key_id || relayContext.relay_key_id,
  };
  Object.assign(mirror, context);
  mirror.authorization_context = { ...(mirror.authorization_context || mirror.authorizationContext || {}), ...context };
  if (!mirror.policy || typeof mirror.policy !== "object") mirror.policy = {};
  mirror.policy.authorization_context = { ...(mirror.policy.authorization_context || mirror.policy.authorizationContext || {}), ...context };
  const policyProductAuthorization = mirror.policy.product_authorization || mirror.policy.productAuthorization;
  if (policyProductAuthorization && typeof policyProductAuthorization === "object") {
    policyProductAuthorization.authorization_context = { ...(policyProductAuthorization.authorization_context || policyProductAuthorization.authorizationContext || {}), ...context };
  }
  const productAuthorization = mirror.product_authorization || mirror.productAuthorization;
  if (productAuthorization && typeof productAuthorization === "object") {
    productAuthorization.authorization_context = { ...(productAuthorization.authorization_context || productAuthorization.authorizationContext || {}), ...context };
  }
  return mirror;
}

function cloneObject(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function unb64(value) {
  return Buffer.from(String(value || ""), "base64");
}
