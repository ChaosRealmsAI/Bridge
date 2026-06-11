export const BRIDGE_SDK_VERSION = "0.1.0";

export const BridgeErrorCodes = Object.freeze({
  already_authorized: "already_authorized",
  authorization_import_proof_required: "authorization_import_proof_required",
  authorization_scope_denied: "authorization_scope_denied",
  bridge_cloud_unavailable: "bridge_cloud_unavailable",
  connect_intent_not_found: "connect_intent_not_found",
  delegated_authorization_proof_mismatch: "delegated_authorization_proof_mismatch",
  delegated_device_mismatch: "delegated_device_mismatch",
  desktop_claim_required: "desktop_claim_required",
  device_not_found: "device_not_found",
  device_offline: "device_offline",
  device_queue_full: "device_queue_full",
  idempotency_key_conflict: "idempotency_key_conflict",
  install_id_required: "install_id_required",
  invalid_authorization_import_proof: "invalid_authorization_import_proof",
  invalid_authorization_policy: "invalid_authorization_policy",
  invalid_connect_intent: "invalid_connect_intent",
  invalid_content_type: "invalid_content_type",
  invalid_json: "invalid_json",
  invalid_origin: "invalid_origin",
  job_not_found: "job_not_found",
  local_policy_denied: "local_policy_denied",
  product_delegation_body_hash_invalid: "product_delegation_body_hash_invalid",
  product_delegation_not_configured: "product_delegation_not_configured",
  product_delegation_replay: "product_delegation_replay",
  product_delegation_signature_invalid: "product_delegation_signature_invalid",
  product_delegation_timestamp_invalid: "product_delegation_timestamp_invalid",
  product_delegation_unauthorized: "product_delegation_unauthorized",
  product_not_authorized: "product_not_authorized",
  product_origin_mismatch: "product_origin_mismatch",
  product_queue_full: "product_queue_full",
  request_body_too_large: "request_body_too_large",
  scope_insufficient: "scope_insufficient",
  unauthorized: "unauthorized",
});

export class BridgeError extends Error {
  constructor(message, options = {}) {
    super(message || "bridge_error");
    this.name = "BridgeError";
    this.code = stringValue(options.code, 160) || "bridge_error";
    this.status = Number.isFinite(Number(options.status)) ? Number(options.status) : 0;
    this.payload = options.payload ?? null;
  }
}

export const bridgeDesktopInstallDefaults = Object.freeze({
  macos: Object.freeze({
    platform: "macos",
    appName: "Panda Bridge",
    fileName: "panda-bridge-macos.dmg",
    openUrl: "panda-bridge://open",
    downloadPath: "/downloads/panda-bridge-macos.dmg",
    downloadUrls: Object.freeze({
      production: "https://assets.bridge.otherline.cc/downloads/panda-bridge-macos.dmg",
      test: "https://assets-bridge.test.example/downloads/panda-bridge-macos.dmg",
    }),
    sha256: "e65e04f08373ffe2363616dc1426516b74f12123f52c71d7225af4bac7225962",
  }),
});

export function bridgeDesktopInstallTarget(options = {}) {
  const platform = stringValue(options.platform, 40) || "macos";
  const target = bridgeDesktopInstallDefaults[platform];
  if (!target) throw new Error(`unsupported_bridge_desktop_platform:${platform}`);

  const channel = stringValue(options.channel, 40) || "production";
  const assetBaseUrl = stringValue(options.assetBaseUrl || options.asset_base_url, 300).replace(/\/$/, "");
  const overrideDownloadUrl = stringValue(options.downloadUrl || options.download_url, 500);
  const overrideOpenUrl = stringValue(options.openUrl || options.open_url, 200);
  const downloadUrl = overrideDownloadUrl
    || (assetBaseUrl ? `${assetBaseUrl}${target.downloadPath}` : target.downloadUrls[channel] || target.downloadUrls.production);

  return {
    platform: target.platform,
    appName: target.appName,
    fileName: target.fileName,
    version: BRIDGE_SDK_VERSION,
    openUrl: overrideOpenUrl || target.openUrl,
    downloadUrl,
    downloadPath: target.downloadPath,
    sha256: target.sha256,
  };
}

