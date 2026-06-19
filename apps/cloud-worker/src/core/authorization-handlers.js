import { activeAuthorization, audit, authorizationForProduct, authorizationImportProofTtlMs, authorizationJobDenial, authorizationRowsForProduct, resolveDelegatedAuthorizationDevice, resolveDelegatedBridgeUserId, resolveSessionAuthorizationDevice, requireConnector, requireSession, updateAuthorizationStatus, updateAuthorizationWithEpoch, ownedDevice } from "./auth-common.js";
import { canonicalProductOrigin, json, readJson, readJsonText, rejectProductOrigin, requireOfficialProduct, sourceOrigin } from "./http.js";
import { consumeAuthorizationImportProof, normalizeAuthorizationPolicy } from "./policy.js";
import { deviceRelayKeyExchange, normalizeRelayKeyBootstrap, plaintextRelayKeyFields, publicAccount, publicAuthorization, publicDevice, publicRelayKeyBootstrap, publicStateDevice, publicStateProduct, updateAuthorizationRelayKeyBootstrap } from "./public-payloads.js";
import { notifyDeviceRoom } from "./realtime.js";
import { bridgeStatePayload, connectIntentByToken, connectIntentDeepLink, publicAccountDevices, recoverableIntentTokenPatch, alreadyAuthorizedConnectPayload, authorizedOfflineConnectPayload } from "./state.js";
import { storage } from "./storage.js";
import { boundedInteger, clean, constantTimeEqual, hmacSha256Hex, httpError, now, object, randomToken, sha256Hex } from "./utils.js";
import { parseJsonText } from "./http.js";

export async function productAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const originError = rejectProductOrigin(product, sourceOrigin(env), env);
  if (originError) return originError;
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const deviceId = url.searchParams.get("device_id") || "";
  const authorization = await authorizationForProduct(env, session.user.id, deviceId, product.id);
  return json({ authorization: publicAuthorization(authorization, { includePolicy: true }), product: publicStateProduct(product) }, env);
}

export async function requestAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const originError = rejectProductOrigin(product, sourceOrigin(env), env);
  if (originError) return originError;
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  const device = await ownedDevice(env, session.user.id, String(body.device_id || ""));
  if (!device) return json({ error: "device_not_found" }, env, 404);
  const authorization = await authorizationForProduct(env, session.user.id, device.id, product.id);
  if (authorization?.status === "active" || authorization?.status === "paused") {
    return json({ authorization: publicAuthorization(authorization), product: publicStateProduct(product) }, env);
  }
  await audit(env, session.user.id, device.id, product.id, "authorization.desktop_required", device.id, { source_origin: sourceOrigin(env) });
  return json({ error: "desktop_authorization_required", authorization: publicAuthorization(authorization), product: publicStateProduct(product) }, env, 403);
}

export async function createAuthorizationImportProof(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const originError = rejectProductOrigin(product, sourceOrigin(env), env);
  if (originError) return originError;
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  const device = await ownedDevice(env, session.user.id, String(body.device_id || ""));
  if (!device || device.status === "revoked") return json({ error: "device_not_found" }, env, 404);
  const authorization = await authorizationForProduct(env, session.user.id, device.id, product.id);
  const denial = authorizationJobDenial(authorization);
  if (denial) return json({ error: denial.error }, env, 403);
  const token = randomToken("pbip_");
  const expiresAt = new Date(Date.now() + authorizationImportProofTtlMs(env)).toISOString();
  await storage(env).insert("bridge_authorization_import_proofs", {
    token_hash: await sha256Hex(token),
    user_id: session.user.id,
    device_id: device.id,
    product_id: product.id,
    authorization_id: authorization.id,
    source_origin: sourceOrigin(env),
    expires_at: expiresAt,
    consumed_at: null,
    created_at: now(),
  });
  await audit(env, session.user.id, device.id, product.id, "authorization.import_proof.create", authorization.id, { source_origin: sourceOrigin(env) });
  return json({
    proof: { token, expires_at: expiresAt },
    authorization: publicAuthorization(authorization),
    device: publicDevice(device, env),
    product: publicStateProduct(product),
  }, env, 201);
}

