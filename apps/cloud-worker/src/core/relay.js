import { RELAY_ENVELOPE_VERSION, publicRelayEnvelope, relayEnvelopeRecord, validateRelayEnvelope } from "@bridge/protocol";
import { RELAY_ACCOUNT_MAX_UNACKED, RELAY_CHANNEL_MAX_UNACKED, RELAY_DEVICE_MAX_UNACKED, RELAY_ENVELOPE_TTL_MS, RELAY_PRODUCT_MAX_UNACKED, RELAY_QUEUE_RETRY_AFTER_MS } from "./constants.js";
import { activeAuthorization, audit, authorizationForProduct, authorizationJobDenial, ownedDevice, requireConnector, requireSession } from "./auth-common.js";
import { json, parseJsonText, readJson, readJsonText, rejectProductOrigin, requireOfficialProduct, sourceOrigin } from "./http.js";
import { isDeviceOnline, publicStateProduct } from "./public-payloads.js";
import { storage } from "./storage.js";
import { notifyDeviceRoom, realtimeEnabled, runBackground } from "./realtime.js";
import { boundedInteger, canonicalJson, clean, httpError, now, object, sha256Hex } from "./utils.js";
import { requireProductDelegation } from "./authorization-handlers.js";

export async function createProductRelayEnvelope(request, env, productId, ctx = {}) {
  const product = requireOfficialProduct(productId, env);
  const source_origin = sourceOrigin(env);
  const originError = rejectProductOrigin(product, source_origin, env);
  if (originError) return originError;
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  return createAuthorizedRelayEnvelope(env, product, session.user.id, source_origin, body, ctx, {
    direction: "product_to_device",
    auditAction: "relay.envelope.create",
  });
}

export async function createDelegatedProductRelayEnvelope(request, env, productId, ctx = {}) {
  const product = requireOfficialProduct(productId, env);
  const rawBody = await readJsonText(request, env);
  const delegation = await requireProductDelegation(request, env, product, rawBody);
  const body = rawBody ? parseJsonText(rawBody) : {};
  return createAuthorizedRelayEnvelope(env, product, delegation.bridgeUserId, delegation.sourceOrigin, body, ctx, {
    direction: "product_to_device",
    auditAction: "relay.envelope.create.delegated",
    delegatedDeviceId: delegation.deviceId,
  });
}

export async function listProductRelayEnvelopes(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const source_origin = sourceOrigin(env);
  const originError = rejectProductOrigin(product, source_origin, env);
  if (originError) return originError;
  const session = await requireSession(request, env);
  return listRelayEnvelopesForProduct(request, env, product, session.user.id, "device_to_product");
}

export async function listDelegatedProductRelayEnvelopes(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const delegation = await requireProductDelegation(request, env, product, "");
  return listRelayEnvelopesForProduct(request, env, product, delegation.bridgeUserId, "device_to_product", delegation.deviceId);
}

export async function ackProductRelayEnvelope(request, env, productId, envelopeId) {
  const product = requireOfficialProduct(productId, env);
  const source_origin = sourceOrigin(env);
  const originError = rejectProductOrigin(product, source_origin, env);
  if (originError) return originError;
  const session = await requireSession(request, env);
  return ackRelayEnvelope(env, {
    envelopeId,
    userId: session.user.id,
    productId: product.id,
    direction: "device_to_product",
    status: "acked",
    auditAction: "relay.envelope.ack.product",
  });
}

export async function ackDelegatedProductRelayEnvelope(request, env, productId, envelopeId) {
  const product = requireOfficialProduct(productId, env);
  const rawBody = await readJsonText(request, env);
  const delegation = await requireProductDelegation(request, env, product, rawBody);
  return ackRelayEnvelope(env, {
    envelopeId,
    userId: delegation.bridgeUserId,
    productId: product.id,
    deviceId: delegation.deviceId,
    direction: "device_to_product",
    status: "acked",
    auditAction: "relay.envelope.ack.delegated",
  });
}

