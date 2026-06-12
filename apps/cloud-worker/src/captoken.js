import { capabilityDanger, capabilityDomain } from "./products.js";

export const CAP_TOKEN_VERSION = "PBCAP-v1";
export const CAP_TOKEN_ISSUER = "panda-bridge-cloud";
export const CAP_TOKEN_TYP = "pbcap+jws";
export const DEFAULT_CAP_TOKEN_KID = "pb-cap-test-2026q2";
export const DEFAULT_CAP_TOKEN_PRIVATE_KEY_B64 = "MC4CAQAwBQYDK2VwBCIEIBJTaTpOTXDzpmaxdfQQSWSnx1CK8VyD7Aoh8P50jzdH";
export const DEFAULT_CAP_TOKEN_PUBLIC_KEY_RAW_B64 = "/bJW7BI4LVkDp9mz6DeP24Ro1QKW8OIztinttSzznYU=";

const textEncoder = new TextEncoder();

export function capTokenMode(env = {}) {
  const value = String(env.PANDA_BRIDGE_CAPTOKEN_MODE || env.BRIDGE_CAPTOKEN_MODE || "shadow").trim().toLowerCase();
  return value === "enforce" ? "enforce" : "shadow";
}

export async function issueCapToken(env, { authorization, job, product, userId, device, nowSeconds = null }) {
  const signer = await capTokenSigner(env);
  const nbf = Number.isFinite(nowSeconds) ? Math.trunc(nowSeconds) : Math.trunc(Date.now() / 1000);
  const danger = capabilityDanger(job.kind) || "low";
  const ttlSeconds = capTokenTtlSeconds(danger);
  const claims = {
    v: CAP_TOKEN_VERSION,
    iss: CAP_TOKEN_ISSUER,
    sub: String(userId),
    aud: String(device.id),
    prd: String(product.id),
    cap: [job.kind],
    bnd: await computeBoundaryFingerprint(authorization.policy, job),
    job: String(job.id),
    rkh: await requestKeyHash(job.request_key),
    eph: authorizationEpoch(authorization),
    nbf,
    exp: nbf + ttlSeconds,
    jti: crypto.randomUUID(),
    max: capTokenMaxUses(danger),
  };
  const header = { alg: "EdDSA", kid: signer.kid(), typ: CAP_TOKEN_TYP };
  const token = await signer.sign(header, claims);
  return { token, header, claims, danger };
}

export async function verifyCapTokenClaims(claims, context = {}) {
  const normalizedClaims = object(claims);
  const job = object(context.job);
  const nowSeconds = Number.isFinite(Number(context.now)) ? Math.trunc(Number(context.now)) : Math.trunc(Date.now() / 1000);
  const skewSeconds = Number.isFinite(Number(context.skew_seconds)) ? Math.max(0, Math.trunc(Number(context.skew_seconds))) : 0;

  if (normalizedClaims.v !== CAP_TOKEN_VERSION || normalizedClaims.iss !== CAP_TOKEN_ISSUER) {
    return deny("cap_token_malformed");
  }
  const nbf = Number(normalizedClaims.nbf);
  const exp = Number(normalizedClaims.exp);
  if (!Number.isFinite(nbf) || !Number.isFinite(exp) || exp <= nbf) return deny("cap_token_malformed");
  if (nowSeconds + skewSeconds < nbf) return deny("cap_token_not_yet_valid");
  if (nowSeconds - skewSeconds >= exp) return deny("cap_token_expired");

  if (String(normalizedClaims.aud || "") !== String(context.device_id || "")) {
    return deny("cap_token_audience_mismatch");
  }
  if (String(normalizedClaims.prd || "") !== String(job.product_id || "")) {
    return deny("cap_token_product_mismatch");
  }
  if (context.user_id && String(normalizedClaims.sub || "") !== String(context.user_id)) {
    return deny("cap_token_subject_mismatch");
  }
  if (String(normalizedClaims.job || "") !== String(job.id || "")) {
    return deny("cap_token_job_mismatch");
  }
  if (String(normalizedClaims.rkh || "") !== await requestKeyHash(job.request_key)) {
    return deny("cap_token_request_key_mismatch");
  }

  const cap = Array.isArray(normalizedClaims.cap)
    ? normalizedClaims.cap.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (!cap.includes(String(job.kind || ""))) return deny("cap_token_capability_missing");
  const authorizedCapabilities = authorizationPolicyCapabilities(context.authorization_policy);
  if (authorizedCapabilities.length && cap.some((item) => !authorizedCapabilities.includes(item))) {
    return deny("cap_token_scope_mismatch");
  }

  const expectedEpoch = Number(context.epoch ?? context.authorization_epoch ?? 1);
  if (Number(normalizedClaims.eph) !== expectedEpoch) return deny("cap_token_epoch_stale");

  const max = Number(normalizedClaims.max);
  if (!Number.isInteger(max) || max < 1) return deny("cap_token_malformed");
  const used = Number(context.jti_uses || 0);
  if (Number.isFinite(used) && used >= max) return deny("cap_token_replay");

  const expectedBnd = await computeBoundaryFingerprint(context.authorization_policy, job);
  if (String(normalizedClaims.bnd || "") !== expectedBnd) return deny("cap_token_bnd_mismatch");
  return { verdict: "allow" };
}

