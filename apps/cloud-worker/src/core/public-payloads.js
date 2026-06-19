import { DEVICE_ONLINE_GRACE_MS } from "./constants.js";
import { storage } from "./storage.js";
import { productInfo } from "./http.js";
import { authorizationEpoch, clean, decodeBase64Text, httpError, now, object } from "./utils.js";

export function publicAuthorization(authorization, options = {}) {
  if (!authorization) return null;
  const payload = {
    id: authorization.id,
    device_id: authorization.device_id,
    product_id: authorization.product_id,
    status: authorization.status,
    epoch: authorizationEpoch(authorization),
    source_origin: authorization.source_origin || null,
    authorized_at: authorization.created_at || authorization.updated_at || null,
    created_at: authorization.created_at || null,
    updated_at: authorization.updated_at || null,
  };
  const bootstrap = publicRelayKeyBootstrap(authorization);
  if (bootstrap) payload.relay_key_bootstrap = bootstrap;
  if (options.includePolicy) payload.policy = publicAuthorizationPolicy(authorization.policy);
  return payload;
}

export function publicAuthorizationPolicy(policy) {
  const payload = structuredClone(object(policy));
  delete payload._relay_key_bootstrap;
  return payload;
}

export function publicStateProduct(product) {
  return product ? {
    id: product.id,
    name: product.name,
    origin: product.origin || product.official_origin || null,
    official_origin: product.official_origin || null,
    official_origins: [...(product.official_origins || [])],
    web_url: product.web_url || product.official_origin || null,
    capabilities: [...(product.capabilities || [])],
    default_policy: object(product.default_policy),
    requires_desktop_authorization: product.requires_desktop_authorization !== false,
  } : null;
}

export function publicBridgeStateDevices(devices, currentDevice, env, authorizations = [], productId = "") {
  const authorizationByDeviceId = new Map(
    authorizations
      .filter((authorization) => authorization?.status !== "revoked")
      .map((authorization) => [authorization.device_id, authorization]),
  );
  return devices.map((device) => {
    const authorization = authorizationByDeviceId.get(device.id) || null;
    return {
      ...publicStateDevice(device, env, productId || authorization?.product_id || ""),
      current: Boolean(currentDevice && currentDevice.id === device.id),
      ...(authorization ? { authorization: publicAuthorization(authorization, { includePolicy: true }) } : {}),
    };
  });
}

export function publicStateDevice(device, env, productId = "") {
  if (!device) return null;
  const localState = safeLocalState(device.local_state);
  const payload = {
    id: device.id,
    name: device.device_name,
    status: publicDeviceStatus(device, env),
    online: isDeviceOnline(device, env),
    last_seen_at: device.last_seen_at || null,
  };
  if (localState.device_info) payload.device_info = localState.device_info;
  const exchange = deviceRelayKeyExchange(device, productId);
  if (exchange) payload.relay_key_exchange = exchange;
  return payload;
}

export function publicDevice(device, env = {}) {
  const localState = safeLocalState(device?.local_state);
  return device ? {
    id: device.id,
    device_name: device.device_name,
    status: publicDeviceStatus(device, env),
    app_version: device.app_version,
    capabilities: safeDeviceCapabilities(device.capabilities),
    local_state: localState,
    ...(localState.device_info ? { device_info: localState.device_info } : {}),
    last_seen_at: device.last_seen_at,
    created_at: device.created_at,
    updated_at: device.updated_at,
  } : null;
}

export function safeDeviceCapabilities(input = {}) {
  const value = object(input);
  const requestedRelay = Array.isArray(value.relay)
    ? value.relay.map((item) => clean(item, 80)).filter((item) => item === "relay.envelope" || item === "relay.ack")
    : [];
  const relay = requestedRelay.length ? requestedRelay : ["relay.envelope", "relay.ack"];
  const adapter = object(value.adapter_router || value.adapterRouter);
  return {
    relay,
    adapter_router: {
      mode: clean(adapter.mode, 80) || "external_http",
    },
  };
}

export function safeLocalState(input = {}) {
  const value = object(input);
  const relay = object(value.relay);
  const adapter = object(value.adapter_router || value.adapterRouter);
  const relayKeyExchange = normalizeRelayKeyExchange(value.relay_key_exchange || value.relayKeyExchange);
  const products = safeAdapterProducts(adapter.products);
  const deviceInfo = safeDeviceInfo(value.device_info || value.deviceInfo);
  const out = {
    relay: {
      envelopes: relay.envelopes !== false,
      ack: relay.ack !== false,
    },
    adapter_router: {
      mode: clean(adapter.mode, 80) || "external_http",
      configured: adapter.configured === true,
    },
  };
  if (Object.keys(products).length) out.adapter_router.products = products;
  const platform = clean(value.platform, 80);
  if (platform) out.platform = platform;
  if (deviceInfo) out.device_info = deviceInfo;
  if (relayKeyExchange) out.relay_key_exchange = relayKeyExchange;
  return out;
}

