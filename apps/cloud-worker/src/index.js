import { BRIDGE_PROTOCOL_VERSION, EVENT_TYPES, bridgeEvent, validateBridgeJob } from "@panda-bridge/protocol";
import { allProducts, officialProductOrigins, productById } from "./products.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SESSION_LINK_TTL_MS = 1000 * 60 * 10;
const PAIRING_TTL_MS = 1000 * 60 * 10;
const CONNECT_INTENT_TTL_MS = 1000 * 60 * 10;
const AUTHORIZATION_IMPORT_PROOF_TTL_MS = 1000 * 60 * 5;
const DEVICE_ONLINE_GRACE_MS = 1000 * 60 * 10;
const PASSWORD_MAX_FAILED_ATTEMPTS = 5;
const PASSWORD_ATTEMPT_WINDOW_MS = 1000 * 60 * 15;
const PASSWORD_LOCK_MS = 1000 * 60 * 15;
const DEVICE_TOKEN_TTL_MS = SESSION_TTL_MS;
const DEVICE_TOKEN_ROTATION_GRACE_MS = 1000 * 60 * 10;
const DEVICE_TOKEN_PREFIX = "pbd_";
const DEVICE_MAX_RUNNING_JOBS = 1;
const DEVICE_MAX_QUEUED_JOBS = 150;
const ACCOUNT_MAX_ACTIVE_JOBS = 500;
const PRODUCT_MAX_ACTIVE_JOBS = 300;
const JOB_ASSIGNMENT_GRACE_MS = 1000 * 30;
const SUPPORTED_JOB_KINDS = Object.freeze(["codex.chat", "codex.run", "codex.rpc", "saas.custom.run"]);
const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 512;
const MAX_JSON_BODY_LIMIT_BYTES = 1024 * 1024 * 2;
const memory = makeMemoryStore();

export default {
  async fetch(request, env = {}, ctx = {}) {
    try {
      env = requestScopedEnv(request, env);
      const originError = rejectBadOrigin(request, env);
      if (originError) return originError;
      if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), env);
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);

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

      if (path === "/v1/queue/summary" && request.method === "GET") return await queueSummary(request, env);

      if (path === "/v1/sessions/password" && request.method === "POST") return await createPasswordSession(request, env);
      if (path === "/v1/sessions/guest" && request.method === "POST") return await createGuestSession(request, env);
      if (path === "/v1/sessions/share" && request.method === "POST") return await createSessionLink(request, env);
      if (path === "/v1/sessions/join" && request.method === "POST") return await joinSessionLink(request, env);
      if (path === "/v1/sessions/logout" && request.method === "POST") return await logoutSession(request, env);
      if (path === "/v1/session" && request.method === "GET") return await sessionResponse(request, env);
      if (path === "/v1/devices" && request.method === "GET") return await listDevices(request, env);
      const deviceMatch = path.match(/^\/v1\/devices\/([^/]+)$/);
      if (deviceMatch && request.method === "DELETE") return await revokeDevice(request, env, decodeURIComponent(deviceMatch[1]));
      if (path === "/v1/products" && request.method === "GET") return json({ items: allProducts(sourceOrigin(env)) }, env);
      if (path === "/v1/devices/pairing-codes" && request.method === "POST") return await createPairingCode(request, env);
      if (path === "/v1/connectors/claim" && request.method === "POST") return await claimConnector(request, env);
      if (path === "/v1/connectors/heartbeat" && request.method === "POST") return await connectorHeartbeat(request, env);
      if (path === "/v1/connectors/token/rotate" && request.method === "POST") return await rotateConnectorToken(request, env);
      const connectorAuthMatch = path.match(/^\/v1\/connectors\/products\/([^/]+)\/authorization$/);
      if (connectorAuthMatch && request.method === "DELETE") return await revokeConnectorAuthorization(request, env, decodeURIComponent(connectorAuthMatch[1]));
      if (path === "/v1/connectors/jobs" && request.method === "GET") return await connectorJobs(request, env);
      const realtimeDeviceMatch = path.match(/^\/v1\/realtime\/devices\/([^/]+)$/);
      if (realtimeDeviceMatch && request.method === "GET") return await realtimeDevice(request, env, decodeURIComponent(realtimeDeviceMatch[1]));

      if (path === "/v1/connect-intents" && request.method === "POST") return await createConnectIntent(request, env);
      const intentMatch = path.match(/^\/v1\/connect-intents\/([^/]+)$/);
      if (intentMatch && request.method === "GET") return await getConnectIntent(request, env, decodeURIComponent(intentMatch[1]));
      const intentClaimMatch = path.match(/^\/v1\/connect-intents\/([^/]+)\/claim$/);
      if (intentClaimMatch && request.method === "POST") return await claimConnectIntent(request, env, decodeURIComponent(intentClaimMatch[1]));

      const authMatch = path.match(/^\/v1\/products\/([^/]+)\/authorization$/);
      if (authMatch && request.method === "GET") return await productAuthorization(request, env, decodeURIComponent(authMatch[1]));
      const authRequestMatch = path.match(/^\/v1\/products\/([^/]+)\/authorization\/request$/);
      if (authRequestMatch && request.method === "POST") return await requestAuthorization(request, env, decodeURIComponent(authRequestMatch[1]));
      const authImportProofMatch = path.match(/^\/v1\/products\/([^/]+)\/authorization\/import-proof$/);
      if (authImportProofMatch && request.method === "POST") return await createAuthorizationImportProof(request, env, decodeURIComponent(authImportProofMatch[1]));
      if (authMatch && request.method === "DELETE") return await revokeAuthorization(request, env, decodeURIComponent(authMatch[1]));
      const productJobMatch = path.match(/^\/v1\/products\/([^/]+)\/jobs$/);
      if (productJobMatch && request.method === "POST") return await createProductJob(request, env, decodeURIComponent(productJobMatch[1]), ctx);
      const delegatedAuthorizationMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/authorization$/);
      if (delegatedAuthorizationMatch && request.method === "GET") return await delegatedProductAuthorization(request, env, decodeURIComponent(delegatedAuthorizationMatch[1]));
      if (delegatedAuthorizationMatch && request.method === "DELETE") return await revokeDelegatedProductAuthorization(request, env, decodeURIComponent(delegatedAuthorizationMatch[1]));
      const delegatedAuthorizationClaimMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/authorization\/claim$/);
      if (delegatedAuthorizationClaimMatch && request.method === "POST") return await claimDelegatedProductAuthorization(request, env, decodeURIComponent(delegatedAuthorizationClaimMatch[1]));
      const delegatedConnectIntentMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/connect-intents$/);
      if (delegatedConnectIntentMatch && request.method === "POST") return await createDelegatedConnectIntent(request, env, decodeURIComponent(delegatedConnectIntentMatch[1]));
      const delegatedConnectIntentInspectMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/connect-intents\/([^/]+)$/);
      if (delegatedConnectIntentInspectMatch && request.method === "GET") return await getDelegatedConnectIntent(request, env, decodeURIComponent(delegatedConnectIntentInspectMatch[1]), decodeURIComponent(delegatedConnectIntentInspectMatch[2]));
      const delegatedProductJobMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/jobs$/);
      if (delegatedProductJobMatch && request.method === "POST") return await createDelegatedProductJob(request, env, decodeURIComponent(delegatedProductJobMatch[1]), ctx);
      const delegatedJobEventsMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/jobs\/([^/]+)\/events$/);
      if (delegatedJobEventsMatch && request.method === "GET") return await getDelegatedJobEvents(request, env, decodeURIComponent(delegatedJobEventsMatch[1]), decodeURIComponent(delegatedJobEventsMatch[2]));
      const delegatedCancelMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/jobs\/([^/]+)\/cancel$/);
      if (delegatedCancelMatch && request.method === "POST") return await cancelDelegatedJob(request, env, decodeURIComponent(delegatedCancelMatch[1]), decodeURIComponent(delegatedCancelMatch[2]));
      const delegatedJobMatch = path.match(/^\/v1\/products\/([^/]+)\/delegated\/jobs\/([^/]+)$/);
      if (delegatedJobMatch && request.method === "GET") return await getDelegatedJob(request, env, decodeURIComponent(delegatedJobMatch[1]), decodeURIComponent(delegatedJobMatch[2]));

      const jobMatch = path.match(/^\/v1\/jobs\/([^/]+)$/);
      if (jobMatch && request.method === "GET") return await getJob(request, env, decodeURIComponent(jobMatch[1]));
      if (jobMatch && request.method === "POST" && url.pathname.endsWith("/cancel")) return notFound(env);

      const jobEventsMatch = path.match(/^\/v1\/jobs\/([^/]+)\/events$/);
      if (jobEventsMatch && request.method === "GET") return await getJobEvents(request, env, decodeURIComponent(jobEventsMatch[1]));
      const cancelMatch = path.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
      if (cancelMatch && request.method === "POST") return await cancelJob(request, env, decodeURIComponent(cancelMatch[1]));

      const connectorEventMatch = path.match(/^\/v1\/connectors\/jobs\/([^/]+)\/events$/);
      if (connectorEventMatch && request.method === "POST") return await postConnectorEvents(request, env, decodeURIComponent(connectorEventMatch[1]));
      const acceptMatch = path.match(/^\/v1\/connectors\/jobs\/([^/]+)\/accept$/);
      if (acceptMatch && request.method === "POST") return await acceptConnectorJob(request, env, decodeURIComponent(acceptMatch[1]));
      const ackMatch = path.match(/^\/v1\/connectors\/jobs\/([^/]+)\/ack$/);
      if (ackMatch && request.method === "POST") return await ackConnectorJob(request, env, decodeURIComponent(ackMatch[1]));

      if (request.method === "GET" && !path.startsWith("/v1/")) return await assetResponse(request, env);
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
    if (message?.type === "job.assign") {
      desktopDelivered = this.safeSend(this.desktop?.socket, message);
      webDelivered = this.broadcastWeb({ type: "job.created", job: message.job, sent_at: message.sent_at || new Date().toISOString() });
    } else if (message?.type === "job.event") {
      webDelivered = this.broadcastWeb(message);
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
      this.desktop = null;
    } else {
      this.webs.delete(socketId);
    }
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
    const tables = await this.state.storage.get("tables") || {};
    const tableName = String(input.table || "");
    if (!tableName) return { error: "missing_table", status: 400 };
    const rows = Array.isArray(tables[tableName]) ? tables[tableName] : [];
    tables[tableName] = rows;

    if (input.op === "select") {
      return { rows: selectRows(rows, object(input.filters), object(input.options)) };
    }
    if (input.op === "insert") {
      const row = object(input.row);
      const duplicate = uniqueConflict(tableName, rows, row);
      if (duplicate) return { error: duplicate, status: 409 };
      const next = { id: crypto.randomUUID(), ...structuredClone(row) };
      rows.push(next);
      await this.state.storage.put("tables", tables);
      return { row: next };
    }
    if (input.op === "upsert") {
      const row = object(input.row);
      const conflictKey = String(input.conflictKey || "id");
      const index = rows.findIndex((item) => item[conflictKey] === row[conflictKey]);
      if (index >= 0) {
        rows[index] = { ...rows[index], ...structuredClone(row) };
        await this.state.storage.put("tables", tables);
        return { row: rows[index] };
      }
      const next = { id: crypto.randomUUID(), ...structuredClone(row) };
      rows.push(next);
      await this.state.storage.put("tables", tables);
      return { row: next };
    }
    if (input.op === "update") {
      const id = String(input.id || "");
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return { row: null };
      rows[index] = { ...rows[index], ...structuredClone(object(input.patch)) };
      await this.state.storage.put("tables", tables);
      return { row: rows[index] };
    }
    if (input.op === "deleteExpired") {
      const column = String(input.column || "expires_at");
      const before = rows.length;
      tables[tableName] = rows.filter((row) => {
        const expiresAt = Date.parse(row[column] || "");
        return !Number.isFinite(expiresAt) || expiresAt > Date.now();
      });
      await this.state.storage.put("tables", tables);
      return { count: before - tables[tableName].length };
    }
    return { error: "unknown_operation", status: 400 };
  }
}

