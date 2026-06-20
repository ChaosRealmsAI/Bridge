import { BRIDGE_PROTOCOL_VERSION } from "@bridge/protocol";
import { allServerCapabilities } from "../products.js";
import { BRIDGE_DESKTOP_INSTALL, BRIDGE_DESKTOP_RELEASE, DEVICE_HEARTBEAT_INTERVAL_MS, DEVICE_ONLINE_GRACE_MS, DEVICE_TOKEN_PREFIX, DEVICE_TOKEN_TTL_MS, RELAY_CAPABILITY_KINDS, RELAY_QUEUE_RETRY_AFTER_MS } from "./constants.js";
import {
  authorizationRowsForProduct,
  compareAuthorizationRows,
  connectIntentTtlMs,
  deviceTokenRotationGraceMs,
  installIdentityHash,
  sessionLinkTtlMs,
} from "./auth-common.js";
import { desktopProtocol, publicApiBase, sourceOrigin, webOrigin } from "./http.js";
import { relayEnvelopeTtlMs, relayQueueLimits } from "./relay.js";
import { realtimeEnabled } from "./realtime.js";
import { storage, storageConfigurationError, storageKind } from "./storage.js";
import { isDeviceOnline, publicAccount, publicAuthorization, publicBridgeStateDevices, publicDevice, publicStateDevice, publicStateProduct } from "./public-payloads.js";
import { boundedInteger, canonicalJson, clean, encryptString, object, sha256Hex } from "./utils.js";

export function diagnosticsPayload(env) {
  const relayLimits = relayQueueLimits(env);
  const storageError = storageConfigurationError(env);
  const serverCapabilityItems = allServerCapabilities(sourceOrigin(env), env).map((product) => ({
    id: product.id,
    name: product.name,
    origin: product.origin,
    official_origin: product.official_origin,
    official_origins: product.official_origins,
    web_url: product.web_url || product.official_origin,
    capabilities: product.capabilities,
    adapter_boundary: product.adapter_boundary || {},
    requires_desktop_authorization: product.requires_desktop_authorization,
  }));
  return {
    ok: !storageError,
    protocol: BRIDGE_PROTOCOL_VERSION,
    env: env.BRIDGE_ENV || "local",
    storage: storageKind(env),
    storage_configured: !storageError,
    storage_error: storageError?.error || null,
    api_base: publicApiBase(env),
    web_origin: webOrigin(env),
    realtime: {
      enabled: realtimeEnabled(env),
      route_template: "/v1/realtime/devices/{device_id}",
    },
    server_capabilities: {
      authority: "bridge_cloud_server_allowlist",
      desktop_catalog: false,
      items: serverCapabilityItems,
    },
    desktop_product_catalog: {
      authority: "bridge_desktop_core_managed_adapters",
      server_defined: false,
    },
    // Compatibility alias for older diagnostics readers. These are server
    // capability allowlist records, not the Desktop product catalog.
    products: serverCapabilityItems,
    relay: {
      supported_directions: ["product_to_device", "device_to_product"],
      envelope_route_template: "/v1/*/relay/envelopes",
      queue_limits: {
        device_max_unacked: relayLimits.deviceMaxUnacked,
        account_max_unacked: relayLimits.accountMaxUnacked,
        product_max_unacked: relayLimits.productMaxUnacked,
        channel_max_unacked: relayLimits.channelMaxUnacked,
        retry_after_ms: RELAY_QUEUE_RETRY_AFTER_MS,
      },
      envelope_ttl_ms: relayEnvelopeTtlMs(env),
      stores_plaintext: false,
    },
    legacy_runtime_api: {
      removed: true,
      status: 410,
      removed_routes: [
        "/v1/products/{product_id}/jobs",
        "/v1/products/{product_id}/delegated/jobs",
        "/v1/connectors/jobs",
        "/v1/jobs/{job_id}",
      ],
    },
    install: bridgeInstallPayload(env),
    connect_intents: {
      token_recovery_configured: Boolean(clean(env.BRIDGE_CONNECT_INTENT_TOKEN_SECRET, 4096)),
      token_recovery_degraded: !clean(env.BRIDGE_CONNECT_INTENT_TOKEN_SECRET, 4096),
    },
    connector: {
      device_token_prefix: DEVICE_TOKEN_PREFIX,
      device_token_ttl_ms: DEVICE_TOKEN_TTL_MS,
      device_token_rotation_grace_ms: deviceTokenRotationGraceMs(env),
      device_online_grace_ms: boundedInteger(env.BRIDGE_DEVICE_ONLINE_GRACE_MS, DEVICE_ONLINE_GRACE_MS, 1000, 1000 * 60 * 60),
      heartbeat_interval_ms: DEVICE_HEARTBEAT_INTERVAL_MS,
      connect_intent_ttl_ms: connectIntentTtlMs(env),
      session_link_ttl_ms: sessionLinkTtlMs(env),
    },
  };
}