export async function connectorRelayEnvelopes(request, env) {
  const connector = await requireConnector(request, env);
  await cleanupExpiredRelayEnvelopes(env);
  const url = new URL(request.url);
  const channelId = clean(url.searchParams.get("channel_id"), 160);
  const productId = clean(url.searchParams.get("product_id"), 80);
  const listOptions = relayListOptions(url);
  const cursorError = rejectUnscopedRelayCursor(env, listOptions, channelId);
  if (cursorError) return cursorError;
  const filters = {
    user_id: connector.device.user_id,
    device_id: connector.device.id,
    direction: "product_to_device",
  };
  if (productId) filters.product_id = productId;
  if (channelId) filters.channel_id = channelId;
  const result = await waitForRelayList(listOptions.waitMs, async () => {
    const rows = await storage(env).select("bridge_relay_envelopes", filters, { order: "created_at" });
    return await connectorRelayListResult(env, rows, listOptions);
  });
  return json({
    ...relayListPayload(result, listOptions),
    transport: realtimeEnabled(env) ? "websocket_or_poll" : "poll",
  }, env);
}

export async function createConnectorRelayEnvelope(request, env, ctx = {}) {
  const connector = await requireConnector(request, env);
  const body = await readJson(request, env);
  const productId = clean(body.product_id || body.productId, 80);
  const product = requireOfficialProduct(productId, env);
  return createAuthorizedRelayEnvelope(env, product, connector.device.user_id, product.official_origin || sourceOrigin(env), {
    ...body,
    device_id: connector.device.id,
    direction: "device_to_product",
  }, ctx, {
    direction: "device_to_product",
    auditAction: "relay.envelope.create.connector",
    delegatedDeviceId: connector.device.id,
  });
}

export async function ackConnectorRelayEnvelope(request, env, envelopeId) {
  const connector = await requireConnector(request, env);
  return ackRelayEnvelope(env, {
    envelopeId,
    userId: connector.device.user_id,
    deviceId: connector.device.id,
    direction: "product_to_device",
    status: "acked",
    auditAction: "relay.envelope.ack.connector",
  });
}

