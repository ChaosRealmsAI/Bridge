import { defaultServerCapabilityProductId } from "../products.js";
import { DEVICE_TOKEN_PREFIX, DEVICE_TOKEN_TTL_MS } from "./constants.js";
import { activeAuthorization, audit, connectIntentTtlMs, connectorInstallId, createDeviceWithToken, createSessionForUser, currentSession, defaultDeviceTokenScope, deviceTokenRotationGraceMs, installIdentityPatch, optionalConnector, ownedDevice, pairingTtlMs, requireConnector, requireSession, sessionLinkTtlMs, sessionTtlMs, updateAuthorizationWithEpoch, updateDeviceForIntent } from "./auth-common.js";
import { isNativeConnectIntentClaim, json, passwordAttemptConfig, passwordAttemptIdentifier, passwordLockedResponse, rejectProductOrigin, requireOfficialProduct, retryAfterMsForAttempt, sourceOrigin, withClearedSessionCookie, withSessionCookie, readJson } from "./http.js";
import { publicAccount, publicAuthorization, publicConnectIntent, publicDevice, publicSession, publicSessionLink, publicStateProduct, safeDeviceCapabilities, safeLocalState } from "./public-payloads.js";
import { normalizeAuthorizationPolicy, upsertAuthorization } from "./policy.js";
import { notifyDeviceRoom } from "./realtime.js";
import { alreadyAuthorizedConnectPayload, authorizedOfflineConnectPayload, bridgeStatePayload, connectIntentByToken, connectIntentDeepLink, publicAccountDevices, recoverableIntentTokenPatch } from "./state.js";
import { storage } from "./storage.js";
import { clean, hashPassword, normalizeEmail, now, object, randomPairingCode, randomToken, sha256Hex, verifyPassword } from "./utils.js";

export async function createPasswordSession(request, env) {
  const body = await readJson(request, env);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  if (!email || password.length < 8) return json({ error: "invalid_credentials" }, env, 400);
  const displayName = clean(body.display_name, 100) || email;
  const createAllowed = body.create !== false && String(body.mode || "").toLowerCase() !== "login";
  const limited = await passwordAttemptLimitResponse(env, email);
  if (limited) return limited;
  const store = storage(env);
  const existing = (await store.select("bridge_users", { email }))[0] || null;
  let user = existing;
  if (user) {
    if (!user.password_hash || !user.password_salt || !user.password_iterations) {
      return json({ error: "password_login_not_enabled" }, env, 403);
    }
    const ok = await verifyPassword(password, user.password_salt, user.password_iterations, user.password_hash);
    if (!ok) {
      const failure = await recordPasswordFailure(env, email);
      await audit(env, user.id, null, null, "session.password_failed", null, { email, locked: failure.locked });
      if (failure.locked) return passwordLockedResponse(env, failure.retryAfterMs);
      return json({ error: "invalid_credentials" }, env, 401);
    }
    await resetPasswordFailures(env, email);
  } else {
    if (!createAllowed) {
      const failure = await recordPasswordFailure(env, email);
      if (failure.locked) return passwordLockedResponse(env, failure.retryAfterMs);
      return json({ error: "invalid_credentials" }, env, 401);
    }
    const credential = await hashPassword(password);
    user = await store.insert("bridge_users", {
      display_name: displayName,
      email,
      password_hash: credential.hash,
      password_salt: credential.salt,
      password_iterations: credential.iterations,
      created_at: now(),
      updated_at: now(),
    });
  }
  const response = await createSessionForUser(env, user);
  await audit(env, user.id, null, null, "session.password", response.session.id, { email });
  return withSessionCookie(json({ authenticated: true, user: publicAccount(user), session: publicSession(response.session) }, env, 201), env, response.token);
}

export async function passwordAttemptLimitResponse(env, email) {
  const attempt = await passwordAttempt(env, email);
  const retryAfterMs = retryAfterMsForAttempt(attempt);
  return retryAfterMs > 0 ? passwordLockedResponse(env, retryAfterMs) : null;
}

export async function passwordAttempt(env, email) {
  return (await storage(env).select("bridge_password_attempts", { identifier: passwordAttemptIdentifier(email) }))[0] || null;
}

