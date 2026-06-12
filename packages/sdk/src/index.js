export const BRIDGE_SDK_VERSION = "0.1.0";

export const BridgeErrorCodes = Object.freeze({
  already_authorized: "already_authorized",
  authorization_import_proof_required: "authorization_import_proof_required",
  authorization_paused: "authorization_paused",
  authorization_revoked: "authorization_revoked",
  authorization_scope_denied: "authorization_scope_denied",
  bridge_cloud_unavailable: "bridge_cloud_unavailable",
  connect_intent_not_found: "connect_intent_not_found",
  delegated_authorization_proof_mismatch: "delegated_authorization_proof_mismatch",
  delegated_device_mismatch: "delegated_device_mismatch",
  desktop_authorization_required: "desktop_authorization_required",
  desktop_claim_required: "desktop_claim_required",
  device_not_found: "device_not_found",
  device_offline: "device_offline",
  device_queue_full: "device_queue_full",
  idempotency_key_conflict: "idempotency_key_conflict",
  install_id_required: "install_id_required",
  invalid_authorization_import_proof: "invalid_authorization_import_proof",
  invalid_authorization_policy: "invalid_authorization_policy",
  invalid_authorization_status: "invalid_authorization_status",
  invalid_connect_intent: "invalid_connect_intent",
  invalid_content_type: "invalid_content_type",
  invalid_job: "invalid_job",
  invalid_json: "invalid_json",
  invalid_origin: "invalid_origin",
  job_not_found: "job_not_found",
  local_policy_denied: "local_policy_denied",
  not_found: "not_found",
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
  unsupported_job_kind: "unsupported_job_kind",
});

// Human-readable fallback messages, keyed by error code. Used when the worker
// did not return a `message` so BridgeError.message is not just a copy of the
// code. `.code` always stays the raw machine code.
export const BRIDGE_ERROR_MESSAGES = Object.freeze({
  already_authorized: "该账号已授权，无需再次授权",
  authorization_import_proof_required: "缺少授权导入凭证（proof_token）",
  authorization_paused: "该账号授权已被用户暂停，请引导用户恢复授权",
  authorization_revoked: "该账号授权已被移除，请重新走授权流程",
  authorization_scope_denied: "本次任务超出了该授权允许的范围",
  bridge_cloud_unavailable: "Bridge 云端暂时不可用，请稍后重试",
  bridge_ready_timeout: "等待设备就绪超时",
  connect_intent_not_found: "找不到该连接意图（可能已消费或过期）",
  delegated_authorization_proof_mismatch: "授权凭证与当前账号/设备不匹配",
  delegated_device_mismatch: "请求的设备与签名中的设备不一致",
  desktop_claim_required: "该连接意图只能由桌面端 claim，浏览器不能 claim",
  device_not_found: "找不到该设备（可能不存在或已撤销）",
  device_offline: "目标设备当前离线，正在重连，请稍后重试",
  device_queue_full: "该设备的任务队列已满，请稍后重试",
  idempotency_key_conflict: "相同 requestKey 但请求体不同，请换新的 requestKey",
  install_id_required: "桌面端 claim 缺少 install_id",
  invalid_authorization_import_proof: "授权导入凭证无效、已使用或已过期",
  invalid_authorization_policy: "授权策略参数不合法",
  invalid_authorization_status: "授权状态值不合法（只能是 active 或 paused）",
  invalid_connect_intent: "连接意图不存在、已消费或已过期，请重新创建",
  invalid_content_type: "写请求必须使用 application/json",
  invalid_job: "任务参数不合法",
  invalid_json: "请求体不是合法 JSON",
  invalid_origin: "请求来源不在该产品的 origin 白名单内",
  job_not_found: "找不到该任务",
  local_policy_denied: "桌面端本地策略拒绝了该越权任务",
  not_found: "请求的资源不存在",
  product_delegation_body_hash_invalid: "请求体哈希与实际请求体不一致",
  product_delegation_not_configured: "云端未为该产品配置委托 secret",
  product_delegation_replay: "该 nonce 已被使用，请用新的 nonce 重试",
  product_delegation_signature_invalid: "委托签名校验失败，请逐字段核对 8 行（注意 path 含 query）与 secret",
  product_delegation_timestamp_invalid: "委托请求时间戳超出允许偏移，请同步后端时钟",
  product_delegation_unauthorized: "委托签名头缺失或身份无效",
  product_not_authorized: "该产品对此账号没有 active 授权，请走授权流程",
  product_origin_mismatch: "Origin 与 product_id 不匹配",
  product_queue_full: "该产品的任务队列已满，请稍后重试",
  request_body_too_large: "请求体超出大小限制",
  scope_insufficient: "该任务类型不在产品能力范围内",
  unsupported_job_kind: "不支持的任务类型（kind）",
  unauthorized: "未登录或会话无效",
});

