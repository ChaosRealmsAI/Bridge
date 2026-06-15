export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type BridgeErrorCode =
  | "already_authorized"
  | "authorization_import_proof_required"
  | "authorization_paused"
  | "authorization_revoked"
  | "authorization_scope_denied"
  | "bridge_cloud_unavailable"
  | "connect_intent_not_found"
  | "delegated_authorization_proof_mismatch"
  | "delegated_device_mismatch"
  | "desktop_authorization_required"
  | "desktop_claim_required"
  | "device_not_found"
  | "device_offline"
  | "device_queue_full"
  | "idempotency_key_conflict"
  | "install_id_required"
  | "invalid_authorization_import_proof"
  | "invalid_authorization_policy"
  | "invalid_authorization_status"
  | "invalid_connect_intent"
  | "invalid_content_type"
  | "invalid_job"
  | "invalid_json"
  | "invalid_origin"
  | "invalid_relay_envelope"
  | "job_not_found"
  | "legacy_runtime_api_removed"
  | "local_policy_denied"
  | "not_found"
  | "plaintext_fields_forbidden"
  | "product_delegation_body_hash_invalid"
  | "product_delegation_not_configured"
  | "product_delegation_replay"
  | "product_delegation_signature_invalid"
  | "product_delegation_timestamp_invalid"
  | "product_delegation_unauthorized"
  | "product_not_authorized"
  | "product_origin_mismatch"
  | "product_queue_full"
  | "relay_account_queue_full"
  | "relay_channel_queue_full"
  | "relay_device_queue_full"
  | "relay_product_queue_full"
  | "relay_response_timeout"
  | "request_body_too_large"
  | "scope_insufficient"
  | "unauthorized"
  | "unsupported_job_kind"
  | "bridge_error"
  | "bridge_ready_timeout";

export const BRIDGE_SDK_VERSION: string;
export const BridgeRelayKeyBootstrapAadVersions: Readonly<{
  bridge: "bridge-relay-key-bootstrap-v1";
}>;
export const BridgeErrorCodes: Readonly<Partial<Record<BridgeErrorCode, BridgeErrorCode>>>;
export const BRIDGE_ERROR_MESSAGES: Readonly<Partial<Record<BridgeErrorCode, string>>>;
export function bridgeErrorMessageForCode(code: BridgeErrorCode | string, status?: number): string;

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

export type BridgeAuthorizationStatus = "active" | "paused" | "revoked";

export type BridgeStateInstall = {
  download_url: string;
  version: string;
  sha256: string;
  platform: "macos" | string;
  open_url: string;
};

export type BridgeStateDevice = {
  id: string | null;
  name: string | null;
  online: boolean;
  last_seen_at: string | null;
  current: boolean;
};

export type BridgeStateAuthorization = {
  id?: string;
  device_id?: string;
  status: BridgeAuthorizationStatus;
  authorized_at?: string;
  updated_at?: string;
  origin?: string;
};

export type BridgeAccount = {
  id?: string;
  email?: string;
  display_name?: string;
};

export type BridgeStateAccount = {
  account: BridgeAccount | null;
  authorization: BridgeStateAuthorization | null;
  connected: boolean;
  current_device: BridgeStateDevice | null;
};

export type BridgeStateIntent = {
  token: string | null;
  expires_at: string | null;
  deep_link: string | null;
};

export type BridgeConnectIntentResult = {
  token: string;
  deep_link?: string;
  expires_at?: string;
  account?: BridgeAccount | null;
  product?: JsonObject;
  connect_intent?: JsonObject;
  [key: string]: JsonValue | undefined;
};

export type BridgeStateModel = {
  product_id?: string;
  product?: JsonObject;
  install: BridgeStateInstall;
  accounts: BridgeStateAccount[];
  ready: boolean;
  current_account: BridgeStateAccount | null;
};

export function bridgeStateModel(payload?: JsonObject, productId?: string): BridgeStateModel;

export type BridgeReadyActionKind = "authorize" | "resume_authorization" | "wait_for_device";

export type BridgeReadyAction = {
  kind: BridgeReadyActionKind;
  reason: string;
};

export type EnsureReadyResult = {
  state: BridgeStateModel;
  ready: boolean;
  action: BridgeReadyAction | null;
  account?: BridgeStateAccount | null;
};

export type EnsureReadyOptions = {
  intervalMs?: number;
  interval_ms?: number;
  timeoutMs?: number;
  timeout_ms?: number;
  wait?: boolean;
  waitForReady?: boolean;
  wait_for_ready?: boolean;
};

export type WatchStateOptions = {
  intervalMs?: number;
  interval_ms?: number;
  timeoutMs?: number;
  timeout_ms?: number;
  realtime?: boolean;
};

export type BridgeDesktopStatusAction =
  | "ready"
  | "download_bridge"
  | "open_bridge"
  | "authorize_product"
  | "manage_authorization"
  | "resume_authorization"
  | "wait_for_device";

