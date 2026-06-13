export const CAPABILITY_DANGER_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);
export const CAPABILITY_BOUNDARY_TYPES = Object.freeze([
  "relay_channel",
  "adapter_boundary",
]);

export const RELAY_CAPABILITIES = Object.freeze([
  "relay.envelope",
  "relay.ack",
]);

export const BRIDGE_RUNTIME_CAPABILITY_REGISTRY = Object.freeze({
  "relay.envelope": Object.freeze({
    domain: "relay",
    verb: "envelope",
    danger: "low",
    boundary_type: "relay_channel",
    description: "Opaque encrypted envelope relay",
  }),
  "relay.ack": Object.freeze({
    domain: "relay",
    verb: "ack",
    danger: "low",
    boundary_type: "relay_channel",
    description: "Opaque encrypted envelope acknowledgement",
  }),
});

export const BRIDGE_RUNTIME_CAPABILITIES = Object.freeze(Object.keys(BRIDGE_RUNTIME_CAPABILITY_REGISTRY));
export const HIGH_TIER_RUNTIME_CAPABILITIES = Object.freeze([]);
export const CRITICAL_TIER_RUNTIME_CAPABILITIES = Object.freeze([]);
export const SYLLO_RUNTIME_CAPABILITIES = Object.freeze([]);
export const NON_DATA_RUNTIME_CAPABILITIES = Object.freeze([...BRIDGE_RUNTIME_CAPABILITIES]);
export const OTHERLINE_RUNTIME_CAPABILITIES = Object.freeze([...BRIDGE_RUNTIME_CAPABILITIES]);

export const PRODUCT_REGISTRY = {
  "panda-chat": {
    id: "panda-chat",
    name: "Panda Chat",
    official_origin: "https://bridge.otherline.cc",
    official_origins: ["https://bridge.otherline.cc", "https://panda.otherline.cc", "https://pandart.cc", "https://www.pandart.cc"],
    capabilities: [...RELAY_CAPABILITIES],
    adapter_boundary: { adapter_id: "panda-chat", adapter_owner: "product" },
    default_policy: {},
    requires_desktop_authorization: true,
  },
  "panda-dev": {
    id: "panda-dev",
    name: "Panda Dev",
    official_origin: "https://bridge.otherline.cc",
    official_origins: ["https://bridge.otherline.cc", "https://dev.otherline.cc"],
    capabilities: [...RELAY_CAPABILITIES],
    adapter_boundary: { adapter_id: "panda-dev", adapter_owner: "product" },
    default_policy: {},
    requires_desktop_authorization: true,
  },
  "panda-spec": {
    id: "panda-spec",
    name: "Panda Spec",
    official_origin: "https://bridge.otherline.cc",
    official_origins: ["https://bridge.otherline.cc", "https://spec.otherline.cc"],
    capabilities: [...RELAY_CAPABILITIES],
    adapter_boundary: { adapter_id: "panda-spec", adapter_owner: "product" },
    default_policy: {},
    requires_desktop_authorization: true,
  },
  "panda-notes": {
    id: "panda-notes",
    name: "Panda Notes",
    official_origin: "https://notes.otherline.cc",
    official_origins: [
      "https://notes.otherline.cc",
      "https://bridge.otherline.cc",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
    ],
    capabilities: [...RELAY_CAPABILITIES],
    adapter_boundary: { adapter_id: "panda-notes", adapter_owner: "product" },
    default_policy: {},
    requires_desktop_authorization: true,
  },
  "panda-syllo": {
    id: "panda-syllo",
    name: "Panda Syllo",
    official_origin: "http://localhost:8790",
    official_origins: ["http://localhost:8790", "https://bridge.otherline.cc"],
    capabilities: [...RELAY_CAPABILITIES],
    adapter_boundary: { adapter_id: "panda-syllo", adapter_owner: "product" },
    default_policy: {},
    requires_desktop_authorization: true,
  },
  otherline: {
    id: "otherline",
    name: "Otherline",
    official_origin: "https://otherline.cc",
    official_origins: ["https://otherline.cc", "https://app.test.example"],
    capabilities: [...RELAY_CAPABILITIES],
    adapter_boundary: { adapter_id: "otherline", adapter_owner: "product" },
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
    adapter_boundary: structuredClone(product.adapter_boundary || {}),
    default_policy: structuredClone(product.default_policy),
    requires_desktop_authorization: product.requires_desktop_authorization !== false,
  };
}

assertRegistryWellFormed();
