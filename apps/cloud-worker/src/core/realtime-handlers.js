import { ownedDevice, requireConnector, requireSession } from "./auth-common.js";
import { json } from "./http.js";
import { storage } from "./storage.js";
import { deviceRoom } from "./realtime.js";
import { clean, now } from "./utils.js";

export async function realtimeDevice(request, env, deviceId) {
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
