import {
  BRIDGE_PROTOCOL_VERSION,
  RELAY_ENVELOPE_VERSION,
  publicRelayEnvelope,
  relayEnvelopeRecord,
  validateRelayEnvelope,
} from "@panda-bridge/protocol";
import {
  BRIDGE_RUNTIME_CAPABILITY_REGISTRY,
  allProducts,
  officialProductOrigins,
  productById,
  scopeDangerMetadataFromCapabilities,
} from "./products.js";
import { legacyRuntimeApiRemovedPayload, isLegacyRuntimeRoute } from "./legacy-runtime.js";
import { requestPath } from "./router.js";

// Authorization epoch helper (relocated from the removed cap-token module).
function authorizationEpoch(authorization) {
  const value = Number(object(authorization).epoch ?? 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SESSION_LINK_TTL_MS = 1000 * 60 * 10;
const PAIRING_TTL_MS = 1000 * 60 * 10;
const CONNECT_INTENT_TTL_MS = 1000 * 60 * 10;
const AUTHORIZATION_IMPORT_PROOF_TTL_MS = 1000 * 60 * 5;
const DEVICE_ONLINE_GRACE_MS = 1000 * 90;
const DEVICE_HEARTBEAT_INTERVAL_MS = 1000 * 30;
const RELAY_ENVELOPE_TTL_MS = 1000 * 60 * 5;
const PASSWORD_MAX_FAILED_ATTEMPTS = 5;
const PASSWORD_ATTEMPT_WINDOW_MS = 1000 * 60 * 15;
const PASSWORD_LOCK_MS = 1000 * 60 * 15;
const DEVICE_TOKEN_TTL_MS = SESSION_TTL_MS;
const DEVICE_TOKEN_ROTATION_GRACE_MS = 1000 * 60 * 10;
const DEVICE_TOKEN_PREFIX = "pbd_";
const RELAY_DEVICE_MAX_UNACKED = 150;
const RELAY_ACCOUNT_MAX_UNACKED = 500;
const RELAY_PRODUCT_MAX_UNACKED = 300;
const RELAY_CHANNEL_MAX_UNACKED = 50;
const RELAY_QUEUE_RETRY_AFTER_MS = 3000;
const RELAY_CAPABILITY_REGISTRY = BRIDGE_RUNTIME_CAPABILITY_REGISTRY;
const RELAY_CAPABILITY_KINDS = Object.freeze(Object.keys(RELAY_CAPABILITY_REGISTRY));
const BRIDGE_DESKTOP_INSTALL = Object.freeze({
  platform: "macos",
  version: "panda-bridge-desktop-lite-v0.1",
  download_url: "https://assets.bridge.chaos-realms.cc/downloads/panda-bridge-macos.dmg",
  download_path: "/downloads/panda-bridge-macos.dmg",
  sha256: "e65e04f08373ffe2363616dc1426516b74f12123f52c71d7225af4bac7225962",
  open_url: "panda-bridge://open",
});
const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 512;
const MAX_JSON_BODY_LIMIT_BYTES = 1024 * 1024 * 2;
const memory = makeMemoryStore();

export function __bridgeTestMemorySnapshot() {
  return typeof memory.snapshot === "function" ? memory.snapshot() : {};
}

export function __bridgeTestRelayEnvelopeMatches(row, input, maxTtlMs = RELAY_ENVELOPE_TTL_MS) {
  const validation = validateRelayEnvelope(input);
  return validation.ok ? sameRelayEnvelope(row, validation.envelope, row?.idempotency_hash || "", maxTtlMs) : false;
}

export async function __bridgeTestConnectorRelayListPayload(env, rows, options = {}) {
  const listOptions = {
    afterSeq: Math.max(0, Number(options.afterSeq || 0)),
    limit: Math.max(1, Number(options.limit || 100)),
    waitMs: 0,
    includeAcked: options.includeAcked === true,
  };
  return relayListPayload(await connectorRelayListResult(env, rows, listOptions), listOptions);
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    try {
      env = requestScopedEnv(request, env);
      const originError = rejectBadOrigin(request, env);
      if (originError) return originError;
      if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), env);
      const { url, path } = requestPath(request, normalizePath);

      if (path === "/v1/health" && request.method === "GET") {
        return json({
          ok: true,
          protocol: BRIDGE_PROTOCOL_VERSION,
          env: env.BRIDGE_ENV || "local",
          storage: storageKind(env),
        }, env);
      }

      if (path === "/v1/diagnostics" && request.method === "GET") {
        return json(diagnosticsPayload(env), env);
      }

      if (isLegacyRuntimeRoute(request.method, path)) return legacyRuntimeApiRemoved(env);

      if (path === "/v1/sessions/password" && request.method === "POST") return await createPasswordSession(request, env);
      if (path === "/v1/sessions/guest" && request.method === "POST") return await createGuestSession(request, env);
      if (path === "/v1/sessions/share" && request.method === "POST") return await createSessionLink(request, env);
      if (path === "/v1/sessions/join" && request.method === "POST") return await joinSessionLink(request, env);
      if (path === "/v1/sessions/logout" && request.method === "POST") return await logoutSession(request, env);
      if (path === "/v1/session" && request.method === "GET") return await sessionResponse(request, env);
      if (path === "/v1/devices" && request.method === "GET") return await listDevices(request, env);
      const deviceMatch = path.match(/^\/v1\/devices\/([^/]+)$/);
      if (deviceMatch && request.method === "DELETE") return await revokeDevice(request, env, decodeURIComponent(deviceMatch[1]));
      if (path === "/v1/products" && request.method === "GET") return json({ items: allProducts(sourceOrigin(env), env) }, env);
      if (path === "/v1/devices/pairing-codes" && request.method === "POST") return await createPairingCode(request, env);
      if (path === "/v1/connectors/claim" && request.method === "POST") return await claimConnector(request, env);
      if (path === "/v1/connectors/heartbeat" && request.method === "POST") return await connectorHeartbeat(request, env);
      if (path === "/v1/connectors/token/rotate" && request.method === "POST") return await rotateConnectorToken(request, env);
      const connectorAuthMatch = path.match(/^\/v1\/connectors\/products\/([^/]+)\/authorization$/);
      if (connectorAuthMatch && request.method === "PATCH") return await updateConnectorAuthorization(request, env, decodeURIComponent(connectorAuthMatch[1]));
      if (connectorAuthMatch && request.method === "DELETE") return await revokeConnectorAuthorization(request, env, decodeURIComponent(connectorAuthMatch[1]));
      const connectorRelayKeyBootstrapMatch = path.match(/^\/v1\/connectors\/products\/([^/]+)\/relay-key-bootstrap$/);
      if (connectorRelayKeyBootstrapMatch && request.method === "GET") return await connectorRelayKeyBootstrap(request, env, decodeURIComponent(connectorRelayKeyBootstrapMatch[1]));
      if (path === "/v1/connectors/relay/envelopes" && request.method === "GET") return await connectorRelayEnvelopes(request, env);
      if (path === "/v1/connectors/relay/envelopes" && request.method === "POST") return await createConnectorRelayEnvelope(request, env, ctx);
      const connectorRelayAckMatch = path.match(/^\/v1\/connectors\/relay\/envelopes\/([^/]+)\/ack$/);
      if (connectorRelayAckMatch && request.method === "POST") return await ackConnectorRelayEnvelope(request, env, decodeURIComponent(connectorRelayAckMatch[1]));
      const realtimeDeviceMatch = path.match(/^\/v1\/realtime\/devices\/([^/]+)$/);
      if (realtimeDeviceMatch && request.method === "GET") return await realtimeDevice(request, env, decodeURIComponent(realtimeDeviceMatch[1]));

      if (path === "/v1/connect-intents" && request.method === "POST") return await createConnectIntent(request, env);
      if (path === "/v1/bridge/state" && request.method === "GET") return await bridgeState(request, env);
      const intentMatch = path.match(/^\/v1\/connect-intents\/([^/]+)$/);
      if (intentMatch && request.method === "GET") return await getConnectIntent(request, env, decodeURIComponent(intentMatch[1]));
      const intentClaimMatch = path.match(/^\/v1\/connect-intents\/([^/]+)\/claim$/);
      if (intentClaimMatch && request.method === "POST") return await claimConnectIntent(request, env, decodeURIComponent(intentClaimMatch[1]));
      const intentConfirmMatch = path.match(/^\/v1\/connect-intents\/([^/]+)\/confirm$/);
      if (intentConfirmMatch && request.method === "POST") return await confirmConnectIntent(request, env, decodeURIComponent(intentConfirmMatch[1]));

      const authMatch = path.match(/^\/v1\/products\/([^/]+)\/authorization$/);
      if (authMatch && request.method === "GET") return await productAuthorization(request, env, decodeURIComponent(authMatch[1]));
      const authRequestMatch = path.match(/^\/v1\/products\/([^/]+)\/authorization\/request$/);
      if (authRequestMatch && request.method === "POST") return await requestAuthorization(request, env, decodeURIComponent(authRequestMatch[1]));
      const authImportProofMatch = path.match(/^\/v1\/products\/([^/]+)\/authorization\/import-proof$/);
      if (authImportProofMatch && request.method === "POST") return await createAuthorizationImportProof(request, env, decodeURIComponent(authImportProofMatch[1]));
      if (authMatch && request.method === "PATCH") return await updateAuthorization(request, env, decodeURIComponent(authMatch[1]));
      if (authMatch && request.method === "DELETE") return await revokeAuthorization(request, env, decodeURIComponent(authMatch[1]));
      const productRelayKeyBootstrapMatch = path.match(/^\/v1\/products\/([^/]+)\/relay-key-bootstrap$/);
      if (productRelayKeyBootstrapMatch && request.method === "POST") return await createProductRelayKeyBootstrap(request, env, decodeURIComponent(productRelayKeyBootstrapMatch[1]));
      const productRelayMatch = path.match(/^\/v1\/products\/([^/]+)\/relay\/envelopes$/);
      if (productRelayMatch && request.method === "POST") return await createProductRelayEnvelope(request, env, decodeURIComponent(productRelayMatch[1]), ctx);
      if (productRelayMatch && request.method === "GET") return await listProductRelayEnvelopes(request, env, decodeURIComponent(productRelayMatch[1]));
      const productRelayAckMatch = path.match(/^\/v1\/products\/([^/]+)\/relay\/envelopes\/([^/]+)\/ack$/);
      if (productRelayAckMatch && request.method === "POST") return await ackProductRelayEnvelope(request, env, decodeURIComponent(productRelayAckMatch[1]), decodeURIComponent(productRelayAckMatch[2]));
      const delegatedAuthorizationMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/authorization$/);
      if (delegatedAuthorizationMatch && request.method === "GET") return await delegatedProductAuthorization(request, env, decodeURIComponent(delegatedAuthorizationMatch[1]));
      if (delegatedAuthorizationMatch && request.method === "PATCH") return await updateDelegatedProductAuthorization(request, env, decodeURIComponent(delegatedAuthorizationMatch[1]));
      if (delegatedAuthorizationMatch && request.method === "DELETE") return await revokeDelegatedProductAuthorization(request, env, decodeURIComponent(delegatedAuthorizationMatch[1]));
      const delegatedStatusMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/status$/);
      if (delegatedStatusMatch && request.method === "GET") return await delegatedProductStatus(request, env, decodeURIComponent(delegatedStatusMatch[1]));
      const delegatedStateMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/state$/);
      if (delegatedStateMatch && request.method === "GET") return await delegatedBridgeState(request, env, decodeURIComponent(delegatedStateMatch[1]));
      const delegatedRelayKeyBootstrapMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/relay-key-bootstrap$/);
      if (delegatedRelayKeyBootstrapMatch && request.method === "POST") return await createDelegatedProductRelayKeyBootstrap(request, env, decodeURIComponent(delegatedRelayKeyBootstrapMatch[1]));
      const delegatedAuthorizationClaimMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/authorization\/claim$/);
      if (delegatedAuthorizationClaimMatch && request.method === "POST") return await claimDelegatedProductAuthorization(request, env, decodeURIComponent(delegatedAuthorizationClaimMatch[1]));
      const delegatedConnectIntentMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/connect-intents$/);
      if (delegatedConnectIntentMatch && request.method === "POST") return await createDelegatedConnectIntent(request, env, decodeURIComponent(delegatedConnectIntentMatch[1]));
      const delegatedConnectIntentInspectMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/connect-intents\/([^/]+)$/);
      if (delegatedConnectIntentInspectMatch && request.method === "GET") return await getDelegatedConnectIntent(request, env, decodeURIComponent(delegatedConnectIntentInspectMatch[1]), decodeURIComponent(delegatedConnectIntentInspectMatch[2]));
      const delegatedProductRelayMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/relay\/envelopes$/);
      if (delegatedProductRelayMatch && request.method === "POST") return await createDelegatedProductRelayEnvelope(request, env, decodeURIComponent(delegatedProductRelayMatch[1]), ctx);
      if (delegatedProductRelayMatch && request.method === "GET") return await listDelegatedProductRelayEnvelopes(request, env, decodeURIComponent(delegatedProductRelayMatch[1]));
      const delegatedProductRelayAckMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/relay\/envelopes\/([^/]+)\/ack$/);
      if (delegatedProductRelayAckMatch && request.method === "POST") return await ackDelegatedProductRelayEnvelope(request, env, decodeURIComponent(delegatedProductRelayAckMatch[1]), decodeURIComponent(delegatedProductRelayAckMatch[2]));
      if (["GET", "HEAD"].includes(request.method) && !path.startsWith("/v1/")) return await assetResponse(request, env);
      return notFound(env);
    } catch (error) {
      if (error?.status) return json(publicErrorPayload(error), env, error.status);
      return json({ error: "internal_error" }, env, 500);
    }
  },
  async scheduled(_event, env = {}, ctx = {}) {
    const cleanup = cleanupExpiredRows(env);
    if (ctx?.waitUntil) {
      ctx.waitUntil(cleanup);
      return;
    }
    await cleanup;
  },
};