export async function recordPasswordFailure(env, email) {
  const config = passwordAttemptConfig(env);
  const existing = await passwordAttempt(env, email);
  const nowMs = Date.now();
  const timestamp = new Date(nowMs).toISOString();
  const lastFailedMs = Date.parse(existing?.last_failed_at || "");
  const withinWindow = Number.isFinite(lastFailedMs) && nowMs - lastFailedMs <= config.windowMs;
  const failedCount = withinWindow ? Number(existing?.failed_count || 0) + 1 : 1;
  const lockedUntil = failedCount >= config.maxFailedAttempts
    ? new Date(nowMs + config.lockMs).toISOString()
    : null;
  await storage(env).upsert("bridge_password_attempts", {
    identifier: passwordAttemptIdentifier(email),
    failed_count: failedCount,
    locked_until: lockedUntil,
    last_failed_at: timestamp,
    updated_at: timestamp,
  }, "identifier");
  return {
    failedCount,
    locked: Boolean(lockedUntil),
    retryAfterMs: lockedUntil ? Math.max(0, Date.parse(lockedUntil) - nowMs) : 0,
  };
}

export async function resetPasswordFailures(env, email) {
  const timestamp = now();
  await storage(env).upsert("bridge_password_attempts", {
    identifier: passwordAttemptIdentifier(email),
    failed_count: 0,
    locked_until: null,
    last_success_at: timestamp,
    updated_at: timestamp,
  }, "identifier");
}

export async function createGuestSession(request, env) {
  const body = await readJson(request, env);
  const displayName = clean(body.display_name, 100) || "Panda Account";
  const store = storage(env);
  const user = await store.insert("bridge_users", {
    display_name: displayName,
    created_at: now(),
  });
  const { token, session } = await createSessionForUser(env, user);
  return withSessionCookie(json({ authenticated: true, user: publicAccount(user), session: publicSession(session) }, env, 201), env, token);
}

export async function createSessionLink(request, env) {
  const session = await requireSession(request, env);
  const token = randomToken("pbl_");
  const row = await storage(env).insert("bridge_session_links", {
    user_id: session.user.id,
    token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + sessionLinkTtlMs(env)).toISOString(),
    consumed_at: null,
    created_at: now(),
  });
  await audit(env, session.user.id, null, null, "session_link.create", row.id, {});
  return json({
    token,
    join_url: `${webOrigin(env)}?join=${encodeURIComponent(token)}`,
    session_link: publicSessionLink(row),
    ttl_seconds: Math.trunc(sessionLinkTtlMs(env) / 1000),
  }, env, 201);
}

export async function joinSessionLink(request, env) {
  const body = await readJson(request, env);
  const tokenHash = await sha256Hex(String(body.token || ""));
  const store = storage(env);
  const link = (await store.select("bridge_session_links", { token_hash: tokenHash }))[0];
  if (!link || Date.parse(link.expires_at) < Date.now()) {
    return json({ error: "invalid_session_link" }, env, 400);
  }
  const user = (await store.select("bridge_users", { id: link.user_id }))[0];
  if (!user) return json({ error: "invalid_session_link" }, env, 400);
  const { token: sessionToken, session } = await createSessionForUser(env, user);
  if (!link.consumed_at) await store.update("bridge_session_links", link.id, { consumed_at: now() });
  await audit(env, user.id, null, null, "session_link.join", link.id, {});
  return withSessionCookie(json({ authenticated: true, user: publicAccount(user), session: publicSession(session) }, env, 201), env, sessionToken);
}

export async function logoutSession(request, env) {
  const session = await currentSession(request, env);
  if (session) {
    const expiresAt = new Date(Date.now() - 1000).toISOString();
    await storage(env).update("bridge_sessions", session.session.id, {
      expires_at: expiresAt,
    });
    await audit(env, session.user.id, null, null, "session.logout", session.session.id, {});
  }
  return withClearedSessionCookie(json({ ok: true, authenticated: false }, env), env);
}

export async function sessionResponse(request, env) {
  const session = await currentSession(request, env);
  if (!session) return json({ authenticated: false }, env, 401);
  return json({ authenticated: true, user: publicAccount(session.user), session: publicSession(session.session) }, env);
}