export type BridgeDesktopStatusModel = {
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
    status: BridgeAuthorizationStatus | "missing";
    authorized: boolean;
    action: BridgeDesktopStatusAction;
  };
  connection: {
    state: "connected" | "reconnecting" | "offline";
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
  ready: boolean;
  connected: boolean;
  account: JsonObject | null;
  authorization: BridgeStateAuthorization | null;
  current_device: BridgeStateDevice | null;
  accounts: BridgeStateAccount[];
};

export function bridgeDelegatedAccountStatusModel(payload?: JsonObject): BridgeDelegatedAccountStatusModel;

export type BridgeDelegatedConnectIntentStatusModel = {
  ready: boolean;
  authorized: boolean;
  connected: boolean;
  account: JsonObject | null;
  current_device: BridgeStateDevice | null;
  authorization: BridgeStateAuthorization | null;
  accounts: BridgeStateAccount[];
  intentId: string | null;
  expiresAt: string | null;
  deepLink: string | null;
};

export function bridgeDelegatedConnectIntentStatusModel(
  payload?: JsonObject,
  token?: string,
): BridgeDelegatedConnectIntentStatusModel;

export function bridgeSnapshotStatusForDevice(device?: JsonObject): "connected" | "reconnecting";

export type BridgeAuthorizationPolicy = {
  version?: string;
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
  [key: string]: JsonValue | undefined;
};

export type BridgeAuthorizationInput = {
  deviceId?: string;
  device_id?: string;
  accountId?: string;
  account_id?: string;
  policy?: BridgeAuthorizationPolicy;
};

export type BridgeAuthorizationResponse = {
  product_id?: string;
  product?: JsonObject;
  install?: BridgeStateInstall;
  ready?: boolean;
  current_account?: BridgeStateAccount | null;
  authorization: BridgeStateAuthorization | null;
  account: BridgeAccount | null;
  connected: boolean;
  current_device: BridgeStateDevice | null;
  accounts: BridgeStateAccount[];
  cancelled_jobs?: number;
};

export type BridgeRelayEnvelopeInput = {
  envelopeVersion?: string;
  envelope_version?: string;
  deviceId?: string;
  device_id?: string;
  channelId?: string;
  channel_id?: string;
  direction?: "product_to_device" | "device_to_product";
  seq?: number;
  requestKey?: string | null;
  request_key?: string | null;
  ciphertext: string;
  aad: string;
  nonce?: string;
  iv?: string;
  algorithm?: string;
  alg?: string;
  senderKeyId?: string;
  sender_key_id?: string;
  recipientKeyId?: string;
  recipient_key_id?: string;
  ttlMs?: number;
  ttl_ms?: number;
  meta?: JsonObject;
};

export type BridgeRelayListInput = {
  deviceId?: string;
  device_id?: string;
  channelId?: string;
  channel_id?: string;
  afterSeq?: number;
  after_seq?: number;
  limit?: number;
  waitMs?: number;
  wait_ms?: number;
  includeAcked?: boolean;
  include_acked?: boolean;
};

export type BridgeRelayWaitInput = BridgeRelayListInput & {
  timeoutMs?: number;
  timeout_ms?: number;
  intervalMs?: number;
  interval_ms?: number;
};

export type BridgeRelayWaitForResponseResult = {
  envelope: JsonObject;
  ack(input?: JsonObject): Promise<JsonObject>;
};

export type BridgeRelayAadInput = {
  productId?: string;
  product_id?: string;
  deviceId?: string;
  device_id?: string;
  channelId?: string;
  channel_id?: string;
  direction?: "product_to_device" | "device_to_product" | string;
  seq?: number;
  authorizationId?: string;
  authorization_id?: string;
  authorizationEpoch?: string | number;
  authorization_epoch?: string | number;
  relayKeyId?: string;
  relay_key_id?: string;
  keyId?: string;
  key_id?: string;
};

export function bridgeRelayEnvelopeAadText(input?: BridgeRelayAadInput): string;
export function bridgeRelayEnvelopeAadBase64(input?: BridgeRelayAadInput): string;
export function bridgeRelayKeyBootstrapAadText(input?: BridgeRelayAadInput & { wireVersion?: string; wire_version?: string }): string;

export type BridgeRelayCryptoContext = {
  productId: string;
  deviceId: string;
  channelId: string;
  direction: "product_to_device";
  seq: number;
  requestKey: string;
  authorizationId: string;
  authorizationEpoch: string;
  relayKeyId: string;
};

export type BridgeRelayEncryptInput = {
  payload: JsonValue | undefined;
  context: BridgeRelayCryptoContext;
  aad: string;
  aadText: string;
  productId: string;
  deviceId: string;
  channelId: string;
  direction: "product_to_device";
  seq: number;
  requestKey: string;
};

export type BridgeRelayEncryptedEnvelopeFields = {
  ciphertext: string;
  aad?: string;
  nonce?: string;
  iv?: string;
  algorithm?: string;
  alg?: string;
  senderKeyId?: string;
  sender_key_id?: string;
  recipientKeyId?: string;
  recipient_key_id?: string;
  meta?: JsonObject;
};

