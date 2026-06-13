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
    official_origins: [
      "http://localhost:8790",
      "https://bridge.otherline.cc",
      "https://bridge.test.example",
      "https://app.test.example",
    ],
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

export function allProducts(origin, env = {}) {
  return Object.values(productRegistryForEnv(env)).map((product) => publicProduct(product, origin));
}

export function productById(productId, origin, env = {}) {
  const product = productRegistryForEnv(env)[productId];
  return product ? publicProduct(product, origin) : null;
}

export function officialProductOrigins(env = {}) {
  return [...new Set(Object.values(productRegistryForEnv(env)).flatMap((product) => product.official_origins || [product.official_origin]))];
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
    web_url: product.web_url || product.official_origin,
    capabilities: [...product.capabilities],
    adapter_boundary: structuredClone(product.adapter_boundary || {}),
    default_policy: structuredClone(product.default_policy),
    requires_desktop_authorization: product.requires_desktop_authorization !== false,
  };
}

function productRegistryForEnv(env = {}) {
  const raw = typeof env?.BRIDGE_PRODUCT_REGISTRY_JSON === "string" ? env.BRIDGE_PRODUCT_REGISTRY_JSON.trim() : "";
  const mode = typeof env?.BRIDGE_PRODUCT_REGISTRY_MODE === "string" ? env.BRIDGE_PRODUCT_REGISTRY_MODE.trim().toLowerCase() : "builtin";
  if (!raw || mode === "builtin") return PRODUCT_REGISTRY;
  if (!["extend", "replace"].includes(mode)) throw registryConfigError(`invalid mode: ${mode}`);
  const custom = parseCustomProducts(raw);
  if (mode === "replace") return custom;
  const duplicateBuiltIn = Object.keys(custom).find((id) => Object.hasOwn(PRODUCT_REGISTRY, id));
  if (duplicateBuiltIn) throw registryConfigError(`custom product cannot override built-in product id in extend mode: ${duplicateBuiltIn}`);
  return { ...PRODUCT_REGISTRY, ...custom };
}

function parseCustomProducts(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw registryConfigError("invalid JSON");
  }
  const items = Array.isArray(parsed) ? parsed : parsed?.products;
  if (!Array.isArray(items) || !items.length) throw registryConfigError("products must be a non-empty array");
  const out = {};
  for (const input of items) {
    const product = normalizeCustomProduct(input);
    if (out[product.id]) throw registryConfigError(`duplicate product id: ${product.id}`);
    out[product.id] = product;
  }
  assertRegistryWellFormed(BRIDGE_RUNTIME_CAPABILITY_REGISTRY, out);
  return out;
}

function normalizeCustomProduct(input = {}) {
  const id = cleanProductString(input.id, 80);
  if (!id || !/^[a-z0-9][a-z0-9_-]{1,78}[a-z0-9]$/.test(id)) throw registryConfigError(`invalid product id: ${id || "[empty]"}`);
  const name = cleanProductString(input.name, 120) || id;
  const origins = normalizeOrigins(input.official_origins ?? input.officialOrigins ?? input.origins, `official_origins for ${id}`);
  const webUrl = cleanOptionalWebUrl(input.web_url ?? input.webUrl, `web_url for ${id}`);
  const officialOrigin = cleanOptionalOrigin(input.official_origin ?? input.officialOrigin, `official_origin for ${id}`)
    || origins[0]
    || originFromWebUrl(webUrl);
  if (!officialOrigin) throw registryConfigError(`missing official_origin for ${id}`);
  const allOrigins = [...new Set([officialOrigin, ...origins])];
  return {
    id,
    name,
    official_origin: officialOrigin,
    official_origins: allOrigins,
    web_url: webUrl || officialOrigin,
    capabilities: [...RELAY_CAPABILITIES],
    adapter_boundary: {
      adapter_id: cleanProductString(input.adapter_boundary?.adapter_id || input.adapterBoundary?.adapterId || input.adapter_id || id, 120) || id,
      adapter_owner: "product",
    },
    default_policy: {},
    requires_desktop_authorization: input.requires_desktop_authorization !== false && input.requiresDesktopAuthorization !== false,
  };
}

function normalizeOrigins(value, label = "official_origins") {
  if (value == null || value === "") return [];
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : null;
  if (!values) throw registryConfigError(`invalid ${label}`);
  return values
    .map((item) => cleanOptionalOrigin(item, label))
    .filter(Boolean);
}

function cleanOptionalOrigin(value, label = "origin") {
  if (value == null || value === "") return "";
  const origin = cleanOrigin(value);
  if (!origin) throw registryConfigError(`invalid ${label}: ${cleanProductString(value, 80) || "[empty]"}`);
  return origin;
}

function cleanOptionalWebUrl(value, label = "web_url") {
  if (value == null || value === "") return "";
  const webUrl = cleanWebUrl(value);
  if (!webUrl) throw registryConfigError(`invalid ${label}: ${cleanProductString(value, 80) || "[empty]"}`);
  return webUrl;
}

function cleanOrigin(value) {
  const text = cleanProductString(value, 300).replace(/\/+$/, "");
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["https:", "http:"].includes(url.protocol)) return "";
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return "";
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function cleanWebUrl(value) {
  const text = cleanProductString(value, 600);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["https:", "http:"].includes(url.protocol)) return "";
    if (url.username || url.password || url.search || url.hash) return "";
    return url.pathname === "/" ? `${url.protocol}//${url.host}` : url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function originFromWebUrl(value) {
  try {
    const url = new URL(cleanProductString(value, 600));
    if (!["https:", "http:"].includes(url.protocol)) return "";
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function cleanProductString(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function registryConfigError(reason) {
  const error = new Error("invalid_product_registry_config");
  error.status = 500;
  error.public = { reason };
  return error;
}

assertRegistryWellFormed();