export async function verifyCapTokenEnvelope(header, claims, context = {}) {
  const normalizedHeader = object(header);
  if (normalizedHeader.alg !== "EdDSA" || normalizedHeader.typ !== CAP_TOKEN_TYP) {
    return deny("cap_token_malformed");
  }
  const kid = String(normalizedHeader.kid || "");
  if (!kid || !capTokenPublicKeys(context.env || {}).has(kid)) return deny("cap_token_kid_unknown");
  return verifyCapTokenClaims(claims, context);
}

export async function verifyCapTokenJws(token, context = {}) {
  const parsed = parseCompactJws(token);
  if (!parsed) return deny("cap_token_malformed");
  const keyB64 = capTokenPublicKeys(context.env || {}).get(parsed.header.kid);
  if (!keyB64) return deny("cap_token_kid_unknown");
  const publicKey = await crypto.subtle.importKey(
    "raw",
    base64Decode(keyB64),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    parsed.signature,
    textEncoder.encode(`${parsed.protected}.${parsed.payload}`),
  );
  if (!ok) return deny("cap_token_signature_invalid");
  return verifyCapTokenClaims(parsed.claims, context);
}

export async function computeBoundaryFingerprint(policy, job) {
  const normalized = normalizeBoundary(policy, job);
  return `sha256:${await sha256Hex(canonicalJson(normalized))}`;
}

export function normalizeBoundary(policyInput, jobInput) {
  const policy = object(policyInput);
  const job = object(jobInput);
  const domain = capabilityDomain(job.kind) || String(job.kind || "").split(".")[0] || "unknown";
  if (domain === "data") return normalizeDataBoundary(policy, job);
  if (domain === "fs") return normalizeFsBoundary(policy);
  if (domain === "codex") return normalizeCodexBoundary(policy);
  return {
    type: "opaque_runtime",
    domain: trimNfc(domain),
    capabilities: normalizeStringList(policy.capabilities),
  };
}

