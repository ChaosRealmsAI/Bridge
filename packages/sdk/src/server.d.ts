import type {
  BridgeAuthorizationInput,
  BridgeAuthorizationPolicy,
  BridgeAuthorizationResponse,
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

export type BridgeServerJobInput = BridgeServerUserInput & {
  kind: string;
  input?: JsonObject;
  payload?: JsonObject;
  policy?: JsonObject;
  workspaceRef?: string | null;
  workspace_ref?: string | null;
  requestKey?: string | null;
  request_key?: string | null;
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
  createConnectIntent(input: BridgeServerConnectIntentInput): Promise<JsonObject>;
  intentStatus(token: string, input: BridgeServerUserInput): Promise<JsonObject>;
  authorization: BridgeServerAuthorizationApi;
  pause(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  resume(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  revoke(input: BridgeServerAuthorizationInput): Promise<BridgeAuthorizationResponse>;
  createJob(input: BridgeServerJobInput): Promise<JsonObject>;
  jobEvents(jobId: string, input: BridgeServerUserInput & { after?: number }): Promise<JsonObject>;
};

export function createBridgeServerClient(options: BridgeServerClientOptions): BridgeServerClient;
