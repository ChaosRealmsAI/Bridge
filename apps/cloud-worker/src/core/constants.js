import { BRIDGE_RUNTIME_CAPABILITY_REGISTRY } from "../products.js";

export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
export const SESSION_LINK_TTL_MS = 1000 * 60 * 10;
export const PAIRING_TTL_MS = 1000 * 60 * 15;
export const CONNECT_INTENT_TTL_MS = 1000 * 60 * 10;
export const AUTHORIZATION_IMPORT_PROOF_TTL_MS = 1000 * 60 * 5;
export const DEVICE_ONLINE_GRACE_MS = 1000 * 90;
export const DEVICE_HEARTBEAT_INTERVAL_MS = 1000 * 30;
export const RELAY_ENVELOPE_TTL_MS = 1000 * 60 * 5;
export const PASSWORD_MAX_FAILED_ATTEMPTS = 5;
export const PASSWORD_ATTEMPT_WINDOW_MS = 1000 * 60 * 15;
export const PASSWORD_LOCK_MS = 1000 * 60 * 15;
export const DEVICE_TOKEN_TTL_MS = SESSION_TTL_MS;
export const DEVICE_TOKEN_ROTATION_GRACE_MS = 1000 * 60 * 10;
export const DEVICE_TOKEN_PREFIX = "pbd_";
export const RELAY_DEVICE_MAX_UNACKED = 150;
export const RELAY_ACCOUNT_MAX_UNACKED = 500;
export const RELAY_PRODUCT_MAX_UNACKED = 300;
export const RELAY_CHANNEL_MAX_UNACKED = 50;
export const RELAY_QUEUE_RETRY_AFTER_MS = 3000;
export const RELAY_CAPABILITY_REGISTRY = BRIDGE_RUNTIME_CAPABILITY_REGISTRY;
export const RELAY_CAPABILITY_KINDS = Object.freeze(Object.keys(RELAY_CAPABILITY_REGISTRY));
export const BRIDGE_DESKTOP_INSTALL = Object.freeze({
  platform: "macos",
  version: "panda-bridge-desktop-lite-v0.1",
  download_url: "https://assets.bridge.chaos-realms.cc/downloads/panda-bridge-macos.dmg",
  download_path: "/downloads/panda-bridge-macos.dmg",
  sha256: "e65e04f08373ffe2363616dc1426516b74f12123f52c71d7225af4bac7225962",
  open_url: "panda-bridge://open",
});
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 512;
export const MAX_JSON_BODY_LIMIT_BYTES = 1024 * 1024 * 2;
