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
