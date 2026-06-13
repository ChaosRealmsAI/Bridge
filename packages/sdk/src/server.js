import {
  BridgeError,
  bridgeStateModel,
} from "./index.js";

// BridgeError maps known codes to human-readable messages when the worker did
// not return one, so the duplicated message-fallback logic stays in one place.

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
      return bridgeStateModel(await request("GET", statePath, null, { userId, deviceId }), productId);
    } catch (error) {
      if (!(error instanceof BridgeError) || error.status !== 404) throw error;
      const legacy = await request("GET", `/v1/products/${encodeURIComponent(productId)}/delegated/status`, null, { userId, deviceId });
      return bridgeStateModel(legacy, productId);
    }
  };
  const listAuthorization = async (input = {}) => normalizeAuthorizationResponse(
    await request("GET", delegatedAuthorizationPath(productId, input), null, input),
    productId,
  );
  const setAuthorizationStatus = async (status, input = {}) => normalizeAuthorizationResponse(
    await request("PATCH", delegatedAuthorizationPath(productId, input), { status }, input),
    productId,
  );
  const removeAuthorization = async (input = {}) => normalizeAuthorizationResponse(
    await request("DELETE", delegatedAuthorizationPath(productId, input), null, input),
    productId,
  );
  const authorization = Object.assign(
    (input = {}) => listAuthorization(input),
    {
      list: listAuthorization,
      authorize: (input = {}) => setAuthorizationStatus("active", input),
      pause: (input = {}) => setAuthorizationStatus("paused", input),
      resume: (input = {}) => setAuthorizationStatus("active", input),
      remove: removeAuthorization,
      revoke: removeAuthorization,
    },
  );

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
    authorization,
    pause: authorization.pause,
    resume: authorization.resume,
    revoke: authorization.remove,
    createRelayEnvelope: (input = {}) => request(
      "POST",
      `/v1/products/${encodeURIComponent(productId)}/delegated/relay/envelopes`,
      normalizeDelegatedRelayEnvelope(input, productId),
      input,
    ),
    listRelayEnvelopes: (input = {}) => {
      const params = new URLSearchParams();
      const deviceId = stringValue(input.deviceId || input.device_id, 200);
      const channelId = stringValue(input.channelId || input.channel_id, 200);
      const afterSeq = input.afterSeq ?? input.after_seq;
      if (deviceId) params.set("device_id", deviceId);
      if (channelId) params.set("channel_id", channelId);
      if (afterSeq != null) params.set("after_seq", String(afterSeq));
      const query = params.toString();
      return request("GET", `/v1/products/${encodeURIComponent(productId)}/delegated/relay/envelopes${query ? `?${query}` : ""}`, null, input);
    },
    ackRelayEnvelope: (envelopeId, input = {}) => {
      return request(
        "POST",
        `/v1/products/${encodeURIComponent(productId)}/delegated/relay/envelopes/${encodeURIComponent(envelopeId)}/ack`,
        {},
        input,
      );
    },
  };
}

function normalizeDelegatedRelayEnvelope(input = {}, productId = "") {
  return {
    envelope_version: input.envelopeVersion || input.envelope_version || "relay-envelope-v1",
    product_id: productId,
    device_id: input.deviceId || input.device_id,
    channel_id: input.channelId || input.channel_id,
    direction: input.direction || "product_to_device",
    seq: input.seq || 0,
    request_key: input.requestKey || input.request_key || null,
    ciphertext: input.ciphertext || "",
    aad: input.aad || "",
    nonce: input.nonce || input.iv || "",
    algorithm: input.algorithm || input.alg || "",
    sender_key_id: input.senderKeyId || input.sender_key_id || "",
    recipient_key_id: input.recipientKeyId || input.recipient_key_id || "",
    ttl_ms: input.ttlMs || input.ttl_ms || undefined,
    meta: objectValue(input.meta),
  };
}

function delegatedAuthorizationPath(productId, input = {}) {
  const params = new URLSearchParams();
  const deviceId = stringValue(input.deviceId || input.device_id, 200);
  const accountId = stringValue(input.accountId || input.account_id, 200);
  if (deviceId) params.set("device_id", deviceId);
  if (accountId) params.set("account_id", accountId);
  const query = params.toString();
  return `/v1/products/${encodeURIComponent(productId)}/delegated/authorization${query ? `?${query}` : ""}`;
}

function normalizeAuthorizationResponse(payload = {}, productId = "") {
  const data = objectValue(payload);
  if (Array.isArray(data.accounts)) {
    const state = bridgeStateModel(data, productId);
    const account = state.current_account || null;
    return {
      ...state,
      authorization: account?.authorization || null,
      account: account?.account || null,
      connected: account?.connected === true,
      current_device: account?.current_device || null,
    };
  }
  const authorization = normalizeAuthorization(data.authorization);
  const account = firstObject(data.account || data.user);
  const device = normalizeDevice(data.current_device || data.currentDevice || data.device || data.selected_device || data.selectedDevice);
  const connected = authorization?.status === "active" && deviceOnline(device);
  const state = bridgeStateModel({
    product_id: productId,
    product: data.product,
    accounts: authorization || account || device ? [{
      account,
      authorization,
      current_device: device,
      connected,
    }] : [],
  }, productId);
  return {
    ...state,
    authorization,
    account,
    connected,
    current_device: device,
    ...(Number.isFinite(Number(data.cancelled_jobs ?? data.cancelledJobs))
      ? { cancelled_jobs: Number(data.cancelled_jobs ?? data.cancelledJobs) }
      : {}),
  };
}

function normalizeAuthorization(input = {}) {
  const value = objectValue(input);
  const status = stringValue(value.status, 40);
  if (!["active", "paused", "revoked"].includes(status)) return null;
  return {
    ...(stringValue(value.id, 200) ? { id: stringValue(value.id, 200) } : {}),
    ...(stringValue(value.device_id || value.deviceId, 200) ? { device_id: stringValue(value.device_id || value.deviceId, 200) } : {}),
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

function normalizeDevice(input = {}) {
  const value = objectValue(input);
  if (!Object.keys(value).length) return null;
  return {
    id: stringValue(value.id, 200) || null,
    name: stringValue(value.name || value.device_name || value.deviceName, 200) || null,
    online: deviceOnline(value),
    last_seen_at: stringValue(value.last_seen_at || value.lastSeenAt, 100) || null,
    current: value.current === true,
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

function firstObject(value) {
  const object = objectValue(value);
  return Object.keys(object).length ? object : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