export function safeDeviceInfo(input = {}) {
  const value = object(input);
  const displayName = cleanDeviceInfoField(value.display_name || value.displayName, 80);
  const model = cleanDeviceInfoField(value.model, 80);
  const os = cleanDeviceInfoField(value.os, 40);
  const arch = cleanDeviceInfoField(value.arch, 40);
  const fingerprint = clean(value.fingerprint, 40);
  const identitySource = clean(value.identity_source || value.identitySource, 40);
  if (
    !displayName
    || !model
    || !os
    || !arch
    || !/^PB-[A-Z0-9]{8,24}$/.test(fingerprint)
    || identitySource !== "local_install"
  ) {
    return null;
  }
  return {
    display_name: displayName,
    model,
    os,
    arch,
    fingerprint,
    identity_source: "local_install",
  };
}

function cleanDeviceInfoField(input, maxLength) {
  const value = clean(input, maxLength);
  if (!value || looksSensitiveDeviceInfoField(value)) return "";
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:@]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return looksSensitiveDeviceInfoField(sanitized) ? "" : sanitized;
}

function looksSensitiveDeviceInfoField(input) {
  const value = String(input || "").trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  return value.includes("@")
    || value.includes("/")
    || value.includes("\\")
    || lower.includes("pbi_")
    || lower.includes("pbd_")
    || isIpv4Literal(value)
    || isMacLiteral(value);
}

