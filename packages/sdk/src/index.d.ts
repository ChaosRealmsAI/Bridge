export type BridgeDesktopInstallChannel = "production" | "test" | string;

export type BridgeDesktopInstallTarget = {
  platform: string;
  appName: string;
  fileName: string;
  openUrl: string;
  downloadUrl: string;
  downloadPath: string;
  sha256: string;
};

export type BridgeDesktopInstallOptions = {
  platform?: string;
  channel?: BridgeDesktopInstallChannel;
  assetBaseUrl?: string;
  asset_base_url?: string;
  downloadUrl?: string;
  download_url?: string;
  openUrl?: string;
  open_url?: string;
};

export const bridgeDesktopInstallDefaults: Readonly<{
  macos: Readonly<{
    platform: "macos";
    appName: "Panda Bridge";
    fileName: "panda-bridge-macos.dmg";
    openUrl: "panda-bridge://open";
    downloadPath: "/downloads/panda-bridge-macos.dmg";
    downloadUrls: Readonly<Record<string, string>>;
    sha256: string;
  }>;
}>;

export function bridgeDesktopInstallTarget(options?: BridgeDesktopInstallOptions): BridgeDesktopInstallTarget;

export type BridgeDesktopAuthorizationState =
  | "authorized"
  | "pending"
  | "missing"
  | "revoked"
  | "denied"
  | "expired"
  | "insufficient"
  | "unknown";

export type BridgeDesktopConnectionState =
  | "connected"
  | "disconnected"
  | "waiting"
  | "not_ready"
  | "unknown";

export type BridgeDesktopStatusAction =
  | "ready"
  | "download_bridge"
  | "open_bridge"
  | "authorize_product"
  | "manage_authorization"
  | "confirm_on_desktop"
  | "refresh_status";

export type BridgeDesktopStatusModel = {
  status: string;
  ready: boolean;
  download: {
    state: "available" | "needed";
    available: boolean;
    downloaded: boolean;
    action: BridgeDesktopStatusAction;
    downloadUrl: string | null;
    openUrl: string | null;
  };
  authorization: {
    state: BridgeDesktopAuthorizationState;
    authorized: boolean;
    action: BridgeDesktopStatusAction;
  };
  connection: {
    state: BridgeDesktopConnectionState;
    connected: boolean;
    action: BridgeDesktopStatusAction;
  };
  nextAction: BridgeDesktopStatusAction;
};

export function bridgeDesktopStatusModel(
  snapshot?: Record<string, unknown>,
  installTarget?: Partial<BridgeDesktopInstallTarget> | null,
): BridgeDesktopStatusModel;

export type BridgeDelegatedAccountStatusModel = {
  status: "connected" | "device_offline" | "source_registered" | "not_installed";
  ready: boolean;
  authorized: boolean;
  connected: boolean;
  deviceId: string | null;
  device: Record<string, unknown> | null;
  authorization: Record<string, unknown> | null;
  outlet: {
    deviceId: string | null;
    status: "connected" | "device_offline";
    ready: boolean;
    device: Record<string, unknown>;
    authorization: Record<string, unknown>;
  } | null;
};

export function bridgeDelegatedAccountStatusModel(payload?: Record<string, unknown>): BridgeDelegatedAccountStatusModel;

export type BridgeDelegatedConnectIntentStatusModel = {
  status: "connected" | "device_offline" | "authorization_pending";
  ready: boolean;
  authorized: boolean;
  connected: boolean;
  deviceId: string | null;
  device: Record<string, unknown> | null;
  authorization: Record<string, unknown> | null;
  intentId: string | null;
  expiresAt: string | null;
  deepLink: string | null;
};

export function bridgeDelegatedConnectIntentStatusModel(
  payload?: Record<string, unknown>,
  token?: string,
): BridgeDelegatedConnectIntentStatusModel;

export function bridgeSnapshotStatusForDevice(device?: Record<string, unknown>): "connected" | "device_offline";

export function createBridgeClient(options?: Record<string, unknown>): Record<string, unknown>;
export function bridgeFullAccessPolicy(overrides?: Record<string, unknown>): Record<string, unknown>;