export async function updateAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const originError = rejectProductOrigin(product, sourceOrigin(env), env);
  if (originError) return originError;
  const session = await requireSession(request, env);
  const resolved = await resolveSessionAuthorizationDevice(request, env, product, session);
  if (resolved.error) return json({ error: resolved.error }, env, resolved.status);
  const device = resolved.device;
  const body = await readJson(request, env);
  const result = await updateAuthorizationStatus(env, {
    userId: session.user.id,
    deviceId: device.id,
    product,
    status: clean(body.status, 40),
    sourceOrigin: sourceOrigin(env),
    auditActionPrefix: "authorization",
  });
  if (result.error) return json({ error: result.error }, env, result.status || 400);
  return json({
    authorization: publicAuthorization(result.authorization),
    product: publicStateProduct(product),
    cancelled_relay_envelopes: result.cancelledRelayEnvelopes || 0,
  }, env);
}

export async function revokeAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const originError = rejectProductOrigin(product, sourceOrigin(env), env);
  if (originError) return originError;
  const session = await requireSession(request, env);
  const resolved = await resolveSessionAuthorizationDevice(request, env, product, session);
  if (resolved.error) return json({ error: resolved.error }, env, resolved.status);
  const device = resolved.device;
  const authorization = (await storage(env).select("bridge_authorizations", {
    user_id: session.user.id,
    device_id: device.id,
    product_id: product.id,
  }))[0];
  if (!authorization) return json({ authorization: null, product: publicStateProduct(product) }, env);
  const revokedResult = await updateAuthorizationWithEpoch(env, authorization, {
    status: "revoked",
    updated_at: now(),
  }, {
    cause: "revoke",
    cancelDenial: { error: "authorization_revoked", reason: "authorization_revoked" },
  });
  const revoked = revokedResult.authorization;
  const cancelled_relay_envelopes = revokedResult.cancelledRelayEnvelopes || 0;
  await audit(env, session.user.id, device.id, product.id, "authorization.revoke", authorization.id, { source_origin: sourceOrigin(env) });
  return json({ authorization: publicAuthorization(revoked), product: publicStateProduct(product), cancelled_relay_envelopes }, env);
}

export async function createProductRelayKeyBootstrap(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const source_origin = sourceOrigin(env);
  const originError = rejectProductOrigin(product, source_origin, env);
  if (originError) return originError;
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  const deviceId = clean(body.device_id || body.deviceId, 120);
  if (!deviceId) return json({ error: "device_id_required" }, env, 400);
  const device = await ownedDevice(env, session.user.id, deviceId);
  if (!device) return json({ error: "device_not_found" }, env, 404);
  const authorization = await activeAuthorization(env, session.user.id, device.id, product.id);
  if (!authorization) return json({ error: "product_not_authorized" }, env, 403);
  const exchange = deviceRelayKeyExchange(device, product.id);
  if (!exchange) return json({ error: "relay_key_exchange_missing" }, env, 409);
  const plaintextFields = plaintextRelayKeyFields(body);
  if (plaintextFields.length) {
    const error = httpError("plaintext_relay_key_forbidden", 400);
    error.public = { plaintext_fields: plaintextFields };
    throw error;
  }
  const bootstrap = normalizeRelayKeyBootstrap(body.relay_key_bootstrap || body.bootstrap || body, {
    productId: product.id,
    deviceId: device.id,
    authorization,
    exchange,
  });
  const updated = await updateAuthorizationRelayKeyBootstrap(env, authorization, bootstrap);
  await audit(env, session.user.id, device.id, product.id, "relay_key.bootstrap", updated.id || authorization.id, {
    algorithm: bootstrap.algorithm,
    key_id: bootstrap.key_id,
    authorization_epoch: bootstrap.authorization_epoch,
  });
  await notifyDeviceRoom(env, device.id, {
    type: "relay_key.bootstrap",
    product_id: product.id,
    device_id: device.id,
    authorization_epoch: bootstrap.authorization_epoch,
    sent_at: now(),
  });
  return json({
    ok: true,
    product: publicStateProduct(product),
    device: publicStateDevice(device, env, product.id),
    authorization: publicAuthorization(updated),
    relay_key_bootstrap: publicRelayKeyBootstrap(updated),
  }, env, 201);
}

