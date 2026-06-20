import { BRIDGE_PROTOCOL_VERSION, validateRelayEnvelope } from "@bridge/protocol";
import { legacyRuntimeApiRemovedPayload } from "./legacy-runtime.js";
import { RELAY_ENVELOPE_TTL_MS } from "./core/constants.js";
import { BridgeDeviceRoom } from "./core/realtime.js";
import { BridgeTestStore, bridgeTestMemorySnapshot, storageConfigurationError, storageKind } from "./core/storage.js";
import { assetResponse, cors, json, notFound, publicErrorPayload, rejectBadOrigin, requestScopedEnv } from "./core/http.js";
import { diagnosticsPayload } from "./core/state.js";
import { cleanupExpiredRows, connectorRelayListResult, relayListPayload, sameRelayEnvelope, connectorRelayEnvelopes, createConnectorRelayEnvelope, ackConnectorRelayEnvelope, createProductRelayEnvelope, createDelegatedProductRelayEnvelope, listProductRelayEnvelopes, listDelegatedProductRelayEnvelopes, ackProductRelayEnvelope, ackDelegatedProductRelayEnvelope } from "./core/relay.js";
import { createPasswordSession, createGuestSession, createSessionLink, joinSessionLink, logoutSession, sessionResponse, listDevices, revokeDevice, createPairingCode, createSelfhostPairingToken, claimConnector, connectorHeartbeat, rotateConnectorToken, createConnectIntent, bridgeState, getConnectIntent, claimConnectIntent, confirmConnectIntent } from "./core/session-handlers.js";
import { productAuthorization, requestAuthorization, createAuthorizationImportProof, updateAuthorization, revokeAuthorization, createProductRelayKeyBootstrap, createDelegatedProductRelayKeyBootstrap, updateConnectorAuthorization, revokeConnectorAuthorization, connectorRelayKeyBootstrap, delegatedProductAuthorization, updateDelegatedProductAuthorization, revokeDelegatedProductAuthorization, delegatedProductStatus, delegatedBridgeState, createDelegatedProductRelayKeyBootstrap as createDelegatedProductRelayKeyBootstrapHandler, claimDelegatedProductAuthorization, createDelegatedConnectIntent, getDelegatedConnectIntent } from "./core/authorization-handlers.js";
import { realtimeDevice } from "./core/realtime-handlers.js";

export function __bridgeTestMemorySnapshot() {
  return bridgeTestMemorySnapshot();
}

export function __bridgeTestRelayEnvelopeMatches(row, input, maxTtlMs = RELAY_ENVELOPE_TTL_MS) {
  const validation = validateRelayEnvelope(input);
  return validation.ok ? sameRelayEnvelope(row, validation.envelope, row?.idempotency_hash || "", maxTtlMs) : false;
}

export async function __bridgeTestConnectorRelayListPayload(env, rows, options = {}) {
  const listOptions = {
    afterSeq: Math.max(0, Number(options.afterSeq || 0)),
    limit: Math.max(1, Number(options.limit || 100)),
    waitMs: 0,
    includeAcked: options.includeAcked === true,
  };
  return relayListPayload(await connectorRelayListResult(env, rows, listOptions), listOptions);
}

