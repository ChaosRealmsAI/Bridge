import {
  AUTHORIZATION_IMPORT_PROOF_TTL_MS,
  CONNECT_INTENT_TTL_MS,
  DEVICE_TOKEN_PREFIX,
  DEVICE_TOKEN_ROTATION_GRACE_MS,
  DEVICE_TOKEN_TTL_MS,
  PAIRING_TTL_MS,
  SESSION_LINK_TTL_MS,
  SESSION_TTL_MS,
} from "./constants.js";
import { notifyDeviceRoom } from "./realtime.js";
import { storage, hasSupabase, supabaseFetch } from "./storage.js";
import { authorizationRelayKeyBootstrap, publicAuthorizationPolicy, publicDevice, safeDeviceCapabilities, safeLocalState, isDeviceOnline } from "./public-payloads.js";
import { authorizationEpoch, boundedInteger, clean, cookie, httpError, now, object, randomToken, sha256Hex } from "./utils.js";

export async function currentSession(request, env) {
  const token = cookie(request, env.SESSION_COOKIE_NAME || "pb_session");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const session = (await storage(env).select("bridge_sessions", { token_hash: tokenHash }))[0];
  if (!session || Date.parse(session.expires_at) < Date.now()) return null;
  const user = (await storage(env).select("bridge_users", { id: session.user_id }))[0];
  return user ? { session, user } : null;
}

export async function createSessionForUser(env, user) {
  const token = randomToken("pbs_");
  const session = await storage(env).insert("bridge_sessions", {
    user_id: user.id,
    token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + sessionTtlMs(env)).toISOString(),
    created_at: now(),
  });
  return { token, session };
}

export async function ensureDelegatedUser(env, productId, externalUserId, input = {}) {
  const id = await productScopedUserId(productId, externalUserId);
  const displayName = clean(input.display_name || input.displayName || input.name, 100) || "Panda Account";
  const email = normalizeEmail(input.email);
  const existing = (await storage(env).select("bridge_users", { id }))[0] || null;
  if (existing) {
    return await storage(env).update("bridge_users", existing.id, {
      display_name: displayName || existing.display_name,
      email: email || existing.email || null,
      updated_at: now(),
    }) || existing;
  }
  return await storage(env).insert("bridge_users", {
    id,
    display_name: displayName,
    email: email || null,
    created_at: now(),
    updated_at: now(),
  });
}

export async function resolveDelegatedBridgeUserId(env, productId, externalUserId, deviceId) {
  const rawUserId = clean(externalUserId, 120);
  const rawDeviceId = clean(deviceId, 120);
  if (!rawUserId) throw httpError("product_delegation_unauthorized", 401);
  if (rawDeviceId) {
    const device = await ownedDevice(env, rawUserId, rawDeviceId);
    if (device && device.status !== "revoked") {
      return rawUserId;
    }
  }
  return productScopedUserId(productId, rawUserId);
}

export async function productScopedUserId(productId, externalUserId) {
  const scoped = clean(externalUserId, 120);
  if (!scoped) throw httpError("product_delegation_unauthorized", 401);
  const hex = await sha256Hex(`panda-bridge:delegated-user:v1:${productId}:${scoped}`);
  return uuidFromHex(hex);
}

export function uuidFromHex(hex) {
  const chars = hex.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

export async function requireSession(request, env) {
  const session = await currentSession(request, env);
  if (!session) throw httpError("unauthorized", 401);
  return session;
}

export async function requireConnector(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) throw httpError("unauthorized", 401);
  const connector = await connectorByToken(env, token, connectorInstallId(request));
  if (!connector) throw httpError("unauthorized", 401);
  return connector;
}

export async function optionalConnector(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return token ? await connectorByToken(env, token, connectorInstallId(request)) : null;
}

export async function connectorByToken(env, token, installId = "") {
  const tokenRow = (await storage(env).select("bridge_device_tokens", { token_hash: await sha256Hex(token) }))[0];
  if (!tokenRow || tokenRow.revoked_at || Date.parse(tokenRow.expires_at) <= Date.now()) return null;
  const device = (await storage(env).select("bridge_devices", { id: tokenRow.device_id }))[0];
  if (!device || device.status === "revoked") return null;
  if (!await installIdentityMatches(device, installId)) return null;
  return { token: tokenRow, device, raw_token: token };
}

export function connectorInstallId(request) {
  return clean(request.headers.get("x-panda-bridge-install-id"), 200);
}