export async function createDelegatedProductRelayKeyBootstrap(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const rawBody = await readJsonText(request, env);
  const delegation = await requireProductDelegation(request, env, product, rawBody);
  const body = rawBody ? parseJsonText(rawBody) : {};
  const deviceId = clean(body.device_id || body.deviceId || delegation.deviceId, 120);
  if (!deviceId) return json({ error: "device_id_required" }, env, 400);
  if (deviceId !== delegation.deviceId) return json({ error: "delegated_device_mismatch" }, env, 403);
  const device = await ownedDevice(env, delegation.bridgeUserId, deviceId);
  if (!device || device.status === "revoked") return json({ error: "device_not_found" }, env, 404);
  const authorization = await activeAuthorization(env, delegation.bridgeUserId, device.id, product.id);
  if (!authorization) return json({ error: "product_not_authorized" }, env, 403);
  const exchange = deviceRelayKeyExchange(device, product.id);
  if (!exchange) return json({ error: "relay_key_exchange_missing" }, env, 409);
  const plaintextFields = plaintextRelayKeyFields(body);
  if (plaintextFields.length) {
    const error = httpError("plaintext_relay_key_forbidden", 400);
    error.public = { plaintext_fields: plaintextFields };
    throw error;
  }
  const bootstrap = normalizeRelayKeyBootstrap(body.relay_key_bootstrap || body.bootstrap || body, {
    productId: product.id,
    deviceId: device.id,
    authorization,
    exchange,
  });
  const updated = await updateAuthorizationRelayKeyBootstrap(env, authorization, bootstrap);
  await audit(env, delegation.bridgeUserId, device.id, product.id, "relay_key.bootstrap.delegated", updated.id || authorization.id, {
    algorithm: bootstrap.algorithm,
    key_id: bootstrap.key_id,
    authorization_epoch: bootstrap.authorization_epoch,
    source_origin: delegation.sourceOrigin,
  });
  await notifyDeviceRoom(env, device.id, {
    type: "relay_key.bootstrap",
    product_id: product.id,
    device_id: device.id,
    authorization_epoch: bootstrap.authorization_epoch,
    sent_at: now(),
  });
  return json({
    ok: true,
    product: publicStateProduct(product),
    device: publicStateDevice(device, env, product.id),
    authorization: publicAuthorization(updated),
    relay_key_bootstrap: publicRelayKeyBootstrap(updated),
  }, env, 201);
}

export async function updateConnectorAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const connector = await requireConnector(request, env);
  const body = await readJson(request, env);
  const result = await updateAuthorizationStatus(env, {
    userId: connector.device.user_id,
    deviceId: connector.device.id,
    product,
    status: clean(body.status, 40),
    sourceOrigin: sourceOrigin(env),
    auditActionPrefix: "authorization.connector",
  });
  if (result.error) return json({ error: result.error }, env, result.status || 400);
  return json({
    authorization: publicAuthorization(result.authorization),
    product: publicStateProduct(product),
    cancelled_relay_envelopes: result.cancelledRelayEnvelopes || 0,
  }, env);
}

export async function revokeConnectorAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const connector = await requireConnector(request, env);
  const authorization = (await storage(env).select("bridge_authorizations", {
    user_id: connector.device.user_id,
    device_id: connector.device.id,
    product_id: product.id,
  }))[0];
  if (!authorization) return json({ authorization: null, product: publicStateProduct(product), cancelled_relay_envelopes: 0 }, env);
  const revokedResult = await updateAuthorizationWithEpoch(env, authorization, {
    status: "revoked",
    updated_at: now(),
  }, {
    cause: "revoke.connector",
    cancelDenial: { error: "authorization_revoked", reason: "authorization_revoked" },
  });
  const revoked = revokedResult.authorization;
  const cancelled_relay_envelopes = revokedResult.cancelledRelayEnvelopes || 0;
  await audit(env, connector.device.user_id, connector.device.id, product.id, "authorization.revoke.connector", authorization.id, {
    source_origin: sourceOrigin(env),
  });
  return json({ authorization: publicAuthorization(revoked), product: publicStateProduct(product), cancelled_relay_envelopes }, env);
}

export async function connectorRelayKeyBootstrap(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const connector = await requireConnector(request, env);
  const authorization = await activeAuthorization(env, connector.device.user_id, connector.device.id, product.id);
  if (!authorization) {
    return json({
      ok: true,
      product: publicStateProduct(product),
      authorization: null,
      relay_key_bootstrap: { status: "missing", reason: "product_not_authorized" },
    }, env);
  }
  const bootstrap = publicRelayKeyBootstrap(authorization, { includeWrapped: true });
  return json({
    ok: true,
    product: publicStateProduct(product),
    authorization: publicAuthorization(authorization),
    relay_key_bootstrap: bootstrap || { status: "missing" },
  }, env);
}

