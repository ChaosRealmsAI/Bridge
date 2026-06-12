export const CAPABILITY_DANGER_LEVELS = Object.freeze(["low", "medium", "high"]);
export const CAPABILITY_BOUNDARY_TYPES = Object.freeze([
  "workspace_sandbox",
  "namespace_kv",
  "directory_whitelist",
  "command_sandbox",
  "opaque_runtime",
]);

// v3.1+ reserved definitions, not registered in v3.0:
// data.put/get/query/delete -> medium / namespace_kv
// fs.read/fs.write -> high / directory_whitelist
// shell.run -> high / command_sandbox
export const BRIDGE_RUNTIME_CAPABILITY_REGISTRY = Object.freeze({
  "codex.chat": Object.freeze({
    domain: "codex",
    verb: "chat",
    danger: "low",
    boundary_type: "workspace_sandbox",
    description: "Codex chat completion",
  }),
  "codex.run": Object.freeze({
    domain: "codex",
    verb: "run",
    danger: "low",
    boundary_type: "workspace_sandbox",
    description: "Codex local run",
  }),
  "codex.rpc": Object.freeze({
    domain: "codex",
    verb: "rpc",
    danger: "low",
    boundary_type: "workspace_sandbox",
    description: "Codex RPC call",
  }),
  "saas.custom.run": Object.freeze({
    domain: "saas",
    verb: "custom.run",
    danger: "high",
    boundary_type: "opaque_runtime",
    description: "Product-defined runtime request",
  }),
});

export const BRIDGE_RUNTIME_CAPABILITIES = Object.freeze(Object.keys(BRIDGE_RUNTIME_CAPABILITY_REGISTRY));

export const PRODUCT_REGISTRY = {
  "panda-chat": {
    id: "panda-chat",
    name: "Panda Chat",
    official_origin: "https://bridge.otherline.cc",
    official_origins: ["https://bridge.otherline.cc", "https://panda.otherline.cc", "https://pandart.cc", "https://www.pandart.cc"],
    capabilities: [...BRIDGE_RUNTIME_CAPABILITIES],
    default_policy: {},
    requires_desktop_authorization: true,
  },
  "panda-dev": {
    id: "panda-dev",
    name: "Panda Dev",
    official_origin: "https://bridge.otherline.cc",
    official_origins: ["https://bridge.otherline.cc", "https://dev.otherline.cc"],
    capabilities: [...BRIDGE_RUNTIME_CAPABILITIES],
    default_policy: {},
    requires_desktop_authorization: true,
  },
  "panda-spec": {
    id: "panda-spec",
    name: "Panda Spec",
    official_origin: "https://bridge.otherline.cc",
    official_origins: ["https://bridge.otherline.cc", "https://spec.otherline.cc"],
    capabilities: [...BRIDGE_RUNTIME_CAPABILITIES],
    default_policy: {},
    requires_desktop_authorization: true,
  },
  "otherline": {
    id: "otherline",
    name: "Otherline",
    official_origin: "https://otherline.cc",
    official_origins: ["https://otherline.cc", "https://app.test.example"],
    capabilities: [...BRIDGE_RUNTIME_CAPABILITIES],
    default_policy: {},
    requires_desktop_authorization: true,
  },
};

export function allProducts(origin) {
  return Object.values(PRODUCT_REGISTRY).map((product) => publicProduct(product, origin));
}

export function productById(productId, origin) {
  const product = PRODUCT_REGISTRY[productId];
  return product ? publicProduct(product, origin) : null;
}

export function officialProductOrigins() {
  return [...new Set(Object.values(PRODUCT_REGISTRY).flatMap((product) => product.official_origins || [product.official_origin]))];
}

export function capabilityDanger(kind) {
  return BRIDGE_RUNTIME_CAPABILITY_REGISTRY[kind]?.danger || null;
}

export function capabilityDomain(kind) {
  return BRIDGE_RUNTIME_CAPABILITY_REGISTRY[kind]?.domain || null;
}

export function capabilityBoundaryType(kind) {
  return BRIDGE_RUNTIME_CAPABILITY_REGISTRY[kind]?.boundary_type || null;
}

export function domainsForTier(tier) {
  return [...new Set(Object.values(BRIDGE_RUNTIME_CAPABILITY_REGISTRY)
    .filter((entry) => entry.danger === tier)
    .map((entry) => entry.domain))];
}

export function scopeDangerMetadataFromCapabilities(capabilities) {
  const tiers = Object.fromEntries(CAPABILITY_DANGER_LEVELS.map((tier) => [tier, { granted: false, domains: [] }]));
  const domainBoundaries = {};
  const domainsByTier = Object.fromEntries(CAPABILITY_DANGER_LEVELS.map((tier) => [tier, new Set()]));
  for (const kind of Array.isArray(capabilities) ? capabilities : []) {
    const entry = BRIDGE_RUNTIME_CAPABILITY_REGISTRY[kind];
    if (!entry) continue;
    domainsByTier[entry.danger].add(entry.domain);
    domainBoundaries[entry.domain] = {
      granted: true,
      danger: entry.danger,
      boundary_type: entry.boundary_type,
    };
  }
  for (const tier of CAPABILITY_DANGER_LEVELS) {
    const domains = [...domainsByTier[tier]].sort();
    tiers[tier] = { granted: domains.length > 0, domains };
  }
  return { danger_tiers: tiers, domain_boundaries: domainBoundaries };
}

export function assertRegistryWellFormed(registry = BRIDGE_RUNTIME_CAPABILITY_REGISTRY, products = PRODUCT_REGISTRY) {
  for (const [kind, entry] of Object.entries(registry)) {
    if (kind !== `${entry.domain}.${entry.verb}`) {
      throw new Error(`invalid capability registry key: ${kind}`);
    }
    if (!CAPABILITY_DANGER_LEVELS.includes(entry.danger)) {
      throw new Error(`invalid capability danger: ${kind}`);
    }
    if (!CAPABILITY_BOUNDARY_TYPES.includes(entry.boundary_type)) {
      throw new Error(`invalid capability boundary_type: ${kind}`);
    }
  }
  for (const product of Object.values(products)) {
    const unsupported = (product.capabilities || []).filter((kind) => !Object.hasOwn(registry, kind));
    if (unsupported.length) {
      throw new Error(`product capability missing from registry: ${product.id}:${unsupported.join(",")}`);
    }
  }
  return true;
}

function publicProduct(product, origin) {
  return {
    id: product.id,
    name: product.name,
    origin: origin || product.official_origin,
    official_origin: product.official_origin,
    official_origins: [...(product.official_origins || [product.official_origin])],
    capabilities: [...product.capabilities],
    default_policy: structuredClone(product.default_policy),
    requires_desktop_authorization: product.requires_desktop_authorization !== false,
  };
}

assertRegistryWellFormed();