export async function installIdentityMatches(device, installId) {
  if (!device.install_id_hash) return true;
  if (!installId) return false;
  return device.install_id_hash === await installIdentityHash(installId);
}

export async function installIdentityPatch(device, installId) {
  if (!installId) return {};
  const hash = await installIdentityHash(installId);
  if (device.install_id_hash && device.install_id_hash !== hash) {
    throw httpError("install_identity_mismatch", 401);
  }
  if (device.install_id_hash) return {};
  return { install_id_hash: hash, install_id_bound_at: now() };
}

export async function installIdentityHash(installId) {
  return sha256Hex(`install:${clean(installId, 200)}`);
}

export async function reusableDeviceForInstall(env, userId, installId) {
  const hash = await installIdentityHash(installId);
  const rows = await storage(env).select("bridge_devices", { user_id: userId, install_id_hash: hash }, { order: "updated_at", desc: true });
  return rows.find((device) => device.status !== "revoked") || null;
}

export async function ownedDevice(env, userId, deviceId) {
  return (await storage(env).select("bridge_devices", { id: deviceId, user_id: userId }))[0] || null;
}

export async function activeAuthorization(env, userId, deviceId, productId) {
  return (await storage(env).select("bridge_authorizations", {
    user_id: userId,
    device_id: deviceId,
    product_id: productId,
    status: "active",
  }))[0] || null;
}

export async function authorizationForProduct(env, userId, deviceId, productId) {
  const filters = {
    user_id: userId,
    product_id: productId,
  };
  if (deviceId) filters.device_id = deviceId;
  const rows = await storage(env).select("bridge_authorizations", filters, { order: "updated_at", desc: true });
  return selectAuthorizationRow(rows) || null;
}

export async function authorizationRowsForProduct(env, userId, productId) {
  const rows = await storage(env).select("bridge_authorizations", {
    user_id: userId,
    product_id: productId,
  }, { order: "updated_at", desc: true });
  return rows.sort(compareAuthorizationRows);
}

// Account-level device placeholders the SDK signs when the caller targets a
// (user, product) without naming a specific device. The value is still part of
// the HMAC payload, so the signature is verified as-is; only the resolution is
// account-scoped.
const ACCOUNT_LEVEL_DEVICE_IDS = new Set(["account", "pending", ""]);

export function isAccountLevelDeviceId(deviceId) {
  return ACCOUNT_LEVEL_DEVICE_IDS.has(clean(deviceId, 120));
}

// Resolves the device an account-level authorization action should act on:
// the current active (preferred) or paused authorization device for this
// (user, product). Returns null when there is no live authorization device.
export async function accountAuthorizationDevice(env, userId, productId) {
  const rows = await authorizationRowsForProduct(env, userId, productId);
  for (const row of rows) {
    if (row.status !== "active" && row.status !== "paused") continue;
    const device = await ownedDevice(env, userId, row.device_id);
    if (device && device.status !== "revoked") return device;
  }
  return null;
}

// Resolves the device a session (browser) authorization PATCH/DELETE targets.
// A concrete device_id stays device-scoped; an account_id (or no params at all)
// resolves the live authorization device for this (user, product) so account-
// level pause/resume/remove work without naming a device.
export async function resolveSessionAuthorizationDevice(request, env, product, session) {
  const url = new URL(request.url);
  const deviceId = clean(url.searchParams.get("device_id"), 120);
  if (deviceId && !isAccountLevelDeviceId(deviceId)) {
    const device = await ownedDevice(env, session.user.id, deviceId);
    if (!device || device.status === "revoked") return { error: "device_not_found", status: 404 };
    return { device };
  }
  const device = await accountAuthorizationDevice(env, session.user.id, product.id);
  if (!device) return { error: "product_not_authorized", status: 403 };
  return { device };
}

