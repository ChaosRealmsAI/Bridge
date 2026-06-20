export const BRIDGE_PROTOCOL_VERSION = "bridge-protocol-v0.2";

export const RELAY_ENVELOPE_VERSION = "relay-envelope-v1";

export const RELAY_DIRECTIONS = Object.freeze([
  "product_to_device",
  "device_to_product",
]);

export const RELAY_DELIVERY_STATUSES = Object.freeze([
  "queued",
  "delivered",
  "acked",
  "expired",
]);

export const RELAY_FORBIDDEN_PLAINTEXT_FIELDS = Object.freeze([
  "args",
  "body",
  "command",
  "content",
  "data",
  "error",
  "file",
  "files",
  "input",
  "message",
  "messages",
  "output",
  "path",
  "payload",
  "project",
  "prompt",
  "reply",
  "response",
  "result",
  "stderr",
  "stdout",
  "text",
  "value",
  "workspace",
  "workspace_path",
]);

export const RELAY_META_ALLOWED_FIELDS = Object.freeze([
  "adapter_id",
  "attempt",
  "authorization_epoch",
  "authorization_id",
  "content_encoding",
  "content_type",
  "correlation_id",
  "expired_reason",
  "priority",
  "relay_key_id",
  "route_hint",
  "schema_id",
  "trace_id",
]);

export const EVENT_TYPES = Object.freeze([
  "queued",
  "claimed",
  "started",
  "status",
  "chunk",
  "relay_delta",
  "relay_event",
  "completed",
  "failed",
  "cancelled",
]);

export function normalizeRelayEnvelope(input = {}) {
  const value = objectValue(input);
  const meta = normalizeRelayMeta(value.meta);
  return {
    envelope_version: stringValue(value.envelopeVersion || value.envelope_version, 80) || RELAY_ENVELOPE_VERSION,
    product_id: stringValue(value.productId || value.product_id, 80),
    device_id: stringValue(value.deviceId || value.device_id || value.connector_id, 120),
    channel_id: stringValue(value.channelId || value.channel_id, 160),
    direction: stringValue(value.direction, 80),
    seq: integerValue(value.seq, 0, 0, Number.MAX_SAFE_INTEGER),
    request_key: stringValue(value.requestKey || value.request_key, 180),
    ciphertext: stringValue(value.ciphertext, 1024 * 1024),
    aad: stringValue(value.aad, 8192),
    nonce: stringValue(value.nonce || value.iv, 256),
    algorithm: stringValue(value.algorithm || value.alg, 120),
    sender_key_id: stringValue(value.senderKeyId || value.sender_key_id, 160),
    recipient_key_id: stringValue(value.recipientKeyId || value.recipient_key_id, 160),
    ttl_ms: integerValue(value.ttlMs ?? value.ttl_ms, 5 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    meta,
  };
}

export function validateRelayEnvelope(input = {}, options = {}) {
  const envelope = normalizeRelayEnvelope(input);
  const errors = [];
  const plaintextFields = forbiddenPlaintextFields(input);
  const invalidMetaFields = invalidRelayMetaFields(objectValue(input).meta);
  if (!envelope.product_id) errors.push("missing_product_id");
  if (!envelope.device_id) errors.push("missing_device_id");
  if (!envelope.channel_id) errors.push("missing_channel_id");
  if (!RELAY_DIRECTIONS.includes(envelope.direction)) errors.push("invalid_direction");
  if (!envelope.ciphertext) errors.push("missing_ciphertext");
  if (!envelope.aad) errors.push("missing_aad");
  if (!envelope.nonce) errors.push("missing_nonce");
  if (!envelope.algorithm) errors.push("missing_algorithm");
  if (!envelope.sender_key_id) errors.push("missing_sender_key_id");
  if (!envelope.recipient_key_id) errors.push("missing_recipient_key_id");
  if (plaintextFields.length) errors.push("plaintext_fields_forbidden");
  if (invalidMetaFields.length) errors.push("invalid_meta");
  if (options.direction && envelope.direction !== options.direction) errors.push("direction_mismatch");
  if (options.productId && envelope.product_id !== options.productId) errors.push("product_id_mismatch");
  if (options.deviceId && envelope.device_id !== options.deviceId) errors.push("device_id_mismatch");
  return {
    ok: errors.length === 0,
    errors,
    envelope,
    plaintext_fields: plaintextFields,
    invalid_meta_fields: invalidMetaFields,
  };
}

export function relayEnvelopeRecord(envelope, fields = {}) {
  const queuedAt = stringValue(fields.queued_at || fields.queuedAt, 80) || new Date().toISOString();
  const ttlMs = integerValue(envelope.ttl_ms, 5 * 60 * 1000, 1000, 24 * 60 * 60 * 1000);
  return {
    user_id: stringValue(fields.user_id || fields.userId, 120) || null,
    product_id: envelope.product_id,
    device_id: envelope.device_id,
    channel_id: envelope.channel_id,
    direction: envelope.direction,
    seq: envelope.seq,
    request_key: envelope.request_key || null,
    ciphertext: envelope.ciphertext,
    aad: envelope.aad,
    nonce: envelope.nonce,
    algorithm: envelope.algorithm,
    sender_key_id: envelope.sender_key_id,
    recipient_key_id: envelope.recipient_key_id,
    idempotency_hash: stringValue(fields.idempotency_hash || fields.idempotencyHash, 128) || null,
    meta: normalizeRelayMeta(envelope.meta),
    delivery_status: "queued",
    queued_at: queuedAt,
    delivered_at: null,
    acked_at: null,
    expires_at: new Date(Date.parse(queuedAt) + ttlMs).toISOString(),
    created_at: queuedAt,
    updated_at: queuedAt,
  };
}

export function publicRelayEnvelope(row = {}) {
  return row ? {
    id: row.id,
    product_id: row.product_id,
    device_id: row.device_id,
    channel_id: row.channel_id,
    direction: row.direction,
    seq: Number(row.seq || 0),
    request_key: row.request_key || null,
    ciphertext: row.ciphertext,
    aad: row.aad,
    nonce: row.nonce,
    algorithm: row.algorithm,
    sender_key_id: row.sender_key_id,
    recipient_key_id: row.recipient_key_id,
    meta: normalizeRelayMeta(row.meta),
    delivery_status: row.delivery_status || "queued",
    queued_at: row.queued_at || row.created_at || null,
    delivered_at: row.delivered_at || null,
    acked_at: row.acked_at || null,
    expires_at: row.expires_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  } : null;
}

export function forbiddenPlaintextFields(input = {}) {
  const found = new Set();
  collectForbiddenFields(input, found, "");
  return [...found].sort();
}

function collectForbiddenFields(value, found, path) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenFields(item, found, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalized = normalizeFieldName(key);
    if (RELAY_FORBIDDEN_PLAINTEXT_FIELDS.includes(normalized)) {
      found.add(path ? `${path}.${key}` : key);
      continue;
    }
    collectForbiddenFields(nested, found, path ? `${path}.${key}` : key);
  }
}