export function createWorkerHandlers() {
  return {
    requestScopedEnv: ({ request, env }) => requestScopedEnv(request, env),
    rejectBadOrigin: ({ request, env }) => rejectBadOrigin(request, env),
    cors: ({ response, env }) => cors(response, env),
    storageConfigurationError: ({ env }) => storageConfigurationError(env),
    json: ({ payload, env, status }) => json(payload, env, status),
    publicErrorPayload: ({ error }) => publicErrorPayload(error),
    notFound: ({ env }) => notFound(env),
    assetResponse: ({ request, env }) => assetResponse(request, env),
    legacyRuntimeApiRemoved: ({ env, payload } = {}) => json(payload || legacyRuntimeApiRemovedPayload(), env, 410),
    health: ({ env }) => {
      const storageError = storageConfigurationError(env);
      return json({
        ok: !storageError,
        protocol: BRIDGE_PROTOCOL_VERSION,
        env: env.BRIDGE_ENV || "local",
        storage: storageKind(env),
        storage_configured: !storageError,
        error: storageError?.error || null,
      }, env, storageError ? 503 : 200);
    },
    diagnostics: ({ env }) => json(diagnosticsPayload(env), env),
    createPasswordSession: ({ request, env }) => createPasswordSession(request, env),
    createGuestSession: ({ request, env }) => createGuestSession(request, env),
    createSessionLink: ({ request, env }) => createSessionLink(request, env),
    joinSessionLink: ({ request, env }) => joinSessionLink(request, env),
    logoutSession: ({ request, env }) => logoutSession(request, env),
    sessionResponse: ({ request, env }) => sessionResponse(request, env),
    listDevices: ({ request, env }) => listDevices(request, env),
    revokeDevice: ({ request, env, params }) => revokeDevice(request, env, params.deviceId),
    products: ({ env }) => json({ items: diagnosticsPayload(env).server_capabilities.items }, env),
    createPairingCode: ({ request, env }) => createPairingCode(request, env),
    createSelfhostPairingToken: ({ request, env }) => createSelfhostPairingToken(request, env),
    claimConnector: ({ request, env }) => claimConnector(request, env),
    connectorHeartbeat: ({ request, env }) => connectorHeartbeat(request, env),
    rotateConnectorToken: ({ request, env }) => rotateConnectorToken(request, env),
    updateConnectorAuthorization: ({ request, env, params }) => updateConnectorAuthorization(request, env, params.productId),
    revokeConnectorAuthorization: ({ request, env, params }) => revokeConnectorAuthorization(request, env, params.productId),
    connectorRelayKeyBootstrap: ({ request, env, params }) => connectorRelayKeyBootstrap(request, env, params.productId),
    connectorRelayEnvelopes: ({ request, env }) => connectorRelayEnvelopes(request, env),
    createConnectorRelayEnvelope: ({ request, env, ctx }) => createConnectorRelayEnvelope(request, env, ctx),
    ackConnectorRelayEnvelope: ({ request, env, params }) => ackConnectorRelayEnvelope(request, env, params.envelopeId),
    realtimeDevice: ({ request, env, params }) => realtimeDevice(request, env, params.deviceId),
    createConnectIntent: ({ request, env }) => createConnectIntent(request, env),
    bridgeState: ({ request, env }) => bridgeState(request, env),
    getConnectIntent: ({ request, env, params }) => getConnectIntent(request, env, params.token),
    claimConnectIntent: ({ request, env, params }) => claimConnectIntent(request, env, params.token),
    confirmConnectIntent: ({ request, env, params }) => confirmConnectIntent(request, env, params.token),
    productAuthorization: ({ request, env, params }) => productAuthorization(request, env, params.productId),
    requestAuthorization: ({ request, env, params }) => requestAuthorization(request, env, params.productId),
    createAuthorizationImportProof: ({ request, env, params }) => createAuthorizationImportProof(request, env, params.productId),
    updateAuthorization: ({ request, env, params }) => updateAuthorization(request, env, params.productId),
    revokeAuthorization: ({ request, env, params }) => revokeAuthorization(request, env, params.productId),
    createProductRelayKeyBootstrap: ({ request, env, params }) => createProductRelayKeyBootstrap(request, env, params.productId),
    createProductRelayEnvelope: ({ request, env, params, ctx }) => createProductRelayEnvelope(request, env, params.productId, ctx),
    listProductRelayEnvelopes: ({ request, env, params }) => listProductRelayEnvelopes(request, env, params.productId),
    ackProductRelayEnvelope: ({ request, env, params }) => ackProductRelayEnvelope(request, env, params.productId, params.envelopeId),
    delegatedProductAuthorization: ({ request, env, params }) => delegatedProductAuthorization(request, env, params.productId),
    updateDelegatedProductAuthorization: ({ request, env, params }) => updateDelegatedProductAuthorization(request, env, params.productId),
    revokeDelegatedProductAuthorization: ({ request, env, params }) => revokeDelegatedProductAuthorization(request, env, params.productId),
    delegatedProductStatus: ({ request, env, params }) => delegatedProductStatus(request, env, params.productId),
    delegatedBridgeState: ({ request, env, params }) => delegatedBridgeState(request, env, params.productId),
    createDelegatedProductRelayKeyBootstrap: ({ request, env, params }) => createDelegatedProductRelayKeyBootstrapHandler(request, env, params.productId),
    claimDelegatedProductAuthorization: ({ request, env, params }) => claimDelegatedProductAuthorization(request, env, params.productId),
    createDelegatedConnectIntent: ({ request, env, params }) => createDelegatedConnectIntent(request, env, params.productId),
    getDelegatedConnectIntent: ({ request, env, params }) => getDelegatedConnectIntent(request, env, params.productId, params.token),
    createDelegatedProductRelayEnvelope: ({ request, env, params, ctx }) => createDelegatedProductRelayEnvelope(request, env, params.productId, ctx),
    listDelegatedProductRelayEnvelopes: ({ request, env, params }) => listDelegatedProductRelayEnvelopes(request, env, params.productId),
    ackDelegatedProductRelayEnvelope: ({ request, env, params }) => ackDelegatedProductRelayEnvelope(request, env, params.productId, params.envelopeId),
  };
}

export async function scheduled(_event, env = {}, ctx = {}) {
  const cleanup = cleanupExpiredRows(env);
  if (ctx?.waitUntil) {
    ctx.waitUntil(cleanup);
    return;
  }
  await cleanup;
}

export { BridgeDeviceRoom, BridgeTestStore };
