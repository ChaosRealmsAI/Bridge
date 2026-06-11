export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type BridgeErrorCode =
  | "already_authorized"
  | "authorization_import_proof_required"
  | "authorization_scope_denied"
  | "bridge_cloud_unavailable"
  | "connect_intent_not_found"
  | "delegated_authorization_proof_mismatch"
  | "delegated_device_mismatch"
  | "desktop_claim_required"
  | "device_not_found"
  | "device_offline"
  | "device_queue_full"
  | "idempotency_key_conflict"
  | "install_id_required"
  | "invalid_authorization_import_proof"
  | "invalid_authorization_policy"
  | "invalid_connect_intent"
  | "invalid_content_type"
  | "invalid_json"
  | "invalid_origin"
  | "job_not_found"
  | "local_policy_denied"
  | "product_delegation_body_hash_invalid"
  | "product_delegation_not_configured"
  | "product_delegation_replay"
  | "product_delegation_signature_invalid"
  | "product_delegation_timestamp_invalid"
  | "product_delegation_unauthorized"
  | "product_not_authorized"
  | "product_origin_mismatch"
  | "product_queue_full"
  | "request_body_too_large"
  | "scope_insufficient"
  | "unauthorized"
  | "bridge_error"
  | "bridge_ready_timeout";

export const BRIDGE_SDK_VERSION: string;
export const BridgeErrorCodes: Readonly<Record<BridgeErrorCode, BridgeErrorCode>>;

export class BridgeError extends Error {
  code: BridgeErrorCode | string;
  status: number;
  payload: JsonObject | null;
  constructor(message: string, options?: { code?: string; status?: number; payload?: JsonObject | null });
}

export type BridgeDesktopInstallChannel = "production" | "test" | string;

export type BridgeDesktopInstallTarget = {
  platform: "macos" | string;
  appName: string;
  fileName: string;
  version: string;
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

export type BridgeCompositeState =
  | "no_session"
  | "no_device"
  | "authorization_pending"
  | "authorized_offline"
  | "not_authorized"
  | "ready";

export type BridgeActionKind = "download" | "open_desktop" | "authorize" | "confirm_on_desktop" | "login";

export type BridgeStateAction = {
  kind: BridgeActionKind;
  url?: string | null;
  deep_link?: string | null;
};

export type BridgeStateDevice = {
  id: string | null;
  name: string | null;
  online: boolean;
  last_seen_at: string | null;
  current: boolean;
};

export type BridgeStateInstall = {
  download_url: string;
  version: string;
  sha256: string;
  platform: "macos" | string;
  open_url: string;
};

export type BridgeStateIntent = {
  token: string | null;
  expires_at: string | null;
  deep_link: string | null;
};

export type BridgeAuthorizationPolicy = {
  version?: "AUTH-SCOPE-v1" | string;
  preset?: string;
  request_source?: string;
  product_id?: string;
  source_origin?: string;
  capabilities?: string[];
  workspace_roots?: Array<{ id?: string; path_display?: string; allow_all?: boolean; [key: string]: JsonValue | undefined }>;
  sandbox_floor?: string;
  approval_policy_floor?: string;
  allow_approval_never?: boolean;
  allow_developer_instructions?: boolean;
  display?: { workspace?: string; sandbox?: string; approval?: string; developer_instructions?: string };
  [key: string]: JsonValue | undefined;
};

export type BridgeStateAuthorization = {
  status?: string;
  policy?: BridgeAuthorizationPolicy;
  authorized_at?: string;
  origin?: string;
  [key: string]: JsonValue | undefined;
} | null;

export type BridgeStateModel = {
  bridge_state: BridgeCompositeState;
  product_id?: string;
  install: BridgeStateInstall;
  devices: BridgeStateDevice[];
  authorization: BridgeStateAuthorization;
  intent: BridgeStateIntent | null;
  actions: BridgeStateAction[];
  [key: string]: JsonValue | BridgeStateInstall | BridgeStateDevice[] | BridgeStateAuthorization | BridgeStateIntent | BridgeStateAction[] | undefined;
};

export type EnsureReadyResult = {
  state: BridgeStateModel;
  ready: boolean;
  action: BridgeStateAction | null;
  response?: JsonObject;
};

export type EnsureReadyOptions = {
  openDeepLink?: (deepLink: string, context: { state: BridgeStateModel; intent: BridgeStateIntent }) => void | Promise<void>;
  deviceName?: string;
  device_name?: string;
  policy?: BridgeAuthorizationPolicy;
  permissions?: BridgeAuthorizationPolicy;
  intervalMs?: number;
  timeoutMs?: number;
};

export type WatchStateOptions = {
  intervalMs?: number;
  interval_ms?: number;
  timeoutMs?: number;
  timeout_ms?: number;
  realtime?: boolean;
};

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
  snapshot?: JsonObject,
  installTarget?: Partial<BridgeDesktopInstallTarget> | null,
): BridgeDesktopStatusModel;

