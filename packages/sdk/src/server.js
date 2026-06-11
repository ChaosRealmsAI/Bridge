import {
  BridgeError,
  bridgeDelegatedAccountStatusModel,
  bridgeDesktopInstallTarget,
} from "./index.js";

export function createBridgeServerClient(options = {}) {
  const apiBase = stringValue(options.apiBase).replace(/\/$/, "");
  const productId = stringValue(options.productId, 120);
  const secret = stringValue(options.secret, 12000);
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!apiBase) throw new Error("apiBase is required");
  if (!productId) throw new Error("productId is required");
  if (!secret) throw new Error("secret is required");
  if (!fetchImpl) throw new Error("fetch is required");

  const request = async (method, path, body, input = {}) => {
    const bodyText = body == null ? "" : JSON.stringify(body);
    const userId = stringValue(input.userId || input.user_id, 200);
    const deviceId = stringValue(input.deviceId || input.device_id || "account", 200);
    if (!userId) throw new Error("userId is required");
    const timestamp = typeof options.timestamp === "function" ? options.timestamp() : stringValue(options.timestamp, 100) || new Date().toISOString();
    const nonce = typeof options.nonce === "function" ? options.nonce() : stringValue(options.nonce, 160) || randomUUID();
    const bodyHash = await sha256Hex(bodyText);
    const signingPayload = [
      method.toUpperCase(),
      path,
      productId,
      userId,
      deviceId,
      timestamp,
      nonce,
      bodyHash,
    ].join("\n");
    const signature = await hmacSha256Hex(secret, signingPayload);
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-panda-bridge-product-id": productId,
        "x-panda-bridge-user-id": userId,
        "x-panda-bridge-device-id": deviceId,
        "x-panda-bridge-request-timestamp": timestamp,
        "x-panda-bridge-request-nonce": nonce,
        "x-panda-bridge-body-sha256": bodyHash,
        "x-panda-bridge-signature": signature,
      },
      body: bodyText || undefined,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) throw bridgeErrorFromResponse(response.status, payload);
    return payload;
  };

  const state = async (input = {}) => {
    const userId = input.userId || input.user_id;
    const deviceId = input.deviceId || input.device_id || "account";
    const statePath = `/v1/products/${encodeURIComponent(productId)}/delegated/state`;
    try {
      return await request("GET", statePath, null, { userId, deviceId });
    } catch (error) {
      if (!(error instanceof BridgeError) || error.status !== 404) throw error;
      const legacy = await request("GET", `/v1/products/${encodeURIComponent(productId)}/delegated/status`, null, { userId, deviceId });
      return legacyDelegatedStatusToBridgeState(legacy, productId);
    }
  };

  return {
    productId,
    state,
    account: state,
    createConnectIntent: (input = {}) => request(
      "POST",
      `/v1/products/${encodeURIComponent(productId)}/delegated/connect-intents`,
      {
        ...(input.account || input.user ? { account: input.account || input.user } : {}),
        device_name: input.deviceName || input.device_name || "Panda Bridge Desktop",
        policy: input.policy || input.permissions || {},
      },
      { userId: input.userId || input.user_id, deviceId: input.deviceId || input.device_id || "pending" },
    ),
    intentStatus: (token, input = {}) => request(
      "GET",
      `/v1/products/${encodeURIComponent(productId)}/delegated/connect-intents/${encodeURIComponent(token)}`,
      null,
      { userId: input.userId || input.user_id, deviceId: input.deviceId || input.device_id || "pending" },
    ),
    authorization: (input = {}) => request(
      "GET",
      `/v1/products/${encodeURIComponent(productId)}/delegated/authorization?device_id=${encodeURIComponent(input.deviceId || input.device_id || "")}`,
      null,
      input,
    ),
    revoke: (input = {}) => request(
      "DELETE",
      `/v1/products/${encodeURIComponent(productId)}/delegated/authorization?device_id=${encodeURIComponent(input.deviceId || input.device_id || "")}`,
      null,
      input,
    ),
    createJob: (input = {}) => request(
      "POST",
      `/v1/products/${encodeURIComponent(productId)}/delegated/jobs`,
      normalizeDelegatedJob(input, productId),
      input,
    ),
    jobEvents: (jobId, input = {}) => {
      const after = input.after == null ? "" : `?after=${encodeURIComponent(String(input.after))}`;
      return request("GET", `/v1/products/${encodeURIComponent(productId)}/delegated/jobs/${encodeURIComponent(jobId)}/events${after}`, null, input);
    },
  };
}

function normalizeDelegatedJob(input = {}, productId = "") {
  return {
    kind: input.kind,
    product_id: productId,
    device_id: input.deviceId || input.device_id,
    workspace_ref: input.workspaceRef ?? input.workspace_ref ?? null,
    request_key: input.requestKey || input.request_key || null,
    input: input.input || input.payload || {},
    policy: input.policy || {},
  };
}

function legacyDelegatedStatusToBridgeState(payload = {}, productId = "") {
  const model = bridgeDelegatedAccountStatusModel(payload);
  const devices = arrayValue(payload.devices).map((device) => normalizeStateDevice(device, model.deviceId));
  const state = model.ready
    ? "ready"
    : model.authorized
      ? "authorized_offline"
      : devices.length
        ? "not_authorized"
        : "no_device";
  return {
    bridge_state: state,
    product_id: productId,
    install: bridgeInstallModel(),
    devices,
    authorization: model.authorization,
    intent: null,
    actions: state === "ready" ? [] : bridgeActionsForState(state),
  };
}

function normalizeStateDevice(device = {}, selectedDeviceId = "") {
  const value = objectValue(device);
  const id = stringValue(value.id, 200);
  return {
    id,
    name: stringValue(value.name || value.device_name || value.deviceName, 200) || null,
    online: value.online === true || stringValue(value.status, 40) === "online",
    last_seen_at: stringValue(value.last_seen_at || value.lastSeenAt, 100) || null,
    current: id && id === selectedDeviceId,
  };
}

function bridgeActionsForState(state) {
  if (state === "no_device") return [{ kind: "download", url: bridgeInstallModel().downloadUrl }];
  if (state === "authorized_offline") return [{ kind: "open_desktop", url: bridgeInstallModel().openUrl }];
  if (state === "not_authorized") return [{ kind: "authorize" }];
  if (state === "authorization_pending") return [{ kind: "confirm_on_desktop" }];
  if (state === "no_session") return [{ kind: "login" }];
  return [];
}

function bridgeInstallModel() {
  const target = bridgeDesktopInstallTarget();
  return {
    download_url: target.downloadUrl,
    version: target.version,
    sha256: target.sha256,
    open_url: target.openUrl,
    platform: target.platform,
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

async function sha256Hex(value) {
  const bytes = await cryptoProvider().subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(bytes);
}

async function hmacSha256Hex(secret, value) {
  const crypto = cryptoProvider();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function randomUUID() {
  const crypto = cryptoProvider();
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function cryptoProvider() {
  if (globalThis.crypto?.subtle) return globalThis.crypto;
  throw new Error("WebCrypto is required");
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