export async function createAuthorizedRelayEnvelope(env, product, userId, source_origin, body, ctx = {}, options = {}) {
  const direction = options.direction || clean(body.direction, 80) || "product_to_device";
  const validation = validateRelayEnvelope({ ...body, productId: product.id, direction }, {
    productId: product.id,
    direction,
    ...(options.delegatedDeviceId ? { deviceId: options.delegatedDeviceId } : {}),
  });
  if (!validation.ok) {
    return json({
      error: validation.errors.includes("plaintext_fields_forbidden") ? "plaintext_fields_forbidden" : "invalid_relay_envelope",
      errors: validation.errors,
      plaintext_fields: validation.plaintext_fields,
    }, env, 400);
  }
  const envelope = validation.envelope;
  const device = await ownedDevice(env, userId, envelope.device_id);
  if (!device) return json({ error: "device_not_found" }, env, 404);
  if (device.status === "revoked") return json({ error: "device_revoked" }, env, 403);
  if (!isDeviceOnline(device, env)) return json({ error: "device_offline" }, env, 409);
  const authorization = await authorizationForProduct(env, userId, device.id, product.id);
  const denial = authorizationJobDenial(authorization);
  if (denial) return json({ error: denial.error }, env, 403);
  const idempotencyHash = await relayEnvelopeIdempotencyHash(envelope);
  const existing = await existingRequestKeyRelayEnvelope(env, userId, device.id, product.id, envelope.request_key);
  if (existing) {
    if (!sameRelayEnvelope(existing, envelope, idempotencyHash, relayEnvelopeTtlMs(env))) return json({ error: "idempotency_key_conflict" }, env, 409);
    return json({ envelope: publicRelayEnvelope(existing), reused: true }, env);
  }
  await cleanupExpiredRelayEnvelopes(env);
  const relayLimit = await relayQueueLimitDenial(env, {
    userId,
    deviceId: device.id,
    productId: product.id,
    channelId: envelope.channel_id,
    direction: envelope.direction,
  });
  if (relayLimit) {
    return json({
      error: relayLimit.error,
      queue: relayLimit.queue,
    }, env, 429);
  }
  const queuedAt = now();
  let row;
  try {
    row = await storage(env).insert("bridge_relay_envelopes", relayEnvelopeRecord({
      ...envelope,
      ttl_ms: Math.min(envelope.ttl_ms, relayEnvelopeTtlMs(env)),
    }, {
      userId,
      queuedAt,
      idempotencyHash,
    }));
  } catch (error) {
    const duplicate = await existingRequestKeyRelayEnvelope(env, userId, device.id, product.id, envelope.request_key);
    if (duplicate && sameRelayEnvelope(duplicate, envelope, idempotencyHash, relayEnvelopeTtlMs(env))) {
      return json({ envelope: publicRelayEnvelope(duplicate), reused: true }, env);
    }
    if (duplicate) return json({ error: "idempotency_key_conflict" }, env, 409);
    throw error;
  }
  await runBackground(ctx, audit(env, userId, device.id, product.id, options.auditAction || "relay.envelope.create", row.id, {
    source_origin,
    direction: row.direction,
    channel_id: row.channel_id,
    request_key: row.request_key,
    ciphertext_bytes: row.ciphertext.length,
    expires_at: row.expires_at,
  }));
  await runBackground(ctx, notifyRelayEnvelope(env, device.id, row));
  return json({ envelope: publicRelayEnvelope(row), product: publicStateProduct(product) }, env, 201);
}

export async function listRelayEnvelopesForProduct(request, env, product, userId, direction, delegatedDeviceId = "") {
  await cleanupExpiredRelayEnvelopes(env);
  const url = new URL(request.url);
  const channelId = clean(url.searchParams.get("channel_id"), 160);
  const deviceId = clean(url.searchParams.get("device_id"), 120) || clean(delegatedDeviceId, 120);
  const listOptions = relayListOptions(url);
  const cursorError = rejectUnscopedRelayCursor(env, listOptions, channelId);
  if (cursorError) return cursorError;
  const filters = {
    user_id: userId,
    product_id: product.id,
    direction,
  };
  if (deviceId) filters.device_id = deviceId;
  if (channelId) filters.channel_id = channelId;
  const result = await waitForRelayList(listOptions.waitMs, async () => {
    const rows = await storage(env).select("bridge_relay_envelopes", filters, { order: "created_at" });
    return relayListResult(rows, listOptions);
  });
  return json({ ...relayListPayload(result, listOptions), product: publicStateProduct(product) }, env);
}

export function relayListOptions(url) {
  const afterSeqRaw = Number(url.searchParams.get("after_seq") || 0);
  const limitRaw = Number(url.searchParams.get("limit") || 100);
  const waitRaw = Number(url.searchParams.get("wait_ms") || url.searchParams.get("waitMs") || 0);
  return {
    afterSeq: Math.max(0, Number.isFinite(afterSeqRaw) ? Math.floor(afterSeqRaw) : 0),
    limit: Math.max(1, Math.min(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100, 500)),
    waitMs: Math.max(0, Math.min(Number.isFinite(waitRaw) ? Math.floor(waitRaw) : 0, 30000)),
    includeAcked: ["1", "true", "yes"].includes(String(url.searchParams.get("include_acked") || url.searchParams.get("includeAcked") || "").toLowerCase()),
  };
}

export function rejectUnscopedRelayCursor(env, options, channelId) {
  if (options.afterSeq <= 0 || clean(channelId, 160)) return null;
  return json({
    error: "relay_cursor_requires_channel",
    message: "after_seq pagination requires channel_id because seq cursors are scoped to one relay channel",
    cursor: { after_seq: options.afterSeq },
  }, env, 400);
}