// Resolves the device a delegated authorization PATCH/DELETE targets. When the
// caller signs a concrete device_id it stays device-scoped (and must match the
// signed device). When the caller signs an account-level placeholder
// ("account"/"pending"/empty) it resolves the live authorization device for the
// (user, product) so account-level pause/resume/remove work without naming a
// device. Returns { device } on success or { error, status } otherwise.
export async function resolveDelegatedAuthorizationDevice(request, env, product, delegation) {
  const url = new URL(request.url);
  const requestedDeviceId = clean(url.searchParams.get("device_id"), 120);
  const signedAccountLevel = isAccountLevelDeviceId(delegation.deviceId);

  if (!signedAccountLevel) {
    // Device-scoped: the signed device_id wins; any query device_id must match.
    if (requestedDeviceId && requestedDeviceId !== delegation.deviceId) {
      return { error: "delegated_device_mismatch", status: 403 };
    }
    const device = await ownedDevice(env, delegation.bridgeUserId, delegation.deviceId);
    if (!device || device.status === "revoked") return { error: "device_not_found", status: 404 };
    return { device };
  }

  // Account-level: a query device_id (when present) must still be a real owned
  // device for this account; otherwise resolve the live authorization device.
  if (requestedDeviceId && !isAccountLevelDeviceId(requestedDeviceId)) {
    const device = await ownedDevice(env, delegation.bridgeUserId, requestedDeviceId);
    if (!device || device.status === "revoked") return { error: "device_not_found", status: 404 };
    return { device };
  }
  const device = await accountAuthorizationDevice(env, delegation.bridgeUserId, product.id);
  if (!device) return { error: "product_not_authorized", status: 403 };
  return { device };
}

export function selectAuthorizationRow(rows) {
  return [...rows].sort(compareAuthorizationRows)[0] || null;
}