async function createPasswordSession(request, env) {
  const body = await readJson(request, env);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  if (!email || password.length < 8) return json({ error: "invalid_credentials" }, env, 400);
  const displayName = clean(body.display_name, 100) || email;
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

async function queueSummary(request, env) {
  const session = await requireSession(request, env);
  const store = storage(env);
  const devices = await store.select("bridge_devices", { user_id: session.user.id }, { order: "last_seen_at", desc: true });
  const jobs = await store.select("bridge_jobs", { user_id: session.user.id }, { order: "created_at" });
  const limits = jobQueueLimits(env);
  return json({
    generated_at: now(),
    limits: {
      device_max_running: limits.deviceMaxRunning,
      device_max_queued: limits.deviceMaxQueued,
      account_max_active: limits.accountMaxActive,
      product_max_active: limits.productMaxActive,
    },
    counts: jobCounts(jobs),
    products: productJobCounts(jobs),
    devices: await Promise.all(devices.map(async (device) => ({
      device: publicDevice(device, env),
      queue: await publicDeviceQueue(env, device.id),
    }))),
    timing: jobTimingSummary(jobs),
  }, env);
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
    await storage(env).update("bridge_authorizations", authorization.id, {
      status: "revoked",
      updated_at: revokedAt,
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
    capabilities: object(body.capabilities),
    local_state: object(body.local_state),
    install_id: connectorInstallId(request) || clean(body.install_id, 200),
  });
  await store.update("bridge_pairing_codes", pairing.id, { consumed_at: now(), device_id: device.id });
  await audit(env, pairing.user_id, device.id, null, "device.claim", device.id, { app_version: body.app_version || null });
  return json({
    device: publicDevice(device, env),
    device_token: token,
    token_type: "Bearer",
    token_expires_at: tokenExpiresAt,
    install_identity_bound: Boolean(device.install_id_hash),
  }, env, 201);
}

async function createConnectIntent(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  const productId = clean(body.product_id || body.productId || "panda-chat", 80) || "panda-chat";
  const product = requireOfficialProduct(productId, env);
  const source_origin = sourceOrigin(env);
  const deviceName = clean(body.device_name || body.deviceName, 120) || "Panda Bridge Desktop";
  const token = randomToken("pbi_");
  const row = await storage(env).insert("bridge_connect_intents", {
    user_id: session.user.id,
    device_id: null,
    product_id: productId,
    source_origin,
    device_name: deviceName,
    token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + connectIntentTtlMs(env)).toISOString(),
    consumed_at: null,
    created_at: now(),
  });
  await audit(env, session.user.id, null, product.id, "connect_intent.create", row.id, { device_name: deviceName, source_origin });
  return json({
    token,
    deep_link: `${desktopProtocol(env)}://connect?intent=${encodeURIComponent(token)}&api=${encodeURIComponent(publicApiBase(env))}`,
    connect_intent: publicConnectIntent(row, session.user, env),
    account: publicAccount(session.user),
    product,
    ttl_seconds: Math.trunc(connectIntentTtlMs(env) / 1000),
  }, env, 201);
}