export async function listDevices(request, env) {
  const session = await requireSession(request, env);
  const rows = await storage(env).select("bridge_devices", { user_id: session.user.id }, { order: "last_seen_at", desc: true });
  return json({ items: rows.map((row) => publicDevice(row, env)) }, env);
}

export async function revokeDevice(request, env, deviceId) {
  const session = await requireSession(request, env);
  const device = await ownedDevice(env, session.user.id, deviceId);
  if (!device || device.status === "revoked") return json({ error: "device_not_found" }, env, 404);
  const revokedAt = now();
  const revoked = await storage(env).update("bridge_devices", device.id, {
    status: "revoked",
    updated_at: revokedAt,
  });
  const authorizations = await storage(env).select("bridge_authorizations", {
    user_id: session.user.id,
    device_id: device.id,
  });
  for (const authorization of authorizations.filter((item) => item.status !== "revoked")) {
    await updateAuthorizationWithEpoch(env, authorization, {
      status: "revoked",
      updated_at: revokedAt,
    }, {
      cause: "device_revoke",
      cancelDenial: { error: "product_not_authorized", reason: "device_revoked" },
    });
  }
  await audit(env, session.user.id, device.id, null, "device.revoke", device.id, {
    authorization_count: authorizations.length,
  });
  await notifyDeviceRoom(env, device.id, {
    type: "device.revoked",
    device: publicDevice(revoked, env),
    sent_at: revokedAt,
  });
  return json({ device: publicDevice(revoked, env) }, env);
}

export async function createPairingCode(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  const code = randomPairingCode();
  const ttlMs = pairingTtlMs(env);
  const row = await storage(env).insert("bridge_pairing_codes", {
    user_id: session.user.id,
    code_hash: await sha256Hex(code),
    device_name: clean(body.device_name, 120) || "Panda Bridge Desktop",
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
    consumed_at: null,
    created_at: now(),
  });
  return json({ code, pairing_code: { id: row.id, expires_at: row.expires_at }, ttl_seconds: Math.ceil(ttlMs / 1000) }, env, 201);
}

export async function createSelfhostPairingToken(request, env) {
  const guard = selfhostAdminGuard(request, env);
  if (guard) return guard;
  const body = await readJson(request, env);
  const user = await ensureSelfhostPairingUser(env, body);
  const token = randomPairingCode();
  const ttlMs = pairingTtlMs(env);
  const row = await storage(env).insert("bridge_pairing_codes", {
    user_id: user.id,
    code_hash: await sha256Hex(token),
    device_name: clean(body.device_name, 120) || "Panda Bridge Desktop",
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
    consumed_at: null,
    created_at: now(),
  });
  await audit(env, user.id, null, null, "selfhost.pairing_token.create", row.id, {
    ttl_ms: ttlMs,
  });
  return json({
    token,
    pairing_token: { id: row.id, expires_at: row.expires_at },
    ttl_seconds: Math.ceil(ttlMs / 1000),
  }, env, 201);
}

export async function ensureSelfhostPairingUser(env, body = {}) {
  const email = normalizeEmail(body.owner_email || body.email) || "selfhost@bridge.local";
  const displayName = clean(body.owner_name || body.display_name || body.displayName, 100) || "My Server";
  const store = storage(env);
  const existing = (await store.select("bridge_users", { email }))[0] || null;
  if (existing) {
    return await store.update("bridge_users", existing.id, {
      display_name: displayName,
      updated_at: now(),
    }) || existing;
  }
  try {
    return await store.insert("bridge_users", {
      display_name: displayName,
      email,
      created_at: now(),
      updated_at: now(),
    });
  } catch (error) {
    const row = (await store.select("bridge_users", { email }))[0] || null;
    if (row) return row;
    throw error;
  }
}

export function selfhostAdminGuard(request, env) {
  const expected = clean(env.BRIDGE_SELFHOST_ADMIN_TOKEN || env.BRIDGE_ADMIN_TOKEN, 500);
  if (!expected) return json({ error: "selfhost_admin_not_configured" }, env, 404);
  const actual = clean(
    request.headers.get("x-panda-bridge-selfhost-admin-token")
      || request.headers.get("x-panda-bridge-admin-token")
      || bearerToken(request),
    500,
  );
  if (actual !== expected) return json({ error: "selfhost_admin_required" }, env, 403);
  return null;
}

