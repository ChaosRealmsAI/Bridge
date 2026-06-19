export function diagnosticsCapabilityRoutes(handlers) {
  return [
    {
      method: "GET",
      path: "/v1/health",
      allowUnconfiguredStorage: true,
      handler: handlers.health,
    },
    {
      method: "GET",
      path: "/v1/diagnostics",
      allowUnconfiguredStorage: true,
      handler: handlers.diagnostics,
    },
    {
      method: "GET",
      path: "/v1/products",
      handler: handlers.products,
    },
  ];
}