export async function connectIntentByToken(env, token) {
  const tokenHash = await sha256Hex(String(token || ""));
  return (await storage(env).select("bridge_connect_intents", { token_hash: tokenHash }))[0] || null;
}

export async function recoverableIntentTokenPatch(env, token) {
  const secret = clean(env.BRIDGE_CONNECT_INTENT_TOKEN_SECRET, 4096);
  if (!secret) return {};
  return { token_ciphertext: await encryptString(secret, token) };
}

export async function bridgeStatePayload(env, user, product, options = {}) {
  const install = bridgeInstallPayload(env);
  if (options.noSession || !user) {
    return {
      authenticated: false,
      product: publicStateProduct(product),
      install,
      accounts: [],
      account: null,
      devices: [],
      authorization: null,
      connected: false,
      current_device: null,
    };
  }

  const devices = await accountDevices(env, user.id);
  const allAuthorizations = await authorizationRowsForProduct(env, user.id, product.id);
  const authorizations = allAuthorizations.filter((a) => a.status === "active" || a.status === "paused");
  if (!authorizations.length) {
    return {
      authenticated: true,
      product: publicStateProduct(product),
      install,
      accounts: [],
      account: null,
      devices: publicBridgeStateDevices(dedupeDevicesByInstall(devices), null, env, [], product.id),
      authorization: null,
      connected: false,
      current_device: null,
    };
  }
  const accountState = accountBridgeState(user, devices, authorizations, env, product.id);

  return {
    authenticated: true,
    product: publicStateProduct(product),
    install,
    accounts: [accountState],
    account: accountState.account,
    devices: publicBridgeStateDevices(
      dedupeDevicesByInstall(devices),
      accountState.current_device,
      env,
      authorizations,
      product.id,
    ),
    authorization: accountState.authorization,
    connected: accountState.connected,
    connection: accountState.connection,
    current_device: accountState.current_device,
  };
}

export function bridgeInstallPayload(env) {
  const base = clean(env.R2_PUBLIC_BASE_URL, 300).replace(/\/$/, "");
  const targetEntries = Object.entries(BRIDGE_DESKTOP_RELEASE.targets).map(([id, target]) => [id, {
    ...target,
    download_url: base ? `${base}${target.download_path}` : target.download_url,
    versioned_download_url: base ? `${base}${target.versioned_download_path}` : `${BRIDGE_DESKTOP_RELEASE.asset_base_urls.production}${target.versioned_download_path}`,
  }]);
  const targets = Object.freeze(Object.fromEntries(targetEntries));
  const macos = targets.macos;
  return {
    ...BRIDGE_DESKTOP_INSTALL,
    download_url: macos.download_url,
    versioned_download_url: macos.versioned_download_url,
    release_manifest_url: base ? `${base}${BRIDGE_DESKTOP_RELEASE.manifest.latest_path}` : `${BRIDGE_DESKTOP_RELEASE.asset_base_urls.production}${BRIDGE_DESKTOP_RELEASE.manifest.latest_path}`,
    versioned_release_manifest_url: base ? `${base}${BRIDGE_DESKTOP_RELEASE.manifest.versioned_path}` : `${BRIDGE_DESKTOP_RELEASE.asset_base_urls.production}${BRIDGE_DESKTOP_RELEASE.manifest.versioned_path}`,
    targets,
  };
}

export function accountBridgeState(user, devices, authorizations, env, productId = "") {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const selectedAuthorization = selectAccountAuthorization(authorizations, deviceById, env);
  const selectedAuthorizedDevice = selectedAuthorization ? deviceById.get(selectedAuthorization.device_id) || null : null;
  const selectedDevice = selectedAuthorizedDevice
    || devices.find((device) => isDeviceOnline(device, env))
    || devices[0]
    || null;
  const connected = Boolean(
    selectedAuthorization?.status === "active"
      && selectedAuthorizedDevice
      && isDeviceOnline(selectedAuthorizedDevice, env),
  );
  return {
    account: publicAccount(user),
    authorization: publicAuthorization(selectedAuthorization, { includePolicy: true }),
    connected,
    connection: {
      status: connected ? "connected" : "reconnecting",
    },
    current_device: publicStateDevice(selectedDevice, env, productId),
  };
}

