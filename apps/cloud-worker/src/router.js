import { authPairingRoutes } from "./routes/auth-pairing.js";
import { delegatedRoutes } from "./routes/delegated.js";
import { diagnosticsCapabilityRoutes } from "./routes/diagnostics-capabilities.js";
import { relayPresenceRoutes } from "./routes/relay-presence.js";

export function requestPath(request, normalizePath = defaultNormalizePath) {
  const url = new URL(request.url);
  return {
    url,
    path: normalizePath(url.pathname),
    method: String(request.method || "GET").toUpperCase(),
  };
}

function defaultNormalizePath(pathname) {
  return String(pathname || "/").replace(/\/+$/, "") || "/";
}

export function createRouteTable(handlers) {
  return [
    ...diagnosticsCapabilityRoutes(handlers),
    ...authPairingRoutes(handlers),
    ...relayPresenceRoutes(handlers),
    ...delegatedRoutes(handlers),
  ].map(normalizeRoute);
}

export function matchRoute(routes, method, path) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  for (const route of routes) {
    if (route.method !== normalizedMethod) continue;
    if (route.path && route.path === path) return { ...route, params: {} };
    if (!route.pattern) continue;
    const match = path.match(route.pattern);
    if (!match) continue;
    return {
      ...route,
      params: Object.fromEntries(
        (route.params || []).map((name, index) => [name, decodeURIComponent(match[index + 1] || "")]),
      ),
    };
  }
  return null;
}

function normalizeRoute(route) {
  return {
    ...route,
    method: String(route.method || "GET").toUpperCase(),
  };
}