export function bridgeDesktopStatusModel(snapshot = {}, installTarget = null) {
  const snap = objectValue(snapshot);
  const status = stringValue(snap.status, 80) || "not_installed";
  const device = objectValue(snap.device);
  const hasDevice = Object.keys(device).length > 0;
  const deviceOnline = device.online === true || stringValue(device.status, 40) === "online";
  const deviceInstalled = hasDevice && device.installed !== false;
  const install = objectValue(installTarget);

  const authorization = bridgeAuthorizationState(status);
  const connection = bridgeConnectionState(status, {
    hasDevice,
    deviceOnline,
    deviceInstalled,
  });
  const downloaded = deviceInstalled || (hasDevice && status !== "desktop_uninstalled") || authorization.authorized;

  return {
    status,
    ready: authorization.authorized && connection.connected,
    download: {
      state: downloaded ? "available" : "needed",
      available: true,
      downloaded,
      action: downloaded ? "open_bridge" : "download_bridge",
      downloadUrl: stringValue(install.downloadUrl || install.download_url, 500) || null,
      openUrl: stringValue(install.openUrl || install.open_url, 200) || bridgeDesktopInstallDefaults.macos.openUrl,
    },
    authorization,
    connection,
    nextAction: bridgeNextAction(authorization, connection, downloaded),
  };
}

export function bridgeDelegatedAccountStatusModel(payload = {}) {
  const data = objectValue(payload);
  const devices = arrayValue(data.devices).map(objectValue).filter(hasObjectKeys);
  const authorizedDevices = arrayValue(data.authorized_devices || data.authorizedDevices).map(objectValue).filter(hasObjectKeys);
  const authorizations = arrayValue(data.authorizations).map(objectValue).filter(hasObjectKeys);
  const selectedDevice = firstObject(data.selected_device || data.selectedDevice)
    || authorizedDevices[0]
    || null;
  const selectedDeviceId = selectedDevice ? stringValue(selectedDevice.id, 200) : "";
  const selectedAuthorization = firstObject(data.authorization)
    || authorizations.find((authorization) => stringValue(authorization.device_id || authorization.deviceId, 200) === selectedDeviceId)
    || null;
  const active = selectedDevice && selectedAuthorization && stringValue(selectedAuthorization.status, 40) === "active";
  const visibleDevice = selectedDevice || devices[0] || null;
  const status = active
    ? bridgeSnapshotStatusForDevice(selectedDevice)
    : visibleDevice
      ? "source_registered"
      : "not_installed";

  return {
    status,
    ready: status === "connected",
    authorized: Boolean(active),
    connected: status === "connected",
    deviceId: active ? selectedDeviceId || null : null,
    device: active ? selectedDevice : visibleDevice,
    authorization: active ? selectedAuthorization : null,
    outlet: active ? {
      deviceId: selectedDeviceId || null,
      status,
      ready: status === "connected",
      device: selectedDevice,
      authorization: selectedAuthorization,
    } : null,
  };
}

export function bridgeDelegatedConnectIntentStatusModel(payload = {}, token = "") {
  const data = objectValue(payload);
  const intent = objectValue(data.connect_intent || data.connectIntent);
  const authorization = firstObject(data.authorization);
  const device = firstObject(data.device);
  const deviceId = stringValue(intent.device_id || intent.deviceId, 200) || (device ? stringValue(device.id, 200) : "");
  const active = Boolean(deviceId && device && authorization && stringValue(authorization.status, 40) === "active");
  const status = active ? bridgeSnapshotStatusForDevice(device) : "authorization_pending";

  return {
    status,
    ready: status === "connected",
    authorized: active,
    connected: status === "connected",
    deviceId: active ? deviceId : null,
    device,
    authorization: active ? authorization : null,
    intentId: stringValue(token, 300) || stringValue(data.token, 300) || null,
    expiresAt: stringValue(intent.expires_at || intent.expiresAt, 80) || null,
    deepLink: stringValue(data.deep_link || data.deepLink, 500) || null,
  };
}

export function bridgeSnapshotStatusForDevice(device = {}) {
  const value = objectValue(device);
  return value.online === true || stringValue(value.status, 40) === "online" ? "connected" : "device_offline";
}

