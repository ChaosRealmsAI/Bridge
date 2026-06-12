import { createBridgeClient } from "@panda-bridge/sdk";
import { bridgeNotesPermissions } from "./permissions.mjs";

export const PRODUCT_ID = "panda-notes";

export function defaultApiBase() {
  return process.env.PANDA_BRIDGE_API_BASE || "https://bridge.otherline.cc";
}

export function createNotesBridge({ apiBase = defaultApiBase(), fetch = globalThis.fetch } = {}) {
  const client = createBridgeClient({ apiBase, productId: PRODUCT_ID, fetch });
  const connect = (input = {}) => client.connect.createIntent({
    deviceName: input.deviceName || "Bridge Notes CLI",
    permissions: input.permissions || bridgeNotesPermissions(),
  });
  const ready = async (input = {}) => {
    const result = await client.ensureReady({
      wait: input.wait !== false,
      timeoutMs: input.timeoutMs || 120000,
      intervalMs: input.intervalMs || 1000,
    });
    const account = result.account || result.state?.current_account || null;
    const deviceId = account?.authorization?.status === "active" && account.connected === true
      ? account.current_device?.id
      : null;
    return { ...result, ready: Boolean(deviceId), deviceId, account };
  };
  return {
    apiBase,
    productId: PRODUCT_ID,
    client,
    connect,
    ready,
  };
}
