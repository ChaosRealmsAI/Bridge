import {
  bridgeRelayKeyContextFromEnvelope,
  bridgeRelayKeyForEnvelope,
  bridgeRelayKeyScope,
  createBridgeRelayKeyState,
  importBridgeRelayKeyBootstrap,
} from "./bridge-adapter-sdk.mjs";

export {
  createBridgeRelayKeyState,
  createBridgeRelayKeyState as createRelayKeyState,
  importBridgeRelayKeyBootstrap,
  importBridgeRelayKeyBootstrap as importRelayKeyBootstrap,
};

export function relayKeyForEnvelope(envelope, relayKeys, defaultKeyBytes) {
  return bridgeRelayKeyForEnvelope(envelope, relayKeys, defaultKeyBytes);
}

export function relayKeyScope(productId, deviceId, authorizationId = "", authorizationEpoch = "", keyId = "") {
  return bridgeRelayKeyScope(productId, deviceId, authorizationId, authorizationEpoch, keyId);
}

export function relayKeyContextFromEnvelope(envelope) {
  return bridgeRelayKeyContextFromEnvelope(envelope);
}
