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

export function createBridgeClient(options?: Record<string, unknown>): Record<string, unknown>;
export function bridgeFullAccessPolicy(overrides?: Record<string, unknown>): Record<string, unknown>;