export function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export async function claimConnector(request, env) {
  const body = await readJson(request, env);
  const installId = connectorInstallId(request) || clean(body.install_id, 200);
  if (!installId) return json({ error: "install_id_required" }, env, 400);
  const codeHash = await sha256Hex(String(body.code || ""));
  const store = storage(env);
  const rows = await store.select("bridge_pairing_codes", { code_hash: codeHash });
  const pairing = rows[0];
  if (!pairing || pairing.consumed_at || Date.parse(pairing.expires_at) < Date.now()) {
    return json({ error: "invalid_pairing_code" }, env, 400);
  }
  const { device, token, tokenExpiresAt } = await createDeviceWithToken(env, pairing.user_id, {
    device_name: clean(body.device_name, 120) || pairing.device_name || "Panda Bridge Desktop",
    app_version: clean(body.app_version, 80) || null,
    capabilities: safeDeviceCapabilities(body.capabilities),
    local_state: safeLocalState(body.local_state),
    install_id: installId,
  });
  await store.update("bridge_pairing_codes", pairing.id, { consumed_at: now(), device_id: device.id });
  await audit(env, pairing.user_id, device.id, null, "device.claim", device.id, { app_version: body.app_version || null });
  return json({
    device: publicDevice(device, env),
    device_token: token,
    token_type: "Bearer",
    token_expires_at: tokenExpiresAt,
    install_identity_bound: Boolean(device.install_id_hash),
    devices: await publicAccountDevices(env, pairing.user_id, device.id),
  }, env, 201);
}

export async function createConnectIntent(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  const defaultProductId = defaultServerCapabilityProductId(env);
  const productId = clean(body.product_id || body.productId || defaultProductId, 80) || defaultProductId;
  const product = requireOfficialProduct(productId, env);
  const source_origin = sourceOrigin(env);
  const originError = rejectProductOrigin(product, source_origin, env);
  if (originError) return originError;
  const deviceName = clean(body.device_name || body.deviceName, 120) || "Panda Bridge Desktop";
  const policy = normalizeAuthorizationPolicy(
    object(body.permissions || body.permission || body.policy || product.default_policy),
    product,
    source_origin,
  );
  const installId = clean(body.install_id || body.installId, 200);
  const alreadyAuthorized = await alreadyAuthorizedConnectPayload(env, session.user, product, policy, installId);
  if (alreadyAuthorized) return json(alreadyAuthorized, env);
  const authorizedOffline = await authorizedOfflineConnectPayload(env, session.user, product, policy, installId);
  if (authorizedOffline) return json(authorizedOffline, env);
  const token = randomToken("pbi_");
  const tokenRecovery = await recoverableIntentTokenPatch(env, token);
  const row = await storage(env).insert("bridge_connect_intents", {
    ...tokenRecovery,
    user_id: session.user.id,
    device_id: null,
    product_id: productId,
    source_origin,
    device_name: deviceName,
    policy,
    token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + connectIntentTtlMs(env)).toISOString(),
    consumed_at: null,
    created_at: now(),
  });
  await audit(env, session.user.id, null, product.id, "connect_intent.create", row.id, { device_name: deviceName, source_origin, policy });
  return json({
    token,
    deep_link: connectIntentDeepLink(env, token),
    connect_intent: publicConnectIntent(row, session.user, env),
    account: publicAccount(session.user),
    product: publicStateProduct(product),
    ttl_seconds: Math.trunc(connectIntentTtlMs(env) / 1000),
  }, env, 201);
}

export async function getConnectIntent(request, env, token) {
  const intent = await connectIntentByToken(env, token);
  const tokenError = connectIntentTokenError(intent);
  if (tokenError) return json({ error: tokenError }, env, 400);
  const product = requireOfficialProduct(intent.product_id, env);
  const user = (await storage(env).select("bridge_users", { id: intent.user_id }))[0] || null;
  return json({
    deep_link: connectIntentDeepLink(env, token),
    connect_intent: publicConnectIntent(intent, user, env),
    account: publicAccount(user),
    product: publicStateProduct(product),
  }, env);
}