export function normalizeRelayMeta(input = {}) {
  const meta = objectValue(input);
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    const normalized = normalizeFieldName(key);
    if (!RELAY_META_ALLOWED_FIELDS.includes(normalized)) continue;
    const clean = relayMetaValue(value);
    if (clean !== undefined) out[normalized] = clean;
  }
  return out;
}

export function invalidRelayMetaFields(input = {}) {
  const meta = objectValue(input);
  const invalid = [];
  for (const [key, value] of Object.entries(meta)) {
    const normalized = normalizeFieldName(key);
    if (!RELAY_META_ALLOWED_FIELDS.includes(normalized)) {
      invalid.push(key);
      continue;
    }
    if (relayMetaValue(value) === undefined) invalid.push(key);
  }
  return invalid.sort();
}

function relayMetaValue(value) {
  if (typeof value === "string") return stringValue(value, 300);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => typeof item === "string" ? stringValue(item, 120) : "")
      .filter(Boolean);
    return items.length === value.length ? items : undefined;
  }
  return undefined;
}

function normalizeFieldName(key) {
  return String(key || "").replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`).toLowerCase();
}

export function normalizePolicy(input = {}) {
  return objectValue(input);
}

export function normalizeKind(kind) {
  return stringPassthrough(kind);
}

export function bridgeEvent(type, payload = {}) {
  return {
    type: EVENT_TYPES.includes(type) ? type : "status",
    payload: objectValue(payload),
    created_at: new Date().toISOString(),
  };
}

export function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function stringValue(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function stringPassthrough(value) {
  return typeof value === "string" ? value : "";
}

export function integerValue(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}