export async function waitForRelayList(waitMs, collect) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await collect();
    if (result.items.length || waitMs <= 0 || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(25, deadline - Date.now()))));
  }
}

export function relayListStatuses(options) {
  return options.includeAcked ? ["queued", "delivered", "acked"] : ["queued", "delivered"];
}

export function relayListCandidateRows(rows, options) {
  const statuses = relayListStatuses(options);
  return rows
    .filter((item) => statuses.includes(item.delivery_status || "queued"))
    .filter((item) => Number(item.seq || 0) > options.afterSeq)
    .filter((item) => !isExpired(item.expires_at));
}

export function relayListResult(rows, options) {
  const candidates = relayListCandidateRows(rows, options);
  return {
    items: candidates.slice(0, options.limit).map(publicRelayEnvelope),
    candidateCount: candidates.length,
  };
}

export async function connectorRelayListResult(env, rows, options) {
  const candidates = relayListCandidateRows(rows, options);
  const items = [];
  let deliverableCount = 0;
  for (const row of candidates) {
    const authorization = await authorizationForProduct(env, row.user_id, row.device_id, row.product_id);
    const denial = authorizationJobDenial(authorization);
    if (denial) {
      await expireRelayEnvelope(env, row, denial.reason);
      continue;
    }
    deliverableCount += 1;
    if (items.length >= options.limit) break;
    const delivered = row.delivery_status === "queued"
      ? await storage(env).update("bridge_relay_envelopes", row.id, {
        delivery_status: "delivered",
        delivered_at: row.delivered_at || now(),
        updated_at: now(),
      })
      : row;
    items.push(publicRelayEnvelope(delivered || row));
  }
  return { items, candidateCount: deliverableCount };
}

export function relayListPayload(result, options) {
  const lastSeq = result.items.length
    ? Math.max(...result.items.map((item) => Number(item.seq || 0)))
    : options.afterSeq;
  return {
    items: result.items,
    cursor: {
      after_seq: options.afterSeq,
      next_after_seq: lastSeq,
      limit: options.limit,
      has_more: result.candidateCount > result.items.length,
      returned: result.items.length,
      include_acked: options.includeAcked,
    },
  };
}

export async function ackRelayEnvelope(env, options = {}) {
  const envelopeId = clean(options.envelopeId, 120);
  const filters = { id: envelopeId };
  if (options.userId) filters.user_id = options.userId;
  if (options.productId) filters.product_id = options.productId;
  if (options.deviceId) filters.device_id = options.deviceId;
  if (options.direction) filters.direction = options.direction;
  const row = (await storage(env).select("bridge_relay_envelopes", filters))[0] || null;
  if (!row) return json({ error: "relay_envelope_not_found" }, env, 404);
  if (row.delivery_status === "cancelled") {
    return json({ envelope: publicRelayEnvelope(row), acked: false, error: "relay_envelope_cancelled" }, env, 409);
  }
  if (isExpired(row.expires_at)) {
    const expired = await expireRelayEnvelope(env, row, "ttl_expired");
    return json({ envelope: publicRelayEnvelope(expired), acked: false, error: "relay_envelope_expired" }, env, 410);
  }
  const ackedAt = now();
  const next = await storage(env).update("bridge_relay_envelopes", row.id, {
    delivery_status: "acked",
    acked_at: row.acked_at || ackedAt,
    updated_at: ackedAt,
  });
  await audit(env, row.user_id, row.device_id, row.product_id, options.auditAction || "relay.envelope.ack", row.id, {
    direction: row.direction,
    channel_id: row.channel_id,
  });
  await notifyRelayEvent(env, row.device_id, next || row);
  return json({ envelope: publicRelayEnvelope(next || row), acked: true }, env);
}