async function getConnectIntent(request, env, token) {
  const intent = await connectIntentByToken(env, token);
  if (!intent || intent.consumed_at || Date.parse(intent.expires_at) < Date.now()) {
    return json({ error: "invalid_connect_intent" }, env, 400);
  }
  const product = requireOfficialProduct(intent.product_id, env);
  const user = (await storage(env).select("bridge_users", { id: intent.user_id }))[0] || null;
  return json({ connect_intent: publicConnectIntent(intent, user, env), account: publicAccount(user), product }, env);
}

async function claimConnectIntent(request, env, token) {
  const body = await readJson(request, env);
  if (!isNativeConnectIntentClaim(request)) {
    return json({ error: "desktop_claim_required" }, env, 403);
  }
  const store = storage(env);
  const intent = await connectIntentByToken(env, token);
  if (!intent || intent.consumed_at || Date.parse(intent.expires_at) < Date.now()) {
    return json({ error: "invalid_connect_intent" }, env, 400);
  }
  const product = requireOfficialProduct(intent.product_id, env);
  const user = (await store.select("bridge_users", { id: intent.user_id }))[0] || null;
  const existingConnector = await optionalConnector(request, env);
  const reuseDevice = existingConnector?.device?.user_id === intent.user_id ? existingConnector : null;
  const input = {
    device_name: clean(body.device_name, 120) || intent.device_name || "Panda Bridge Desktop",
    app_version: clean(body.app_version, 80) || null,
    capabilities: object(body.capabilities),
    local_state: object(body.local_state),
    install_id: connectorInstallId(request) || clean(body.install_id, 200),
  };
  const { device, token: deviceToken, tokenExpiresAt } = reuseDevice
    ? await updateDeviceForIntent(env, reuseDevice.device, reuseDevice.raw_token, input)
    : await createDeviceWithToken(env, intent.user_id, input);
  const source_origin = clean(intent.source_origin, 300) || product.origin || sourceOrigin(env);
  const policy = normalizeAuthorizationPolicy(object(body.policy), product, source_origin);
  const authorization = await upsertAuthorization(env, intent.user_id, device.id, product.id, policy, source_origin);
  await store.update("bridge_connect_intents", intent.id, { consumed_at: now(), device_id: device.id });
  await audit(env, intent.user_id, device.id, product.id, "connect_intent.claim", intent.id, { app_version: body.app_version || null, source_origin });
  return json({
    device: publicDevice(device, env),
    authorization,
    account: publicAccount(user),
    product,
    device_token: deviceToken,
    token_type: "Bearer",
    token_expires_at: tokenExpiresAt,
    install_identity_bound: Boolean(device.install_id_hash),
  }, env, 201);
}

async function connectorHeartbeat(request, env) {
  const connector = await requireConnector(request, env);
  const body = await readJson(request, env);
  const installPatch = await installIdentityPatch(connector.device, connectorInstallId(request) || clean(body.install_id, 200));
  const patch = {
    ...installPatch,
    status: "online",
    app_version: clean(body.app_version, 80) || connector.device.app_version || null,
    capabilities: object(body.capabilities),
    local_state: object(body.local_state),
    last_seen_at: now(),
    updated_at: now(),
  };
  const device = await storage(env).update("bridge_devices", connector.device.id, patch);
  return json({ ok: true, device: publicDevice(device, env) }, env);
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
    capabilities: object(body.capabilities).runtime ? object(body.capabilities) : connector.device.capabilities || {},
    local_state: object(body.local_state).platform ? object(body.local_state) : connector.device.local_state || {},
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

async function connectorJobs(request, env) {
  const connector = await requireConnector(request, env);
  const store = storage(env);
  const rows = await store.select("bridge_jobs", { device_id: connector.device.id, status: "queued" }, { order: "created_at" });
  const authorizedRows = [];
  for (const row of rows) {
    if (await activeAuthorization(env, row.user_id, row.device_id, row.product_id)) {
      authorizedRows.push(row);
    } else {
      await cancelAuthorizationRevokedJob(env, row);
    }
  }
  const available = await availableDeviceSlots(env, connector.device.id);
  if (available <= 0) return json({ items: [], queue: await publicDeviceQueue(env, connector.device.id) }, env);
  const jobs = [];
  for (const row of authorizedRows.slice(0, available)) {
    const acceptedAt = now();
    const job = await store.update("bridge_jobs", row.id, {
      status: "running",
      pushed_at: row.pushed_at || acceptedAt,
      desktop_received_at: row.desktop_received_at || acceptedAt,
      accepted_at: row.accepted_at || acceptedAt,
      updated_at: acceptedAt,
    });
    const event = await appendEvent(env, job.id, "claimed", {
      device_id: connector.device.id,
      transport: "poll",
      accepted_at: acceptedAt,
      desktop_received_at: job.desktop_received_at,
    }, 2);
    await notifyJobEvent(env, connector.device.id, job, event);
    jobs.push(publicJob(job));
  }
  return json({ items: jobs, queue: await publicDeviceQueue(env, connector.device.id) }, env);
}

async function productAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const deviceId = url.searchParams.get("device_id") || "";
  const authorization = await activeAuthorization(env, session.user.id, deviceId, product.id);
  return json({ authorization, product }, env);
}

async function requestAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  const device = await ownedDevice(env, session.user.id, String(body.device_id || ""));
  if (!device) return json({ error: "device_not_found" }, env, 404);
  const authorization = await activeAuthorization(env, session.user.id, device.id, product.id);
  if (authorization) return json({ authorization, product }, env);
  await audit(env, session.user.id, device.id, product.id, "authorization.desktop_required", device.id, { source_origin: sourceOrigin(env) });
  return json({ error: "desktop_authorization_required", authorization: null, product }, env, 403);
}

async function createAuthorizationImportProof(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  const device = await ownedDevice(env, session.user.id, String(body.device_id || ""));
  if (!device || device.status === "revoked") return json({ error: "device_not_found" }, env, 404);
  const authorization = await activeAuthorization(env, session.user.id, device.id, product.id);
  if (!authorization) return json({ error: "product_not_authorized" }, env, 403);
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
    authorization,
    device: publicDevice(device, env),
    product,
  }, env, 201);
}