export function connectIntentTokenError(intent) {
  if (!intent) return "token_invalid";
  if (intent.consumed_at) return "token_already_claimed";
  if (Date.parse(intent.expires_at) < Date.now()) return "token_expired";
  return "";
}

export function connectIntentConfirmError(intent) {
  if (!intent) return "token_invalid";
  if (Date.parse(intent.expires_at) < Date.now()) return "token_expired";
  if (!intent.consumed_at || !intent.device_id) return "claim_required";
  return "";
}

export async function bridgeState(request, env) {
  const url = new URL(request.url);
  const defaultProductId = defaultServerCapabilityProductId(env);
  const productId = clean(url.searchParams.get("product_id") || url.searchParams.get("productId") || defaultProductId, 80) || defaultProductId;
  const product = requireOfficialProduct(productId, env);
  const originError = rejectProductOrigin(product, sourceOrigin(env), env);
  if (originError) return originError;
  const session = await currentSession(request, env);
  if (!session) {
    return json(await bridgeStatePayload(env, null, product, { noSession: true }), env);
  }
  return json(await bridgeStatePayload(env, session.user, product), env);
}

export async function claimConnectIntent(request, env, token) {
  const body = await readJson(request, env);
  if (!isNativeConnectIntentClaim(request)) {
    return json({ error: "desktop_claim_required" }, env, 403);
  }
  const store = storage(env);
  const intent = await connectIntentByToken(env, token);
  const tokenError = connectIntentTokenError(intent);
  if (tokenError) return json({ error: tokenError }, env, 400);
  const product = requireOfficialProduct(intent.product_id, env);
  const user = (await store.select("bridge_users", { id: intent.user_id }))[0] || null;
  const existingConnector = await optionalConnector(request, env);
  const reuseDevice = existingConnector?.device?.user_id === intent.user_id ? existingConnector : null;
  const installId = connectorInstallId(request) || clean(body.install_id, 200);
  if (!installId) return json({ error: "install_id_required" }, env, 400);
  const input = {
    device_name: clean(body.device_name, 120) || intent.device_name || "Panda Bridge Desktop",
    app_version: clean(body.app_version, 80) || null,
    capabilities: safeDeviceCapabilities(body.capabilities),
    local_state: safeLocalState(body.local_state),
    install_id: installId,
  };
  const { device, token: deviceToken, tokenExpiresAt } = reuseDevice
    ? await updateDeviceForIntent(env, reuseDevice.device, reuseDevice.raw_token, input)
    : await createDeviceWithToken(env, intent.user_id, input);
  const source_origin = clean(intent.source_origin, 300) || product.origin || sourceOrigin(env);
  const intentPolicy = object(intent.policy);
  const claimPolicy = object(body.policy);
  const policy = normalizeAuthorizationPolicy(
    Object.keys(intentPolicy).length ? intentPolicy : claimPolicy,
    product,
    source_origin,
  );
  const authorization = await upsertAuthorization(env, intent.user_id, device.id, product.id, policy, source_origin, { status: "pending" });
  await store.update("bridge_connect_intents", intent.id, { consumed_at: now(), device_id: device.id });
  await audit(env, intent.user_id, device.id, product.id, "connect_intent.claim", intent.id, { app_version: body.app_version || null, source_origin });
  return json({
    device: publicDevice(device, env),
    authorization: publicAuthorization(authorization, { includePolicy: true }),
    account: publicAccount(user),
    product,
    device_token: deviceToken,
    token_type: "Bearer",
    token_expires_at: tokenExpiresAt,
    install_identity_bound: Boolean(device.install_id_hash),
    devices: await publicAccountDevices(env, intent.user_id, device.id),
  }, env, 201);
}

