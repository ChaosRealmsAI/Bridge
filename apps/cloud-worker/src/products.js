export const BRIDGE_RUNTIME_CAPABILITIES = Object.freeze(["codex.chat", "codex.run", "codex.rpc", "saas.custom.run"]);

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