export type BridgeDelegatedAccountStatusModel = {
  status: "connected" | "device_offline" | "source_registered" | "not_installed";
  ready: boolean;
  authorized: boolean;
  connected: boolean;
  deviceId: string | null;
  device: JsonObject | null;
  authorization: JsonObject | null;
  outlet: {
    deviceId: string | null;
    status: "connected" | "device_offline";
    ready: boolean;
    device: JsonObject;
    authorization: JsonObject;
  } | null;
};

export function bridgeDelegatedAccountStatusModel(payload?: JsonObject): BridgeDelegatedAccountStatusModel;

export type BridgeDelegatedConnectIntentStatusModel = {
  status: "connected" | "device_offline" | "authorization_pending";
  ready: boolean;
  authorized: boolean;
  connected: boolean;
  deviceId: string | null;
  device: JsonObject | null;
  authorization: JsonObject | null;
  intentId: string | null;
  expiresAt: string | null;
  deepLink: string | null;
};

export function bridgeDelegatedConnectIntentStatusModel(
  payload?: JsonObject,
  token?: string,
): BridgeDelegatedConnectIntentStatusModel;

export function bridgeSnapshotStatusForDevice(device?: JsonObject): "connected" | "device_offline";

export type BridgeJobInput = {
  kind?: string;
  deviceId?: string;
  device_id?: string;
  prompt?: string;
  calls?: JsonValue[];
  input?: JsonObject;
  payload?: JsonObject;
  workspaceRef?: string | null;
  workspace_ref?: string | null;
  requestKey?: string | null;
  request_key?: string | null;
  policy?: JsonObject;
};

export type BridgeClient = {
  productId: string;
  state(): Promise<BridgeStateModel>;
  watchState(options?: WatchStateOptions): AsyncGenerator<BridgeStateModel>;
  ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult>;
  install(options?: BridgeDesktopInstallOptions): { downloadUrl: string; version: string; sha256: string; openUrl: string; platform: string };
  diagnostics(): Promise<JsonObject>;
  preflight(input?: { deviceId?: string; device_id?: string }): Promise<JsonObject>;
  queue: { summary(): Promise<JsonObject> };
  auth: {
    session(): Promise<JsonObject>;
    password(email: string, password: string, displayName?: string): Promise<JsonObject>;
    guest(displayName?: string): Promise<JsonObject>;
    share(): Promise<JsonObject>;
    join(token: string): Promise<JsonObject>;
    logout(): Promise<JsonObject>;
  };
  devices: {
    list(): Promise<JsonObject>;
    createPairingCode(deviceName?: string): Promise<JsonObject>;
    revoke(deviceId: string): Promise<JsonObject>;
  };
  connect: {
    createIntent(input?: { productId?: string; product_id?: string; deviceName?: string; device_name?: string; policy?: BridgeAuthorizationPolicy; permissions?: BridgeAuthorizationPolicy; permission?: BridgeAuthorizationPolicy }): Promise<JsonObject>;
    intent(token: string): Promise<JsonObject>;
    claim(token: string, input?: JsonObject): Promise<JsonObject>;
  };
  products: {
    list(): Promise<JsonObject>;
    requestAuthorization(deviceId: string, policy?: JsonObject): Promise<JsonObject>;
    authorization(deviceId: string): Promise<JsonObject>;
    revokeAuthorization(deviceId: string): Promise<JsonObject>;
  };
  codex: {
    chat(input: BridgeJobInput): Promise<JsonObject>;
    run(input: BridgeJobInput): Promise<JsonObject>;
    rpc(input: BridgeJobInput): Promise<JsonObject>;
  };
  jobs: {
    create(input?: BridgeJobInput): Promise<JsonObject>;
    get(jobId: string): Promise<JsonObject>;
    events(jobId: string, after?: number): Promise<JsonObject>;
    wait(jobId: string, options?: { timeoutMs?: number; intervalMs?: number }): Promise<JsonObject>;
    stream(jobId: string, options?: { deviceId?: string; device_id?: string; after?: number; intervalMs?: number; timeoutMs?: number; realtime?: boolean }): AsyncGenerator<JsonObject>;
    cancel(jobId: string): Promise<JsonObject>;
  };
};

export function createBridgeClient(options: {
  apiBase: string;
  productId?: string;
  fetch?: typeof fetch;
}): BridgeClient;

export function bridgeFullAccessPolicy(overrides?: BridgeAuthorizationPolicy): BridgeAuthorizationPolicy;
