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
export const BRIDGE_DESKTOP_RELEASE = Object.freeze({
  version: "0.1.1",
  asset_base_urls: Object.freeze({
    production: "https://assets.bridge.chaos-realms.cc",
    test: "https://assets-bridge-test.chaos-realms.cc",
  }),
  manifest: Object.freeze({
    latest_path: "/downloads/bridge-desktop/latest.json",
    versioned_path: "/downloads/releases/v0.1.1/bridge-desktop-v0.1.1.json",
  }),
  targets: Object.freeze({
    macos: Object.freeze({
      platform: "macos",
      package: "dmg",
      version: "0.1.1",
      file_name: "bridge-macos.dmg",
      versioned_file_name: "bridge-desktop-v0.1.1-macos.dmg",
      download_url: "https://assets.bridge.chaos-realms.cc/downloads/bridge-macos.dmg",
      download_path: "/downloads/bridge-macos.dmg",
      versioned_download_path: "/downloads/releases/v0.1.1/bridge-desktop-v0.1.1-macos.dmg",
      sha256: "1352877bdbbc2f0863563ae3bee95d32d689a90dc98599939c909b945d7d53bf",
      open_url: "bridge://open",
    }),
    windows_x64: Object.freeze({
      platform: "windows",
      arch: "x64",
      package: "portable-zip",
      version: "0.1.1",
      file_name: "bridge-windows-x64.zip",
      versioned_file_name: "bridge-desktop-v0.1.1-windows-x64.zip",
      download_url: "https://assets.bridge.chaos-realms.cc/downloads/bridge-windows-x64.zip",
      download_path: "/downloads/bridge-windows-x64.zip",
      versioned_download_path: "/downloads/releases/v0.1.1/bridge-desktop-v0.1.1-windows-x64.zip",
      sha256: "95cf2d5a7cff6702ae3d7e3ea54367dfad669115d1d7ec2ced93235901d5ffbd",
      open_url: "bridge://open",
    }),
  }),
});
export const BRIDGE_DESKTOP_INSTALL = Object.freeze({
  ...BRIDGE_DESKTOP_RELEASE.targets.macos,
  version: BRIDGE_DESKTOP_RELEASE.version,
  targets: BRIDGE_DESKTOP_RELEASE.targets,
  release_manifest_path: BRIDGE_DESKTOP_RELEASE.manifest.latest_path,
});
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 512;
export const MAX_JSON_BODY_LIMIT_BYTES = 1024 * 1024 * 2;