async function revokeAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const device = await ownedDevice(env, session.user.id, url.searchParams.get("device_id") || "");
  if (!device) return json({ error: "device_not_found" }, env, 404);
  const authorization = (await storage(env).select("bridge_authorizations", {
    user_id: session.user.id,
    device_id: device.id,
    product_id: product.id,
  }))[0];
  if (!authorization) return json({ authorization: null, product }, env);
  const revoked = await storage(env).update("bridge_authorizations", authorization.id, { status: "revoked", updated_at: now() });
  const cancelled_jobs = await cancelQueuedJobsForAuthorization(env, session.user.id, device.id, product.id);
  await audit(env, session.user.id, device.id, product.id, "authorization.revoke", authorization.id, { source_origin: sourceOrigin(env) });
  return json({ authorization: revoked, product, cancelled_jobs }, env);
}

async function revokeConnectorAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const connector = await requireConnector(request, env);
  const authorization = (await storage(env).select("bridge_authorizations", {
    user_id: connector.device.user_id,
    device_id: connector.device.id,
    product_id: product.id,
  }))[0];
  if (!authorization) return json({ authorization: null, product, cancelled_jobs: 0 }, env);
  const revoked = await storage(env).update("bridge_authorizations", authorization.id, { status: "revoked", updated_at: now() });
  const cancelled_jobs = await cancelQueuedJobsForAuthorization(env, connector.device.user_id, connector.device.id, product.id);
  await audit(env, connector.device.user_id, connector.device.id, product.id, "authorization.revoke.connector", authorization.id, {
    source_origin: sourceOrigin(env),
  });
  return json({ authorization: revoked, product, cancelled_jobs }, env);
}

async function createProductJob(request, env, productId, ctx = {}) {
  const product = requireOfficialProduct(productId, env);
  const session = await requireSession(request, env);
  const body = await readJson(request, env);
  return await createAuthorizedProductJob(env, product, session.user.id, sourceOrigin(env), body, ctx, {
    auditAction: "job.create",
  });
}

async function createDelegatedProductJob(request, env, productId, ctx = {}) {
  const product = requireOfficialProduct(productId, env);
  const rawBody = await readJsonText(request, env);
  const delegation = await requireProductDelegation(request, env, product, rawBody);
  const body = rawBody ? parseJsonText(rawBody) : {};
  return await createAuthorizedProductJob(env, product, delegation.bridgeUserId, delegation.sourceOrigin, body, ctx, {
    auditAction: "job.create.delegated",
    delegatedDeviceId: delegation.deviceId,
    delegationNonce: delegation.nonce,
  });
}

async function delegatedProductAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const delegation = await requireProductDelegation(request, env, product, "");
  const url = new URL(request.url);
  const deviceId = clean(url.searchParams.get("device_id"), 120);
  if (deviceId !== delegation.deviceId) return json({ error: "delegated_device_mismatch" }, env, 403);
  const device = await ownedDevice(env, delegation.bridgeUserId, deviceId);
  if (!device || device.status === "revoked") return json({ error: "device_not_found" }, env, 404);
  const authorization = await activeAuthorization(env, delegation.bridgeUserId, device.id, product.id);
  return json({ authorization, device: publicDevice(device, env), product }, env);
}

