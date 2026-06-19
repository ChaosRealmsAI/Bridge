export function relayPresenceRoutes(handlers) {
  return [
    { method: "POST", path: "/v1/connectors/claim", handler: handlers.claimConnector },
    { method: "POST", path: "/v1/connectors/heartbeat", handler: handlers.connectorHeartbeat },
    { method: "POST", path: "/v1/connectors/token/rotate", handler: handlers.rotateConnectorToken },
    {
      method: "PATCH",
      pattern: /^\/v1\/connectors\/products\/([^/]+)\/authorization$/,
      params: ["productId"],
      handler: handlers.updateConnectorAuthorization,
    },
    {
      method: "DELETE",
      pattern: /^\/v1\/connectors\/products\/([^/]+)\/authorization$/,
      params: ["productId"],
      handler: handlers.revokeConnectorAuthorization,
    },
    {
      method: "GET",
      pattern: /^\/v1\/connectors\/products\/([^/]+)\/relay-key-bootstrap$/,
      params: ["productId"],
      handler: handlers.connectorRelayKeyBootstrap,
    },
    { method: "GET", path: "/v1/connectors/relay/envelopes", handler: handlers.connectorRelayEnvelopes },
    { method: "POST", path: "/v1/connectors/relay/envelopes", handler: handlers.createConnectorRelayEnvelope },
    {
      method: "POST",
      pattern: /^\/v1\/connectors\/relay\/envelopes\/([^/]+)\/ack$/,
      params: ["envelopeId"],
      handler: handlers.ackConnectorRelayEnvelope,
    },
    {
      method: "GET",
      pattern: /^\/v1\/realtime\/devices\/([^/]+)$/,
      params: ["deviceId"],
      handler: handlers.realtimeDevice,
    },
    {
      method: "POST",
      pattern: /^\/v1\/products\/([^/]+)\/relay-key-bootstrap$/,
      params: ["productId"],
      handler: handlers.createProductRelayKeyBootstrap,
    },
    {
      method: "POST",
      pattern: /^\/v1\/products\/([^/]+)\/relay\/envelopes$/,
      params: ["productId"],
      handler: handlers.createProductRelayEnvelope,
    },
    {
      method: "GET",
      pattern: /^\/v1\/products\/([^/]+)\/relay\/envelopes$/,
      params: ["productId"],
      handler: handlers.listProductRelayEnvelopes,
    },
    {
      method: "POST",
      pattern: /^\/v1\/products\/([^/]+)\/relay\/envelopes\/([^/]+)\/ack$/,
      params: ["productId", "envelopeId"],
      handler: handlers.ackProductRelayEnvelope,
    },
  ];
}
