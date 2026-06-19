import { RELAY_CAPABILITY_KINDS } from "./constants.js";
import { hasSupabase, storage, supabaseFetch } from "./storage.js";
import { updateAuthorizationWithEpoch } from "./auth-common.js";
import { publicAuthorizationPolicy } from "./public-payloads.js";
import { canonicalJson, clean, httpError, now, object } from "./utils.js";

export function normalizeAuthorizationPolicy(input, product, source_origin) {
  const policy = object(input);
  const hasExplicitInput = Object.keys(policy).length > 0;
  rejectLegacyAuthorizationPolicyFields(policy);
  const requested = hasExplicitInput ? policy : defaultRelayAuthorizationPolicy();
  const requestedSourceOrigin = clean(requested.source_origin, 300);
  if (requestedSourceOrigin && requestedSourceOrigin !== source_origin) {
    throw httpError("invalid_authorization_policy", 400);
  }
  const capabilities = normalizedPolicyCapabilities(requested, product, !hasExplicitInput);
  const productAuthorization = normalizeProductAuthorization(requested.product_authorization ?? requested.productAuthorization);
  const normalized = {
    version: "BRIDGE-RELAY-AUTH-v1",
    request_source: clean(requested.request_source, 120) || (hasExplicitInput ? "caller_request" : "worker_default_relay"),
    product_id: product.id,
    source_origin: source_origin || product.official_origin || product.origin || null,
    capabilities,
  };
  if (Object.keys(productAuthorization).length) normalized.product_authorization = productAuthorization;
  return normalized;
}

export function rejectLegacyAuthorizationPolicyFields(policy) {
  const fields = [
    "workspace_roots",
    "workspaceRoots",
    "sandbox_floor",
    "sandboxFloor",
    "approval_policy_floor",
    "approvalPolicyFloor",
    "allow_approval_never",
    "allowApprovalNever",
    "allow_developer_instructions",
    "allowDeveloperInstructions",
    "fullAccess",
    "full_access",
    "preset",
    "permission_preset",
  ];
  const present = fields.filter((field) => Object.hasOwn(policy, field));
  if (!present.length) return;
  const error = httpError("legacy_authorization_policy_forbidden", 400);
  error.public = { fields: [...new Set(present)] };
  throw error;
}

export function normalizeProductAuthorization(input) {
  const value = object(input);
  const out = {};
  const owner = clean(value.owner, 120);
  const enforcement = clean(value.enforcement, 160);
  const control = clean(value.control || value.mode || value.grant || value.kind, 120);
  const label = clean(value.label || value.summary || value.description, 300);
  if (owner) out.owner = owner;
  if (enforcement) out.enforcement = enforcement;
  if (control) out.control = control;
  if (label) out.label = label;
  return out;
}

export function normalizedPolicyCapabilities(requested, product, defaultLowTier = false) {
  if (defaultLowTier || !Object.hasOwn(requested, "capabilities")) return lowTierCapabilities().filter((kind) => product.capabilities.includes(kind));
  if (!Array.isArray(requested.capabilities)) throw httpError("invalid_authorization_policy", 400);
  let capabilities = [...new Set(requested.capabilities.map((item) => clean(item, 120)).filter(Boolean))];
  const unsupported = capabilities.filter((item) => !RELAY_CAPABILITY_KINDS.includes(item));
  if (unsupported.length) {
    const error = httpError("invalid_authorization_policy", 400);
    error.public = { field: "capabilities", unsupported };
    throw error;
  }
  const unsupportedByProduct = capabilities.filter((kind) => !product.capabilities.includes(kind));
  if (unsupportedByProduct.length) {
    const error = httpError("invalid_authorization_policy", 400);
    error.public = { field: "capabilities", unsupported: unsupportedByProduct };
    throw error;
  }
  return capabilities;
}

export function defaultRelayAuthorizationPolicy() {
  return {
    request_source: "worker_default_relay",
    capabilities: lowTierCapabilities(),
  };
}

export function lowTierCapabilities() {
  return [...RELAY_CAPABILITY_KINDS];
}

export async function upsertAuthorization(env, userId, deviceId, productId, policy, sourceOrigin = "", options = {}) {
  const status = clean(options.status, 40) || "active";
  const store = storage(env);
  const existing = (await store.select("bridge_authorizations", {
    user_id: userId,
    product_id: productId,
    device_id: deviceId,
  }))[0];
  if (existing) {
    const policyChanged = canonicalJson(existing.policy || {}) !== canonicalJson(policy || {});
    const statusChanged = existing.status !== status;
    const patch = {
      status,
      policy,
      source_origin: sourceOrigin || existing.source_origin || null,
      updated_at: now(),
    };
    if (policyChanged || statusChanged) {
      return (await updateAuthorizationWithEpoch(env, existing, patch, {
        cause: policyChanged ? "policy_change" : "resume",
        cancelDenial: policyChanged ? { error: "authorization_scope_changed", reason: "authorization_policy_changed" } : null,
      })).authorization;
    }
    return store.update("bridge_authorizations", existing.id, patch);
  }
  return store.insert("bridge_authorizations", {
    user_id: userId,
    device_id: deviceId,
    product_id: productId,
    source_origin: sourceOrigin || null,
    status,
    policy,
    epoch: 1,
    created_at: now(),
    updated_at: now(),
  });
}

export async function consumeAuthorizationImportProof(env, proof) {
  const consumedAt = now();
  if (hasSupabase(env) && !env.BRIDGE_LOCAL_MEMORY) {
    const url = new URL("/rest/v1/bridge_authorization_import_proofs", env.SUPABASE_URL);
    url.searchParams.set("id", `eq.${proof.id}`);
    url.searchParams.set("consumed_at", "is.null");
    const rows = await supabaseFetch(env, url, {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ consumed_at: consumedAt }),
    });
    return rows[0] || null;
  }
  const current = (await storage(env).select("bridge_authorization_import_proofs", { id: proof.id }))[0];
  if (!current || current.consumed_at) return null;
  return await storage(env).update("bridge_authorization_import_proofs", proof.id, { consumed_at: consumedAt });
}
