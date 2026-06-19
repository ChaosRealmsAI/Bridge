import { relayKeyContextFromEnvelope } from "./key-exchange.mjs";
import {
  decryptBridgeRelayEnvelope,
  encryptBridgeRelayEnvelope,
  encryptBridgeRelayResponseEnvelope,
  envelopeReplayKey as bridgeEnvelopeReplayKey,
  keyBytesFromBase64 as bridgeKeyBytesFromBase64,
} from "./bridge-adapter-sdk.mjs";

export {
  createRelayKeyState,
  importRelayKeyBootstrap,
  relayKeyContextFromEnvelope,
  relayKeyForEnvelope,
  relayKeyScope,
} from "./key-exchange.mjs";

export async function encryptBurnCommandEnvelope(input, keyBytes, fields = {}) {
  return encryptBridgeRelayEnvelope(input, keyBytes, {
    product_id: fields.product_id || "panda-burn",
    device_id: fields.device_id || "",
    channel_id: fields.channel_id || "burn-relay-v1",
    direction: "product_to_device",
    seq: Number(fields.seq || 1),
    request_key: fields.request_key || `burn-${Date.now()}`,
    sender_key_id: fields.sender_key_id || "burn-app-dev",
    recipient_key_id: fields.recipient_key_id || "burn-adapter-dev",
    ttl_ms: Number(fields.ttl_ms || 300000),
    adapter_id: "panda-burn",
    schema_id: "burn-relay-v1",
    trace_id: fields.trace_id || `trace-${Date.now()}`,
    gzip_above_bytes: Number(fields.gzip_above_bytes ?? 16 * 1024),
    authorization_id: fields.authorization_id || fields.authorizationId || "",
    authorization_epoch: fields.authorization_epoch || fields.authorizationEpoch || "",
    relay_key_id: fields.relay_key_id || fields.relayKeyId || "",
  });
}

export async function decryptBurnResponseEnvelope(envelope, keyBytes) {
  return decryptEnvelope(envelope, keyBytes);
}

export async function decryptEnvelope(envelope, keyBytes) {
  return decryptBridgeRelayEnvelope(envelope, keyBytes);
}

export async function encryptResponseEnvelope(requestEnvelope, payload, keyBytes, fields = {}) {
  const relayContext = relayKeyContextFromEnvelope(requestEnvelope);
  const responseSeq = Number(fields.seq || fields.response_seq || fields.responseSeq || 0);
  const sourceEnvelope = responseSeq > 0
    ? { ...requestEnvelope, seq: Math.max(0, responseSeq - 1) }
    : requestEnvelope;
  return encryptBridgeRelayResponseEnvelope(sourceEnvelope, payload, keyBytes, {
    adapter_id: "panda-burn",
    schema_id: "burn-relay-v1",
    authorization_id: relayContext.authorization_id,
    authorization_epoch: relayContext.authorization_epoch,
    relay_key_id: relayContext.relay_key_id,
  });
}

export function keyBytesFromBase64(value) {
  return bridgeKeyBytesFromBase64(value, "BURN_RELAY_KEY_B64");
}

export function envelopeReplayKey(envelope) {
  return bridgeEnvelopeReplayKey(envelope);
}