export class BridgeDeviceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.desktop = null;
    this.webs = new Map();
    this.nextSocketId = 1;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && (request.headers.get("upgrade") || "").toLowerCase() === "websocket") {
      return this.acceptSocket(request);
    }
    if (request.method === "POST" && url.pathname === "/notify") {
      const message = await request.json();
      return new Response(JSON.stringify(this.notify(message), null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  }

  acceptSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const socketId = String(this.nextSocketId++);
    const role = request.headers.get("x-bridge-role") || "web";
    const userId = request.headers.get("x-bridge-user-id") || "";
    const deviceId = request.headers.get("x-bridge-device-id") || "";
    const meta = { id: socketId, role, userId, deviceId, connectedAt: new Date().toISOString() };
    server.accept();
    if (role === "desktop") {
      if (this.desktop?.socket) this.safeClose(this.desktop.socket, 1012, "desktop_replaced");
      this.desktop = { socket: server, meta };
    } else {
      this.webs.set(socketId, { socket: server, meta });
    }
    this.safeSend(server, { type: "realtime.ready", role, device_id: deviceId, connected_at: meta.connectedAt });
    server.addEventListener("message", (event) => this.onSocketMessage(server, meta, event));
    server.addEventListener("close", () => this.removeSocket(socketId, role));
    server.addEventListener("error", () => this.removeSocket(socketId, role));
    return new Response(null, { status: 101, webSocket: client });
  }

  onSocketMessage(socket, meta, event) {
    let message = null;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      this.safeSend(socket, { type: "realtime.error", error: "invalid_json" });
      return;
    }
    if (message?.type === "ping") {
      this.safeSend(socket, { type: "pong", at: new Date().toISOString() });
    } else if (meta.role === "desktop" && message?.type === "desktop.status") {
      this.broadcastWeb({ type: "desktop.status", status: object(message.status), sent_at: new Date().toISOString() });
    }
  }

  notify(message) {
    let desktopDelivered = false;
    let webDelivered = 0;
    if (message?.type === "relay.envelope") {
      desktopDelivered = this.safeSend(this.desktop?.socket, message);
      webDelivered = this.broadcastWeb({ type: "relay.envelope.created", envelope: message.envelope, sent_at: message.sent_at || new Date().toISOString() });
    } else {
      webDelivered = this.broadcastWeb(message);
    }
    return {
      ok: true,
      desktop_online: Boolean(this.desktop?.socket),
      desktop_delivered: desktopDelivered,
      web_delivered: webDelivered,
      web_count: this.webs.size,
    };
  }

  broadcastWeb(message) {
    let delivered = 0;
    for (const [id, entry] of this.webs) {
      if (this.safeSend(entry.socket, message)) delivered += 1;
      else this.webs.delete(id);
    }
    return delivered;
  }

  safeSend(socket, message) {
    if (!socket) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  safeClose(socket, code, reason) {
    try {
      socket.close(code, reason);
    } catch {
      // Ignore stale sockets.
    }
  }

  removeSocket(socketId, role) {
    if (role === "desktop" && this.desktop?.meta?.id === socketId) {
      const meta = this.desktop.meta;
      this.desktop = null;
      this.markDesktopOffline(meta).catch(() => {});
    } else {
      this.webs.delete(socketId);
    }
  }

  async markDesktopOffline(meta) {
    if (!meta?.deviceId) return;
    const at = new Date().toISOString();
    try {
      await storage(this.env).update("bridge_devices", meta.deviceId, { status: "offline", updated_at: at });
    } catch {
      // Presence fanout should not throw from a socket close handler.
    }
    this.broadcastWeb({
      type: "bridge.state",
      connected: false,
      connection: { status: "reconnecting" },
      device_id: meta.deviceId,
      user_id: meta.userId || null,
      sent_at: at,
    });
  }
}