export function bridgeErrorMessageForCode(code, status = 0) {
  return BRIDGE_ERROR_MESSAGES[code] || (status ? `Bridge API ${status}` : "bridge_error");
}

export class BridgeError extends Error {
  constructor(message, options = {}) {
    const code = stringValue(options.code, 160) || "bridge_error";
    const status = Number.isFinite(Number(options.status)) ? Number(options.status) : 0;
    const text = stringValue(message, 300);
    // Fall back to a human-readable, code-mapped message when the caller passed
    // nothing or just a copy of the code itself.
    const resolved = text && text !== code
      ? text
      : (BRIDGE_ERROR_MESSAGES[code] || text || (status ? `Bridge API ${status}` : "bridge_error"));
    super(resolved);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
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
  const state = bridgeStateModel(snapshot, stringValue(snapshot?.product_id || snapshot?.productId, 120));
  const account = bridgePreferredAccount(state);
  const install = objectValue(installTarget);
  const installed = Boolean(account?.current_device)
    || arrayValue(snapshot?.devices).some((device) => objectValue(device).installed !== false)
    || account?.authorization?.status === "active";
  const authorizationStatus = account?.authorization?.status || "missing";
  const authorized = authorizationStatus === "active";
  const connected = authorized && account?.connected === true;
  const authorization = {
    status: authorizationStatus,
    authorized,
    action: authorizationStatus === "paused"
      ? "resume_authorization"
      : authorized
        ? "manage_authorization"
        : "authorize_product",
  };
  const connection = {
    state: connected ? "connected" : authorizationStatus === "active" ? "reconnecting" : "offline",
    connected,
    action: connected ? "ready" : authorizationStatus === "active" ? "wait_for_device" : "authorize_product",
  };

  return {
    ready: connected,
    download: {
      state: installed ? "available" : "needed",
      available: true,
      downloaded: installed,
      action: installed ? "open_bridge" : "download_bridge",
      downloadUrl: stringValue(install.downloadUrl || install.download_url, 500) || null,
      openUrl: stringValue(install.openUrl || install.open_url, 200) || bridgeDesktopInstallDefaults.macos.openUrl,
    },
    authorization,
    connection,
    nextAction: connected
      ? "ready"
      : !installed
        ? "download_bridge"
        : authorization.action === "manage_authorization"
          ? connection.action
          : authorization.action,
  };
}

export function bridgeDelegatedAccountStatusModel(payload = {}) {
  const state = bridgeStateModel(payload);
  const account = bridgePreferredAccount(state);
  return {
    ready: Boolean(account?.authorization?.status === "active" && account.connected),
    connected: account?.connected === true,
    account: account?.account || null,
    authorization: account?.authorization || null,
    current_device: account?.current_device || null,
    accounts: state.accounts,
  };
}

export function bridgeDelegatedConnectIntentStatusModel(payload = {}, token = "") {
  const data = objectValue(payload);
  const intent = objectValue(data.connect_intent || data.connectIntent);
  const authorization = firstObject(data.authorization);
  const device = firstObject(data.device);
  const deviceId = stringValue(intent.device_id || intent.deviceId, 200) || (device ? stringValue(device.id, 200) : "");
  const account = normalizeBridgeStateAccount({
    account: data.account || data.user || null,
    authorization,
    current_device: device,
    connected: Boolean(deviceId && device && authorization?.status === "active" && deviceOnline(device)),
  });

  return {
    ready: account.authorization?.status === "active" && account.connected,
    authorized: account.authorization?.status === "active",
    connected: account.connected,
    account: account.account,
    current_device: account.current_device,
    authorization: account.authorization,
    accounts: account.account || account.authorization || account.current_device ? [account] : [],
    intentId: stringValue(token, 300) || stringValue(data.token, 300) || null,
    expiresAt: stringValue(intent.expires_at || intent.expiresAt, 80) || null,
    deepLink: stringValue(data.deep_link || data.deepLink, 500) || null,
  };
}

export function bridgeSnapshotStatusForDevice(device = {}) {
  return deviceOnline(device) ? "connected" : "reconnecting";
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
  const readState = async () => bridgeStateModel(
    await request("GET", bridgeStatePath(productId)),
    productId,
  );
  const listAuthorization = async (input = {}) => normalizeAuthorizationResponse(
    await request("GET", authorizationPath(productId, input)),
    productId,
  );
  const setAuthorizationStatus = async (status, input = {}) => {
    const value = normalizeAuthorizationInput(input);
    const body = {
      status,
      ...(value.policy ? { policy: value.policy } : {}),
    };
    try {
      return normalizeAuthorizationResponse(
        await request("PATCH", authorizationPath(productId, value), body),
        productId,
      );
    } catch (error) {
      if (
        status === "active"
        && (value.deviceId || value.device_id)
        && error instanceof BridgeError
        && (error.status === 404 || error.status === 405)
      ) {
        return normalizeAuthorizationResponse(
          await request("POST", `/v1/products/${encodeURIComponent(productId)}/authorization/request`, {
            device_id: value.deviceId || value.device_id,
            policy: value.policy || {},
          }),
          productId,
        );
      }
      throw error;
    }
  };
  const removeAuthorization = async (input = {}) => normalizeAuthorizationResponse(
    await request("DELETE", authorizationPath(productId, input)),
    productId,
  );
  const createAuthorizationIntent = async (input = {}) =>
    request("POST", "/v1/connect-intents", {
      product_id: input.productId || input.product_id || productId,
      device_name: input.deviceName || input.device_name || "Panda Bridge Desktop",
      policy: normalizeAuthorizationPolicyRequest(input.permissions || input.permission || input.policy || bridgeDefaultAuthorizationPolicy()),
    });
  const authorization = {
    list: listAuthorization,
    authorize: (input = {}) => setAuthorizationStatus("active", input),
    pause: (input = {}) => setAuthorizationStatus("paused", input),
    resume: (input = {}) => setAuthorizationStatus("active", input),
    remove: removeAuthorization,
    createIntent: createAuthorizationIntent,
  };

  return {
    productId,
    state: readState,
    watchState: (input = {}) => watchBridgeState(request, apiBase, { ...input, productId }),
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
          policy: normalizeAuthorizationPolicyRequest(input.permissions || input.permission || input.policy || bridgeDefaultAuthorizationPolicy()),
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
    authorization,
    products: {
      list: () => request("GET", "/v1/products"),
      requestAuthorization: (deviceId, policy = {}) => authorization.authorize({ deviceId, policy }),
      authorization: (deviceId) => authorization.list({ deviceId }),
      revokeAuthorization: (deviceId) => authorization.remove({ deviceId }),
      pauseAuthorization: (deviceId) => authorization.pause({ deviceId }),
      resumeAuthorization: (deviceId) => authorization.resume({ deviceId }),
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

function bridgeDefaultAuthorizationPolicy(overrides = {}) {
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
    ...objectValue(overrides),
  };
  delete policy.display;
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

export function bridgeStateModel(payload = {}, productId = "") {
  const data = objectValue(payload);
  const product = firstObject(data.product) || null;
  const normalizedProductId = stringValue(
    productId || data.product_id || data.productId || product?.id,
    120,
  ) || null;
  const install = normalizeStateInstall(data.install);
  const accounts = normalizeBridgeStateAccounts(data);
  const readyAccount = accounts.find((account) => account.authorization?.status === "active" && account.connected);
  const currentAccount = readyAccount
    || accounts.find((account) => account.authorization?.status === "active")
    || accounts.find((account) => account.authorization?.status === "paused")
    || accounts[0]
    || null;

  return {
    ...(normalizedProductId ? { product_id: normalizedProductId } : {}),
    ...(product ? { product } : {}),
    install,
    accounts,
    ready: Boolean(readyAccount),
    current_account: currentAccount,
  };
}

function normalizeBridgeStateAccounts(data = {}) {
  const value = objectValue(data);
  const directAccounts = arrayValue(value.accounts)
    .map(normalizeBridgeStateAccount)
    .filter((account) => account.account || account.authorization || account.current_device);
  if (directAccounts.length) return directAccounts;
  // An explicit (present) accounts array is authoritative — even when empty.
  // The worker returns accounts: [] after a removed/revoked authorization, and
  // the account must then disappear from state instead of being re-synthesized
  // from a still-online device row. Only synthesize when accounts is absent.
  if (Array.isArray(value.accounts)) return [];

  const rootDevice = normalizeStateDevice(value.device);
  const devices = [
    ...(rootDevice ? [rootDevice] : []),
    ...arrayValue(value.devices).map((device) => normalizeStateDevice(device)).filter(Boolean),
  ];
  const authorizedDevices = arrayValue(value.authorized_devices || value.authorizedDevices)
    .map((device) => normalizeStateDevice(device))
    .filter(Boolean);
  const authorizations = arrayValue(value.authorizations).map(normalizeBridgeStateAuthorization).filter(Boolean);
  const selectedDevice = normalizeStateDevice(value.selected_device || value.selectedDevice)
    || normalizeStateDevice(value.current_device || value.currentDevice)
    || authorizedDevices.find((device) => deviceOnline(device))
    || authorizedDevices[0]
    || devices.find((device) => deviceOnline(device))
    || devices[0]
    || null;
  const selectedDeviceId = selectedDevice ? stringValue(selectedDevice.id, 200) : "";
  const authorization = normalizeBridgeStateAuthorization(value.authorization)
    || authorizations.find((item) => {
      const raw = objectValue(item);
      return selectedDeviceId && stringValue(raw.device_id || raw.deviceId, 200) === selectedDeviceId;
    })
    || authorizations[0]
    || legacyAuthorizationForState(value.bridge_state || value.state || value.status);
  const account = normalizeAccount(value.account || value.user);

  if (!account && !authorization && !selectedDevice) return [];
  return [normalizeBridgeStateAccount({
    account,
    authorization,
    current_device: selectedDevice,
    connected: authorization?.status === "active" && selectedDevice && deviceOnline(selectedDevice),
  })];
}

function normalizeBridgeStateAccount(input = {}) {
  const value = objectValue(input);
  const account = normalizeAccount(value.account || value.user);
  const authorization = normalizeBridgeStateAuthorization(value.authorization);
  const currentDevice = normalizeStateDevice(value.current_device || value.currentDevice || value.device || value.selected_device || value.selectedDevice);
  const active = authorization?.status === "active";
  const connected = active && (
    value.connected === true
    || stringValue(value.connection, 40) === "connected"
    || deviceOnline(currentDevice)
  );
  return {
    account,
    authorization,
    connected,
    current_device: currentDevice,
  };
}

function normalizeBridgeStateAuthorization(input = {}) {
  const value = objectValue(input);
  const status = normalizeAuthorizationStatus(value.status);
  if (!status) return null;
  return {
    ...(stringValue(value.id, 200) ? { id: stringValue(value.id, 200) } : {}),
    ...(stringValue(value.device_id || value.deviceId, 200)
      ? { device_id: stringValue(value.device_id || value.deviceId, 200) }
      : {}),
    status,
    ...(stringValue(value.authorized_at || value.authorizedAt || value.created_at || value.createdAt, 100)
      ? { authorized_at: stringValue(value.authorized_at || value.authorizedAt || value.created_at || value.createdAt, 100) }
      : {}),
    ...(stringValue(value.updated_at || value.updatedAt, 100)
      ? { updated_at: stringValue(value.updated_at || value.updatedAt, 100) }
      : {}),
    ...(stringValue(value.origin || value.source_origin || value.sourceOrigin, 300)
      ? { origin: stringValue(value.origin || value.source_origin || value.sourceOrigin, 300) }
      : {}),
  };
}

function normalizeAuthorizationStatus(status) {
  const value = stringValue(status, 40);
  if (value === "active" || value === "paused" || value === "revoked") return value;
  return "";
}

function legacyAuthorizationForState(state) {
  const value = stringValue(state, 80);
  if (value === "ready" || value === "authorized_offline" || value === "connected" || value === "device_offline") {
    return { status: "active" };
  }
  if (value === "revoked") return { status: "revoked" };
  return null;
}

function normalizeAccount(input = {}) {
  const value = objectValue(input);
  if (!hasObjectKeys(value)) return null;
  return {
    ...(stringValue(value.id || value.account_id || value.accountId, 200)
      ? { id: stringValue(value.id || value.account_id || value.accountId, 200) }
      : {}),
    ...(stringValue(value.email, 320) ? { email: stringValue(value.email, 320) } : {}),
    ...(stringValue(value.display_name || value.displayName || value.name, 200)
      ? { display_name: stringValue(value.display_name || value.displayName || value.name, 200) }
      : {}),
  };
}

function normalizeStateInstall(input = {}) {
  const value = objectValue(input);
  const fallback = bridgeDesktopInstallTarget();
  return {
    download_url: stringValue(value.download_url || value.downloadUrl, 500) || fallback.downloadUrl,
    version: stringValue(value.version, 80) || fallback.version || BRIDGE_SDK_VERSION,
    sha256: stringValue(value.sha256, 100) || fallback.sha256,
    platform: stringValue(value.platform, 40) || fallback.platform,
    open_url: stringValue(value.open_url || value.openUrl, 200) || fallback.openUrl,
  };
}

function normalizeAuthorizationResponse(payload = {}, productId = "") {
  const data = objectValue(payload);
  if (Array.isArray(data.accounts)) {
    const state = bridgeStateModel(data, productId);
    const account = bridgePreferredAccount(state);
    return {
      ...state,
      authorization: account?.authorization || null,
      account: account?.account || null,
      connected: account?.connected === true,
      current_device: account?.current_device || null,
    };
  }
  const authorization = normalizeBridgeStateAuthorization(data.authorization);
  const account = normalizeAccount(data.account || data.user);
  const currentDevice = normalizeStateDevice(data.current_device || data.currentDevice || data.device || data.selected_device || data.selectedDevice);
  const connected = authorization?.status === "active" && (data.connected === true || deviceOnline(currentDevice));
  const accounts = arrayValue(data.authorizations).length || account || authorization || currentDevice
    ? normalizeBridgeStateAccounts({
      account,
      authorization,
      current_device: currentDevice,
      authorizations: data.authorizations,
      devices: data.devices,
      authorized_devices: data.authorized_devices || data.authorizedDevices,
    })
    : [];
  return {
    ...(productId ? { product_id: productId } : {}),
    ...(firstObject(data.product) ? { product: firstObject(data.product) } : {}),
    authorization,
    account,
    connected,
    current_device: currentDevice,
    accounts,
    ...(Number.isFinite(Number(data.cancelled_jobs ?? data.cancelledJobs))
      ? { cancelled_jobs: Number(data.cancelled_jobs ?? data.cancelledJobs) }
      : {}),
  };
}

function normalizeAuthorizationInput(input = {}) {
  if (typeof input === "string") return { deviceId: input };
  return objectValue(input);
}

function authorizationPath(productId, input = {}) {
  const value = normalizeAuthorizationInput(input);
  const params = new URLSearchParams();
  const deviceId = stringValue(value.deviceId || value.device_id, 200);
  const accountId = stringValue(value.accountId || value.account_id, 200);
  if (deviceId) params.set("device_id", deviceId);
  if (accountId) params.set("account_id", accountId);
  const query = params.toString();
  return `/v1/products/${encodeURIComponent(productId)}/authorization${query ? `?${query}` : ""}`;
}

function bridgeReadyAccount(state = {}) {
  return arrayValue(state.accounts)
    .map(objectValue)
    .find((account) => objectValue(account.authorization).status === "active" && account.connected === true)
    || null;
}

function bridgePreferredAccount(state = {}) {
  const accounts = arrayValue(state.accounts).map(objectValue);
  return bridgeReadyAccount(state)
    || accounts.find((account) => objectValue(account.authorization).status === "active")
    || accounts.find((account) => objectValue(account.authorization).status === "paused")
    || accounts[0]
    || null;
}

function bridgeReadyAction(state = {}) {
  const account = bridgePreferredAccount(state);
  const authorization = objectValue(account?.authorization);
  if (!account) return { kind: "authorize", reason: "authorization_required" };
  if (authorization.status === "paused") return { kind: "resume_authorization", reason: "authorization_paused" };
  if (authorization.status === "revoked" || !authorization.status) return { kind: "authorize", reason: "authorization_required" };
  if (authorization.status === "active" && account.connected !== true) return { kind: "wait_for_device", reason: "device_reconnecting" };
  return null;
}

async function ensureBridgeReady(request, productId, input = {}) {
  const timeoutMs = Number(input.timeoutMs || input.timeout_ms || 120000);
  const intervalMs = Number(input.intervalMs || input.interval_ms || 3000);
  const started = Date.now();
  let current = bridgeStateModel(await request("GET", bridgeStatePath(productId)), productId);
  let account = bridgeReadyAccount(current);
  if (account) return { state: current, ready: true, action: null, account };

  const immediate = bridgeReadyAction(current);
  const shouldWait = input.wait === true || input.waitForReady === true || input.wait_for_ready === true;
  if (!shouldWait || immediate?.kind !== "wait_for_device") {
    return { state: current, ready: false, action: immediate, account: bridgePreferredAccount(current) };
  }

  for await (const state of watchBridgeState(request, "", { intervalMs, timeoutMs, initialState: current, productId })) {
    current = state;
    account = bridgeReadyAccount(state);
    if (account) return { state, ready: true, action: null, account };
    if (Date.now() - started >= timeoutMs) break;
  }
  throw new BridgeError("bridge_ready_timeout", {
    code: "bridge_ready_timeout",
    status: 0,
    payload: { timeout_ms: timeoutMs, ready: false },
  });
}

async function* watchBridgeState(request, apiBase, input = {}) {
  const intervalMs = Number(input.intervalMs || input.interval_ms || 3000);
  const timeoutMs = input.timeoutMs || input.timeout_ms;
  const started = Date.now();
  const productId = input.productId || input.product_id;
  let current = bridgeStateModel(input.initialState || await request("GET", bridgeStatePath(productId)), productId);

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
      current = bridgeStateModel(await request("GET", bridgeStatePath(productId)), productId);
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
  const accountDevices = arrayValue(state.accounts)
    .map((account) => objectValue(account).current_device || objectValue(account).currentDevice)
    .map(objectValue)
    .filter(hasObjectKeys);
  const legacyDevices = arrayValue(state.devices).map(objectValue);
  const devices = accountDevices.length ? accountDevices : legacyDevices;
  const selected = devices.find((device) => device.current === true && deviceOnline(device))
    || devices.find(deviceOnline)
    || devices.find((device) => device.current === true)
    || devices[0];
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

function normalizeStateDevice(device = {}, current = false) {
  const value = objectValue(device);
  if (!hasObjectKeys(value)) return null;
  return {
    id: stringValue(value.id, 200) || null,
    name: stringValue(value.name || value.device_name || value.deviceName, 200) || null,
    online: deviceOnline(value),
    last_seen_at: stringValue(value.last_seen_at || value.lastSeenAt, 100) || null,
    current: value.current === true || current,
  };
}

function deviceOnline(device = {}) {
  const value = objectValue(device);
  return value.online === true || stringValue(value.status, 40) === "online" || stringValue(value.connection, 40) === "connected";
}

function bridgeErrorFromResponse(status, payload = {}) {
  const data = objectValue(payload);
  const code = stringValue(data.error || data.code || data.message, 160) || `bridge_http_${status}`;
  // Pass the worker-provided message when present; otherwise BridgeError maps the
  // code to a human-readable message so `.message` is never just the raw code.
  return new BridgeError(stringValue(data.message, 300), {
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
    const authorizationPayload = authorization.payload?.authorization;
    if (authorization.ok && authorizationPayload?.status === "active") {
      result.authorizations.push(authorizationPayload);
      result.authorized_devices.push(device);
    } else if (authorization.ok && authorizationPayload?.status === "paused") {
      result.authorizations.push(authorizationPayload);
    } else if (!authorization.ok) {
      result.authorizations.push({ device_id: device.id, error: authorization.error });
    }
  }

  if (candidateDevices.length && !result.authorized_devices.length) {
    if (result.authorizations.some((authorization) => authorization?.status === "paused")) {
      addPreflightIssue(result, "authorization_paused", "This product authorization is paused.", "resume_authorization");
    } else {
      addPreflightIssue(result, "product_not_authorized", "This product is not authorized for an online Bridge device.", "authorize_product");
    }
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
    resume_authorization: "Resume this product authorization.",
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
  if (!Object.keys(policy).length) return bridgeDefaultAuthorizationPolicy();
  if (policy.fullAccess === true || policy.full_access === true || policy.preset === "full-access") {
    return bridgeDefaultAuthorizationPolicy(policy);
  }
  return policy;
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
