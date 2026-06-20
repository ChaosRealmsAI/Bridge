export function delegatedRoutes(handlers) {
  return [
    {
      method: "GET",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/authorization$/,
      params: ["productId"],
      handler: handlers.delegatedProductAuthorization,
    },
    {
      method: "PATCH",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/authorization$/,
      params: ["productId"],
      handler: handlers.updateDelegatedProductAuthorization,
    },
    {
      method: "DELETE",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/authorization$/,
      params: ["productId"],
      handler: handlers.revokeDelegatedProductAuthorization,
    },
    {
      method: "GET",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/status$/,
      params: ["productId"],
      handler: handlers.delegatedProductStatus,
    },
    {
      method: "GET",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/state$/,
      params: ["productId"],
      handler: handlers.delegatedBridgeState,
    },
    {
      method: "POST",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/relay-key-bootstrap$/,
      params: ["productId"],
      handler: handlers.createDelegatedProductRelayKeyBootstrap,
    },
    {
      method: "POST",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/authorization\/claim$/,
      params: ["productId"],
      handler: handlers.claimDelegatedProductAuthorization,
    },
    {
      method: "POST",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/connect-intents$/,
      params: ["productId"],
      handler: handlers.createDelegatedConnectIntent,
    },
    {
      method: "GET",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/connect-intents\/([^/]+)$/,
      params: ["productId", "token"],
      handler: handlers.getDelegatedConnectIntent,
    },
    {
      method: "POST",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/relay\/envelopes$/,
      params: ["productId"],
      handler: handlers.createDelegatedProductRelayEnvelope,
    },
    {
      method: "GET",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/relay\/envelopes$/,
      params: ["productId"],
      handler: handlers.listDelegatedProductRelayEnvelopes,
    },
    {
      method: "POST",
      pattern: /^\/v1\/products\/([^/]+)\/delegated\/relay\/envelopes\/([^/]+)\/ack$/,
      params: ["productId", "envelopeId"],
      handler: handlers.ackDelegatedProductRelayEnvelope,
    },
  ];
}