async function createDelegatedConnectIntent(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const rawBody = await readJsonText(request, env);
  const delegation = await requireProductDelegation(request, env, product, rawBody);
  const body = rawBody ? parseJsonText(rawBody) : {};
  const user = await ensureDelegatedUser(env, product.id, delegation.userId, object(body.account || body.user));
  const deviceName = clean(body.device_name || body.deviceName, 120) || "Panda Bridge Desktop";
  const token = randomToken("pbi_");
  const row = await storage(env).insert("bridge_connect_intents", {
    user_id: user.id,
    device_id: null,
    product_id: product.id,
    source_origin: delegation.sourceOrigin,
    device_name: deviceName,
    token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + connectIntentTtlMs(env)).toISOString(),
    consumed_at: null,
    created_at: now(),
  });
  await audit(env, user.id, null, product.id, "connect_intent.create.delegated", row.id, {
    device_name: deviceName,
    source_origin: delegation.sourceOrigin,
  });
  return json({
    token,
    deep_link: `${desktopProtocol(env)}://connect?intent=${encodeURIComponent(token)}&api=${encodeURIComponent(publicApiBase(env))}`,
    connect_intent: publicConnectIntent(row, user, env),
    account: publicAccount(user),
    product,
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
  const authorization = device ? await activeAuthorization(env, intent.user_id, device.id, product.id) : null;
  return json({
    connect_intent: publicConnectIntent(intent, user, env),
    account: publicAccount(user),
    device: publicDevice(device, env),
    authorization,
    product,
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
    authorization,
    device: publicDevice(device, env),
    product,
    proof: { consumed_at: consumedProof.consumed_at },
  }, env);
}

async function revokeDelegatedProductAuthorization(request, env, productId) {
  const product = requireOfficialProduct(productId, env);
  const rawBody = await readJsonText(request, env);
  const delegation = await requireProductDelegation(request, env, product, rawBody);
  const url = new URL(request.url);
  const deviceId = clean(url.searchParams.get("device_id") || delegation.deviceId, 120);
  if (deviceId !== delegation.deviceId) return json({ error: "delegated_device_mismatch" }, env, 403);
  const device = await ownedDevice(env, delegation.bridgeUserId, deviceId);
  if (!device || device.status === "revoked") return json({ error: "device_not_found" }, env, 404);
  const authorization = (await storage(env).select("bridge_authorizations", {
    user_id: delegation.bridgeUserId,
    device_id: device.id,
    product_id: product.id,
  }))[0];
  if (!authorization) return json({ authorization: null, device: publicDevice(device, env), product, cancelled_jobs: 0 }, env);
  const revoked = await storage(env).update("bridge_authorizations", authorization.id, { status: "revoked", updated_at: now() });
  const cancelled_jobs = await cancelQueuedJobsForAuthorization(env, delegation.bridgeUserId, device.id, product.id);
  await audit(env, delegation.bridgeUserId, device.id, product.id, "authorization.revoke.delegated", authorization.id, {
    source_origin: delegation.sourceOrigin,
  });
  return json({ authorization: revoked, device: publicDevice(device, env), product, cancelled_jobs }, env);
}

async function createAuthorizedProductJob(env, product, userId, source_origin, body, ctx = {}, options = {}) {
  const validation = validateBridgeJob({ ...body, productId: product.id });
  if (!validation.ok) return json({ error: "invalid_job", errors: validation.errors }, env, 400);
  const normalized = validation.job;
  if (!product.capabilities.includes(normalized.kind)) return json({ error: "scope_insufficient" }, env, 403);
  if (options.delegatedDeviceId && normalized.device_id !== options.delegatedDeviceId) {
    return json({ error: "delegated_device_mismatch" }, env, 403);
  }
  const device = await ownedDevice(env, userId, normalized.device_id);
  if (!device || device.status === "revoked") return json({ error: "device_not_found" }, env, 404);
  if (!isDeviceOnline(device, env)) return json({ error: "device_offline" }, env, 409);
  const authorization = await activeAuthorization(env, userId, device.id, product.id);
  if (!authorization) return json({ error: "product_not_authorized" }, env, 403);

  const existing = await existingRequestKeyJob(env, userId, device.id, product.id, normalized.request_key);
  if (existing) {
    if (!sameNormalizedJob(existing, normalized)) return json({ error: "idempotency_key_conflict" }, env, 409);
    return json({ job: publicJob(existing), reused: true }, env);
  }

  const limits = jobQueueLimits(env);
  const active = await activeJobsForDevice(env, device.id);
  const accountActive = await activeJobsForAccount(env, userId);
  const productActive = accountActive.filter((job) => job.product_id === product.id).length;
  if (active.length >= limits.deviceMaxQueued) {
    return json({
      error: "device_queue_full",
      queue: queueLimitPayload(active.length, limits.deviceMaxQueued, limits.deviceMaxRunning),
    }, env, 429);
  }
  if (accountActive.length >= limits.accountMaxActive) {
    return json({
      error: "account_queue_full",
      queue: queueLimitPayload(accountActive.length, limits.accountMaxActive, limits.deviceMaxRunning),
    }, env, 429);
  }
  if (productActive >= limits.productMaxActive) {
    return json({
      error: "product_queue_full",
      queue: queueLimitPayload(productActive, limits.productMaxActive, limits.deviceMaxRunning),
    }, env, 429);
  }

  const queuedAt = now();
  let job;
  try {
    job = await storage(env).insert("bridge_jobs", {
      user_id: userId,
      device_id: device.id,
      product_id: product.id,
      source_origin,
      kind: normalized.kind,
      runtime: "codex_app_server",
      workspace_ref: normalized.workspace_ref,
      input: normalized.input,
      policy: normalized.policy,
      request_key: normalized.request_key,
      status: "queued",
      result: {},
      queued_at: queuedAt,
      pushed_at: null,
      created_at: queuedAt,
      updated_at: queuedAt,
    });
  } catch (error) {
    const duplicate = await existingRequestKeyJob(env, userId, device.id, product.id, normalized.request_key);
    if (duplicate && sameNormalizedJob(duplicate, normalized)) return json({ job: publicJob(duplicate), reused: true }, env);
    if (duplicate) return json({ error: "idempotency_key_conflict" }, env, 409);
    throw error;
  }
  await runBackground(ctx, appendEvent(env, job.id, "queued", {
    product_id: product.id,
    source_origin,
    kind: job.kind,
    transport: realtimeEnabled(env) ? "scheduled_websocket" : "poll",
    queued_at: queuedAt,
    queue_position: active.length + 1,
  }, 1));
  await runBackground(ctx, audit(env, userId, device.id, product.id, options.auditAction || "job.create", job.id, {
    kind: job.kind,
    source_origin,
    delegated: Boolean(options.delegationNonce),
  }));
  await dispatchQueuedJobs(env, device.id);
  const refreshed = await jobById(env, job.id) || job;
  return json({
    job: publicJob(refreshed),
    product,
    queue: {
      position: active.length + 1,
      max_running: limits.deviceMaxRunning,
      max_queued: limits.deviceMaxQueued,
    },
  }, env, 201);
}

async function getDelegatedJob(request, env, productId, jobId) {
  const product = requireOfficialProduct(productId, env);
  const delegation = await requireProductDelegation(request, env, product, "");
  const job = await delegatedOwnedJob(env, delegation, product, jobId);
  if (!job) return json({ error: "job_not_found" }, env, 404);
  return json({ job: publicJob(job), product }, env);
}

async function getDelegatedJobEvents(request, env, productId, jobId) {
  const product = requireOfficialProduct(productId, env);
  const delegation = await requireProductDelegation(request, env, product, "");
  const job = await delegatedOwnedJob(env, delegation, product, jobId);
  if (!job) return json({ error: "job_not_found" }, env, 404);
  const after = Number(new URL(request.url).searchParams.get("after") || 0);
  const items = (await storage(env).select("bridge_job_events", { job_id: jobId }, { order: "seq" }))
    .filter((item) => Number(item.seq || 0) > after);
  return json({ job: publicJob(job), items }, env);
}

async function cancelDelegatedJob(request, env, productId, jobId) {
  const product = requireOfficialProduct(productId, env);
  const rawBody = await readJsonText(request, env);
  const delegation = await requireProductDelegation(request, env, product, rawBody);
  const job = await delegatedOwnedJob(env, delegation, product, jobId);
  if (!job) return json({ error: "job_not_found" }, env, 404);
  if (isTerminalJobStatus(job.status)) return json({ job: publicJob(job), cancelled: false }, env);
  const cancelledAt = now();
  const next = await storage(env).update("bridge_jobs", job.id, { status: "cancelled", completed_at: job.completed_at || cancelledAt, updated_at: cancelledAt });
  const event = await appendEvent(env, job.id, "cancelled", { completed_at: next.updated_at });
  await notifyJobEvent(env, job.device_id, next, event);
  await dispatchQueuedJobs(env, job.device_id);
  await audit(env, delegation.bridgeUserId, job.device_id, product.id, "job.cancel.delegated", job.id, { source_origin: delegation.sourceOrigin });
  return json({ job: publicJob(next), cancelled: true }, env);
}

async function getJob(request, env, jobId) {
  const session = await requireSession(request, env);
  const job = await ownedJob(env, session.user.id, jobId);
  if (!job) return json({ error: "job_not_found" }, env, 404);
  return json({ job: publicJob(job) }, env);
}

async function getJobEvents(request, env, jobId) {
  const session = await requireSession(request, env);
  const job = await ownedJob(env, session.user.id, jobId);
  if (!job) return json({ error: "job_not_found" }, env, 404);
  const after = Number(new URL(request.url).searchParams.get("after") || 0);
  const items = (await storage(env).select("bridge_job_events", { job_id: jobId }, { order: "seq" }))
    .filter((item) => Number(item.seq || 0) > after);
  return json({ job: publicJob(job), items }, env);
}

async function cancelJob(request, env, jobId) {
  const session = await requireSession(request, env);
  const job = await ownedJob(env, session.user.id, jobId);
  if (!job) return json({ error: "job_not_found" }, env, 404);
  if (isTerminalJobStatus(job.status)) return json({ job: publicJob(job), cancelled: false }, env);
  const cancelledAt = now();
  const next = await storage(env).update("bridge_jobs", job.id, { status: "cancelled", completed_at: job.completed_at || cancelledAt, updated_at: cancelledAt });
  const event = await appendEvent(env, job.id, "cancelled", { completed_at: next.updated_at });
  await notifyJobEvent(env, job.device_id, next, event);
  await dispatchQueuedJobs(env, job.device_id);
  return json({ job: publicJob(next), cancelled: true }, env);
}

async function postConnectorEvents(request, env, jobId) {
  const connector = await requireConnector(request, env);
  const job = await jobForDevice(env, connector.device.id, jobId);
  if (!job) return json({ error: "job_not_found" }, env, 404);
  if (isTerminalJobStatus(job.status)) {
    return json({ items: [], job: publicJob(job), ignored: true }, env);
  }
  const body = await readJson(request, env);
  const incoming = Array.isArray(body.events) ? body.events : [body];
  const events = [];
  let currentJob = job;
  for (const item of incoming) {
    const eventType = clean(item.type, 80) || "status";
    const eventPayload = object(item.payload || item);
    const patch = timingPatchForEvent(currentJob, eventType);
    if (Object.keys(patch).length) currentJob = await storage(env).update("bridge_jobs", currentJob.id, patch);
    const event = await appendEvent(env, currentJob.id, eventType, { ...eventPayload, ...patch });
    events.push(event);
    await notifyJobEvent(env, connector.device.id, currentJob, event);
  }
  return json({ items: events }, env, 201);
}

async function acceptConnectorJob(request, env, jobId) {
  const connector = await requireConnector(request, env);
  const job = await jobForDevice(env, connector.device.id, jobId);
  if (!job) return json({ error: "job_not_found" }, env, 404);
  const body = await readJson(request, env);
  if (job.status !== "queued") return json({ job: publicJob(job), accepted: false }, env);
  if (!await activeAuthorization(env, job.user_id, job.device_id, job.product_id)) {
    const cancelled = await cancelAuthorizationRevokedJob(env, job);
    return json({
      job: publicJob(cancelled),
      accepted: false,
      reason: "product_not_authorized",
    }, env);
  }
  if (!job.pushed_at && await availableDeviceSlots(env, connector.device.id) <= 0) {
    return json({
      job: publicJob(job),
      accepted: false,
      reason: "device_busy",
      queue: await publicDeviceQueue(env, connector.device.id),
    }, env);
  }
  const acceptedAt = now();
  const desktopReceivedAt = clean(body.desktop_received_at, 80) || acceptedAt;
  const next = await storage(env).update("bridge_jobs", job.id, {
    status: "running",
    desktop_received_at: job.desktop_received_at || desktopReceivedAt,
    accepted_at: job.accepted_at || acceptedAt,
    updated_at: acceptedAt,
  });
  const event = await appendEvent(env, job.id, "claimed", {
    device_id: connector.device.id,
    transport: clean(body.transport, 40) || "websocket",
    accepted_at: acceptedAt,
    desktop_received_at: next.desktop_received_at,
  }, 2);
  await notifyJobEvent(env, connector.device.id, next, event);
  return json({ job: publicJob(next), accepted: true }, env);
}

async function ackConnectorJob(request, env, jobId) {
  const connector = await requireConnector(request, env);
  const job = await jobForDevice(env, connector.device.id, jobId);
  if (!job) return json({ error: "job_not_found" }, env, 404);
  if (!await activeAuthorization(env, job.user_id, job.device_id, job.product_id)) {
    const cancelled = await cancelAuthorizationRevokedJob(env, job);
    return json({ error: "product_not_authorized", job: publicJob(cancelled) }, env, 403);
  }
  if (isTerminalJobStatus(job.status)) {
    return json({ job: publicJob(job), ignored: true }, env);
  }
  const body = await readJson(request, env);
  const status = body.status === "failed" ? "failed" : "succeeded";
  const terminalAt = now();
  const next = await storage(env).update("bridge_jobs", job.id, {
    status,
    result: object(body.result),
    completed_at: job.completed_at || terminalAt,
    acked_at: terminalAt,
    updated_at: terminalAt,
  });
  const event = await appendEvent(env, job.id, status === "failed" ? "failed" : "completed", {
    ...object(body.result),
    completed_at: next.completed_at,
    acked_at: terminalAt,
  });
  await notifyJobEvent(env, connector.device.id, next, event);
  await dispatchQueuedJobs(env, connector.device.id);
  return json({ job: publicJob(next) }, env);
}

function isTerminalJobStatus(status) {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

async function appendEvent(env, jobId, type, payload = {}, seq = null) {
  const store = storage(env);
  const existing = seq ? [] : await store.select("bridge_job_events", { job_id: jobId });
  const nextSeq = seq || Math.max(0, ...existing.map((item) => Number(item.seq || 0))) + 1;
  return store.insert("bridge_job_events", {
    job_id: jobId,
    seq: nextSeq,
    ...bridgeEvent(type, payload),
  });
}

function timingPatchForEvent(job, eventType) {
  const at = now();
  if (eventType === "started" && !job.started_at) {
    return { started_at: at, updated_at: at };
  }
  if (eventType === "text_delta" && !job.first_delta_at) {
    return { first_delta_at: at, updated_at: at };
  }
  return {};
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

async function notifyJobAssignment(env, deviceId, job) {
  return notifyDeviceRoom(env, deviceId, { type: "job.assign", job: publicJob(job), sent_at: now() });
}

async function notifyJobEvent(env, deviceId, job, event) {
  return notifyDeviceRoom(env, deviceId, {
    type: "job.event",
    job: publicJob(job),
    event,
    sent_at: now(),
  });
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

async function existingRequestKeyJob(env, userId, deviceId, productId, requestKey) {
  return requestKey
    ? (await storage(env).select("bridge_jobs", {
        user_id: userId,
        device_id: deviceId,
        product_id: productId,
        request_key: requestKey,
      }))[0] || null
    : null;
}

async function delegatedOwnedJob(env, delegation, product, jobId) {
  const job = await ownedJob(env, delegation.bridgeUserId, jobId);
  if (!job) return null;
  if (job.product_id !== product.id || job.device_id !== delegation.deviceId) return null;
  return job;
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
  if (productId === "otherline" && env.BRIDGE_OTHERLINE_DELEGATION_SECRET) {
    return clean(env.BRIDGE_OTHERLINE_DELEGATION_SECRET, 4096);
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

function productDelegationSkewMs(env) {
  return boundedInteger(env.BRIDGE_PRODUCT_DELEGATION_SKEW_MS, 1000 * 60 * 5, 1000, 1000 * 60 * 30);
}

async function reserveProductDelegationNonce(env, productId, nonce, timestamp) {
  const nonceHash = await sha256Hex(`${productId}:${nonce}`);
  try {
    await storage(env).insert("bridge_product_delegation_nonces", {
      product_id: productId,
      nonce_hash: nonceHash,
      request_timestamp: timestamp,
      expires_at: new Date(Date.now() + productDelegationSkewMs(env)).toISOString(),
      created_at: now(),
    });
    return true;
  } catch {
    return false;
  }
}

function sameNormalizedJob(existing, normalized) {
  return existing.kind === normalized.kind
    && existing.workspace_ref === normalized.workspace_ref
    && canonicalJson(existing.input || {}) === canonicalJson(normalized.input || {})
    && canonicalJson(existing.policy || {}) === canonicalJson(normalized.policy || {});
}

function canonicalJson(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return "{}";
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
}

async function jobById(env, jobId) {
  return (await storage(env).select("bridge_jobs", { id: jobId }))[0] || null;
}

async function activeJobsForDevice(env, deviceId) {
  const rows = await storage(env).select("bridge_jobs", { device_id: deviceId }, { order: "created_at" });
  return rows.filter((job) => isActiveJobStatus(job.status));
}

async function activeJobsForAccount(env, userId) {
  const rows = await storage(env).select("bridge_jobs", { user_id: userId }, { order: "created_at" });
  return rows.filter((job) => isActiveJobStatus(job.status));
}

async function availableDeviceSlots(env, deviceId) {
  const limits = jobQueueLimits(env);
  const active = await activeJobsForDevice(env, deviceId);
  const assigned = active.filter((job) => isAssignedDeviceJob(job, env)).length;
  return Math.max(0, limits.deviceMaxRunning - assigned);
}

async function dispatchQueuedJobs(env, deviceId) {
  if (!realtimeEnabled(env)) return [];
  const limits = jobQueueLimits(env);
  const active = await activeJobsForDevice(env, deviceId);
  const stillAuthorized = [];
  for (const job of active) {
    if (job.status === "queued" && !await activeAuthorization(env, job.user_id, job.device_id, job.product_id)) {
      await cancelAuthorizationRevokedJob(env, job);
    } else {
      stillAuthorized.push(job);
    }
  }
  const assigned = stillAuthorized.filter((job) => isAssignedDeviceJob(job, env)).length;
  const available = Math.max(0, limits.deviceMaxRunning - assigned);
  if (available <= 0) return [];
  const candidates = stillAuthorized
    .filter((job) => job.status === "queued" && !isAssignedDeviceJob(job, env))
    .sort(compareJobsByQueueOrder)
    .slice(0, available);
  const dispatched = [];
  for (const candidate of candidates) {
    const pushedAt = now();
    const job = await storage(env).update("bridge_jobs", candidate.id, {
      pushed_at: pushedAt,
      updated_at: pushedAt,
    });
    const delivery = await notifyJobAssignment(env, deviceId, job);
    if (delivery?.desktop_delivered) {
      dispatched.push(job);
    } else {
      await storage(env).update("bridge_jobs", candidate.id, {
        pushed_at: null,
        updated_at: candidate.updated_at || candidate.created_at || pushedAt,
      });
    }
  }
  return dispatched;
}

async function cancelQueuedJobsForAuthorization(env, userId, deviceId, productId) {
  const rows = await storage(env).select("bridge_jobs", {
    user_id: userId,
    device_id: deviceId,
    product_id: productId,
  });
  let count = 0;
  for (const row of rows.filter((job) => ["queued", "running"].includes(job.status))) {
    await cancelAuthorizationRevokedJob(env, row);
    count += 1;
  }
  return count;
}

async function cancelAuthorizationRevokedJob(env, job) {
  if (!["queued", "running"].includes(job.status)) return job;
  const cancelledAt = now();
  const next = await storage(env).update("bridge_jobs", job.id, {
    status: "cancelled",
    result: {
      ok: false,
      error: "product_not_authorized",
      reason: "authorization_revoked",
    },
    completed_at: job.completed_at || cancelledAt,
    updated_at: cancelledAt,
  });
  const event = await appendEvent(env, job.id, "cancelled", {
    error: "product_not_authorized",
    reason: "authorization_revoked",
    completed_at: next.completed_at,
  });
  await notifyJobEvent(env, job.device_id, next, event);
  return next;
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
  return deleted;
}

async function publicDeviceQueue(env, deviceId) {
  const limits = jobQueueLimits(env);
  const active = await activeJobsForDevice(env, deviceId);
  const running = active.filter((job) => job.status === "running").length;
  const assigned = active.filter((job) => isAssignedDeviceJob(job, env)).length;
  return {
    active: active.length,
    running,
    assigned,
    waiting: Math.max(0, active.length - assigned),
    max_running: limits.deviceMaxRunning,
    max_queued: limits.deviceMaxQueued,
  };
}

function jobCounts(jobs) {
  const counts = {
    total: jobs.length,
    active: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    other: 0,
  };
  for (const job of jobs) {
    if (isActiveJobStatus(job.status)) counts.active += 1;
    if (job.status && Object.prototype.hasOwnProperty.call(counts, job.status)) counts[job.status] += 1;
    else counts.other += 1;
  }
  return counts;
}

function productJobCounts(jobs) {
  const buckets = {};
  for (const job of jobs) {
    const productId = clean(job.product_id, 80) || "unknown";
    buckets[productId] = buckets[productId] || [];
    buckets[productId].push(job);
  }
  return Object.fromEntries(Object.entries(buckets).map(([productId, rows]) => [productId, jobCounts(rows)]));
}

function jobTimingSummary(jobs) {
  const terminal = jobs.filter((job) => isTerminalJobStatus(job.status));
  const fields = [
    "queued_to_claimed_ms",
    "pushed_to_claimed_ms",
    "claimed_to_started_ms",
    "started_to_first_delta_ms",
    "first_delta_to_completed_ms",
    "total_job_ms",
  ];
  const averages = {};
  const max = {};
  for (const field of fields) {
    const values = terminal
      .map((job) => Number(jobTiming(job)[field]))
      .filter(Number.isFinite);
    averages[field] = averageNumber(values);
    max[field] = values.length ? Math.max(...values) : null;
  }
  return {
    completed_count: terminal.length,
    average_ms: averages,
    max_ms: max,
  };
}

function averageNumber(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function jobQueueLimits(env) {
  return {
    deviceMaxRunning: boundedInteger(env.BRIDGE_DEVICE_MAX_RUNNING_JOBS, DEVICE_MAX_RUNNING_JOBS, 1, 5),
    deviceMaxQueued: boundedInteger(env.BRIDGE_DEVICE_MAX_QUEUED_JOBS, DEVICE_MAX_QUEUED_JOBS, 1, 1000),
    accountMaxActive: boundedInteger(env.BRIDGE_ACCOUNT_MAX_ACTIVE_JOBS, ACCOUNT_MAX_ACTIVE_JOBS, 1, 5000),
    productMaxActive: boundedInteger(env.BRIDGE_PRODUCT_MAX_ACTIVE_JOBS, PRODUCT_MAX_ACTIVE_JOBS, 1, 3000),
  };
}

function queueLimitPayload(active, max, maxRunning) {
  return {
    active,
    max_queued: max,
    max_running: maxRunning,
    retry_after_ms: 3000,
  };
}

function diagnosticsPayload(env) {
  const limits = jobQueueLimits(env);
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
    products: allProducts(sourceOrigin(env)).map((product) => ({
      id: product.id,
      name: product.name,
      origin: product.origin,
      official_origin: product.official_origin,
      official_origins: product.official_origins,
      capabilities: product.capabilities,
      requires_desktop_authorization: product.requires_desktop_authorization,
    })),
    jobs: {
      supported_kinds: [...SUPPORTED_JOB_KINDS],
      event_types: [...EVENT_TYPES],
      queue_limits: {
        device_max_running: limits.deviceMaxRunning,
        device_max_queued: limits.deviceMaxQueued,
        account_max_active: limits.accountMaxActive,
        product_max_active: limits.productMaxActive,
      },
      assignment_grace_ms: boundedInteger(env.BRIDGE_JOB_ASSIGNMENT_GRACE_MS, JOB_ASSIGNMENT_GRACE_MS, 1000, 1000 * 60 * 10),
    },
    connector: {
      device_token_prefix: DEVICE_TOKEN_PREFIX,
      device_token_ttl_ms: DEVICE_TOKEN_TTL_MS,
      device_token_rotation_grace_ms: deviceTokenRotationGraceMs(env),
      device_online_grace_ms: boundedInteger(env.BRIDGE_DEVICE_ONLINE_GRACE_MS, DEVICE_ONLINE_GRACE_MS, 1000, 1000 * 60 * 60),
      connect_intent_ttl_ms: connectIntentTtlMs(env),
      session_link_ttl_ms: sessionLinkTtlMs(env),
    },
  };
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function isAssignedDeviceJob(job, env) {
  if (job.status === "running") return true;
  if (job.status !== "queued" || !job.pushed_at) return false;
  return !isStaleAssignedJob(job, env);
}

function isStaleAssignedJob(job, env) {
  const pushedAt = Date.parse(job.pushed_at || "");
  if (!Number.isFinite(pushedAt)) return false;
  const graceMs = boundedInteger(env.BRIDGE_JOB_ASSIGNMENT_GRACE_MS, JOB_ASSIGNMENT_GRACE_MS, 1000, 1000 * 60 * 10);
  return !job.accepted_at && Date.now() - pushedAt > graceMs;
}

function compareJobsByQueueOrder(left, right) {
  const leftTime = Date.parse(left.created_at || left.queued_at || "") || 0;
  const rightTime = Date.parse(right.created_at || right.queued_at || "") || 0;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return String(left.id || "").localeCompare(String(right.id || ""));
}

async function connectIntentByToken(env, token) {
  const tokenHash = await sha256Hex(String(token || ""));
  return (await storage(env).select("bridge_connect_intents", { token_hash: tokenHash }))[0] || null;
}

async function createDeviceWithToken(env, userId, input) {
  const store = storage(env);
  const installPatch = await installIdentityPatch({}, clean(input.install_id, 200));
  const device = await store.insert("bridge_devices", {
    ...installPatch,
    user_id: userId,
    device_name: clean(input.device_name, 120) || "Panda Bridge Desktop",
    status: "online",
    app_version: clean(input.app_version, 80) || null,
    capabilities: object(input.capabilities),
    local_state: object(input.local_state),
    last_seen_at: now(),
    created_at: now(),
    updated_at: now(),
  });
  const { token, tokenExpiresAt } = await createDeviceToken(env, device.id);
  return { device, token, tokenExpiresAt };
}

async function updateDeviceForIntent(env, device, token, input) {
  const installPatch = await installIdentityPatch(device, clean(input.install_id, 200));
  const next = await storage(env).update("bridge_devices", device.id, {
    ...installPatch,
    device_name: clean(input.device_name, 120) || device.device_name,
    status: "online",
    app_version: clean(input.app_version, 80) || device.app_version || null,
    capabilities: object(input.capabilities),
    local_state: object(input.local_state),
    last_seen_at: now(),
    updated_at: now(),
  });
  return { device: next, token, tokenExpiresAt: null };
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
  return ["heartbeat", "jobs:read", "jobs:ack", "events:write"];
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
  const workspaceRoots = Array.isArray(policy.workspace_roots) && policy.workspace_roots.length
    ? policy.workspace_roots.map((item, index) => {
        const root = object(item);
        return {
          id: clean(root.id, 80) || `workspace-${index + 1}`,
          path_display: clean(root.path_display || root.label, 200) || "[local]/workspace",
        };
      })
    : [{ id: "default", path_display: "[local]/default" }];
  return {
    version: "AUTH-SCOPE-v1",
    product_id: product.id,
    source_origin: clean(policy.source_origin, 300) || source_origin || product.official_origin || product.origin || null,
    capabilities: Array.isArray(policy.capabilities) && policy.capabilities.length
      ? policy.capabilities.filter((item) => product.capabilities.includes(item))
      : [...product.capabilities],
    workspace_roots: workspaceRoots,
    sandbox_floor: ["workspace-write", "read-only"].includes(policy.sandbox_floor) ? policy.sandbox_floor : "workspace-write",
    approval_policy_floor: ["on-request", "on-failure", "untrusted"].includes(policy.approval_policy_floor) ? policy.approval_policy_floor : "on-request",
    allow_approval_never: policy.allow_approval_never === true,
    allow_developer_instructions: policy.allow_developer_instructions === true,
    display: object(policy.display),
  };
}

async function upsertAuthorization(env, userId, deviceId, productId, policy, sourceOrigin = "") {
  const store = storage(env);
  const existing = (await store.select("bridge_authorizations", {
    user_id: userId,
    product_id: productId,
    device_id: deviceId,
  }))[0];
  return existing
    ? store.update("bridge_authorizations", existing.id, { status: "active", policy, source_origin: sourceOrigin || existing.source_origin || null, updated_at: now() })
    : store.insert("bridge_authorizations", {
        user_id: userId,
        device_id: deviceId,
        product_id: productId,
        source_origin: sourceOrigin || null,
        status: "active",
        policy,
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

async function ownedJob(env, userId, jobId) {
  return (await storage(env).select("bridge_jobs", { id: jobId, user_id: userId }))[0] || null;
}

async function jobForDevice(env, deviceId, jobId) {
  return (await storage(env).select("bridge_jobs", { id: jobId, device_id: deviceId }))[0] || null;
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
    reset() {
      tables.clear();
    },
  };
}

function uniqueConflict(tableName, rows, row) {
  if (tableName === "bridge_jobs" && row.request_key) {
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

function publicJob(job) {
  const timing = job ? jobTiming(job) : null;
  return job ? {
    id: job.id,
    device_id: job.device_id,
    product_id: job.product_id,
    source_origin: job.source_origin || null,
    kind: job.kind,
    runtime: job.runtime,
    workspace_ref: job.workspace_ref,
    input: job.input,
    policy: job.policy,
    status: job.status,
    result: job.result,
    request_key: job.request_key,
    created_at: job.created_at,
    updated_at: job.updated_at,
    queued_at: job.queued_at || job.created_at || null,
    pushed_at: job.pushed_at || null,
    desktop_received_at: job.desktop_received_at || null,
    accepted_at: job.accepted_at || null,
    started_at: job.started_at || null,
    first_delta_at: job.first_delta_at || null,
    completed_at: job.completed_at || null,
    acked_at: job.acked_at || null,
    timing,
  } : null;
}

function jobTiming(job) {
  return {
    queued_to_claimed_ms: durationMs(job.queued_at || job.created_at, job.accepted_at),
    pushed_to_claimed_ms: durationMs(job.pushed_at, job.accepted_at),
    claimed_to_started_ms: durationMs(job.accepted_at, job.started_at),
    started_to_first_delta_ms: durationMs(job.started_at, job.first_delta_at),
    first_delta_to_completed_ms: durationMs(job.first_delta_at, job.completed_at),
    total_job_ms: durationMs(job.created_at, job.acked_at || job.completed_at),
  };
}

function durationMs(start, end) {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function publicDevice(device, env = {}) {
  return device ? {
    id: device.id,
    device_name: device.device_name,
    status: publicDeviceStatus(device, env),
    app_version: device.app_version,
    capabilities: device.capabilities || {},
    local_state: device.local_state || {},
    last_seen_at: device.last_seen_at,
    created_at: device.created_at,
    updated_at: device.updated_at,
  } : null;
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
    product: productInfo(intent.product_id, env),
    source_origin: intent.source_origin || null,
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
    if (url.hostname === "bridge.otherline.cc") return "https://api.bridge.otherline.cc";
    return `${url.protocol}//${url.host}`;
  } catch {
    return "https://api.bridge.otherline.cc";
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
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
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
  if (/^\/v1\/connect-intents\/[^/]+\/claim$/.test(path)) {
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
  return [...new Set([
    webOrigin(env),
    ...officialProductOrigins(),
    ...splitOrigins(env.BRIDGE_ALLOWED_ORIGINS),
  ].filter(Boolean))];
}

function splitOrigins(value) {
  return clean(value, 4000).split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function publicApiBase(env) {
  return env.BRIDGE_PUBLIC_API_BASE || "https://api.bridge.otherline.cc";
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
  return productById(productId, sourceOrigin(env));
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