export function selectAccountAuthorization(authorizations, deviceById, env) {
  const rows = [...authorizations].sort((left, right) => {
    const leftOnline = left?.status === "active" && isDeviceOnline(deviceById.get(left.device_id), env);
    const rightOnline = right?.status === "active" && isDeviceOnline(deviceById.get(right.device_id), env);
    if (leftOnline !== rightOnline) return leftOnline ? -1 : 1;
    return compareAuthorizationRows(left, right);
  });
  return rows[0] || null;
}

export function dedupeDevicesByInstall(devices) {
  const seen = new Set();
  const result = [];
  for (const device of devices) {
    const key = device.install_id_hash || device.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(device);
  }
  return result;
}

export async function accountDevices(env, userId) {
  return (await storage(env).select("bridge_devices", { user_id: userId }, { order: "last_seen_at", desc: true }))
    .filter((device) => device.status !== "revoked");
}

export async function publicAccountDevices(env, userId, currentDeviceId = "") {
  const devices = dedupeDevicesByInstall(await accountDevices(env, userId));
  return devices.map((device) => ({
    id: device.id,
    name: device.device_name,
    online: isDeviceOnline(device, env),
    last_seen_at: device.last_seen_at || null,
    current: Boolean(currentDeviceId && device.id === currentDeviceId),
  }));
}

export async function alreadyAuthorizedConnectPayload(env, user, product, requestedPolicy, installId = "") {
  const devices = await accountDevices(env, user.id);
  const authorizations = await storage(env).select("bridge_authorizations", {
    user_id: user.id,
    product_id: product.id,
    status: "active",
  }, { order: "updated_at", desc: true });
  for (const authorization of authorizations) {
    const device = devices.find((item) => item.id === authorization.device_id);
    if (!device || !isDeviceOnline(device, env)) continue;
    if (!await deviceMatchesInstallId(device, installId)) continue;
    if (!authorizationPolicyCoversRequest(authorization.policy, requestedPolicy)) continue;
    return {
      already_authorized: true,
      connected: true,
      connection: { status: "connected" },
      authorization: publicAuthorization(authorization),
      current_device: publicStateDevice(device, env, product.id),
      device: publicDevice(device, env),
      product: publicStateProduct(product),
      account: publicAccount(user),
    };
  }
  return null;
}

export async function authorizedOfflineConnectPayload(env, user, product, requestedPolicy, installId = "") {
  const devices = await accountDevices(env, user.id);
  const authorizations = await storage(env).select("bridge_authorizations", {
    user_id: user.id,
    product_id: product.id,
    status: "active",
  }, { order: "updated_at", desc: true });
  for (const authorization of authorizations) {
    const device = devices.find((item) => item.id === authorization.device_id);
    if (!device || isDeviceOnline(device, env)) continue;
    if (!await deviceMatchesInstallId(device, installId)) continue;
    if (!authorizationPolicyCoversRequest(authorization.policy, requestedPolicy)) continue;
    return {
      already_authorized: true,
      connected: false,
      connection: { status: "reconnecting" },
      authorization: publicAuthorization(authorization),
      current_device: publicStateDevice(device, env, product.id),
      device: publicDevice(device, env),
      product: publicStateProduct(product),
      account: publicAccount(user),
    };
  }
  return null;
}

export async function deviceMatchesInstallId(device, installId) {
  const expected = clean(installId, 200);
  if (!expected) return true;
  if (!device?.install_id_hash) return false;
  return device.install_id_hash === await installIdentityHash(expected);
}

export function authorizationPolicyCoversRequest(grantPolicy, requestedPolicy) {
  const grant = object(grantPolicy);
  if (grant.version !== "BRIDGE-RELAY-AUTH-v1") return false;
  const requested = object(requestedPolicy);
  const capabilities = Array.isArray(requested.capabilities) ? requested.capabilities : [];
  const grantedCapabilities = Array.isArray(grant.capabilities) ? grant.capabilities : [];
  if (capabilities.some((capability) => !grantedCapabilities.includes(capability))) return false;
  for (const capability of capabilities) {
    if (!RELAY_CAPABILITY_KINDS.includes(capability)) return false;
  }
  if (canonicalJson(object(grant.product_authorization)) !== canonicalJson(object(requested.product_authorization))) return false;
  return true;
}

export function connectIntentDeepLink(env, token) {
  return `${desktopProtocol(env)}://connect?intent=${encodeURIComponent(token)}&api=${encodeURIComponent(publicApiBase(env))}`;
}
