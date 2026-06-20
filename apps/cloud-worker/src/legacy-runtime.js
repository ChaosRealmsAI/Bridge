const LEGACY_RUNTIME_ROUTES = Object.freeze([
  { method: "GET", pattern: /^\/v1\/queue\/summary$/ },
  { method: "GET", pattern: /^\/v1\/connectors\/jobs$/ },
  { method: "POST", pattern: /^\/v1\/products\/[^/]+\/jobs$/ },
  { method: "POST", pattern: /^\/v1\/products\/[^/]+\/delegated\/jobs$/ },
  { method: "GET", pattern: /^\/v1\/products\/[^/]+\/delegated\/jobs\/[^/]+\/events$/ },
  { method: "POST", pattern: /^\/v1\/products\/[^/]+\/delegated\/jobs\/[^/]+\/cancel$/ },
  { method: "GET", pattern: /^\/v1\/products\/[^/]+\/delegated\/jobs\/[^/]+$/ },
  { method: "GET", pattern: /^\/v1\/jobs\/[^/]+$/ },
  { method: "GET", pattern: /^\/v1\/jobs\/[^/]+\/events$/ },
  { method: "POST", pattern: /^\/v1\/jobs\/[^/]+\/cancel$/ },
  { method: "POST", pattern: /^\/v1\/connectors\/jobs\/[^/]+\/events$/ },
  { method: "POST", pattern: /^\/v1\/connectors\/jobs\/[^/]+\/accept$/ },
  { method: "POST", pattern: /^\/v1\/connectors\/jobs\/[^/]+\/ack$/ },
]);

export function isLegacyRuntimeRoute(method, path) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  return LEGACY_RUNTIME_ROUTES.some((route) => route.method === normalizedMethod && route.pattern.test(path));
}

export function legacyRuntimeApiRemovedPayload() {
  return {
    error: "legacy_runtime_api_removed",
    message: "Bridge V0.9 only exposes hosted opaque relay surfaces. Use diagnostics for relay limits and /v1/*/relay/envelopes for encrypted transport.",
    relay: {
      product_create: "/v1/products/{product_id}/relay/envelopes",
      delegated_create: "/v1/products/{product_id}/delegated/relay/envelopes",
      connector_poll: "/v1/connectors/relay/envelopes",
      diagnostics: "/v1/diagnostics",
    },
  };
}
