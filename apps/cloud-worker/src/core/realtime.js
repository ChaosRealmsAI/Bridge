import { storage } from "./storage.js";
import { redactedErrorMessage } from "./utils.js";

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

export function realtimeEnabled(env) {
  return Boolean(env.BRIDGE_DEVICE_ROOMS);
}

export function deviceRoom(env, deviceId) {
  const id = env.BRIDGE_DEVICE_ROOMS.idFromName(deviceId);
  return env.BRIDGE_DEVICE_ROOMS.get(id);
}

export async function notifyDeviceRoom(env, deviceId, message) {
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

export async function runBackground(ctx, promise) {
  const guarded = Promise.resolve(promise).catch((error) => {
    console.error("[bridge:background]", redactedErrorMessage(error));
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(guarded);
    return;
  }
  await guarded;
}