export function compareAuthorizationRows(left, right) {
  const leftRank = authorizationStatusRank(left?.status);
  const rightRank = authorizationStatusRank(right?.status);
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftTime = Date.parse(left?.updated_at || left?.created_at || "") || 0;
  const rightTime = Date.parse(right?.updated_at || right?.created_at || "") || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

export function authorizationStatusRank(status) {
  if (status === "active") return 0;
  if (status === "paused") return 1;
  if (status === "revoked") return 2;
  return 3;
}

export function authorizationJobDenial(authorization) {
  if (authorization?.status === "active") return null;
  if (authorization?.status === "paused") {
    return { error: "authorization_paused", reason: "authorization_paused" };
  }
  return { error: "authorization_revoked", reason: "authorization_revoked" };
}

export async function updateAuthorizationWithEpoch(env, authorization, patch, options = {}) {
  const from = authorizationEpoch(authorization);
  const to = from + 1;
  const nextPatch = { ...patch };
  if (authorizationRelayKeyBootstrap(authorization).status || Object.hasOwn(patch, "policy")) {
    nextPatch.policy = publicAuthorizationPolicy(Object.hasOwn(patch, "policy") ? patch.policy : authorization.policy);
  }
  const updated = await storage(env).update("bridge_authorizations", authorization.id, {
    ...nextPatch,
    epoch: to,
  });
  const cancelDenial = options.cancelDenial || null;
  const cancelledRelayEnvelopes = cancelDenial
    ? await cancelQueuedRelayEnvelopesForAuthorization(
        env,
        authorization.user_id,
        authorization.device_id,
        authorization.product_id,
        cancelDenial,
      )
    : 0;
  await audit(env, authorization.user_id, authorization.device_id, authorization.product_id, "authorization.epoch_bump", authorization.id, {
    from,
    to,
    cause: clean(options.cause, 120) || "authorization_update",
    cancelled_relay_envelopes: cancelledRelayEnvelopes,
  });
  await notifyDeviceRoom(env, authorization.device_id, {
    type: "authorization.epoch_bump",
    authorization: {
      id: authorization.id,
      product_id: authorization.product_id,
      status: updated?.status || patch.status || authorization.status,
      epoch: to,
    },
    sent_at: now(),
  });
  return { authorization: updated, cancelledRelayEnvelopes, from, to };
}

export async function updateAuthorizationStatus(env, { userId, deviceId, product, status, sourceOrigin = "", auditActionPrefix = "authorization" }) {
  if (!["active", "paused"].includes(status)) {
    return { error: "invalid_authorization_status", status: 400 };
  }
  const authorization = await authorizationForProduct(env, userId, deviceId, product.id);
  if (!authorization) return { error: "product_not_authorized", status: 403 };
  if (authorization.status === "revoked") return { error: "authorization_revoked", status: 409 };
  if (authorization.status === status) return { authorization, cancelledRelayEnvelopes: 0 };

  const denial = status === "paused"
    ? { error: "authorization_paused", reason: "authorization_paused" }
    : { error: "authorization_revoked", reason: "authorization_revoked" };
  const updatedResult = await updateAuthorizationWithEpoch(env, authorization, {
    status,
    updated_at: now(),
  }, {
    cause: status === "paused" ? "pause" : "resume",
    cancelDenial: status === "paused" ? denial : null,
  });
  const updated = updatedResult.authorization;
  const cancelledRelayEnvelopes = updatedResult.cancelledRelayEnvelopes || 0;
  await audit(env, userId, deviceId, product.id, `${auditActionPrefix}.${status === "paused" ? "pause" : "resume"}`, authorization.id, {
    source_origin: sourceOrigin || null,
    previous_status: authorization.status,
    next_status: status,
    cancelled_relay_envelopes: cancelledRelayEnvelopes,
  });
  return { authorization: updated, cancelledRelayEnvelopes };
}

export async function cancelQueuedRelayEnvelopesForAuthorization(env, userId, deviceId, productId, denial = { error: "authorization_revoked", reason: "authorization_revoked" }) {
  const rows = await storage(env).select("bridge_relay_envelopes", {
    user_id: userId,
    device_id: deviceId,
    product_id: productId,
  });
  let count = 0;
  for (const row of rows.filter((item) => ["queued", "delivered"].includes(item.delivery_status || "queued"))) {
    await cancelRelayEnvelope(env, row, denial.reason || denial.error || "authorization_revoked");
    count += 1;
  }
  return count;
}

export async function cancelRelayEnvelope(env, row, reason = "authorization_revoked") {
  return await storage(env).update("bridge_relay_envelopes", row.id, {
    delivery_status: "cancelled",
    updated_at: now(),
    meta: { ...object(row.meta), cancelled_reason: reason },
  }) || row;
}

function connectIntentDeepLink(env, token) {
  return `${desktopProtocol(env)}://connect?intent=${encodeURIComponent(token)}&api=${encodeURIComponent(publicApiBase(env))}`;
}

export async function createDeviceWithToken(env, userId, input) {
  const store = storage(env);
  const installId = clean(input.install_id, 200);
  const existing = installId ? await reusableDeviceForInstall(env, userId, installId) : null;
  const patch = {
    device_name: clean(input.device_name, 120) || existing?.device_name || "Panda Bridge Desktop",
    status: "online",
    app_version: clean(input.app_version, 80) || existing?.app_version || null,
    capabilities: safeDeviceCapabilities(input.capabilities),
    local_state: safeLocalState(input.local_state),
    last_seen_at: now(),
    updated_at: now(),
  };
  const device = existing
    ? await store.update("bridge_devices", existing.id, patch)
    : await store.insert("bridge_devices", {
        ...await installIdentityPatch({}, installId),
        user_id: userId,
        ...patch,
        created_at: now(),
      });
  const { token, tokenExpiresAt } = await createDeviceToken(env, device.id);
  const replacement = await replaceOtherBridgeDevices(env, userId, device.id, "device.claim.replace");
  return { device, token, tokenExpiresAt, replacement };
}

export async function updateDeviceForIntent(env, device, token, input) {
  const installPatch = await installIdentityPatch(device, clean(input.install_id, 200));
  const next = await storage(env).update("bridge_devices", device.id, {
    ...installPatch,
    device_name: clean(input.device_name, 120) || device.device_name,
    status: "online",
    app_version: clean(input.app_version, 80) || device.app_version || null,
    capabilities: safeDeviceCapabilities(input.capabilities),
    local_state: safeLocalState(input.local_state),
    last_seen_at: now(),
    updated_at: now(),
  });
  const replacement = await replaceOtherBridgeDevices(env, device.user_id, device.id, "device.intent.replace");
  const refreshed = await createDeviceToken(env, device.id);
  return { device: next, token: refreshed.token || token, tokenExpiresAt: refreshed.tokenExpiresAt, replacement };
}

export async function replaceOtherBridgeDevices(env, userId, activeDeviceId, reason) {
  const store = storage(env);
  const replacedAt = now();
  const devices = await store.select("bridge_devices", { user_id: userId });
  const activeDevice = devices.find((item) => item.id === activeDeviceId) || null;
  const installHash = activeDevice?.install_id_hash || "";
  if (!installHash) return { devicesRevoked: 0, tokensRevoked: 0, authorizationsRevoked: 0, cancelledRelayEnvelopes: 0 };
  let devicesRevoked = 0;
  let tokensRevoked = 0;
  let authorizationsRevoked = 0;
  let cancelledRelayEnvelopes = 0;
  for (const device of devices.filter((item) => item.id !== activeDeviceId && item.status !== "revoked" && item.install_id_hash === installHash)) {
    await store.update("bridge_devices", device.id, {
      status: "revoked",
      updated_at: replacedAt,
    });
    devicesRevoked += 1;

    const tokens = await store.select("bridge_device_tokens", { device_id: device.id });
    for (const token of tokens.filter((item) => !item.revoked_at)) {
      await store.update("bridge_device_tokens", token.id, {
        revoked_at: replacedAt,
        last_used_at: token.last_used_at || replacedAt,
      });
      tokensRevoked += 1;
    }

    const authorizations = await store.select("bridge_authorizations", {
      user_id: userId,
      device_id: device.id,
    });
    for (const authorization of authorizations.filter((item) => item.status !== "revoked")) {
      const revokedResult = await updateAuthorizationWithEpoch(env, authorization, {
        status: "revoked",
        updated_at: replacedAt,
      }, {
        cause: reason,
        cancelDenial: { error: "product_not_authorized", reason: "device_replaced" },
      });
      authorizationsRevoked += 1;
      cancelledRelayEnvelopes += revokedResult.cancelledRelayEnvelopes || 0;
    }
    await notifyDeviceRoom(env, device.id, {
      type: "device.replaced",
      device_id: device.id,
      active_device_id: activeDeviceId,
      reason,
      sent_at: replacedAt,
    });
  }
  if (devicesRevoked > 0) {
    await audit(env, userId, activeDeviceId, null, reason, activeDeviceId, {
      revoked_devices: devicesRevoked,
      revoked_tokens: tokensRevoked,
      revoked_authorizations: authorizationsRevoked,
      cancelled_relay_envelopes: cancelledRelayEnvelopes,
    });
  }
  return { devicesRevoked, tokensRevoked, authorizationsRevoked, cancelledRelayEnvelopes };
}

export async function createDeviceToken(env, deviceId) {
  const token = randomToken(DEVICE_TOKEN_PREFIX);
  const tokenExpiresAt = new Date(Date.now() + DEVICE_TOKEN_TTL_MS).toISOString();
  await storage(env).insert("bridge_device_tokens", {
    device_id: deviceId,
    token_hash: await sha256Hex(token),
    scope: defaultDeviceTokenScope(),
    expires_at: tokenExpiresAt,
    last_used_at: now(),
    revoked_at: null,
    created_at: now(),
  });
  return { token, tokenExpiresAt };
}

export function defaultDeviceTokenScope() {
  return ["heartbeat", "relay:read", "relay:ack", "relay:write"];
}

export function deviceTokenRotationGraceMs(env) {
  const value = Number(env.BRIDGE_DEVICE_TOKEN_ROTATION_GRACE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEVICE_TOKEN_ROTATION_GRACE_MS;
}

export function sessionTtlMs(env) {
  return boundedInteger(env.BRIDGE_SESSION_TTL_MS, SESSION_TTL_MS, 1, SESSION_TTL_MS);
}

export function sessionLinkTtlMs(env) {
  return boundedInteger(env.BRIDGE_SESSION_LINK_TTL_MS, SESSION_LINK_TTL_MS, 1, SESSION_LINK_TTL_MS);
}

export function connectIntentTtlMs(env) {
  return boundedInteger(env.BRIDGE_CONNECT_INTENT_TTL_MS, CONNECT_INTENT_TTL_MS, 1, CONNECT_INTENT_TTL_MS);
}

export function pairingTtlMs(env) {
  return boundedInteger(env.BRIDGE_PAIRING_TOKEN_TTL_MS || env.BRIDGE_PAIRING_TTL_MS, PAIRING_TTL_MS, 1, PAIRING_TTL_MS);
}

export function authorizationImportProofTtlMs(env) {
  return boundedInteger(env.BRIDGE_AUTHORIZATION_IMPORT_PROOF_TTL_MS, AUTHORIZATION_IMPORT_PROOF_TTL_MS, 1000, 1000 * 60 * 30);
}

export async function audit(env, userId, deviceId, productId, action, targetId, payload) {
  return storage(env).insert("bridge_audit_log", {
    user_id: userId,
    device_id: deviceId,
    product_id: productId,
    action,
    target_id: targetId,
    payload: object(payload),
    created_at: now(),
  });
}
