import { webcrypto } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

import { bridgeRelayEnvelopeAadText } from "@panda-bridge/sdk";

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
  const seq = Number(requestEnvelope.seq || 0) + 1;
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

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function unb64(value) {
  return Buffer.from(String(value || ""), "base64");
}