export async function delegatedProductAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const delegation = await requireProductDelegation(request, env, product, "");
  const url = new URL(request.url);
  const deviceId = clean(url.searchParams.get("device_id"), 120);
  if (deviceId !== delegation.deviceId) return json({ error: "delegated_device_mismatch" }, env, 403);
  const device = await ownedDevice(env, delegation.bridgeUserId, deviceId);
  if (!device || device.status === "revoked") return json({ error: "device_not_found" }, env, 404);
  const authorization = await authorizationForProduct(env, delegation.bridgeUserId, device.id, product.id);
  return json({ authorization: publicAuthorization(authorization), device: publicDevice(device, env), product: publicStateProduct(product) }, env);
}

export async function delegatedProductStatus(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const delegation = await requireProductDelegation(request, env, product, "");
  const devices = (await storage(env).select("bridge_devices", {
    user_id: delegation.bridgeUserId,
  }, { order: "last_seen_at", desc: true })).filter((device) => device.status !== "revoked");
  const authorizations = await authorizationRowsForProduct(env, delegation.bridgeUserId, product.id);
  const activeByDevice = new Map(authorizations.filter((authorization) => authorization.status === "active").map((authorization) => [authorization.device_id, authorization]));
  const authorizedDevices = devices.filter((device) => activeByDevice.has(device.id));
  const selectedDevice = authorizedDevices.find((device) => isDeviceOnline(device, env))
    || authorizedDevices[0]
    || null;
  const selectedAuthorization = selectedDevice ? activeByDevice.get(selectedDevice.id) || null : null;
  return json({
    product: publicStateProduct(product),
    devices: devices.map((device) => publicDevice(device, env)),
    authorized_devices: authorizedDevices.map((device) => publicDevice(device, env)),
    authorizations: authorizations.map((authorization) => publicAuthorization(authorization)),
    selected_device: publicDevice(selectedDevice, env),
    authorization: publicAuthorization(selectedAuthorization, { includePolicy: true }),
    ready: Boolean(selectedDevice && selectedAuthorization && isDeviceOnline(selectedDevice, env)),
  }, env);
}

export async function delegatedBridgeState(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const delegation = await requireProductDelegation(request, env, product, "");
  const user = (await storage(env).select("bridge_users", { id: delegation.bridgeUserId }))[0] || {
    id: delegation.bridgeUserId,
    display_name: "Panda Account",
  };
  return json(await bridgeStatePayload(env, user, product), env);
}

export async function createDelegatedConnectIntent(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const rawBody = await readJsonText(request, env);
  const delegation = await requireProductDelegation(request, env, product, rawBody);
  const body = rawBody ? parseJsonText(rawBody) : {};
  const user = await ensureDelegatedUser(env, product.id, delegation.userId, object(body.account || body.user));
  const deviceName = clean(body.device_name || body.deviceName, 120) || "Panda Bridge Desktop";
  const policy = normalizeAuthorizationPolicy(
    object(body.permissions || body.permission || body.policy || product.default_policy),
    product,
    delegation.sourceOrigin,
  );
  const installId = clean(body.install_id || body.installId, 200);
  const alreadyAuthorized = await alreadyAuthorizedConnectPayload(env, user, product, policy, installId);
  if (alreadyAuthorized) return json(alreadyAuthorized, env);
  const authorizedOffline = await authorizedOfflineConnectPayload(env, user, product, policy, installId);
  if (authorizedOffline) return json(authorizedOffline, env);
  const token = randomToken("pbi_");
  const tokenRecovery = await recoverableIntentTokenPatch(env, token);
  const row = await storage(env).insert("bridge_connect_intents", {
    ...tokenRecovery,
    user_id: user.id,
    device_id: null,
    product_id: product.id,
    source_origin: delegation.sourceOrigin,
    device_name: deviceName,
    policy,
    token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + connectIntentTtlMs(env)).toISOString(),
    consumed_at: null,
    created_at: now(),
  });
  await audit(env, user.id, null, product.id, "connect_intent.create.delegated", row.id, {
    device_name: deviceName,
    source_origin: delegation.sourceOrigin,
    policy,
  });
  return json({
    token,
    deep_link: connectIntentDeepLink(env, token),
    connect_intent: publicConnectIntent(row, user, env),
    account: publicAccount(user),
    product: publicStateProduct(product),
    ttl_seconds: Math.trunc(connectIntentTtlMs(env) / 1000),
  }, env, 201);
}