export function canonicalJson(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return "{}";
  // Ordinal code-point sort to stay byte-identical with Rust L2 String
  // ordering. localeCompare is locale-dependent, and JS UTF-16 `<` diverges
  // from Rust UTF-8 ordering for supplementary-plane characters.
  const entries = Object.entries(value).sort(([left], [right]) => codePointCompare(left, right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
}

export async function requestKeyHash(requestKey) {
  return `sha256:${await sha256Hex(String(requestKey ?? ""))}`;
}

export function authorizationEpoch(authorization) {
  const value = Number(object(authorization).epoch ?? 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

export function parseCompactJws(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
    return {
      protected: parts[0],
      payload: parts[1],
      signature: base64UrlDecode(parts[2]),
      header,
      claims,
    };
  } catch {
    return null;
  }
}

function normalizeCodexBoundary(policy) {
  const roots = Array.isArray(policy.workspace_roots) ? policy.workspace_roots : [];
  const workspaceRoots = dedupeByCanonical(roots.map((item, index) => {
    const root = object(item);
    return {
      id: trimNfc(root.id || `workspace-${index + 1}`),
      allow_all: root.allow_all === true || root.allowAll === true || root.id === "all" || root.id === "*",
    };
  }));
  workspaceRoots.sort((left, right) => {
    // Code-point order matches Rust L2 `roots.sort_by_key(canonical_json)`;
    // localeCompare and JS UTF-16 `<` can split the L1/L2 bnd fingerprint.
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return codePointCompare(a, b);
  });
  return {
    capabilities: normalizeStringList(policy.capabilities),
    workspace_roots: workspaceRoots,
    sandbox_floor: trimNfc(policy.sandbox_floor || policy.sandboxFloor || "workspace-write"),
    approval_policy_floor: trimNfc(policy.approval_policy_floor || policy.approvalPolicyFloor || "on-request"),
    allow_developer_instructions: policy.allow_developer_instructions === true || policy.allowDeveloperInstructions === true,
  };
}

function normalizeDataBoundary(policy, job) {
  const data = object(policy.boundaries?.data);
  return {
    type: trimNfc(data.type || data.boundary_type || data.boundaryType || "namespace_kv"),
    owner_product_id: trimNfc(data.owner_product_id || data.ownerProductId || job.product_id || ""),
    namespace: trimNfc(data.namespace || `product:${job.product_id || ""}`),
  };
}

function normalizeFsBoundary(policy) {
  const fs = object(policy.boundaries?.fs);
  const roots = Array.isArray(fs.allowed_roots || fs.allowedRoots)
    ? (fs.allowed_roots || fs.allowedRoots)
    : [];
  const allowedRoots = dedupeByCanonical(roots.map((item, index) => {
    const root = object(item);
    const id = trimNfcKeepSlash(root.id || "");
    return {
      id: id || `root-${index + 1}`,
      path_display: trimNfcKeepSlash(root.path_display || root.pathDisplay || ""),
    };
  }));
  allowedRoots.sort((left, right) => codePointCompare(canonicalJson(left), canonicalJson(right)));
  const rawWriteRoots = Array.isArray(fs.write_roots || fs.writeRoots)
    ? (fs.write_roots || fs.writeRoots)
    : [];
  const writeRoots = dedupeByCanonical(rawWriteRoots.map((item, index) => {
    const root = object(item);
    const id = trimNfcKeepSlash(root.id || "");
    return {
      id: id || `root-${index + 1}`,
      path_display: trimNfcKeepSlash(root.path_display || root.pathDisplay || ""),
    };
  }));
  writeRoots.sort((left, right) => codePointCompare(canonicalJson(left), canonicalJson(right)));
  return {
    type: "directory_whitelist",
    allowed_roots: allowedRoots,
    write_roots: writeRoots,
    writable: fs.writable === true,
    max_bytes: boundedInteger(fs.max_bytes ?? fs.maxBytes, 8388608, 1, 67108864),
    follow_symlinks: fs.follow_symlinks === true || fs.followSymlinks === true,
  };
}

function authorizationPolicyCapabilities(policyInput) {
  return normalizeStringList(object(policyInput).capabilities);
}

function normalizeStringList(input) {
  const seen = new Set();
  for (const item of Array.isArray(input) ? input : []) {
    const normalized = trimNfc(item);
    if (normalized) seen.add(normalized);
  }
  return [...seen].sort();
}

function dedupeByCanonical(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = canonicalJson(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function codePointCompare(left, right) {
  const a = String(left);
  const b = String(right);
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    const ac = a.codePointAt(ai);
    const bc = b.codePointAt(bi);
    if (ac !== bc) return ac < bc ? -1 : 1;
    ai += ac > 0xffff ? 2 : 1;
    bi += bc > 0xffff ? 2 : 1;
  }
  if (ai === a.length && bi === b.length) return 0;
  return ai === a.length ? -1 : 1;
}

function trimNfc(value) {
  return String(value ?? "").trim().normalize("NFC").replace(/\/+$/, "");
}

function trimNfcKeepSlash(value) {
  return String(value ?? "").trim().normalize("NFC");
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function capTokenTtlSeconds(danger) {
  if (danger === "high") return 60;
  if (danger === "medium") return 120;
  return 300;
}

function capTokenMaxUses(_danger) {
  return 1;
}

async function capTokenSigner(env) {
  const signer = String(env.BRIDGE_CAPTOKEN_SIGNER || "local").trim().toLowerCase();
  if (signer === "kms") throw new Error("cap_token_kms_signer_not_configured");
  if (signer !== "local") throw new Error("cap_token_signer_not_configured");
  const kid = String(env.BRIDGE_CAPTOKEN_KID || DEFAULT_CAP_TOKEN_KID).trim();
  const keyB64 = localPrivateKeyB64(env);
  return new LocalKeySigner(kid, keyB64);
}

class LocalKeySigner {
  constructor(kid, privateKeyB64) {
    this.keyId = kid;
    this.privateKeyB64 = privateKeyB64;
    this.keyPromise = null;
  }

  kid() {
    return this.keyId;
  }

  async key() {
    if (!this.keyPromise) {
      this.keyPromise = crypto.subtle.importKey(
        "pkcs8",
        base64Decode(this.privateKeyB64),
        { name: "Ed25519" },
        false,
        ["sign"],
      );
    }
    return this.keyPromise;
  }

  async sign(header, claims) {
    const protectedHeader = base64UrlEncode(textEncoder.encode(JSON.stringify(header)));
    const payload = base64UrlEncode(textEncoder.encode(JSON.stringify(claims)));
    const signingInput = `${protectedHeader}.${payload}`;
    const signature = await crypto.subtle.sign(
      { name: "Ed25519" },
      await this.key(),
      textEncoder.encode(signingInput),
    );
    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  }
}

function localPrivateKeyB64(env) {
  const explicit = String(env.BRIDGE_CAPTOKEN_PRIVATE_KEY_B64 || env.BRIDGE_CAPTOKEN_LOCAL_PRIVATE_KEY_B64 || "").trim();
  if (explicit) return explicit;
  if (env.BRIDGE_LOCAL_MEMORY === "1" || env.BRIDGE_ENV === "test") return DEFAULT_CAP_TOKEN_PRIVATE_KEY_B64;
  throw new Error("cap_token_local_private_key_not_configured");
}

function capTokenPublicKeys(env) {
  const map = new Map([[DEFAULT_CAP_TOKEN_KID, DEFAULT_CAP_TOKEN_PUBLIC_KEY_RAW_B64]]);
  const raw = String(env.BRIDGE_CAPTOKEN_PUBLIC_KEYS || "").trim();
  if (!raw) return map;
  try {
    const parsed = JSON.parse(raw);
    for (const [kid, key] of Object.entries(object(parsed))) {
      if (kid && key) map.set(kid, String(key));
    }
  } catch {
    for (const item of raw.split(",")) {
      const [kid, key] = item.split(":");
      if (kid?.trim() && key?.trim()) map.set(kid.trim(), key.trim());
    }
  }
  return map;
}

function deny(reason) {
  return { verdict: "deny", reason };
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Decode(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return base64Decode(padded);
}