export async function confirmConnectIntent(request, env, token) {
  if (!isNativeConnectIntentClaim(request)) {
    return json({ error: "desktop_claim_required" }, env, 403);
  }
  const connector = await requireConnector(request, env);
  const store = storage(env);
  const intent = await connectIntentByToken(env, token);
  const tokenError = connectIntentConfirmError(intent);
  if (tokenError) return json({ error: tokenError }, env, 400);
  if (intent.device_id !== connector.device.id) return json({ error: "connect_intent_device_mismatch" }, env, 403);
  if (connector.device.user_id !== intent.user_id) return json({ error: "connect_intent_account_mismatch" }, env, 403);
  const product = requireOfficialProduct(intent.product_id, env);
  const user = (await store.select("bridge_users", { id: intent.user_id }))[0] || null;
  const source_origin = clean(intent.source_origin, 300) || product.origin || sourceOrigin(env);
  const policy = normalizeAuthorizationPolicy(object(intent.policy), product, source_origin);
  const authorization = await upsertAuthorization(env, intent.user_id, connector.device.id, product.id, policy, source_origin, { status: "active" });
  await audit(env, intent.user_id, connector.device.id, product.id, "connect_intent.confirm", intent.id, { source_origin });
  return json({
    device: publicDevice(connector.device, env),
    authorization: publicAuthorization(authorization, { includePolicy: true }),
    account: publicAccount(user),
    product,
    install_identity_bound: Boolean(connector.device.install_id_hash),
    devices: await publicAccountDevices(env, intent.user_id, connector.device.id),
  }, env, 200);
}

export async function connectorHeartbeat(request, env) {
  const connector = await requireConnector(request, env);
  const body = await readJson(request, env);
  const installPatch = await installIdentityPatch(connector.device, connectorInstallId(request) || clean(body.install_id, 200));
  const patch = {
    ...installPatch,
    status: "online",
    app_version: clean(body.app_version, 80) || connector.device.app_version || null,
    capabilities: safeDeviceCapabilities(body.capabilities),
    local_state: safeLocalState(body.local_state),
    last_seen_at: now(),
    updated_at: now(),
  };
  const device = await storage(env).update("bridge_devices", connector.device.id, patch);
  return json({ ok: true, device: publicDevice(device, env), devices: await publicAccountDevices(env, device.user_id, device.id) }, env);
}

export async function rotateConnectorToken(request, env) {
  const connector = await requireConnector(request, env);
  const body = await readJson(request, env);
  const store = storage(env);
  const issuedAt = now();
  const installPatch = await installIdentityPatch(connector.device, connectorInstallId(request) || clean(body.install_id, 200));
  const tokenExpiresAt = new Date(Date.now() + DEVICE_TOKEN_TTL_MS).toISOString();
  const oldTokenExpiresAt = new Date(Date.now() + deviceTokenRotationGraceMs(env)).toISOString();
  const nextToken = randomToken(DEVICE_TOKEN_PREFIX);
  const tokenRow = await store.insert("bridge_device_tokens", {
    device_id: connector.device.id,
    token_hash: await sha256Hex(nextToken),
    scope: connector.token.scope || defaultDeviceTokenScope(),
    expires_at: tokenExpiresAt,
    last_used_at: issuedAt,
    revoked_at: null,
    created_at: issuedAt,
  });
  await store.update("bridge_device_tokens", connector.token.id, {
    expires_at: oldTokenExpiresAt,
    last_used_at: issuedAt,
  });
  const device = await store.update("bridge_devices", connector.device.id, {
    ...installPatch,
    status: "online",
    app_version: clean(body.app_version, 80) || connector.device.app_version || null,
    capabilities: Object.keys(object(body.capabilities)).length ? safeDeviceCapabilities(body.capabilities) : safeDeviceCapabilities(connector.device.capabilities),
    local_state: object(body.local_state).platform ? safeLocalState(body.local_state) : safeLocalState(connector.device.local_state),
    last_seen_at: issuedAt,
    updated_at: issuedAt,
  });
  await audit(env, connector.device.user_id, connector.device.id, null, "device_token.rotate", tokenRow.id, {
    old_token_expires_at: oldTokenExpiresAt,
    new_token_expires_at: tokenExpiresAt,
  });
  return json({
    ok: true,
    device: publicDevice(device, env),
    device_token: nextToken,
    token_type: "Bearer",
    token_expires_at: tokenExpiresAt,
    old_token_expires_at: oldTokenExpiresAt,
    install_identity_bound: Boolean(device.install_id_hash),
  }, env);
}
