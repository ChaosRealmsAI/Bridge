import type {
  BridgeAuthorizationInput,
  BridgeAuthorizationPolicy,
  BridgeAuthorizationResponse,
  BridgeConnectIntentResult,
  BridgeRelayWaitForResponseResult,
  BridgeStateModel,
  JsonObject,
} from "./index.js";

export type BridgeServerClientOptions = {
  apiBase: string;
  productId: string;
  secret: string;
  fetch?: typeof fetch;
  timestamp?: string | (() => string);
  nonce?: string | (() => string);
};

export type BridgeServerUserInput = {
  userId: string;
  user_id?: string;
  deviceId?: string;
  device_id?: string;
  accountId?: string;
  account_id?: string;
};

export type BridgeServerAuthorizationInput = BridgeServerUserInput & BridgeAuthorizationInput;

export type BridgeServerConnectIntentInput = BridgeServerUserInput & {
  deviceName?: string;
  device_name?: string;
  account?: JsonObject;
  user?: JsonObject;
  policy?: BridgeAuthorizationPolicy;
  permissions?: BridgeAuthorizationPolicy;
};

export type BridgeServerRelayEnvelopeInput = BridgeServerUserInput & {
  envelopeVersion?: string;
  envelope_version?: string;
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

export type BridgeServerRelayListInput = BridgeServerUserInput & {
  channelId?: string;
  channel_id?: string;
  afterSeq?: number;
  after_seq?: number;
};

export type BridgeServerRelayWaitInput = BridgeServerRelayListInput & {
  timeoutMs?: number;
  timeout_ms?: number;
  intervalMs?: number;
  interval_ms?: number;
};

export type BridgeServerAuthorizationApi = {
  (input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  list(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  authorize(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  pause(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  resume(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  remove(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  revoke(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
};

export type BridgeServerClient = {
  productId: string;
  state(input: BridgeServerUserInput): Promise<BridgeStateModel>;
  account(input: BridgeServerUserInput): Promise<BridgeStateModel>;
  createConnectIntent(input: BridgeServerConnectIntentInput): Promise<BridgeConnectIntentResult>;
  intentStatus(token: string, input: BridgeServerUserInput): Promise<JsonObject>;
  authorization: BridgeServerAuthorizationApi;
  pause(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  resume(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  revoke(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  createRelayEnvelope(input: BridgeServerRelayEnvelopeInput): Promise<JsonObject>;
  listRelayEnvelopes(input: BridgeServerRelayListInput): Promise<JsonObject>;
  ackRelayEnvelope(envelopeId: string, input: BridgeServerUserInput): Promise<JsonObject>;
  waitForResponse(input: BridgeServerRelayWaitInput): Promise<BridgeRelayWaitForResponseResult>;
};

export function createBridgeServerClient(options: BridgeServerClientOptions): BridgeServerClient;