export async function existingRequestKeyRelayEnvelope(env, userId, deviceId, productId, requestKey) {
  if (!requestKey) return null;
  const rows = await storage(env).select("bridge_relay_envelopes", {
    user_id: userId,
    device_id: deviceId,
    product_id: productId,
    request_key: requestKey,
  });
  return rows[0] || null;
}

export function sameRelayEnvelope(row, envelope, idempotencyHash, maxTtlMs = RELAY_ENVELOPE_TTL_MS) {
  if (row?.idempotency_hash) return String(row.idempotency_hash) === String(idempotencyHash || "");
  return sameLegacyRelayEnvelope(row, envelope, maxTtlMs);
}

export function sameLegacyRelayEnvelope(row, envelope, maxTtlMs) {
  const rowTtlMs = relayRowTtlMs(row);
  const expectedTtlMs = Math.min(Number(envelope.ttl_ms || 0), maxTtlMs);
  return Boolean(row && envelope)
    && String(row.product_id || "") === String(envelope.product_id || "")
    && String(row.device_id || "") === String(envelope.device_id || "")
    && String(row.channel_id || "") === String(envelope.channel_id || "")
    && String(row.direction || "") === String(envelope.direction || "")
    && Number(row.seq || 0) === Number(envelope.seq || 0)
    && String(row.request_key || "") === String(envelope.request_key || "")
    && String(row.ciphertext || "") === String(envelope.ciphertext || "")
    && String(row.aad || "") === String(envelope.aad || "")
    && String(row.nonce || "") === String(envelope.nonce || "")
    && String(row.algorithm || "") === String(envelope.algorithm || "")
    && String(row.sender_key_id || "") === String(envelope.sender_key_id || "")
    && String(row.recipient_key_id || "") === String(envelope.recipient_key_id || "")
    && String(row.envelope_version || RELAY_ENVELOPE_VERSION) === String(envelope.envelope_version || RELAY_ENVELOPE_VERSION)
    && rowTtlMs !== null
    && Math.abs(rowTtlMs - expectedTtlMs) <= 1
    && canonicalJson(row.meta || {}) === canonicalJson(envelope.meta || {});
}

export function relayRowTtlMs(row = {}) {
  const queuedMs = Date.parse(row.queued_at || row.created_at || "");
  const expiresMs = Date.parse(row.expires_at || "");
  return Number.isFinite(queuedMs) && Number.isFinite(expiresMs) ? Math.max(0, expiresMs - queuedMs) : null;
}

export async function relayEnvelopeIdempotencyHash(envelope) {
  return sha256Hex(canonicalJson({
    envelope_version: envelope.envelope_version,
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
    ttl_ms: envelope.ttl_ms,
    meta: envelope.meta || {},
  }));
}

export async function expireRelayEnvelope(env, row, reason = "expired") {
  return await storage(env).update("bridge_relay_envelopes", row.id, {
    delivery_status: "expired",
    updated_at: now(),
    meta: { ...object(row.meta), expired_reason: reason },
  }) || row;
}

export async function cleanupExpiredRelayEnvelopes(env) {
  const store = storage(env);
  if (typeof store.deleteExpired !== "function") return 0;
  return await store.deleteExpired("bridge_relay_envelopes", "expires_at");
}