function isIpv4Literal(value) {
  const parts = String(value).split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isMacLiteral(value) {
  const delimiter = value.includes(":") ? ":" : value.includes("-") ? "-" : "";
  if (!delimiter) return false;
  const parts = value.split(delimiter);
  return parts.length === 6 && parts.every((part) => /^[0-9a-fA-F]{2}$/.test(part));
}

export function safeAdapterProducts(input = {}) {
  const value = object(input);
  const out = {};
  for (const [rawProductId, rawProduct] of Object.entries(value)) {
    const productId = clean(rawProductId, 120);
    if (!productId) continue;
    const product = object(rawProduct);
    const relayKeyExchange = normalizeRelayKeyExchange(product.relay_key_exchange || product.relayKeyExchange);
    out[productId] = {
      configured: product.configured === true,
    };
    const mode = clean(product.mode, 80);
    if (mode) out[productId].mode = mode;
    if (relayKeyExchange) out[productId].relay_key_exchange = relayKeyExchange;
  }
  return out;
}

export function normalizeRelayKeyExchange(input) {
  const value = object(input);
  const algorithm = clean(value.algorithm || value.alg, 80) || "ECDH-P256+A256GCM";
  if (algorithm !== "ECDH-P256+A256GCM") return null;
  const publicJwk = publicEcJwk(value.public_jwk || value.publicJwk);
  if (!publicJwk) return null;
  return {
    status: "available",
    algorithm,
    key_id: clean(value.key_id || value.keyId, 160) || relayKeyExchangeId(publicJwk),
    public_jwk: publicJwk,
    created_at: clean(value.created_at || value.createdAt, 80) || null,
  };
}

export function publicEcJwk(input) {
  const jwk = object(input);
  const kty = clean(jwk.kty, 10);
  const crv = clean(jwk.crv, 20);
  const x = clean(jwk.x, 200);
  const y = clean(jwk.y, 200);
  if (kty !== "EC" || crv !== "P-256" || !x || !y) return null;
  return { kty, crv, x, y, ext: true, key_ops: ["deriveBits"] };
}

export function relayKeyExchangeId(publicJwk) {
  return `rkx_${String(publicJwk.x || "").slice(0, 16)}_${String(publicJwk.y || "").slice(0, 16)}`;
}

export function deviceRelayKeyExchange(device, productId = "") {
  const localState = object(device?.local_state);
  const productExchange = productId
    ? object(object(object(localState.adapter_router).products)[productId]).relay_key_exchange
    : null;
  return normalizeRelayKeyExchange(productExchange) || normalizeRelayKeyExchange(localState.relay_key_exchange);
}

export function normalizeRelayKeyBootstrap(input, { productId, deviceId, authorization, exchange }) {
  const plaintextFields = plaintextRelayKeyFields(input);
  if (plaintextFields.length) {
    const error = httpError("plaintext_relay_key_forbidden", 400);
    error.public = { plaintext_fields: plaintextFields };
    throw error;
  }
  const value = object(input);
  const wrapped = object(value.wrapped_key || value.wrappedKey || value);
  const algorithm = clean(value.algorithm || wrapped.algorithm || wrapped.alg, 80) || "ECDH-P256+A256GCM";
  if (algorithm !== "ECDH-P256+A256GCM") throw httpError("unsupported_relay_key_bootstrap_algorithm", 400);
  const keyId = clean(value.key_id || value.keyId || wrapped.key_id || wrapped.keyId, 160);
  if (!keyId || keyId !== exchange.key_id) throw httpError("relay_key_exchange_mismatch", 409);
  const appPublicJwk = publicEcJwk(wrapped.app_public_jwk || wrapped.appPublicJwk || wrapped.sender_public_jwk || wrapped.senderPublicJwk);
  const nonceB64 = clean(wrapped.nonce_b64 || wrapped.nonceB64, 400);
  const ciphertextB64 = clean(wrapped.ciphertext_b64 || wrapped.ciphertextB64, 4096);
  const aadB64 = clean(wrapped.aad_b64 || wrapped.aadB64, 2048);
  if (!appPublicJwk || !nonceB64 || !ciphertextB64 || !aadB64) {
    throw httpError("invalid_relay_key_bootstrap", 400);
  }
  const authorization_epoch = authorizationEpoch(authorization);
  const aadText = decodeBase64Text(aadB64);
  const expectedAads = relayKeyBootstrapAadTexts(productId, deviceId, authorization.id, authorization_epoch, keyId);
  if (!expectedAads.includes(aadText)) throw httpError("relay_key_bootstrap_aad_mismatch", 409);
  const issuedAt = now();
  return {
    status: "ready",
    algorithm,
    product_id: productId,
    device_id: deviceId,
    authorization_id: authorization.id,
    authorization_epoch,
    key_id: keyId,
    exchange_key_id: exchange.key_id,
    wrapped_key: {
      algorithm,
      key_id: keyId,
      app_public_jwk: appPublicJwk,
      nonce_b64: nonceB64,
      ciphertext_b64: ciphertextB64,
      aad_b64: aadB64,
    },
    created_at: issuedAt,
    updated_at: issuedAt,
  };
}

export function relayKeyBootstrapAadTexts(productId, deviceId, authorizationId, authorizationEpochValue, keyId) {
  return [[
    "bridge-relay-key-bootstrap-v1",
    productId,
    deviceId,
    authorizationId,
    String(authorizationEpochValue),
    keyId,
  ].join("|")];
}

export function plaintextRelayKeyFields(input, path = "") {
  if (!input || typeof input !== "object") return [];
  const forbidden = new Set(["relay_key_b64", "relayKeyB64", "key_b64", "keyB64", "plaintext_key", "plaintextKey"]);
  const out = [];
  for (const [key, value] of Object.entries(input)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (forbidden.has(key) && clean(value, 10000)) out.push(nextPath);
    if (value && typeof value === "object") out.push(...plaintextRelayKeyFields(value, nextPath));
  }
  return out;
}

export function authorizationRelayKeyBootstrap(authorization) {
  return object(object(authorization?.policy)._relay_key_bootstrap);
}

export function publicRelayKeyBootstrap(authorization, options = {}) {
  const value = authorizationRelayKeyBootstrap(authorization);
  if (!clean(value.status, 40)) return null;
  const payload = {
    status: clean(value.status, 40) || "missing",
    algorithm: clean(value.algorithm, 80) || "ECDH-P256+A256GCM",
    product_id: clean(value.product_id, 80) || authorization.product_id,
    device_id: clean(value.device_id, 120) || authorization.device_id,
    authorization_id: clean(value.authorization_id, 120) || authorization.id,
    authorization_epoch: Number(value.authorization_epoch || authorizationEpoch(authorization)),
    key_id: clean(value.key_id, 160) || null,
    exchange_key_id: clean(value.exchange_key_id, 160) || null,
    created_at: clean(value.created_at, 80) || null,
    updated_at: clean(value.updated_at, 80) || null,
  };
  if (options.includeWrapped) payload.wrapped_key = object(value.wrapped_key);
  return payload;
}

export async function updateAuthorizationRelayKeyBootstrap(env, authorization, bootstrap) {
  const policy = publicAuthorizationPolicy(authorization.policy);
  const nextPolicy = { ...policy, _relay_key_bootstrap: bootstrap };
  return await storage(env).update("bridge_authorizations", authorization.id, {
    policy: nextPolicy,
    updated_at: now(),
  });
}

export function publicDeviceStatus(device, env = {}) {
  if (!device || device.status === "revoked") return device?.status || "offline";
  return isDeviceOnline(device, env) ? "online" : "offline";
}

export function isDeviceOnline(device, env = {}) {
  if (!device || device.status !== "online" || !device.last_seen_at) return false;
  const graceMs = Number(env.BRIDGE_DEVICE_ONLINE_GRACE_MS || DEVICE_ONLINE_GRACE_MS);
  return Date.now() - Date.parse(device.last_seen_at) <= graceMs;
}

export function publicSession(session) {
  return { id: session.id, expires_at: session.expires_at, created_at: session.created_at };
}

export function publicAccount(user) {
  return user ? {
    id: user.id,
    display_name: user.display_name || user.email || "Panda Account",
    email: user.email || null,
  } : null;
}

export function publicSessionLink(link) {
  return link ? {
    id: link.id,
    expires_at: link.expires_at,
    consumed_at: link.consumed_at || null,
    created_at: link.created_at,
  } : null;
}

export function publicConnectIntent(intent, user = null, env = {}) {
  return intent ? {
    id: intent.id,
    product_id: intent.product_id,
    product: publicStateProduct(productInfo(intent.product_id, env)),
    source_origin: intent.source_origin || null,
    policy: object(intent.policy),
    device_id: intent.device_id || null,
    device_name: intent.device_name,
    expires_at: intent.expires_at,
    consumed_at: intent.consumed_at || null,
    created_at: intent.created_at,
    user: publicAccount(user),
  } : null;
}