export async function getDelegatedConnectIntent(request, env, productId, token) {
  const product = requireOfficialProduct(productId, env);
  const delegation = await requireProductDelegation(request, env, product, "");
  const intent = await connectIntentByToken(env, token);
  if (!intent || intent.product_id !== product.id || intent.user_id !== delegation.bridgeUserId) {
    return json({ error: "connect_intent_not_found" }, env, 404);
  }
  if (!intent.consumed_at && Date.parse(intent.expires_at) < Date.now()) {
    return json({ error: "invalid_connect_intent" }, env, 400);
  }
  const user = (await storage(env).select("bridge_users", { id: intent.user_id }))[0] || null;
  const device = intent.device_id
    ? (await storage(env).select("bridge_devices", { id: intent.device_id, user_id: intent.user_id }))[0] || null
    : null;
  const authorization = device ? await authorizationForProduct(env, intent.user_id, device.id, product.id) : null;
  return json({
    deep_link: connectIntentDeepLink(env, token),
    connect_intent: publicConnectIntent(intent, user, env),
    account: publicAccount(user),
    device: publicDevice(device, env),
    authorization: publicAuthorization(authorization),
    product: publicStateProduct(product),
  }, env);
}

export async function claimDelegatedProductAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const rawBody = await readJsonText(request, env);
  const delegation = await requireProductDelegation(request, env, product, rawBody);
  const body = rawBody ? parseJsonText(rawBody) : {};
  const proofToken = clean(body.proof_token || body.authorization_proof || body.token, 4096);
  if (!proofToken) return json({ error: "authorization_import_proof_required" }, env, 400);
  const proofHash = await sha256Hex(proofToken);
  const proof = (await storage(env).select("bridge_authorization_import_proofs", {
    product_id: product.id,
    token_hash: proofHash,
  }))[0];
  if (!proof || proof.consumed_at || Date.parse(proof.expires_at) <= Date.now()) {
    return json({ error: "invalid_authorization_import_proof" }, env, 409);
  }
  if (proof.user_id !== delegation.bridgeUserId || proof.device_id !== delegation.deviceId) {
    return json({ error: "delegated_authorization_proof_mismatch" }, env, 403);
  }
  const consumedProof = await consumeAuthorizationImportProof(env, proof);
  if (!consumedProof) return json({ error: "invalid_authorization_import_proof" }, env, 409);
  const device = await ownedDevice(env, delegation.bridgeUserId, delegation.deviceId);
  if (!device || device.status === "revoked") return json({ error: "device_not_found" }, env, 404);
  const authorization = await activeAuthorization(env, delegation.bridgeUserId, device.id, product.id);
  if (!authorization || authorization.id !== proof.authorization_id) return json({ error: "product_not_authorized" }, env, 403);
  await audit(env, delegation.bridgeUserId, device.id, product.id, "authorization.claim.delegated", authorization.id, { source_origin: delegation.sourceOrigin });
  return json({
    authorization: publicAuthorization(authorization),
    device: publicDevice(device, env),
    product: publicStateProduct(product),
    proof: { consumed_at: consumedProof.consumed_at },
  }, env);
}

export async function updateDelegatedProductAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const rawBody = await readJsonText(request, env);
  const delegation = await requireProductDelegation(request, env, product, rawBody);
  const body = rawBody ? parseJsonText(rawBody) : {};
  const resolved = await resolveDelegatedAuthorizationDevice(request, env, product, delegation);
  if (resolved.error) return json({ error: resolved.error }, env, resolved.status);
  const device = resolved.device;
  const result = await updateAuthorizationStatus(env, {
    userId: delegation.bridgeUserId,
    deviceId: device.id,
    product,
    status: clean(body.status, 40),
    sourceOrigin: delegation.sourceOrigin,
    auditActionPrefix: "authorization.delegated",
  });
  if (result.error) return json({ error: result.error }, env, result.status || 400);
  return json({
    authorization: publicAuthorization(result.authorization),
    device: publicDevice(device, env),
    product: publicStateProduct(product),
    cancelled_relay_envelopes: result.cancelledRelayEnvelopes || 0,
  }, env);
}