export type BridgeRelaySession = {
  encrypt?(input: BridgeRelayEncryptInput): Promise<BridgeRelayEncryptedEnvelopeFields> | BridgeRelayEncryptedEnvelopeFields;
  encryptEnvelope?(input: BridgeRelayEncryptInput): Promise<BridgeRelayEncryptedEnvelopeFields> | BridgeRelayEncryptedEnvelopeFields;
  decrypt?(envelope: JsonObject, input: { context: BridgeRelayCryptoContext; requestEnvelope: JsonObject | null; responseEnvelope: JsonObject; aadText: string }): Promise<JsonValue> | JsonValue;
  decryptEnvelope?(envelope: JsonObject, input: { context: BridgeRelayCryptoContext; requestEnvelope: JsonObject | null; responseEnvelope: JsonObject; aadText: string }): Promise<JsonValue> | JsonValue;
};

export type BridgeRelayCallInput = BridgeRelayWaitInput & {
  session?: BridgeRelaySession;
  crypto?: BridgeRelaySession;
  payload?: JsonValue;
  command?: JsonValue;
  input?: JsonValue;
  deviceId?: string;
  device_id?: string;
  channelId?: string;
  channel_id?: string;
  seq?: number;
  requestKey?: string;
  request_key?: string;
  aad?: string;
  ttlMs?: number;
  ttl_ms?: number;
  authorizationId?: string;
  authorization_id?: string;
  authorizationEpoch?: string | number;
  authorization_epoch?: string | number;
  relayKeyId?: string;
  relay_key_id?: string;
  recipientKeyId?: string;
  recipient_key_id?: string;
  meta?: JsonObject;
};

export type BridgeRelayCallResult = {
  created: JsonObject;
  request: JsonObject | null;
  response: JsonObject;
  payload: JsonValue;
  ack(input?: JsonObject): Promise<JsonObject>;
};

export type BridgeClient = {
  productId: string;
  state(): Promise<BridgeStateModel>;
  watchState(options?: WatchStateOptions): AsyncGenerator<BridgeStateModel>;
  ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult>;
  install(options?: BridgeDesktopInstallOptions): { downloadUrl: string; version: string; sha256: string; openUrl: string; platform: string };
  diagnostics(): Promise<JsonObject>;
  preflight(input?: { deviceId?: string; device_id?: string }): Promise<JsonObject>;
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
    createIntent(input?: { productId?: string; product_id?: string; deviceName?: string; device_name?: string; policy?: BridgeAuthorizationPolicy; permissions?: BridgeAuthorizationPolicy; permission?: BridgeAuthorizationPolicy }): Promise<BridgeConnectIntentResult>;
    intent(token: string): Promise<JsonObject>;
    claim(token: string, input?: JsonObject): Promise<JsonObject>;
  };
  authorization: {
    list(input?: BridgeAuthorizationInput): Promise<BridgeAuthorizationResponse>;
    authorize(input?: BridgeAuthorizationInput): Promise<BridgeAuthorizationResponse>;
    pause(input?: BridgeAuthorizationInput): Promise<BridgeAuthorizationResponse>;
    resume(input?: BridgeAuthorizationInput): Promise<BridgeAuthorizationResponse>;
    remove(input?: BridgeAuthorizationInput): Promise<BridgeAuthorizationResponse>;
    createIntent(input?: { productId?: string; product_id?: string; deviceName?: string; device_name?: string; policy?: BridgeAuthorizationPolicy; permissions?: BridgeAuthorizationPolicy; permission?: BridgeAuthorizationPolicy }): Promise<BridgeConnectIntentResult>;
  };
  products: {
    list(): Promise<JsonObject>;
    requestAuthorization(deviceId: string, policy?: BridgeAuthorizationPolicy): Promise<BridgeAuthorizationResponse>;
    authorization(deviceId: string): Promise<BridgeAuthorizationResponse>;
    revokeAuthorization(deviceId: string): Promise<BridgeAuthorizationResponse>;
    pauseAuthorization(deviceId: string): Promise<BridgeAuthorizationResponse>;
    resumeAuthorization(deviceId: string): Promise<BridgeAuthorizationResponse>;
  };
  relay: {
    create(input: BridgeRelayEnvelopeInput): Promise<JsonObject>;
    list(input?: BridgeRelayListInput): Promise<JsonObject>;
    ack(envelopeId: string, input?: JsonObject): Promise<JsonObject>;
    waitForResponse(input?: BridgeRelayWaitInput): Promise<BridgeRelayWaitForResponseResult>;
    createCall(input?: BridgeRelayCallInput): Promise<BridgeRelayCallResult>;
  };
};

export function createBridgeClient(options: {
  apiBase: string;
  productId?: string;
  fetch?: typeof fetch;
}): BridgeClient;
