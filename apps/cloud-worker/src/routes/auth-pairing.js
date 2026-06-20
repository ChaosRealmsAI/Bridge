export function authPairingRoutes(handlers) {
  return [
    { method: "POST", path: "/v1/sessions/password", handler: handlers.createPasswordSession },
    { method: "POST", path: "/v1/sessions/guest", handler: handlers.createGuestSession },
    { method: "POST", path: "/v1/sessions/share", handler: handlers.createSessionLink },
    { method: "POST", path: "/v1/sessions/join", handler: handlers.joinSessionLink },
    { method: "POST", path: "/v1/sessions/logout", handler: handlers.logoutSession },
    { method: "GET", path: "/v1/session", handler: handlers.sessionResponse },
    { method: "GET", path: "/v1/devices", handler: handlers.listDevices },
    {
      method: "DELETE",
      pattern: /^\/v1\/devices\/([^/]+)$/,
      params: ["deviceId"],
      handler: handlers.revokeDevice,
    },
    { method: "POST", path: "/v1/devices/pairing-codes", handler: handlers.createPairingCode },
    { method: "POST", path: "/v1/selfhost/pairing-token", handler: handlers.createSelfhostPairingToken },
    { method: "POST", path: "/v1/connect-intents", handler: handlers.createConnectIntent },
    { method: "GET", path: "/v1/bridge/state", handler: handlers.bridgeState },
    {
      method: "GET",
      pattern: /^\/v1\/connect-intents\/([^/]+)$/,
      params: ["token"],
      handler: handlers.getConnectIntent,
    },
    {
      method: "POST",
      pattern: /^\/v1\/connect-intents\/([^/]+)\/claim$/,
      params: ["token"],
      handler: handlers.claimConnectIntent,
    },
    {
      method: "POST",
      pattern: /^\/v1\/connect-intents\/([^/]+)\/confirm$/,
      params: ["token"],
      handler: handlers.confirmConnectIntent,
    },
    {
      method: "GET",
      pattern: /^\/v1\/products\/([^/]+)\/authorization$/,
      params: ["productId"],
      handler: handlers.productAuthorization,
    },
    {
      method: "POST",
      pattern: /^\/v1\/products\/([^/]+)\/authorization\/request$/,
      params: ["productId"],
      handler: handlers.requestAuthorization,
    },
    {
      method: "POST",
      pattern: /^\/v1\/products\/([^/]+)\/authorization\/import-proof$/,
      params: ["productId"],
      handler: handlers.createAuthorizationImportProof,
    },
    {
      method: "PATCH",
      pattern: /^\/v1\/products\/([^/]+)\/authorization$/,
      params: ["productId"],
      handler: handlers.updateAuthorization,
    },
    {
      method: "DELETE",
      pattern: /^\/v1\/products\/([^/]+)\/authorization$/,
      params: ["productId"],
      handler: handlers.revokeAuthorization,
    },
  ];
}