export async function revokeDelegatedProductAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const rawBody = await readJsonText(request, env);
  const delegation = await requireProductDelegation(request, env, product, rawBody);
  const resolved = await resolveDelegatedAuthorizationDevice(request, env, product, delegation);
  if (resolved.error) return json({ error: resolved.error }, env, resolved.status);
  const device = resolved.device;
  const authorization = (await storage(env).select("bridge_authorizations", {
    user_id: delegation.bridgeUserId,
    device_id: device.id,
    product_id: product.id,
  }))[0];
  if (!authorization) return json({ authorization: null, device: publicDevice(device, env), product: publicStateProduct(product), cancelled_relay_envelopes: 0 }, env);
  const revokedResult = await updateAuthorizationWithEpoch(env, authorization, {
    status: "revoked",
    updated_at: now(),
  }, {
    cause: "revoke.delegated",
    cancelDenial: { error: "authorization_revoked", reason: "authorization_revoked" },
  });
  const revoked = revokedResult.authorization;
  const cancelled_relay_envelopes = revokedResult.cancelledRelayEnvelopes || 0;
  await audit(env, delegation.bridgeUserId, device.id, product.id, "authorization.revoke.delegated", authorization.id, {
    source_origin: delegation.sourceOrigin,
  });
  return json({ authorization: publicAuthorization(revoked), device: publicDevice(device, env), product: publicStateProduct(product), cancelled_relay_envelopes }, env);
}

export async function requireProductDelegation(request, env, product, rawBody) {
  const secret = productDelegationSecret(env, product.id);
  if (!secret) throw httpError("product_delegation_not_configured", 503);
  const productId = clean(request.headers.get("x-panda-bridge-product-id"), 80);
  const userId = clean(request.headers.get("x-panda-bridge-user-id"), 120);
  const deviceId = clean(request.headers.get("x-panda-bridge-device-id"), 120);
  const timestamp = clean(request.headers.get("x-panda-bridge-request-timestamp"), 80);
  const nonce = clean(request.headers.get("x-panda-bridge-request-nonce"), 120);
  const bodyHash = clean(request.headers.get("x-panda-bridge-body-sha256"), 80);
  const signature = clean(request.headers.get("x-panda-bridge-signature"), 160);
  if (productId !== product.id || !userId || !deviceId || !timestamp || !nonce || !bodyHash || !signature) {
    throw httpError("product_delegation_unauthorized", 401);
  }
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > productDelegationSkewMs(env)) {
    throw httpError("product_delegation_timestamp_invalid", 401);
  }
  const actualBodyHash = await sha256Hex(rawBody || "");
  if (!constantTimeEqual(bodyHash, actualBodyHash)) throw httpError("product_delegation_body_hash_invalid", 401);
  const url = new URL(request.url);
  const signedPath = `${url.pathname}${url.search || ""}`;
  const signingPayload = [
    request.method.toUpperCase(),
    signedPath,
    product.id,
    userId,
    deviceId,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  const expected = await hmacSha256Hex(secret, signingPayload);
  if (!constantTimeEqual(signature, expected)) throw httpError("product_delegation_signature_invalid", 401);
  if (!await reserveProductDelegationNonce(env, product.id, nonce, timestamp)) {
    throw httpError("product_delegation_replay", 401);
  }
  const bridgeUserId = await resolveDelegatedBridgeUserId(env, product.id, userId, deviceId);
  return { userId, bridgeUserId, deviceId, nonce, sourceOrigin: canonicalProductOrigin(product, env) };
}

export function productDelegationSecret(env, productId) {
  const envKey = productDelegationSecretEnvKey(productId);
  if (envKey && env[envKey]) {
    return clean(env[envKey], 4096);
  }
  const raw = clean(env.BRIDGE_PRODUCT_DELEGATION_SECRETS, 20000);
  if (!raw) return "";
  try {
    const map = JSON.parse(raw);
    return clean(map?.[productId], 4096);
  } catch {
    return "";
  }
}

export function productDelegationSecretEnvKey(productId) {
  const normalized = clean(productId, 200)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized ? `BRIDGE_${normalized}_DELEGATION_SECRET` : "";
}

export function productDelegationSkewMs(env) {
  return boundedInteger(env.BRIDGE_PRODUCT_DELEGATION_SKEW_MS, 1000 * 60 * 5, 1000, 1000 * 60 * 30);
}

export async function reserveProductDelegationNonce(env, productId, nonce, timestamp) {
  const nonceHash = await sha256Hex(`${productId}:${nonce}`);
  const store = storage(env);
  if (typeof store.deleteExpired === "function") {
    await store.deleteExpired("bridge_product_delegation_nonces", "expires_at");
  }
  try {
    await store.insert("bridge_product_delegation_nonces", {
      product_id: productId,
      nonce_hash: nonceHash,
      request_timestamp: timestamp,
      expires_at: new Date(Date.now() + productDelegationSkewMs(env)).toISOString(),
      created_at: now(),
    });
    return true;
  } catch (error) {
    if (error?.code === "product_delegation_replay") return false;
    throw httpError("product_delegation_nonce_store_failed", 503);
  }
}