export class BridgeTestStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    const input = await request.json();
    const result = await this.applyOperation(input);
    return new Response(JSON.stringify(result, null, 2), {
      status: result?.error ? result.status || 400 : 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  async applyOperation(input) {
    const tableName = String(input.table || "");
    if (!tableName) return { error: "missing_table", status: 400 };
    const tableKey = bridgeTestStoreTableKey(tableName);
    const storedRows = await this.state.storage.get(tableKey);
    const rows = Array.isArray(storedRows) ? storedRows : [];
    const saveRows = async (nextRows) => {
      await this.state.storage.put(tableKey, nextRows);
    };

    if (input.op === "select") {
      return { rows: selectRows(rows, object(input.filters), object(input.options)) };
    }
    if (input.op === "insert") {
      const row = object(input.row);
      const duplicate = uniqueConflict(tableName, rows, row);
      if (duplicate) return { error: duplicate, status: 409 };
      const next = { id: crypto.randomUUID(), ...structuredClone(row) };
      rows.push(next);
      await saveRows(rows);
      return { row: next };
    }
    if (input.op === "upsert") {
      const row = object(input.row);
      const conflictKey = String(input.conflictKey || "id");
      const index = rows.findIndex((item) => item[conflictKey] === row[conflictKey]);
      if (index >= 0) {
        rows[index] = { ...rows[index], ...structuredClone(row) };
        await saveRows(rows);
        return { row: rows[index] };
      }
      const next = { id: crypto.randomUUID(), ...structuredClone(row) };
      rows.push(next);
      await saveRows(rows);
      return { row: next };
    }
    if (input.op === "update") {
      const id = String(input.id || "");
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return { row: null };
      rows[index] = { ...rows[index], ...structuredClone(object(input.patch)) };
      await saveRows(rows);
      return { row: rows[index] };
    }
    if (input.op === "deleteExpired") {
      const column = String(input.column || "expires_at");
      const before = rows.length;
      const keep = rows.filter((row) => {
        const expiresAt = Date.parse(row[column] || "");
        return !Number.isFinite(expiresAt) || expiresAt > Date.now();
      });
      await saveRows(keep);
      return { count: before - keep.length };
    }
    if (input.op === "deleteWhere") {
      const filters = object(input.filters);
      const before = rows.length;
      const keep = rows.filter((row) => !Object.entries(filters).every(([key, value]) => row[key] === value));
      await saveRows(keep);
      return { count: before - keep.length };
    }
    return { error: "unknown_operation", status: 400 };
  }
}

function bridgeTestStoreTableKey(tableName) {
  return `table:${String(tableName).replace(/[^a-zA-Z0-9_:-]/g, "_")}`;
}

async function createPasswordSession(request, env) {
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

async function passwordAttemptLimitResponse(env, email) {
  const attempt = await passwordAttempt(env, email);
  const retryAfterMs = retryAfterMsForAttempt(attempt);
  return retryAfterMs > 0 ? passwordLockedResponse(env, retryAfterMs) : null;
}

async function passwordAttempt(env, email) {
  return (await storage(env).select("bridge_password_attempts", { identifier: passwordAttemptIdentifier(email) }))[0] || null;
}

async function recordPasswordFailure(env, email) {
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

async function resetPasswordFailures(env, email) {
  const timestamp = now();
  await storage(env).upsert("bridge_password_attempts", {
    identifier: passwordAttemptIdentifier(email),
    failed_count: 0,
    locked_until: null,
    last_success_at: timestamp,
    updated_at: timestamp,
  }, "identifier");
}

async function createGuestSession(request, env) {
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

async function createSessionLink(request, env) {
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

async function joinSessionLink(request, env) {
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

async function logoutSession(request, env) {
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

async function sessionResponse(request, env) {
  const session = await currentSession(request, env);
  if (!session) return json({ authenticated: false }, env, 401);
  return json({ authenticated: true, user: publicAccount(session.user), session: publicSession(session.session) }, env);
}

async function listDevices(request, env) {
  const session = await requireSession(request, env);
  const rows = await storage(env).select("bridge_devices", { user_id: session.user.id }, { order: "last_seen_at", desc: true });
  return json({ items: rows.map((row) => publicDevice(row, env)) }, env);
}

async function revokeDevice(request, env, deviceId) {
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

async function createPairingCode(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  const code = formatPairingCode(randomToken("").slice(0, 10));
  const row = await storage(env).insert("bridge_pairing_codes", {
    user_id: session.user.id,
    code_hash: await sha256Hex(code),
    device_name: clean(body.device_name, 120) || "Panda Bridge Desktop",
    expires_at: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
    consumed_at: null,
    created_at: now(),
  });
  return json({ code, pairing_code: { id: row.id, expires_at: row.expires_at }, ttl_seconds: Math.trunc(PAIRING_TTL_MS / 1000) }, env, 201);
}

async function claimConnector(request, env) {
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

async function createConnectIntent(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  const productId = clean(body.product_id || body.productId || "bridge-demo", 80) || "bridge-demo";
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

async function getConnectIntent(request, env, token) {
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

function connectIntentTokenError(intent) {
  if (!intent) return "token_invalid";
  if (intent.consumed_at) return "token_already_claimed";
  if (Date.parse(intent.expires_at) < Date.now()) return "token_expired";
  return "";
}

function connectIntentConfirmError(intent) {
  if (!intent) return "token_invalid";
  if (Date.parse(intent.expires_at) < Date.now()) return "token_expired";
  if (!intent.consumed_at || !intent.device_id) return "claim_required";
  return "";
}

async function bridgeState(request, env) {
  const url = new URL(request.url);
  const productId = clean(url.searchParams.get("product_id") || url.searchParams.get("productId") || "bridge-demo", 80) || "bridge-demo";
  const product = requireOfficialProduct(productId, env);
  const originError = rejectProductOrigin(product, sourceOrigin(env), env);
  if (originError) return originError;
  const session = await currentSession(request, env);
  if (!session) {
    return json(await bridgeStatePayload(env, null, product, { noSession: true }), env);
  }
  return json(await bridgeStatePayload(env, session.user, product), env);
}

async function claimConnectIntent(request, env, token) {
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

async function confirmConnectIntent(request, env, token) {
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

async function connectorHeartbeat(request, env) {
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

async function rotateConnectorToken(request, env) {
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

function legacyRuntimeApiRemoved(env) {
  return json(legacyRuntimeApiRemovedPayload(), env, 410);
}

async function createProductRelayEnvelope(request, env, productId, ctx = {}) {
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

async function createDelegatedProductRelayEnvelope(request, env, productId, ctx = {}) {
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

async function listProductRelayEnvelopes(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const source_origin = sourceOrigin(env);
  const originError = rejectProductOrigin(product, source_origin, env);
  if (originError) return originError;
  const session = await requireSession(request, env);
  return listRelayEnvelopesForProduct(request, env, product, session.user.id, "device_to_product");
}

async function listDelegatedProductRelayEnvelopes(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const delegation = await requireProductDelegation(request, env, product, "");
  return listRelayEnvelopesForProduct(request, env, product, delegation.bridgeUserId, "device_to_product", delegation.deviceId);
}

async function ackProductRelayEnvelope(request, env, productId, envelopeId) {
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

async function ackDelegatedProductRelayEnvelope(request, env, productId, envelopeId) {
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

async function connectorRelayEnvelopes(request, env) {
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

async function createConnectorRelayEnvelope(request, env, ctx = {}) {
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

async function ackConnectorRelayEnvelope(request, env, envelopeId) {
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

async function createAuthorizedRelayEnvelope(env, product, userId, source_origin, body, ctx = {}, options = {}) {
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

async function listRelayEnvelopesForProduct(request, env, product, userId, direction, delegatedDeviceId = "") {
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

function relayListOptions(url) {
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

function rejectUnscopedRelayCursor(env, options, channelId) {
  if (options.afterSeq <= 0 || clean(channelId, 160)) return null;
  return json({
    error: "relay_cursor_requires_channel",
    message: "after_seq pagination requires channel_id because seq cursors are scoped to one relay channel",
    cursor: { after_seq: options.afterSeq },
  }, env, 400);
}

async function waitForRelayList(waitMs, collect) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await collect();
    if (result.items.length || waitMs <= 0 || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(25, deadline - Date.now()))));
  }
}

function relayListStatuses(options) {
  return options.includeAcked ? ["queued", "delivered", "acked"] : ["queued", "delivered"];
}

function relayListCandidateRows(rows, options) {
  const statuses = relayListStatuses(options);
  return rows
    .filter((item) => statuses.includes(item.delivery_status || "queued"))
    .filter((item) => Number(item.seq || 0) > options.afterSeq)
    .filter((item) => !isExpired(item.expires_at));
}

function relayListResult(rows, options) {
  const candidates = relayListCandidateRows(rows, options);
  return {
    items: candidates.slice(0, options.limit).map(publicRelayEnvelope),
    candidateCount: candidates.length,
  };
}

async function connectorRelayListResult(env, rows, options) {
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

function relayListPayload(result, options) {
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

async function ackRelayEnvelope(env, options = {}) {
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

async function existingRequestKeyRelayEnvelope(env, userId, deviceId, productId, requestKey) {
  if (!requestKey) return null;
  const rows = await storage(env).select("bridge_relay_envelopes", {
    user_id: userId,
    device_id: deviceId,
    product_id: productId,
    request_key: requestKey,
  });
  return rows[0] || null;
}

function sameRelayEnvelope(row, envelope, idempotencyHash, maxTtlMs = RELAY_ENVELOPE_TTL_MS) {
  if (row?.idempotency_hash) return String(row.idempotency_hash) === String(idempotencyHash || "");
  return sameLegacyRelayEnvelope(row, envelope, maxTtlMs);
}

function sameLegacyRelayEnvelope(row, envelope, maxTtlMs) {
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

function relayRowTtlMs(row = {}) {
  const queuedMs = Date.parse(row.queued_at || row.created_at || "");
  const expiresMs = Date.parse(row.expires_at || "");
  return Number.isFinite(queuedMs) && Number.isFinite(expiresMs) ? Math.max(0, expiresMs - queuedMs) : null;
}

async function relayEnvelopeIdempotencyHash(envelope) {
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

async function expireRelayEnvelope(env, row, reason = "expired") {
  return await storage(env).update("bridge_relay_envelopes", row.id, {
    delivery_status: "expired",
    updated_at: now(),
    meta: { ...object(row.meta), expired_reason: reason },
  }) || row;
}

async function cleanupExpiredRelayEnvelopes(env) {
  const store = storage(env);
  if (typeof store.deleteExpired !== "function") return 0;
  return await store.deleteExpired("bridge_relay_envelopes", "expires_at");
}

async function relayQueueLimitDenial(env, input = {}) {
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

async function activeRelayEnvelopes(env, filters = {}) {
  const rows = await storage(env).select("bridge_relay_envelopes", filters, { order: "created_at" });
  return rows.filter((item) => (
    ["queued", "delivered"].includes(item.delivery_status || "queued")
    && !isExpired(item.expires_at)
  ));
}

function isExpired(expiresAt) {
  const expiresMs = Date.parse(expiresAt || "");
  return Number.isFinite(expiresMs) && expiresMs <= Date.now();
}

function relayEnvelopeTtlMs(env) {
  return boundedInteger(env.BRIDGE_RELAY_ENVELOPE_TTL_MS, RELAY_ENVELOPE_TTL_MS, 1000, 24 * 60 * 60 * 1000);
}

async function notifyRelayEnvelope(env, deviceId, envelope) {
  return notifyDeviceRoom(env, deviceId, {
    type: "relay.envelope",
    envelope: publicRelayEnvelope(envelope),
    sent_at: now(),
  });
}

async function notifyRelayEvent(env, deviceId, envelope) {
  return notifyDeviceRoom(env, deviceId, {
    type: "relay.envelope.event",
    envelope: publicRelayEnvelope(envelope),
    sent_at: now(),
  });
}

async function productAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const originError = rejectProductOrigin(product, sourceOrigin(env), env);
  if (originError) return originError;
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const deviceId = url.searchParams.get("device_id") || "";
  const authorization = await authorizationForProduct(env, session.user.id, deviceId, product.id);
  return json({ authorization: publicAuthorization(authorization, { includePolicy: true }), product: publicStateProduct(product) }, env);
}

async function requestAuthorization(request, env, productId) {
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

async function createAuthorizationImportProof(request, env, productId) {
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

async function updateAuthorization(request, env, productId) {
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

async function revokeAuthorization(request, env, productId) {
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

async function createProductRelayKeyBootstrap(request, env, productId) {
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

async function createDelegatedProductRelayKeyBootstrap(request, env, productId) {
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

async function updateConnectorAuthorization(request, env, productId) {
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

async function revokeConnectorAuthorization(request, env, productId) {
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

async function connectorRelayKeyBootstrap(request, env, productId) {
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

async function delegatedProductAuthorization(request, env, productId) {
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

async function delegatedProductStatus(request, env, productId) {
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

async function delegatedBridgeState(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const delegation = await requireProductDelegation(request, env, product, "");
  const user = (await storage(env).select("bridge_users", { id: delegation.bridgeUserId }))[0] || {
    id: delegation.bridgeUserId,
    display_name: "Panda Account",
  };
  return json(await bridgeStatePayload(env, user, product), env);
}

async function createDelegatedConnectIntent(request, env, productId) {
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

async function getDelegatedConnectIntent(request, env, productId, token) {
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

async function claimDelegatedProductAuthorization(request, env, productId) {
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

async function updateDelegatedProductAuthorization(request, env, productId) {
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

async function revokeDelegatedProductAuthorization(request, env, productId) {
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

async function realtimeDevice(request, env, deviceId) {
  if (!env.BRIDGE_DEVICE_ROOMS) return json({ error: "realtime_unavailable" }, env, 426);
  if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return json({ error: "websocket_required" }, env, 426);
  }
  const url = new URL(request.url);
  const role = clean(url.searchParams.get("role"), 40);
  const headers = new Headers(request.headers);
  headers.set("x-bridge-device-id", deviceId);
  if (role === "desktop") {
    const connector = await requireConnector(request, env);
    if (connector.device.id !== deviceId) return json({ error: "device_not_found" }, env, 404);
    await storage(env).update("bridge_devices", connector.device.id, {
      status: "online",
      last_seen_at: now(),
      updated_at: now(),
    });
    headers.set("x-bridge-role", "desktop");
    headers.set("x-bridge-user-id", connector.device.user_id);
  } else if (role === "web") {
    const session = await requireSession(request, env);
    const device = await ownedDevice(env, session.user.id, deviceId);
    if (!device) return json({ error: "device_not_found" }, env, 404);
    headers.set("x-bridge-role", "web");
    headers.set("x-bridge-user-id", session.user.id);
  } else {
    return json({ error: "invalid_realtime_role" }, env, 400);
  }
  const stub = deviceRoom(env, deviceId);
  return stub.fetch(new Request(request.url, { method: "GET", headers }));
}

function realtimeEnabled(env) {
  return Boolean(env.BRIDGE_DEVICE_ROOMS);
}

function deviceRoom(env, deviceId) {
  const id = env.BRIDGE_DEVICE_ROOMS.idFromName(deviceId);
  return env.BRIDGE_DEVICE_ROOMS.get(id);
}

async function notifyDeviceRoom(env, deviceId, message) {
  if (!env.BRIDGE_DEVICE_ROOMS) return { ok: false, delivered: false, reason: "realtime_unavailable" };
  try {
    const response = await deviceRoom(env, deviceId).fetch("https://bridge-device-room.local/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    const text = await response.text();
    return text ? JSON.parse(text) : { ok: response.ok };
  } catch (error) {
    return { ok: false, delivered: false, reason: error.message || String(error) };
  }
}

async function runBackground(ctx, promise) {
  const guarded = Promise.resolve(promise).catch((error) => {
    console.error("[bridge:background]", redactedErrorMessage(error));
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(guarded);
    return;
  }
  await guarded;
}

async function currentSession(request, env) {
  const token = cookie(request, env.SESSION_COOKIE_NAME || "pb_session");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const session = (await storage(env).select("bridge_sessions", { token_hash: tokenHash }))[0];
  if (!session || Date.parse(session.expires_at) < Date.now()) return null;
  const user = (await storage(env).select("bridge_users", { id: session.user_id }))[0];
  return user ? { session, user } : null;
}

async function createSessionForUser(env, user) {
  const token = randomToken("pbs_");
  const session = await storage(env).insert("bridge_sessions", {
    user_id: user.id,
    token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + sessionTtlMs(env)).toISOString(),
    created_at: now(),
  });
  return { token, session };
}

async function ensureDelegatedUser(env, productId, externalUserId, input = {}) {
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

async function resolveDelegatedBridgeUserId(env, productId, externalUserId, deviceId) {
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

async function productScopedUserId(productId, externalUserId) {
  const scoped = clean(externalUserId, 120);
  if (!scoped) throw httpError("product_delegation_unauthorized", 401);
  const hex = await sha256Hex(`panda-bridge:delegated-user:v1:${productId}:${scoped}`);
  return uuidFromHex(hex);
}

function uuidFromHex(hex) {
  const chars = hex.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

async function requireSession(request, env) {
  const session = await currentSession(request, env);
  if (!session) throw httpError("unauthorized", 401);
  return session;
}

async function requireConnector(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) throw httpError("unauthorized", 401);
  const connector = await connectorByToken(env, token, connectorInstallId(request));
  if (!connector) throw httpError("unauthorized", 401);
  return connector;
}

async function optionalConnector(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return token ? await connectorByToken(env, token, connectorInstallId(request)) : null;
}

async function connectorByToken(env, token, installId = "") {
  const tokenRow = (await storage(env).select("bridge_device_tokens", { token_hash: await sha256Hex(token) }))[0];
  if (!tokenRow || tokenRow.revoked_at || Date.parse(tokenRow.expires_at) <= Date.now()) return null;
  const device = (await storage(env).select("bridge_devices", { id: tokenRow.device_id }))[0];
  if (!device || device.status === "revoked") return null;
  if (!await installIdentityMatches(device, installId)) return null;
  return { token: tokenRow, device, raw_token: token };
}

function connectorInstallId(request) {
  return clean(request.headers.get("x-panda-bridge-install-id"), 200);
}

async function installIdentityMatches(device, installId) {
  if (!device.install_id_hash) return true;
  if (!installId) return false;
  return device.install_id_hash === await installIdentityHash(installId);
}

async function installIdentityPatch(device, installId) {
  if (!installId) return {};
  const hash = await installIdentityHash(installId);
  if (device.install_id_hash && device.install_id_hash !== hash) {
    throw httpError("install_identity_mismatch", 401);
  }
  if (device.install_id_hash) return {};
  return { install_id_hash: hash, install_id_bound_at: now() };
}

async function installIdentityHash(installId) {
  return sha256Hex(`install:${clean(installId, 200)}`);
}

async function reusableDeviceForInstall(env, userId, installId) {
  const hash = await installIdentityHash(installId);
  const rows = await storage(env).select("bridge_devices", { user_id: userId, install_id_hash: hash }, { order: "updated_at", desc: true });
  return rows.find((device) => device.status !== "revoked") || null;
}

async function ownedDevice(env, userId, deviceId) {
  return (await storage(env).select("bridge_devices", { id: deviceId, user_id: userId }))[0] || null;
}

async function activeAuthorization(env, userId, deviceId, productId) {
  return (await storage(env).select("bridge_authorizations", {
    user_id: userId,
    device_id: deviceId,
    product_id: productId,
    status: "active",
  }))[0] || null;
}

async function authorizationForProduct(env, userId, deviceId, productId) {
  const filters = {
    user_id: userId,
    product_id: productId,
  };
  if (deviceId) filters.device_id = deviceId;
  const rows = await storage(env).select("bridge_authorizations", filters, { order: "updated_at", desc: true });
  return selectAuthorizationRow(rows) || null;
}

async function authorizationRowsForProduct(env, userId, productId) {
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

function isAccountLevelDeviceId(deviceId) {
  return ACCOUNT_LEVEL_DEVICE_IDS.has(clean(deviceId, 120));
}

// Resolves the device an account-level authorization action should act on:
// the current active (preferred) or paused authorization device for this
// (user, product). Returns null when there is no live authorization device.
async function accountAuthorizationDevice(env, userId, productId) {
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
async function resolveSessionAuthorizationDevice(request, env, product, session) {
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
async function resolveDelegatedAuthorizationDevice(request, env, product, delegation) {
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

function selectAuthorizationRow(rows) {
  return [...rows].sort(compareAuthorizationRows)[0] || null;
}

function compareAuthorizationRows(left, right) {
  const leftRank = authorizationStatusRank(left?.status);
  const rightRank = authorizationStatusRank(right?.status);
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftTime = Date.parse(left?.updated_at || left?.created_at || "") || 0;
  const rightTime = Date.parse(right?.updated_at || right?.created_at || "") || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function authorizationStatusRank(status) {
  if (status === "active") return 0;
  if (status === "paused") return 1;
  if (status === "revoked") return 2;
  return 3;
}

function authorizationJobDenial(authorization) {
  if (authorization?.status === "active") return null;
  if (authorization?.status === "paused") {
    return { error: "authorization_paused", reason: "authorization_paused" };
  }
  return { error: "authorization_revoked", reason: "authorization_revoked" };
}

function decodeBase64Text(value) {
  try {
    const bytes = Uint8Array.from(atob(String(value || "")), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

async function updateAuthorizationWithEpoch(env, authorization, patch, options = {}) {
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

async function updateAuthorizationStatus(env, { userId, deviceId, product, status, sourceOrigin = "", auditActionPrefix = "authorization" }) {
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

async function requireProductDelegation(request, env, product, rawBody) {
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

function productDelegationSecret(env, productId) {
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

function productDelegationSecretEnvKey(productId) {
  const normalized = clean(productId, 200)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized ? `BRIDGE_${normalized}_DELEGATION_SECRET` : "";
}

function productDelegationSkewMs(env) {
  return boundedInteger(env.BRIDGE_PRODUCT_DELEGATION_SKEW_MS, 1000 * 60 * 5, 1000, 1000 * 60 * 30);
}

async function reserveProductDelegationNonce(env, productId, nonce, timestamp) {
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

function canonicalJson(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return "{}";
  const entries = Object.entries(value).sort(([left], [right]) => codePointCompare(left, right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
}

async function cancelQueuedRelayEnvelopesForAuthorization(env, userId, deviceId, productId, denial = { error: "authorization_revoked", reason: "authorization_revoked" }) {
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

async function cancelRelayEnvelope(env, row, reason = "authorization_revoked") {
  return await storage(env).update("bridge_relay_envelopes", row.id, {
    delivery_status: "cancelled",
    updated_at: now(),
    meta: { ...object(row.meta), cancelled_reason: reason },
  }) || row;
}

async function cleanupExpiredRows(env) {
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

function relayQueueLimits(env) {
  return {
    deviceMaxUnacked: boundedInteger(env.BRIDGE_RELAY_DEVICE_MAX_UNACKED, RELAY_DEVICE_MAX_UNACKED, 1, 1000),
    accountMaxUnacked: boundedInteger(env.BRIDGE_RELAY_ACCOUNT_MAX_UNACKED, RELAY_ACCOUNT_MAX_UNACKED, 1, 5000),
    productMaxUnacked: boundedInteger(env.BRIDGE_RELAY_PRODUCT_MAX_UNACKED, RELAY_PRODUCT_MAX_UNACKED, 1, 3000),
    channelMaxUnacked: boundedInteger(env.BRIDGE_RELAY_CHANNEL_MAX_UNACKED, RELAY_CHANNEL_MAX_UNACKED, 1, 1000),
  };
}

function relayLimitPayload(active, max, scope) {
  return {
    scope,
    active,
    max_unacked: max,
    retry_after_ms: RELAY_QUEUE_RETRY_AFTER_MS,
  };
}

function diagnosticsPayload(env) {
  const relayLimits = relayQueueLimits(env);
  return {
    ok: true,
    protocol: BRIDGE_PROTOCOL_VERSION,
    env: env.BRIDGE_ENV || "local",
    storage: storageKind(env),
    api_base: publicApiBase(env),
    web_origin: webOrigin(env),
    realtime: {
      enabled: realtimeEnabled(env),
      route_template: "/v1/realtime/devices/{device_id}",
    },
    products: allProducts(sourceOrigin(env), env).map((product) => ({
      id: product.id,
      name: product.name,
      origin: product.origin,
      official_origin: product.official_origin,
      official_origins: product.official_origins,
      web_url: product.web_url || product.official_origin,
      capabilities: product.capabilities,
      adapter_boundary: product.adapter_boundary || {},
      requires_desktop_authorization: product.requires_desktop_authorization,
    })),
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

async function connectIntentByToken(env, token) {
  const tokenHash = await sha256Hex(String(token || ""));
  return (await storage(env).select("bridge_connect_intents", { token_hash: tokenHash }))[0] || null;
}

async function recoverableIntentTokenPatch(env, token) {
  const secret = clean(env.BRIDGE_CONNECT_INTENT_TOKEN_SECRET, 4096);
  if (!secret) return {};
  return { token_ciphertext: await encryptString(secret, token) };
}

async function bridgeStatePayload(env, user, product, options = {}) {
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

function bridgeInstallPayload(env) {
  const base = clean(env.R2_PUBLIC_BASE_URL, 300).replace(/\/$/, "");
  return {
    ...BRIDGE_DESKTOP_INSTALL,
    download_url: base ? `${base}${BRIDGE_DESKTOP_INSTALL.download_path}` : BRIDGE_DESKTOP_INSTALL.download_url,
  };
}

function accountBridgeState(user, devices, authorizations, env, productId = "") {
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

function selectAccountAuthorization(authorizations, deviceById, env) {
  const rows = [...authorizations].sort((left, right) => {
    const leftOnline = left?.status === "active" && isDeviceOnline(deviceById.get(left.device_id), env);
    const rightOnline = right?.status === "active" && isDeviceOnline(deviceById.get(right.device_id), env);
    if (leftOnline !== rightOnline) return leftOnline ? -1 : 1;
    return compareAuthorizationRows(left, right);
  });
  return rows[0] || null;
}

function publicAuthorization(authorization, options = {}) {
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

function publicAuthorizationPolicy(policy) {
  const payload = structuredClone(object(policy));
  delete payload._relay_key_bootstrap;
  return payload;
}

function publicStateProduct(product) {
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

function dedupeDevicesByInstall(devices) {
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

function publicBridgeStateDevices(devices, currentDevice, env, authorizations = [], productId = "") {
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

function publicStateDevice(device, env, productId = "") {
  if (!device) return null;
  const payload = {
    id: device.id,
    name: device.device_name,
    status: publicDeviceStatus(device, env),
    online: isDeviceOnline(device, env),
    last_seen_at: device.last_seen_at || null,
  };
  const exchange = deviceRelayKeyExchange(device, productId);
  if (exchange) payload.relay_key_exchange = exchange;
  return payload;
}

async function accountDevices(env, userId) {
  return (await storage(env).select("bridge_devices", { user_id: userId }, { order: "last_seen_at", desc: true }))
    .filter((device) => device.status !== "revoked");
}

async function publicAccountDevices(env, userId, currentDeviceId = "") {
  const devices = dedupeDevicesByInstall(await accountDevices(env, userId));
  return devices.map((device) => ({
    id: device.id,
    name: device.device_name,
    online: isDeviceOnline(device, env),
    last_seen_at: device.last_seen_at || null,
    current: Boolean(currentDeviceId && device.id === currentDeviceId),
  }));
}

async function alreadyAuthorizedConnectPayload(env, user, product, requestedPolicy, installId = "") {
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

async function authorizedOfflineConnectPayload(env, user, product, requestedPolicy, installId = "") {
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

async function deviceMatchesInstallId(device, installId) {
  const expected = clean(installId, 200);
  if (!expected) return true;
  if (!device?.install_id_hash) return false;
  return device.install_id_hash === await installIdentityHash(expected);
}

function authorizationPolicyCoversRequest(grantPolicy, requestedPolicy) {
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

function connectIntentDeepLink(env, token) {
  return `${desktopProtocol(env)}://connect?intent=${encodeURIComponent(token)}&api=${encodeURIComponent(publicApiBase(env))}`;
}

async function createDeviceWithToken(env, userId, input) {
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

async function updateDeviceForIntent(env, device, token, input) {
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

async function replaceOtherBridgeDevices(env, userId, activeDeviceId, reason) {
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

async function createDeviceToken(env, deviceId) {
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

function defaultDeviceTokenScope() {
  return ["heartbeat", "relay:read", "relay:ack", "relay:write"];
}

function deviceTokenRotationGraceMs(env) {
  const value = Number(env.BRIDGE_DEVICE_TOKEN_ROTATION_GRACE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEVICE_TOKEN_ROTATION_GRACE_MS;
}

function sessionTtlMs(env) {
  return boundedInteger(env.BRIDGE_SESSION_TTL_MS, SESSION_TTL_MS, 1, SESSION_TTL_MS);
}

function sessionLinkTtlMs(env) {
  return boundedInteger(env.BRIDGE_SESSION_LINK_TTL_MS, SESSION_LINK_TTL_MS, 1, SESSION_LINK_TTL_MS);
}

function connectIntentTtlMs(env) {
  return boundedInteger(env.BRIDGE_CONNECT_INTENT_TTL_MS, CONNECT_INTENT_TTL_MS, 1, CONNECT_INTENT_TTL_MS);
}

function authorizationImportProofTtlMs(env) {
  return boundedInteger(env.BRIDGE_AUTHORIZATION_IMPORT_PROOF_TTL_MS, AUTHORIZATION_IMPORT_PROOF_TTL_MS, 1000, 1000 * 60 * 30);
}

function normalizeAuthorizationPolicy(input, product, source_origin) {
  const policy = object(input);
  const hasExplicitInput = Object.keys(policy).length > 0;
  rejectLegacyAuthorizationPolicyFields(policy);
  const requested = hasExplicitInput ? policy : defaultRelayAuthorizationPolicy();
  const capabilities = normalizedPolicyCapabilities(requested, product, !hasExplicitInput);
  const productAuthorization = normalizeProductAuthorization(requested.product_authorization ?? requested.productAuthorization);
  const normalized = {
    version: "BRIDGE-RELAY-AUTH-v1",
    request_source: clean(requested.request_source, 120) || (hasExplicitInput ? "caller_request" : "worker_default_relay"),
    product_id: product.id,
    source_origin: clean(requested.source_origin, 300) || source_origin || product.official_origin || product.origin || null,
    capabilities,
  };
  if (Object.keys(productAuthorization).length) normalized.product_authorization = productAuthorization;
  return normalized;
}

function rejectLegacyAuthorizationPolicyFields(policy) {
  const fields = [
    "workspace_roots",
    "workspaceRoots",
    "sandbox_floor",
    "sandboxFloor",
    "approval_policy_floor",
    "approvalPolicyFloor",
    "allow_approval_never",
    "allowApprovalNever",
    "allow_developer_instructions",
    "allowDeveloperInstructions",
    "fullAccess",
    "full_access",
    "preset",
    "permission_preset",
  ];
  const present = fields.filter((field) => Object.hasOwn(policy, field));
  if (!present.length) return;
  const error = httpError("legacy_authorization_policy_forbidden", 400);
  error.public = { fields: [...new Set(present)] };
  throw error;
}

function normalizeProductAuthorization(input) {
  const value = object(input);
  const out = {};
  const owner = clean(value.owner, 120);
  const enforcement = clean(value.enforcement, 160);
  const control = clean(value.control || value.mode || value.grant || value.kind, 120);
  const label = clean(value.label || value.summary || value.description, 300);
  if (owner) out.owner = owner;
  if (enforcement) out.enforcement = enforcement;
  if (control) out.control = control;
  if (label) out.label = label;
  return out;
}

function normalizedPolicyCapabilities(requested, product, defaultLowTier = false) {
  if (defaultLowTier || !Object.hasOwn(requested, "capabilities")) return lowTierCapabilities().filter((kind) => product.capabilities.includes(kind));
  if (!Array.isArray(requested.capabilities)) throw httpError("invalid_authorization_policy", 400);
  let capabilities = [...new Set(requested.capabilities.map((item) => clean(item, 120)).filter(Boolean))];
  const unsupported = capabilities.filter((item) => !RELAY_CAPABILITY_KINDS.includes(item));
  if (unsupported.length) {
    const error = httpError("invalid_authorization_policy", 400);
    error.public = { field: "capabilities", unsupported };
    throw error;
  }
  const unsupportedByProduct = capabilities.filter((kind) => !product.capabilities.includes(kind));
  if (unsupportedByProduct.length) {
    const error = httpError("invalid_authorization_policy", 400);
    error.public = { field: "capabilities", unsupported: unsupportedByProduct };
    throw error;
  }
  return capabilities;
}

function defaultRelayAuthorizationPolicy() {
  return {
    request_source: "worker_default_relay",
    capabilities: lowTierCapabilities(),
  };
}

function lowTierCapabilities() {
  return [...RELAY_CAPABILITY_KINDS];
}

async function upsertAuthorization(env, userId, deviceId, productId, policy, sourceOrigin = "", options = {}) {
  const status = clean(options.status, 40) || "active";
  const store = storage(env);
  const existing = (await store.select("bridge_authorizations", {
    user_id: userId,
    product_id: productId,
    device_id: deviceId,
  }))[0];
  if (existing) {
    const policyChanged = canonicalJson(existing.policy || {}) !== canonicalJson(policy || {});
    const statusChanged = existing.status !== status;
    const patch = {
      status,
      policy,
      source_origin: sourceOrigin || existing.source_origin || null,
      updated_at: now(),
    };
    if (policyChanged || statusChanged) {
      return (await updateAuthorizationWithEpoch(env, existing, patch, {
        cause: policyChanged ? "policy_change" : "resume",
        cancelDenial: policyChanged ? { error: "authorization_scope_changed", reason: "authorization_policy_changed" } : null,
      })).authorization;
    }
    return store.update("bridge_authorizations", existing.id, patch);
  }
  return store.insert("bridge_authorizations", {
    user_id: userId,
    device_id: deviceId,
    product_id: productId,
    source_origin: sourceOrigin || null,
    status,
    policy,
    epoch: 1,
    created_at: now(),
    updated_at: now(),
  });
}

async function consumeAuthorizationImportProof(env, proof) {
  const consumedAt = now();
  if (hasSupabase(env) && !env.BRIDGE_LOCAL_MEMORY) {
    const url = new URL("/rest/v1/bridge_authorization_import_proofs", env.SUPABASE_URL);
    url.searchParams.set("id", `eq.${proof.id}`);
    url.searchParams.set("consumed_at", "is.null");
    const rows = await supabaseFetch(env, url, {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ consumed_at: consumedAt }),
    });
    return rows[0] || null;
  }
  const current = (await storage(env).select("bridge_authorization_import_proofs", { id: proof.id }))[0];
  if (!current || current.consumed_at) return null;
  return await storage(env).update("bridge_authorization_import_proofs", proof.id, { consumed_at: consumedAt });
}

async function audit(env, userId, deviceId, productId, action, targetId, payload) {
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

function storageKind(env) {
  if (env.BRIDGE_STORAGE_BACKEND === "durable" && env.BRIDGE_TEST_STORE) return "durable";
  if (hasSupabase(env) && !env.BRIDGE_LOCAL_MEMORY) return "supabase";
  return "memory";
}

function storage(env) {
  if (env.BRIDGE_STORAGE_BACKEND === "durable" && env.BRIDGE_TEST_STORE) return durableObjectStore(env);
  if (hasSupabase(env) && !env.BRIDGE_LOCAL_MEMORY) return supabaseStore(env);
  return memory;
}

function durableObjectStore(env) {
  return {
    async select(table, filters = {}, options = {}) {
      return (await durableStoreOperation(env, { op: "select", table, filters, options })).rows || [];
    },
    async insert(table, row) {
      return (await durableStoreOperation(env, { op: "insert", table, row })).row;
    },
    async upsert(table, row, conflictKey = "id") {
      return (await durableStoreOperation(env, { op: "upsert", table, row, conflictKey })).row;
    },
    async update(table, id, patch) {
      return (await durableStoreOperation(env, { op: "update", table, id, patch })).row;
    },
    async deleteExpired(table, column = "expires_at") {
      return (await durableStoreOperation(env, { op: "deleteExpired", table, column })).count || 0;
    },
    async deleteWhere(table, filters = {}) {
      return (await durableStoreOperation(env, { op: "deleteWhere", table, filters })).count || 0;
    },
  };
}

async function durableStoreOperation(env, payload) {
  const id = env.BRIDGE_TEST_STORE.idFromName("bridge-test-store");
  const stub = env.BRIDGE_TEST_STORE.get(id);
  const response = await stub.fetch("https://bridge-test-store.local/storage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok || body.error) {
    const error = new Error(body.error || `durable_store_${response.status}`);
    error.code = body.error;
    throw error;
  }
  return body;
}

function supabaseStore(env) {
  return {
    async select(table, filters = {}, options = {}) {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      url.searchParams.set("select", "*");
      for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, `eq.${value}`);
      if (options.order) url.searchParams.set("order", `${options.order}.${options.desc ? "desc" : "asc"}`);
      const response = await supabaseFetch(env, url, { method: "GET" });
      return response;
    },
    async insert(table, row) {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      const rows = await supabaseFetch(env, url, {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(row),
      });
      return rows[0];
    },
    async upsert(table, row, conflictKey = "id") {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      url.searchParams.set("on_conflict", conflictKey);
      const rows = await supabaseFetch(env, url, {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(row),
      });
      return rows[0];
    },
    async update(table, id, patch) {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      url.searchParams.set("id", `eq.${id}`);
      const rows = await supabaseFetch(env, url, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(patch),
      });
      return rows[0];
    },
    async deleteExpired(table, column = "expires_at") {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      url.searchParams.set(column, `lt.${new Date().toISOString()}`);
      await supabaseFetch(env, url, { method: "DELETE" });
      return null;
    },
    async deleteWhere(table, filters = {}) {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, `eq.${value}`);
      await supabaseFetch(env, url, { method: "DELETE" });
      return null;
    },
  };
}

async function supabaseFetch(env, url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Supabase ${init.method} ${url.pathname} failed: ${response.status} [redacted]`);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : [];
}

function makeMemoryStore() {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };
  return {
    async select(name, filters = {}, options = {}) {
      return selectRows(table(name), filters, options);
    },
    async insert(name, row) {
      const duplicate = uniqueConflict(name, table(name), row);
      if (duplicate) {
        const error = new Error(duplicate);
        error.code = duplicate;
        throw error;
      }
      const next = { id: crypto.randomUUID(), ...structuredClone(row) };
      table(name).push(next);
      return structuredClone(next);
    },
    async upsert(name, row, conflictKey = "id") {
      const rows = table(name);
      const index = rows.findIndex((item) => item[conflictKey] === row[conflictKey]);
      if (index >= 0) {
        rows[index] = { ...rows[index], ...structuredClone(row) };
        return structuredClone(rows[index]);
      }
      const next = { id: crypto.randomUUID(), ...structuredClone(row) };
      rows.push(next);
      return structuredClone(next);
    },
    async update(name, id, patch) {
      const rows = table(name);
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return null;
      rows[index] = { ...rows[index], ...structuredClone(patch) };
      return structuredClone(rows[index]);
    },
    async deleteExpired(name, column = "expires_at") {
      const rows = table(name);
      const keep = rows.filter((row) => {
        const expiresAt = Date.parse(row[column] || "");
        return !Number.isFinite(expiresAt) || expiresAt > Date.now();
      });
      const count = rows.length - keep.length;
      tables.set(name, keep);
      return count;
    },
    async deleteWhere(name, filters = {}) {
      const rows = table(name);
      const keep = rows.filter((row) => !Object.entries(filters).every(([key, value]) => row[key] === value));
      const count = rows.length - keep.length;
      tables.set(name, keep);
      return count;
    },
    snapshot() {
      return Object.fromEntries(
        [...tables.entries()].map(([name, rows]) => [
          name,
          rows.map((row) => structuredClone(row)),
        ]),
      );
    },
    reset() {
      tables.clear();
    },
  };
}

function uniqueConflict(tableName, rows, row) {
  if (tableName === "bridge_relay_envelopes" && row.request_key) {
    const duplicate = rows.find((item) => (
      item.user_id === row.user_id
      && item.device_id === row.device_id
      && item.product_id === row.product_id
      && item.request_key === row.request_key
    ));
    if (duplicate) return "duplicate_request_key";
  }
  if (tableName === "bridge_product_delegation_nonces") {
    const duplicate = rows.find((item) => (
      item.product_id === row.product_id
      && item.nonce_hash === row.nonce_hash
    ));
    if (duplicate) return "product_delegation_replay";
  }
  return "";
}

function selectRows(rows, filters = {}, options = {}) {
  let selected = rows.filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value));
  if (options.order) selected = selected.sort((a, b) => String(a[options.order] || "").localeCompare(String(b[options.order] || "")));
  if (options.desc) selected.reverse();
  return selected.map((row) => structuredClone(row));
}

function publicDevice(device, env = {}) {
  return device ? {
    id: device.id,
    device_name: device.device_name,
    status: publicDeviceStatus(device, env),
    app_version: device.app_version,
    capabilities: safeDeviceCapabilities(device.capabilities),
    local_state: safeLocalState(device.local_state),
    last_seen_at: device.last_seen_at,
    created_at: device.created_at,
    updated_at: device.updated_at,
  } : null;
}

function safeDeviceCapabilities(input = {}) {
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

function safeLocalState(input = {}) {
  const value = object(input);
  const relay = object(value.relay);
  const adapter = object(value.adapter_router || value.adapterRouter);
  const relayKeyExchange = normalizeRelayKeyExchange(value.relay_key_exchange || value.relayKeyExchange);
  const products = safeAdapterProducts(adapter.products);
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
  if (relayKeyExchange) out.relay_key_exchange = relayKeyExchange;
  return out;
}

function safeAdapterProducts(input = {}) {
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

function normalizeRelayKeyExchange(input) {
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

function publicEcJwk(input) {
  const jwk = object(input);
  const kty = clean(jwk.kty, 10);
  const crv = clean(jwk.crv, 20);
  const x = clean(jwk.x, 200);
  const y = clean(jwk.y, 200);
  if (kty !== "EC" || crv !== "P-256" || !x || !y) return null;
  return { kty, crv, x, y, ext: true, key_ops: ["deriveBits"] };
}

function relayKeyExchangeId(publicJwk) {
  return `rkx_${String(publicJwk.x || "").slice(0, 16)}_${String(publicJwk.y || "").slice(0, 16)}`;
}

function deviceRelayKeyExchange(device, productId = "") {
  const localState = object(device?.local_state);
  const productExchange = productId
    ? object(object(object(localState.adapter_router).products)[productId]).relay_key_exchange
    : null;
  return normalizeRelayKeyExchange(productExchange) || normalizeRelayKeyExchange(localState.relay_key_exchange);
}

function normalizeRelayKeyBootstrap(input, { productId, deviceId, authorization, exchange }) {
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

function relayKeyBootstrapAadTexts(productId, deviceId, authorizationId, authorizationEpochValue, keyId) {
  return [[
    "bridge-relay-key-bootstrap-v1",
    productId,
    deviceId,
    authorizationId,
    String(authorizationEpochValue),
    keyId,
  ].join("|")];
}

function plaintextRelayKeyFields(input, path = "") {
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

function authorizationRelayKeyBootstrap(authorization) {
  return object(object(authorization?.policy)._relay_key_bootstrap);
}

function publicRelayKeyBootstrap(authorization, options = {}) {
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

async function updateAuthorizationRelayKeyBootstrap(env, authorization, bootstrap) {
  const policy = publicAuthorizationPolicy(authorization.policy);
  const nextPolicy = { ...policy, _relay_key_bootstrap: bootstrap };
  return await storage(env).update("bridge_authorizations", authorization.id, {
    policy: nextPolicy,
    updated_at: now(),
  });
}

function publicDeviceStatus(device, env = {}) {
  if (!device || device.status === "revoked") return device?.status || "offline";
  return isDeviceOnline(device, env) ? "online" : "offline";
}

function isDeviceOnline(device, env = {}) {
  if (!device || device.status !== "online" || !device.last_seen_at) return false;
  const graceMs = Number(env.BRIDGE_DEVICE_ONLINE_GRACE_MS || DEVICE_ONLINE_GRACE_MS);
  return Date.now() - Date.parse(device.last_seen_at) <= graceMs;
}

function publicSession(session) {
  return { id: session.id, expires_at: session.expires_at, created_at: session.created_at };
}

function publicAccount(user) {
  return user ? {
    id: user.id,
    display_name: user.display_name || user.email || "Panda Account",
    email: user.email || null,
  } : null;
}

function publicSessionLink(link) {
  return link ? {
    id: link.id,
    expires_at: link.expires_at,
    consumed_at: link.consumed_at || null,
    created_at: link.created_at,
  } : null;
}

function publicConnectIntent(intent, user = null, env = {}) {
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

function json(payload, env, status = 200) {
  return cors(new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  }), env);
}

function cors(response, env) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", sourceOrigin(env));
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization");
  headers.append("vary", "Origin");
  setSecurityHeaders(headers, env);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withSecurityHeaders(response, env) {
  const headers = new Headers(response.headers);
  setSecurityHeaders(headers, env);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function setSecurityHeaders(headers, env) {
  headers.set("content-security-policy", contentSecurityPolicy(env));
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  if (webOrigin(env).startsWith("https://")) {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
  } else {
    headers.delete("strict-transport-security");
  }
}

function contentSecurityPolicy(env) {
  const origins = allowedWebOrigins(env);
  const connectOrigins = [...new Set(origins.flatMap((origin) => {
    const apiOrigin = apiOriginForCsp(origin);
    return [origin, apiOrigin, origin.replace(/^http/, "ws"), apiOrigin.replace(/^http/, "ws")];
  }))];
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${connectOrigins.join(" ")}`,
    "frame-src 'self' panda-bridge:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function apiOriginForCsp(origin) {
  try {
    const url = new URL(origin);
    if (url.hostname === "bridge.chaos-realms.cc") return "https://api.bridge.chaos-realms.cc";
    if (url.hostname === "bridge.test.example" || url.hostname === "app.test.example") {
      return "https://api.bridge.test.example";
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return "https://api.bridge.chaos-realms.cc";
  }
}

function withSessionCookie(response, env, token) {
  const headers = new Headers(response.headers);
  const secure = (env.BRIDGE_WEB_ORIGIN || "").startsWith("https://") ? "; Secure" : "";
  const domain = env.SESSION_COOKIE_DOMAIN ? `; Domain=${env.SESSION_COOKIE_DOMAIN}` : "";
  const sameSite = "SameSite=Lax";
  headers.set("set-cookie", `${env.SESSION_COOKIE_NAME || "pb_session"}=${token}; Path=/; Max-Age=${Math.trunc(SESSION_TTL_MS / 1000)}; HttpOnly; ${sameSite}${secure}${domain}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withClearedSessionCookie(response, env) {
  const headers = new Headers(response.headers);
  const secure = (env.BRIDGE_WEB_ORIGIN || "").startsWith("https://") ? "; Secure" : "";
  const domain = env.SESSION_COOKIE_DOMAIN ? `; Domain=${env.SESSION_COOKIE_DOMAIN}` : "";
  headers.set("set-cookie", `${env.SESSION_COOKIE_NAME || "pb_session"}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}${domain}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withHeader(response, key, value) {
  const headers = new Headers(response.headers);
  headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function passwordLockedResponse(env, retryAfterMs) {
  const retryAfterSeconds = Math.max(1, Math.ceil(Number(retryAfterMs || 0) / 1000));
  return withHeader(
    json({ error: "too_many_login_attempts", retry_after_ms: retryAfterSeconds * 1000 }, env, 429),
    "retry-after",
    String(retryAfterSeconds),
  );
}

async function assetResponse(request, env) {
  if (env.ASSETS) return withSecurityHeaders(await env.ASSETS.fetch(request), env);
  return withSecurityHeaders(new Response("Panda Bridge Cloud", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  }), env);
}

function notFound(env) {
  return json({ error: "not_found" }, env, 404);
}

function rejectBadOrigin(request, env) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  const { path } = requestPath(request, normalizePath);
  const origin = request.headers.get("origin");
  if (origin && allowedWebOrigins(env).includes(origin)) return null;
  if (!origin && allowsMissingOrigin(request, path)) return null;
  return json({ error: "invalid_origin" }, env, 403);
}

function allowsMissingOrigin(request, path) {
  if (path === "/v1/connectors/claim") return true;
  if (/^\/v1\/connectors(?:\/|$)/.test(path)) {
    return (request.headers.get("authorization") || "").startsWith("Bearer ");
  }
  if (/^\/v1\/products\/[^/]+\/delegated(?:\/|$)/.test(path)) {
    return Boolean(request.headers.get("x-panda-bridge-signature"));
  }
  if (/^\/v1\/connect-intents\/[^/]+\/(?:claim|confirm)$/.test(path)) {
    return isLocalBridgeClient(request);
  }
  return false;
}

function isLocalBridgeClient(request) {
  const value = (request.headers.get("x-panda-bridge-local-client") || "").trim().toLowerCase();
  return value === "desktop" || value === "connector-cli";
}

function isNativeConnectIntentClaim(request) {
  return !request.headers.get("origin") && isLocalBridgeClient(request);
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function publicErrorPayload(error) {
  return {
    error: error.message || "error",
    ...(error.public || {}),
  };
}

function redactedErrorMessage(error) {
  const text = error?.message || String(error);
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/(token|secret|password|cookie|authorization)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/"?(token|secret|password|cookie|authorization)"?\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"');
}

async function readJson(request, env) {
  const text = await readJsonText(request, env);
  if (!text) return {};
  return parseJsonText(text);
}

async function readJsonText(request, env) {
  if (!request.body) return "";
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw httpError("invalid_content_type", 415);
  }
  const limit = jsonBodyLimitBytes(env);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw requestTooLargeError(limit);
  }

  const reader = request.body.getReader?.();
  if (!reader) {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > limit) throw requestTooLargeError(limit);
    return text;
  }

  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > limit) throw requestTooLargeError(limit);
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw httpError("invalid_json", 400);
  }
}

function requestTooLargeError(limit) {
  const error = httpError("request_body_too_large", 413);
  error.public = { limit_bytes: limit };
  return error;
}

function jsonBodyLimitBytes(env) {
  return boundedInteger(env.BRIDGE_MAX_JSON_BODY_BYTES, DEFAULT_JSON_BODY_LIMIT_BYTES, 1024, MAX_JSON_BODY_LIMIT_BYTES);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeStringList(input, max = 120) {
  const values = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\s,]+/) : [];
  return [...new Set(values.map((item) => clean(item, max)).filter(Boolean))];
}

function codePointCompare(left, right) {
  const a = String(left);
  const b = String(right);
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    const ac = a.codePointAt(ai);
    const bc = b.codePointAt(bi);
    if (ac !== bc) return ac < bc ? -1 : 1;
    ai += ac > 0xffff ? 2 : 1;
    bi += bc > 0xffff ? 2 : 1;
  }
  if (ai === a.length && bi === b.length) return 0;
  return ai === a.length ? -1 : 1;
}

function normalizeEmail(value) {
  const email = clean(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizePath(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}

function webOrigin(env) {
  return env.BRIDGE_WEB_ORIGIN || "http://127.0.0.1:8787";
}

function sourceOrigin(env) {
  return env.__bridgeRequestOrigin || webOrigin(env);
}

function requestScopedEnv(request, env) {
  const origin = request.headers.get("origin");
  const selected = origin && allowedWebOrigins(env).includes(origin) ? origin : webOrigin(env);
  return { ...env, __bridgeRequestOrigin: selected };
}

function allowedWebOrigins(env) {
  let productOrigins = [];
  try {
    productOrigins = officialProductOrigins(env);
  } catch {
    productOrigins = [];
  }
  return [...new Set([
    webOrigin(env),
    ...productOrigins,
    ...splitOrigins(env.BRIDGE_ALLOWED_ORIGINS),
  ].filter(Boolean))];
}

function splitOrigins(value) {
  return clean(value, 4000).split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function rejectProductOrigin(product, origin, env) {
  if (productAllowedOrigins(product, env).includes(origin)) return null;
  return json({
    error: "product_origin_mismatch",
    product_id: product.id,
    source_origin: origin,
  }, env, 403);
}

function productAllowedOrigins(product, env) {
  return [...new Set([
    ...(product.official_origins || [product.official_origin]),
    ...productExtraAllowedOrigins(product.id, env),
  ].filter(Boolean))];
}

function productExtraAllowedOrigins(productId, env) {
  const raw = clean(env.BRIDGE_PRODUCT_ALLOWED_ORIGINS, 20000);
  if (!raw) return [];
  try {
    const map = JSON.parse(raw);
    const value = map?.[productId];
    if (Array.isArray(value)) return value.map((item) => clean(item, 300)).filter(Boolean);
    return splitOrigins(value);
  } catch {
    return [];
  }
}

function publicApiBase(env) {
  return env.BRIDGE_PUBLIC_API_BASE || "https://api.bridge.chaos-realms.cc";
}

function desktopProtocol(env) {
  return env.BRIDGE_DESKTOP_PROTOCOL || "panda-bridge";
}

function hasSupabase(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

function passwordAttemptConfig(env) {
  return {
    maxFailedAttempts: boundedInteger(env.BRIDGE_PASSWORD_MAX_FAILED_ATTEMPTS, PASSWORD_MAX_FAILED_ATTEMPTS, 3, 20),
    windowMs: boundedInteger(env.BRIDGE_PASSWORD_ATTEMPT_WINDOW_MS, PASSWORD_ATTEMPT_WINDOW_MS, 1000, 1000 * 60 * 60),
    lockMs: boundedInteger(env.BRIDGE_PASSWORD_LOCK_MS, PASSWORD_LOCK_MS, 1000, 1000 * 60 * 60),
  };
}

function passwordAttemptIdentifier(email) {
  return `email:${email}`;
}

function retryAfterMsForAttempt(attempt) {
  const lockedUntilMs = Date.parse(attempt?.locked_until || "");
  if (!Number.isFinite(lockedUntilMs)) return 0;
  return Math.max(0, lockedUntilMs - Date.now());
}

function productInfo(productId, env) {
  return productById(productId, sourceOrigin(env), env);
}

function canonicalProductOrigin(product, env) {
  return product.official_origin || product.origin || sourceOrigin(env);
}

function requireOfficialProduct(productId, env) {
  const product = productInfo(productId, env);
  if (!product) throw httpError("unsupported_product", 403);
  return product;
}

function cookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function now() {
  return new Date().toISOString();
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function randomToken(prefix) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return prefix + base64Url(bytes);
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function formatPairingCode(raw) {
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().replace(/(.{4})/, "$1-").slice(0, 11);
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptString(secret, value) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await aesKey(secret);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value),
  ));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return base64Url(packed);
}

async function decryptString(secret, packedValue) {
  const packed = base64UrlDecode(packedValue);
  if (packed.length <= 12) return "";
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const key = await aesKey(secret);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function aesKey(secret) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function hashPassword(password) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = base64Url(saltBytes);
  const iterations = 100000;
  const hash = await derivePasswordHash(password, salt, iterations);
  return { salt, iterations, hash };
}

async function verifyPassword(password, salt, iterations, expectedHash) {
  const actual = await derivePasswordHash(password, salt, Number(iterations));
  return constantTimeEqual(actual, expectedHash);
}

async function derivePasswordHash(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: new TextEncoder().encode(salt),
    iterations,
  }, key, 256);
  return base64Url(new Uint8Array(bits));
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}
