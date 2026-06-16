export type BridgeAuthorizationContext = {
  product_id: string;
  device_id: string;
  authorization_id: string;
  authorization_epoch: string;
  relay_key_id: string;
};

export type BridgeAdapterDenial = {
  error: string;
  code: string;
  message: string;
  context_field?: string;
};

export type BridgeRelayEnvelope = {
  id?: string;
  product_id: string;
  device_id: string;
  channel_id: string;
  direction: string;
  seq: number;
  request_key?: string;
  ciphertext: string;
  aad: string;
  nonce: string;
  algorithm: "AES-GCM-256" | string;
  sender_key_id?: string;
  recipient_key_id?: string;
  ttl_ms?: number;
  meta?: Record<string, unknown>;
};

export type BridgeRelayEncryptFields = {
  product_id?: string;
  productId?: string;
  device_id?: string;
  deviceId?: string;
  channel_id?: string;
  channelId?: string;
  direction?: string;
  seq?: number;
  request_key?: string;
  requestKey?: string;
  sender_key_id?: string;
  senderKeyId?: string;
  recipient_key_id?: string;
  recipientKeyId?: string;
  ttl_ms?: number;
  ttlMs?: number;
  adapter_id?: string;
  adapterId?: string;
  schema_id?: string;
  schemaId?: string;
  trace_id?: string;
  traceId?: string;
  authorization_id?: string;
  authorizationId?: string;
  authorization_epoch?: string | number;
  authorizationEpoch?: string | number;
  relay_key_id?: string;
  relayKeyId?: string;
  gzip_above_bytes?: number;
  gzipAboveBytes?: number;
};

export type BridgeAdapterResponseCache = {
  get(envelope: BridgeRelayEnvelope): BridgeRelayEnvelope | null;
  set(envelope: BridgeRelayEnvelope, responseEnvelope: BridgeRelayEnvelope): BridgeRelayEnvelope;
  getOrSet(envelope: BridgeRelayEnvelope, factory: () => BridgeRelayEnvelope): BridgeRelayEnvelope;
  getOrSetAsync(envelope: BridgeRelayEnvelope, factory: () => BridgeRelayEnvelope | Promise<BridgeRelayEnvelope>): Promise<BridgeRelayEnvelope>;
  size(): number;
  pendingSize(): number;
  clear(): void;
};

export type BridgeRelayKeyContext = {
  authorization_id: string;
  authorization_epoch: string;
  relay_key_id: string;
};

export type BridgeRelayKeyState = {
  keyPair: CryptoKeyPair;
  state_jwk: {
    private_jwk: JsonWebKey;
    public_jwk: JsonWebKey;
  };
  exchange: {
    status: "available";
    algorithm: "ECDH-P256+A256GCM";
    key_id: string;
    public_jwk: JsonWebKey;
    created_at: string;
  };
};

export type BridgeRelayKeyBootstrapResult = BridgeAuthorizationContext & {
  key_id: string;
  keyBytes: Uint8Array;
};

export type BridgeProductAdapterRuntime = {
  productId: string;
  schemaId: string;
  keyBytes: Uint8Array | Buffer | null;
  calls: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
  responseCache: BridgeAdapterResponseCache;
  relayKeys: Map<string, Uint8Array | Buffer>;
  relayKeyState: BridgeRelayKeyState;
  relayKeyExchange: BridgeRelayKeyState["exchange"];
  readonly authorizationMirror: unknown;
  setAuthorizationMirror(next: unknown): void;
  readonly activeRelayContext: BridgeRelayKeyBootstrapResult | null;
  url: string;
  close(): Promise<void>;
};

export type BridgeProductAdapterRuntimeOptions = {
  productId?: string;
  product_id?: string;
  schemaId?: string;
  schema_id?: string;
  host?: string;
  port?: number;
  keyBytes?: Uint8Array | Buffer;
  keyB64?: string;
  relayKeys?: Map<string, Uint8Array | Buffer>;
  relayKeyState?: BridgeRelayKeyState;
  relayKeyJwk?: unknown;
  relayKeyJWK?: unknown;
  responseCache?: BridgeAdapterResponseCache;
  responseCacheEntries?: number;
  authorizationMirror?: unknown;
  requireAuthorizationMirror?: boolean;
  dispatchContext?: Record<string, unknown>;
  dispatch(command: unknown, context: {
    envelope: BridgeRelayEnvelope;
    keyBytes: Uint8Array | Buffer;
    authorizationMirror: unknown;
    activeRelayContext: BridgeRelayKeyBootstrapResult | null;
    emitProgress(payload: unknown): Promise<BridgeRelayEnvelope>;
  } & Record<string, unknown>): Promise<unknown> | unknown;
  errorResponse?(error: unknown): unknown;
  selectAuthorizationMirror?(input: {
    current: unknown;
    bootstrap: unknown;
    relayContext: BridgeRelayKeyBootstrapResult;
    bindRelayAuthorizationContext(input: unknown, relayContext: BridgeRelayKeyBootstrapResult): unknown;
  }): unknown;
};

export function normalizeBridgeAuthorizationContext(input?: unknown): BridgeAuthorizationContext;
export function bridgeAuthorizationContextFromMirror(mirror?: unknown): BridgeAuthorizationContext;
export function bridgeProductAuthorizationCapabilities(mirror?: unknown): string[];
export function bridgeAdapterAuthorizationContextDenial(context: unknown, mirror: unknown, activeRelayContext?: unknown): BridgeAdapterDenial | null;
export function bridgeRelayContextFromEnvelope(envelope?: Partial<BridgeRelayEnvelope>): BridgeAuthorizationContext;
export function decryptBridgeRelayEnvelope<T = unknown>(envelope: BridgeRelayEnvelope, keyBytes: Uint8Array | Buffer): Promise<T>;
export function encryptBridgeRelayEnvelope(payload: unknown, keyBytes: Uint8Array | Buffer, fields?: BridgeRelayEncryptFields): Promise<BridgeRelayEnvelope>;
export function encryptBridgeRelayResponseEnvelope(requestEnvelope: BridgeRelayEnvelope, payload: unknown, keyBytes: Uint8Array | Buffer, fields?: BridgeRelayEncryptFields): Promise<BridgeRelayEnvelope>;
export function createBridgeAdapterResponseCache(options?: { maxEntries?: number; max_entries?: number }): BridgeAdapterResponseCache;
export function envelopeReplayKey(envelope?: Partial<BridgeRelayEnvelope>): string;
export function keyBytesFromBase64(value: string, label?: string): Buffer;
export function createBridgeRelayKeyState(input?: unknown): Promise<BridgeRelayKeyState>;
export function importBridgeRelayKeyBootstrap(bootstrap: unknown, privateKey: CryptoKey): Promise<BridgeRelayKeyBootstrapResult>;
export function bridgeRelayKeyContextFromEnvelope(envelope?: Partial<BridgeRelayEnvelope>): BridgeRelayKeyContext;
export function bridgeRelayKeyScope(productId: string, deviceId: string, authorizationId?: string, authorizationEpoch?: string | number, keyId?: string): string;
export function bridgeRelayKeyForEnvelope(envelope: BridgeRelayEnvelope, relayKeys: Map<string, Uint8Array | Buffer>, defaultKeyBytes?: Uint8Array | Buffer | null): Uint8Array | Buffer;
export function createBridgeProductAdapterRuntime(options: BridgeProductAdapterRuntimeOptions): Promise<BridgeProductAdapterRuntime>;