function bridgeAuthorizationState(status) {
  if (status === "connected" || status === "device_offline") {
    return { state: "authorized", authorized: true, action: "manage_authorization" };
  }
  if (status === "authorization_pending") {
    return { state: "pending", authorized: false, action: "confirm_on_desktop" };
  }
  if (status === "revoked") {
    return { state: "revoked", authorized: false, action: "authorize_product" };
  }
  if (status === "denied") {
    return { state: "denied", authorized: false, action: "authorize_product" };
  }
  if (status === "expired") {
    return { state: "expired", authorized: false, action: "authorize_product" };
  }
  if (status === "scope_insufficient") {
    return { state: "insufficient", authorized: false, action: "authorize_product" };
  }
  if (status === "bridge_cloud_unavailable" || status === "control_surface_missing" || status === "stale_state") {
    return { state: "unknown", authorized: false, action: "refresh_status" };
  }
  return { state: "missing", authorized: false, action: "authorize_product" };
}

function bridgeConnectionState(status, device) {
  if (status === "authorization_pending") {
    return { state: "waiting", connected: false, action: "confirm_on_desktop" };
  }
  if (status === "connected" && device.deviceOnline) {
    return { state: "connected", connected: true, action: "ready" };
  }
  if (status === "bridge_cloud_unavailable" || status === "control_surface_missing") {
    return { state: "unknown", connected: false, action: "refresh_status" };
  }
  if (device.hasDevice || device.deviceInstalled || status === "device_offline" || status === "connected") {
    return { state: "disconnected", connected: false, action: "open_bridge" };
  }
  return { state: "not_ready", connected: false, action: "download_bridge" };
}

function bridgeNextAction(authorization, connection, downloaded) {
  if (!downloaded) return "download_bridge";
  if (!authorization.authorized) return authorization.action;
  if (!connection.connected) return connection.action;
  return "ready";
}