export async function relayQueueLimitDenial(env, input = {}) {
  const limits = relayQueueLimits(env);
  const base = {};
  const deviceActive = await activeRelayEnvelopes(env, { ...base, device_id: input.deviceId });
  if (deviceActive.length >= limits.deviceMaxUnacked) {
    return {
      error: "relay_device_queue_full",
      queue: relayLimitPayload(deviceActive.length, limits.deviceMaxUnacked, "device"),
    };
  }
  const accountActive = await activeRelayEnvelopes(env, { ...base, user_id: input.userId });
  if (accountActive.length >= limits.accountMaxUnacked) {
    return {
      error: "relay_account_queue_full",
      queue: relayLimitPayload(accountActive.length, limits.accountMaxUnacked, "account"),
    };
  }
  const productActive = await activeRelayEnvelopes(env, {
    ...base,
    user_id: input.userId,
    product_id: input.productId,
  });
  if (productActive.length >= limits.productMaxUnacked) {
    return {
      error: "relay_product_queue_full",
      queue: relayLimitPayload(productActive.length, limits.productMaxUnacked, "product"),
    };
  }
  const channelActive = await activeRelayEnvelopes(env, {
    ...base,
    user_id: input.userId,
    device_id: input.deviceId,
    product_id: input.productId,
    channel_id: input.channelId,
  });
  if (channelActive.length >= limits.channelMaxUnacked) {
    return {
      error: "relay_channel_queue_full",
      queue: relayLimitPayload(channelActive.length, limits.channelMaxUnacked, "channel"),
    };
  }
  return null;
}

export async function activeRelayEnvelopes(env, filters = {}) {
  const rows = await storage(env).select("bridge_relay_envelopes", filters, { order: "created_at" });
  return rows.filter((item) => (
    ["queued", "delivered"].includes(item.delivery_status || "queued")
    && !isExpired(item.expires_at)
  ));
}

export function isExpired(expiresAt) {
  const expiresMs = Date.parse(expiresAt || "");
  return Number.isFinite(expiresMs) && expiresMs <= Date.now();
}

export function relayEnvelopeTtlMs(env) {
  return boundedInteger(env.BRIDGE_RELAY_ENVELOPE_TTL_MS, RELAY_ENVELOPE_TTL_MS, 1000, 24 * 60 * 60 * 1000);
}

export async function notifyRelayEnvelope(env, deviceId, envelope) {
  return notifyDeviceRoom(env, deviceId, {
    type: "relay.envelope",
    envelope: publicRelayEnvelope(envelope),
    sent_at: now(),
  });
}

export async function notifyRelayEvent(env, deviceId, envelope) {
  return notifyDeviceRoom(env, deviceId, {
    type: "relay.envelope.event",
    envelope: publicRelayEnvelope(envelope),
    sent_at: now(),
  });
}

export async function cleanupExpiredRows(env) {
  const store = storage(env);
  if (typeof store.deleteExpired !== "function") return {};
  const tables = [
    "bridge_product_delegation_nonces",
    "bridge_authorization_import_proofs",
    "bridge_sessions",
    "bridge_session_links",
    "bridge_pairing_codes",
    "bridge_connect_intents",
    "bridge_device_tokens",
    "bridge_password_attempts",
  ];
  const deleted = {};
  for (const table of tables) {
    deleted[table] = await store.deleteExpired(table, "expires_at");
  }
  deleted.bridge_relay_envelopes = await cleanupExpiredRelayEnvelopes(env);
  return deleted;
}

export function relayQueueLimits(env) {
  return {
    deviceMaxUnacked: boundedInteger(env.BRIDGE_RELAY_DEVICE_MAX_UNACKED, RELAY_DEVICE_MAX_UNACKED, 1, 1000),
    accountMaxUnacked: boundedInteger(env.BRIDGE_RELAY_ACCOUNT_MAX_UNACKED, RELAY_ACCOUNT_MAX_UNACKED, 1, 5000),
    productMaxUnacked: boundedInteger(env.BRIDGE_RELAY_PRODUCT_MAX_UNACKED, RELAY_PRODUCT_MAX_UNACKED, 1, 3000),
    channelMaxUnacked: boundedInteger(env.BRIDGE_RELAY_CHANNEL_MAX_UNACKED, RELAY_CHANNEL_MAX_UNACKED, 1, 1000),
  };
}

export function relayLimitPayload(active, max, scope) {
  return {
    scope,
    active,
    max_unacked: max,
    retry_after_ms: RELAY_QUEUE_RETRY_AFTER_MS,
  };
}
