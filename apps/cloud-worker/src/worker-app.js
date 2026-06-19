import { matchRoute } from "./router.js";

export function createWorkerApp({
  handlers,
  routes,
  requestPath,
  legacyRuntimeRoute,
  legacyRuntimeApiRemoved,
  scheduled,
}) {
  return {
    async fetch(request, env = {}, ctx = {}) {
      try {
        env = handlers.requestScopedEnv({ request, env });
        const originError = handlers.rejectBadOrigin({ request, env });
        if (originError) return originError;
        if (request.method === "OPTIONS") {
          return handlers.cors({ response: new Response(null, { status: 204 }), env });
        }

        const { url, path, method } = requestPath(request);
        if (legacyRuntimeRoute(request, path)) return legacyRuntimeApiRemoved(env);

        const route = matchRoute(routes, method, path);
        if (!route?.allowUnconfiguredStorage) {
          const storageError = handlers.storageConfigurationError({ env });
          if (storageError) return handlers.json({ payload: storageError, env, status: 503 });
        }
        if (route) return await route.handler({ request, env, ctx, url, path, params: route.params });

        if (["GET", "HEAD"].includes(method) && !path.startsWith("/v1/")) {
          return await handlers.assetResponse({ request, env });
        }
        return handlers.notFound({ env });
      } catch (error) {
        if (error?.status) {
          return handlers.json({
            payload: handlers.publicErrorPayload({ error }),
            env,
            status: error.status,
          });
        }
        return handlers.json({ payload: { error: "internal_error" }, env, status: 500 });
      }
    },
    scheduled,
  };
}