export function createBridgeClient(options = {}) {
  const apiBase = String(options.apiBase || "").replace(/\/$/, "");
  const productId = options.productId || "panda-chat";
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!apiBase) throw new Error("apiBase is required");
  if (!fetchImpl) throw new Error("fetch is required");

  const request = async (method, path, body) => {
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw bridgeErrorFromResponse(response.status, payload);
    }
    return payload;
  };

  return {
    productId,
    state: () => request("GET", `/v1/bridge/state?product_id=${encodeURIComponent(productId)}`),
    watchState: (input = {}) => watchBridgeState(request, apiBase, input),
    ensureReady: (input = {}) => ensureBridgeReady(request, productId, input),
    install: (input = {}) => bridgeInstallModel(input),
    diagnostics: () => request("GET", "/v1/diagnostics"),
    preflight: (input = {}) => preflight(request, productId, input),
    queue: {
      summary: () => request("GET", "/v1/queue/summary"),
    },
    auth: {
      session: () => request("GET", "/v1/session"),
      password: (email, password, displayName = "") =>
        request("POST", "/v1/sessions/password", { email, password, display_name: displayName }),
      guest: (displayName = "Guest") => request("POST", "/v1/sessions/guest", { display_name: displayName }),
      share: () => request("POST", "/v1/sessions/share", {}),
      join: (token) => request("POST", "/v1/sessions/join", { token }),
      logout: () => request("POST", "/v1/sessions/logout", {}),
    },
    devices: {
      list: () => request("GET", "/v1/devices"),
      createPairingCode: (deviceName = "Panda Bridge Desktop") =>
        request("POST", "/v1/devices/pairing-codes", { device_name: deviceName }),
      revoke: (deviceId) => request("DELETE", `/v1/devices/${encodeURIComponent(deviceId)}`),
    },
    connect: {
      createIntent: (input = {}) =>
        request("POST", "/v1/connect-intents", {
          product_id: input.productId || input.product_id || productId,
          device_name: input.deviceName || input.device_name || "Panda Bridge Desktop",
          policy: normalizeAuthorizationPolicyRequest(input.permissions || input.permission || input.policy || bridgeFullAccessPolicy()),
        }),
      intent: (token) => request("GET", `/v1/connect-intents/${encodeURIComponent(token)}`),
      claim: (token, input = {}) =>
        request("POST", `/v1/connect-intents/${encodeURIComponent(token)}/claim`, {
          device_name: input.deviceName || input.device_name || "Panda Bridge Desktop",
          app_version: input.appVersion || input.app_version || null,
          capabilities: input.capabilities || {},
          local_state: input.localState || input.local_state || {},
          policy: input.policy || {},
        }),
    },
    products: {
      list: () => request("GET", "/v1/products"),
      requestAuthorization: (deviceId, policy = {}) =>
        request("POST", `/v1/products/${encodeURIComponent(productId)}/authorization/request`, {
          device_id: deviceId,
          policy,
        }),
      authorization: (deviceId) =>
        request("GET", `/v1/products/${encodeURIComponent(productId)}/authorization?device_id=${encodeURIComponent(deviceId)}`),
      revokeAuthorization: (deviceId) =>
        request("DELETE", `/v1/products/${encodeURIComponent(productId)}/authorization?device_id=${encodeURIComponent(deviceId)}`),
    },
    codex: {
      chat: (input) => createJob(request, productId, { ...input, kind: "codex.chat" }),
      run: (input) => createJob(request, productId, { ...input, kind: "codex.run" }),
      rpc: (input) => createJob(request, productId, { ...input, kind: "codex.rpc" }),
    },
    jobs: {
      create: (input = {}) => createJob(request, productId, input),
      get: (jobId) => request("GET", `/v1/jobs/${encodeURIComponent(jobId)}`),
      events: (jobId, after = 0) =>
        request("GET", `/v1/jobs/${encodeURIComponent(jobId)}/events?after=${encodeURIComponent(String(after))}`),
      wait: (jobId, options = {}) => waitForJob(request, jobId, options),
      stream: (jobId, options = {}) => streamEvents(request, apiBase, jobId, options),
      cancel: (jobId) => request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/cancel`),
    },
  };
}

export function bridgeFullAccessPolicy(overrides = {}) {
  const policy = {
    version: "AUTH-SCOPE-v1",
    preset: "full-access",
    request_source: "sdk_default_full_access",
    capabilities: ["codex.chat", "codex.run", "codex.rpc", "saas.custom.run"],
    workspace_roots: [{
      id: "all",
      path_display: "All local files",
      allow_all: true,
    }],
    sandbox_floor: "danger-full-access",
    approval_policy_floor: "never",
    allow_approval_never: true,
    allow_developer_instructions: true,
    display: {
      workspace: "All local files",
      sandbox: "danger-full-access",
      approval: "never",
      developer_instructions: "allowed",
    },
    ...objectValue(overrides),
  };
  policy.display = authorizationPolicyDisplay(policy);
  return policy;
}

function bridgeInstallModel(options = {}) {
  const target = bridgeDesktopInstallTarget(options);
  return {
    downloadUrl: target.downloadUrl,
    version: target.version || BRIDGE_SDK_VERSION,
    sha256: target.sha256,
    openUrl: target.openUrl,
    platform: target.platform,
  };
}

async function ensureBridgeReady(request, productId, input = {}) {
  const timeoutMs = Number(input.timeoutMs || input.timeout_ms || 120000);
  const intervalMs = Number(input.intervalMs || input.interval_ms || 3000);
  const started = Date.now();
  let current = await request("GET", `/v1/bridge/state?product_id=${encodeURIComponent(productId)}`);
  if (current.bridge_state === "ready") return { state: current, ready: true, action: null };
  if (current.bridge_state === "authorized_offline") {
    return { state: current, ready: false, action: firstAction(current, "open_desktop") };
  }
  if (current.bridge_state === "no_session" || current.bridge_state === "no_device") {
    return { state: current, ready: false, action: firstAction(current) };
  }

  let intent = objectValue(current.intent);
  if (current.bridge_state === "not_authorized") {
    const created = await request("POST", "/v1/connect-intents", {
      product_id: input.productId || input.product_id || productId,
      device_name: input.deviceName || input.device_name || "Panda Bridge Desktop",
      policy: normalizeAuthorizationPolicyRequest(input.permissions || input.permission || input.policy || bridgeFullAccessPolicy()),
    });
    if (created.already_authorized === true) {
      return {
        state: normalizeAlreadyAuthorizedState(created, productId),
        ready: true,
        action: null,
        response: created,
      };
    }
    intent = normalizeIntentPayload(created);
    current = {
      ...current,
      bridge_state: "authorization_pending",
      intent,
      actions: [{ kind: "confirm_on_desktop", deep_link: intent.deep_link || null }],
    };
  }

  const deepLink = stringValue(intent.deep_link || intent.deepLink, 800);
  if (deepLink && typeof input.openDeepLink === "function") {
    await input.openDeepLink(deepLink, { state: current, intent });
  }

  for await (const state of watchBridgeState(request, "", { intervalMs, timeoutMs, initialState: current, productId })) {
    if (state.bridge_state === "ready") return { state, ready: true, action: null };
    if (state.bridge_state === "authorized_offline") return { state, ready: false, action: firstAction(state, "open_desktop") };
    if (state.bridge_state === "no_session" || state.bridge_state === "no_device" || state.bridge_state === "not_authorized") {
      return { state, ready: false, action: firstAction(state) };
    }
    if (Date.now() - started >= timeoutMs) break;
  }
  throw new BridgeError("bridge_ready_timeout", {
    code: "bridge_ready_timeout",
    status: 0,
    payload: { bridge_state: current.bridge_state, timeout_ms: timeoutMs },
  });
}

async function* watchBridgeState(request, apiBase, input = {}) {
  const intervalMs = Number(input.intervalMs || input.interval_ms || 3000);
  const timeoutMs = input.timeoutMs || input.timeout_ms;
  const started = Date.now();
  let current = input.initialState || await request("GET", bridgeStatePath(input.productId || input.product_id));

  let ws = null;
  let wake = null;
  let realtimeTriggered = false;
  let realtimeClosed = false;
  const wakeWaiter = () => {
    if (wake) {
      wake();
      wake = null;
    }
  };
  const closeRealtime = () => {
    if (ws && ws.readyState < 2) ws.close();
    ws = null;
  };

  const attachRealtime = (deviceId) => {
    if (!apiBase || input.realtime === false || !deviceId || typeof WebSocket === "undefined") return;
    try {
      ws = new WebSocket(realtimeDeviceUrl(apiBase, deviceId, "web"));
      ws.addEventListener("message", (message) => {
        let payload = null;
        try {
          payload = JSON.parse(String(message.data || ""));
        } catch {
          return;
        }
        if (payload.type === "bridge.state") {
          realtimeTriggered = true;
          wakeWaiter();
        }
      });
      ws.addEventListener("error", () => {
        realtimeClosed = true;
        wakeWaiter();
      });
      ws.addEventListener("close", () => {
        realtimeClosed = true;
        wakeWaiter();
      });
    } catch {
      closeRealtime();
    }
  };
  attachRealtime(realtimeStateDeviceId(current));
  yield current;

  try {
    while (!timeoutMs || Date.now() - started < Number(timeoutMs)) {
      await visibleDelay(intervalMs, () => realtimeTriggered || realtimeClosed);
      realtimeTriggered = false;
      current = await request("GET", bridgeStatePath(input.productId || input.product_id));
      yield current;
      if (!ws && apiBase && input.realtime !== false) {
        const nextDeviceId = realtimeStateDeviceId(current);
        attachRealtime(nextDeviceId);
      }
    }
  } finally {
    closeRealtime();
  }
}

function bridgeStatePath(productId = "") {
  const product = stringValue(productId, 120);
  return product ? `/v1/bridge/state?product_id=${encodeURIComponent(product)}` : "/v1/bridge/state";
}

function realtimeStateDeviceId(state = {}) {
  const devices = arrayValue(state.devices).map(objectValue);
  const selected = devices.find((device) => device.current === true && device.online === true)
    || devices.find((device) => device.online === true)
    || devices.find((device) => device.current === true);
  return selected ? stringValue(selected.id, 200) : "";
}

async function visibleDelay(intervalMs, shouldWake = () => false) {
  const started = Date.now();
  while (Date.now() - started < intervalMs) {
    if (shouldWake()) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      await waitForDocumentVisible();
      return;
    }
    await sleep(Math.min(100, intervalMs));
  }
}

function waitForDocumentVisible() {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const onVisible = () => {
      if (document.visibilityState !== "hidden") {
        document.removeEventListener("visibilitychange", onVisible);
        resolve();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
  });
}

function firstAction(state, kind = "") {
  const actions = arrayValue(state.actions);
  return kind ? actions.find((action) => action?.kind === kind) || actions[0] || null : actions[0] || null;
}

function normalizeIntentPayload(payload = {}) {
  const intent = objectValue(payload.intent || payload.connect_intent || payload.connectIntent);
  return {
    token: stringValue(payload.token || intent.token, 300) || null,
    expires_at: stringValue(intent.expires_at || intent.expiresAt || payload.expires_at || payload.expiresAt, 100) || null,
    deep_link: stringValue(payload.deep_link || payload.deepLink || intent.deep_link || intent.deepLink, 800) || null,
  };
}

function normalizeAlreadyAuthorizedState(payload = {}, productId = "") {
  const device = firstObject(payload.device) || null;
  const authorization = firstObject(payload.authorization) || null;
  return {
    bridge_state: "ready",
    product_id: productId,
    install: bridgeInstallModel(),
    devices: device ? [normalizeStateDevice(device, true)] : [],
    authorization,
    intent: null,
    actions: [],
  };
}

function normalizeStateDevice(device = {}, current = false) {
  const value = objectValue(device);
  return {
    id: stringValue(value.id, 200) || null,
    name: stringValue(value.name || value.device_name || value.deviceName, 200) || null,
    online: value.online === true || stringValue(value.status, 40) === "online",
    last_seen_at: stringValue(value.last_seen_at || value.lastSeenAt, 100) || null,
    current: value.current === true || current,
  };
}

function bridgeErrorFromResponse(status, payload = {}) {
  const data = objectValue(payload);
  const code = stringValue(data.error || data.code || data.message, 160) || `bridge_http_${status}`;
  return new BridgeError(stringValue(data.message, 300) || code || `Bridge API ${status}`, {
    code,
    status,
    payload: data,
  });
}

async function preflight(request, productId, input = {}) {
  const targetDeviceId = stringValue(input.deviceId || input.device_id, 120) || null;
  const issues = [];
  const actions = [];
  const result = {
    ready: false,
    product_id: productId,
    target_device_id: targetDeviceId,
    diagnostics: null,
    authenticated: false,
    session: null,
    devices: [],
    online_devices: [],
    authorizations: [],
    authorized_devices: [],
    selected_device: null,
    queue: null,
    issues,
    actions,
  };

  const diagnostics = await preflightCall(() => request("GET", "/v1/diagnostics"));
  if (!diagnostics.ok) {
    addPreflightIssue(result, "bridge_unreachable", "Bridge diagnostics is not reachable.", "retry_bridge", diagnostics.error);
    return result;
  }
  result.diagnostics = diagnostics.payload;
  if (diagnostics.payload?.ok !== true) {
    addPreflightIssue(result, "bridge_not_ready", "Bridge diagnostics did not report ready.", "retry_bridge", { payload: diagnostics.payload });
  }

  const session = await preflightCall(() => request("GET", "/v1/session"));
  if (!session.ok) {
    if (session.error.status === 401) {
      addPreflightIssue(result, "not_authenticated", "No active Bridge session.", "login");
      return result;
    }
    addPreflightIssue(result, "session_unavailable", "Bridge session could not be read.", "retry_session", session.error);
    return result;
  }
  result.authenticated = session.payload?.authenticated === true;
  result.session = session.payload || null;
  if (!result.authenticated) {
    addPreflightIssue(result, "not_authenticated", "No active Bridge session.", "login");
    return result;
  }

  const devices = await preflightCall(() => request("GET", "/v1/devices"));
  if (!devices.ok) {
    addPreflightIssue(result, "devices_unavailable", "Bridge devices could not be read.", "retry_devices", devices.error);
    return result;
  }
  result.devices = Array.isArray(devices.payload?.items) ? devices.payload.items : [];
  result.online_devices = result.devices.filter((device) => device?.status === "online");

  if (!result.devices.length) {
    addPreflightIssue(result, "no_devices", "No Bridge desktop device is connected to this account.", "connect_device");
  }
  if (result.devices.length && !result.online_devices.length) {
    addPreflightIssue(result, "no_online_devices", "No Bridge desktop device is currently online.", "open_desktop");
  }

  let candidateDevices = targetDeviceId
    ? result.online_devices.filter((device) => device.id === targetDeviceId)
    : result.online_devices;
  if (targetDeviceId && !result.devices.some((device) => device.id === targetDeviceId)) {
    addPreflightIssue(result, "device_not_found", "The requested Bridge device is not visible to this account.", "connect_device");
    candidateDevices = [];
  }

  for (const device of candidateDevices) {
    const authorization = await preflightCall(() => (
      request("GET", `/v1/products/${encodeURIComponent(productId)}/authorization?device_id=${encodeURIComponent(device.id)}`)
    ));
    if (authorization.ok && authorization.payload?.authorization?.status === "active") {
      result.authorizations.push(authorization.payload.authorization);
      result.authorized_devices.push(device);
    } else if (!authorization.ok) {
      result.authorizations.push({ device_id: device.id, error: authorization.error });
    }
  }

  if (candidateDevices.length && !result.authorized_devices.length) {
    addPreflightIssue(result, "product_not_authorized", "This product is not authorized for an online Bridge device.", "authorize_product");
  }

  const queue = await preflightCall(() => request("GET", "/v1/queue/summary"));
  if (queue.ok) {
    result.queue = queue.payload;
  } else {
    addPreflightIssue(result, "queue_unavailable", "Bridge queue summary could not be read.", "retry_queue", queue.error);
  }

  result.selected_device = targetDeviceId
    ? result.authorized_devices.find((device) => device.id === targetDeviceId) || null
    : result.authorized_devices[0] || null;
  result.ready = result.issues.length === 0 && Boolean(result.selected_device);
  return result;
}

async function preflightCall(operation) {
  try {
    return { ok: true, payload: await operation() };
  } catch (error) {
    return { ok: false, error: preflightError(error) };
  }
}

function preflightError(error) {
  return {
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
    code: stringValue(error?.payload?.error || error?.message || "bridge_error", 120) || "bridge_error",
    payload: objectValue(error?.payload),
  };
}

function addPreflightIssue(result, code, message, action, detail = null) {
  result.issues.push({
    code,
    message,
    ...(detail ? { detail } : {}),
  });
  if (!result.actions.some((item) => item.code === action)) {
    result.actions.push(preflightAction(action));
  }
}

function preflightAction(code) {
  const labels = {
    retry_bridge: "Retry Bridge diagnostics or check the API base.",
    retry_session: "Retry session lookup.",
    retry_devices: "Retry device lookup.",
    retry_queue: "Retry queue summary.",
    login: "Sign in or create a Bridge session.",
    connect_device: "Connect Panda Bridge Desktop to this account.",
    open_desktop: "Open Panda Bridge Desktop and keep it online.",
    authorize_product: "Connect this product to the desktop device.",
  };
  return { code, label: labels[code] || "Review Bridge setup." };
}

async function createJob(request, productId, input) {
  const deviceId = input.deviceId || input.device_id;
  const jobInput = input.input || input.payload || { prompt: input.prompt, calls: input.calls };
  const normalized = normalizeBridgeJob({
    ...input,
    productId,
    deviceId,
    input: jobInput,
    policy: input.policy || {},
  });
  const validation = validateBridgeJob(normalized);
  if (!validation.ok) {
    const error = new Error(`invalid_bridge_job: ${validation.errors.join(",")}`);
    error.errors = validation.errors;
    throw error;
  }
  return request("POST", `/v1/products/${encodeURIComponent(productId)}/jobs`, validation.job);
}

function normalizeBridgeJob(input = {}) {
  const kind = normalizeKind(input.kind || input.job_kind);
  const productId = stringValue(input.productId || input.product_id, 80);
  const deviceId = stringValue(input.deviceId || input.device_id || input.connector_id, 80);
  const workspaceRef = stringPassthrough(input.workspaceRef ?? input.workspace_ref);
  const requestKey = stringValue(input.requestKey || input.request_key, 160);
  return {
    kind,
    product_id: productId,
    device_id: deviceId,
    workspace_ref: workspaceRef || null,
    request_key: requestKey || null,
    input: objectValue(input.input || input.payload),
    policy: normalizePolicy(input.policy || {}),
  };
}

function validateBridgeJob(input = {}) {
  const job = normalizeBridgeJob(input);
  const errors = [];
  if (!job.kind) errors.push("missing_kind");
  if (!job.product_id) errors.push("missing_product_id");
  if (!job.device_id) errors.push("missing_device_id");
  return { ok: errors.length === 0, errors, job };
}

function normalizeKind(kind) {
  return stringPassthrough(kind);
}

function normalizePolicy(input = {}) {
  return objectValue(input);
}

function normalizeAuthorizationPolicyRequest(input = {}) {
  const policy = objectValue(input);
  if (!Object.keys(policy).length) return bridgeFullAccessPolicy();
  if (policy.fullAccess === true || policy.full_access === true || policy.preset === "full-access") {
    return bridgeFullAccessPolicy(policy);
  }
  return policy;
}

function authorizationPolicyDisplay(policy) {
  const roots = Array.isArray(policy.workspace_roots) ? policy.workspace_roots : [];
  const workspace = roots.some((root) => root?.allow_all === true || root?.allowAll === true)
    ? "All local files"
    : roots.map((root) => stringValue(root?.path_display || root?.label || root?.id, 200)).filter(Boolean).join(", ");
  return {
    workspace: workspace || "All local files",
    sandbox: stringValue(policy.sandbox_floor || policy.sandboxFloor, 80) || "danger-full-access",
    approval: stringValue(policy.approval_policy_floor || policy.approvalPolicyFloor, 80) || "never",
    developer_instructions: policy.allow_developer_instructions === false || policy.allowDeveloperInstructions === false ? "denied" : "allowed",
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function firstObject(value) {
  const object = objectValue(value);
  return hasObjectKeys(object) ? object : null;
}

function hasObjectKeys(value) {
  return Object.keys(value).length > 0;
}

function stringValue(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringPassthrough(value) {
  return typeof value === "string" ? value : "";
}

async function waitForJob(request, jobId, options = {}) {
  const timeoutMs = options.timeoutMs || 300000;
  const intervalMs = options.intervalMs || 1500;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await request("GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
    if (payload.job && !["queued", "pending", "running"].includes(payload.job.status)) return payload.job;
    await sleep(intervalMs);
  }
  throw new Error("bridge_job_timeout");
}

async function* pollEvents(request, jobId, options = {}) {
  let after = Number(options.after || 0);
  const intervalMs = options.intervalMs || 900;
  const timeoutMs = options.timeoutMs || 300000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await request("GET", `/v1/jobs/${encodeURIComponent(jobId)}/events?after=${after}`);
    for (const event of payload.items || []) {
      after = Math.max(after, Number(event.seq || 0));
      yield event;
    }
    const job = payload.job;
    if (job && !["queued", "pending", "running"].includes(job.status)) return;
    await sleep(intervalMs);
  }
}

async function* streamEvents(request, apiBase, jobId, options = {}) {
  const deviceId = stringValue(options.deviceId || options.device_id, 120);
  if (options.realtime === false || !deviceId || typeof WebSocket === "undefined") {
    yield* pollEvents(request, jobId, options);
    return;
  }

  let after = Number(options.after || 0);
  const timeoutMs = options.timeoutMs || 300000;
  const fallbackIntervalMs = options.intervalMs || 900;
  const started = Date.now();
  const queue = [];
  let ws = null;
  let opened = false;
  let closed = false;
  let failed = null;
  let wake = null;
  const wakeWaiter = () => {
    if (wake) {
      wake();
      wake = null;
    }
  };

  try {
    ws = new WebSocket(realtimeDeviceUrl(apiBase, deviceId, "web"));
    ws.addEventListener("open", () => {
      opened = true;
      wakeWaiter();
    });
    ws.addEventListener("message", (message) => {
      let payload = null;
      try {
        payload = JSON.parse(String(message.data || ""));
      } catch {
        return;
      }
      if (payload.type === "job.event" && payload.event?.job_id === jobId) {
        queue.push(payload.event);
        wakeWaiter();
      }
    });
    ws.addEventListener("error", () => {
      failed = new Error("bridge_realtime_error");
      wakeWaiter();
    });
    ws.addEventListener("close", () => {
      closed = true;
      wakeWaiter();
    });

    await waitFor(() => opened || failed || closed, 5000);
    if (!opened) throw failed || new Error("bridge_realtime_unavailable");

    const initial = await request("GET", `/v1/jobs/${encodeURIComponent(jobId)}/events?after=${after}`);
    for (const event of initial.items || []) {
      after = Math.max(after, Number(event.seq || 0));
      yield event;
    }
    if (isTerminalJob(initial.job)) return;

    while (Date.now() - started < timeoutMs) {
      while (queue.length) {
        const event = queue.shift();
        const seq = Number(event.seq || 0);
        if (seq <= after) continue;
        after = seq;
        yield event;
        if (isTerminalEvent(event)) return;
      }
      if (closed || failed) break;
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, 15000);
      });
    }
  } catch {
    // Fall back to the durable HTTP event log without surfacing transport details to users.
  } finally {
    if (ws && ws.readyState < 2) ws.close();
  }

  yield* pollEvents(request, jobId, { ...options, after, intervalMs: fallbackIntervalMs });
}

function realtimeDeviceUrl(apiBase, deviceId, role) {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/v1/realtime/devices/${encodeURIComponent(deviceId)}`;
  url.search = `?role=${encodeURIComponent(role)}`;
  return url.toString();
}

function isTerminalJob(job) {
  return job && !["queued", "pending", "running"].includes(job.status);
}

function isTerminalEvent(event) {
  return ["completed", "failed", "cancelled"].includes(event?.type);
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
