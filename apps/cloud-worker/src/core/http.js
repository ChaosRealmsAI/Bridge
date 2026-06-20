import { officialServerCapabilityOrigins, serverCapabilityByProductId } from "../products.js";
import { requestPath } from "../router.js";
import { DEFAULT_JSON_BODY_LIMIT_BYTES, MAX_JSON_BODY_LIMIT_BYTES, PASSWORD_ATTEMPT_WINDOW_MS, PASSWORD_LOCK_MS, PASSWORD_MAX_FAILED_ATTEMPTS, SESSION_TTL_MS } from "./constants.js";
import { boundedInteger, clean, normalizePath } from "./utils.js";

export function json(payload, env, status = 200) {
  return cors(new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  }), env);
}

export function cors(response, env) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", sourceOrigin(env));
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization");
  headers.append("vary", "Origin");
  setSecurityHeaders(headers, env);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function withSecurityHeaders(response, env) {
  const headers = new Headers(response.headers);
  setSecurityHeaders(headers, env);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function setSecurityHeaders(headers, env) {
  headers.set("content-security-policy", contentSecurityPolicy(env));
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  if (webOrigin(env).startsWith("https://")) {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
  } else {
    headers.delete("strict-transport-security");
  }
}

export function contentSecurityPolicy(env) {
  const origins = allowedWebOrigins(env);
  const connectOrigins = [...new Set(origins.flatMap((origin) => {
    const apiOrigin = apiOriginForCsp(origin);
    return [origin, apiOrigin, origin.replace(/^http/, "ws"), apiOrigin.replace(/^http/, "ws")];
  }))];
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${connectOrigins.join(" ")}`,
    "frame-src 'self' bridge:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function apiOriginForCsp(origin) {
  try {
    const url = new URL(origin);
    if (url.hostname === "bridge.chaos-realms.cc") return "https://api.bridge.chaos-realms.cc";
    if (url.hostname === "bridge.test.example" || url.hostname === "app.test.example") {
      return "https://api.bridge.test.example";
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return "https://api.bridge.chaos-realms.cc";
  }
}

export function withSessionCookie(response, env, token) {
  const headers = new Headers(response.headers);
  const secure = (env.BRIDGE_WEB_ORIGIN || "").startsWith("https://") ? "; Secure" : "";
  const domain = env.SESSION_COOKIE_DOMAIN ? `; Domain=${env.SESSION_COOKIE_DOMAIN}` : "";
  const sameSite = "SameSite=Lax";
  headers.set("set-cookie", `${env.SESSION_COOKIE_NAME || "pb_session"}=${token}; Path=/; Max-Age=${Math.trunc(SESSION_TTL_MS / 1000)}; HttpOnly; ${sameSite}${secure}${domain}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function withClearedSessionCookie(response, env) {
  const headers = new Headers(response.headers);
  const secure = (env.BRIDGE_WEB_ORIGIN || "").startsWith("https://") ? "; Secure" : "";
  const domain = env.SESSION_COOKIE_DOMAIN ? `; Domain=${env.SESSION_COOKIE_DOMAIN}` : "";
  headers.set("set-cookie", `${env.SESSION_COOKIE_NAME || "pb_session"}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}${domain}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function withHeader(response, key, value) {
  const headers = new Headers(response.headers);
  headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function passwordLockedResponse(env, retryAfterMs) {
  const retryAfterSeconds = Math.max(1, Math.ceil(Number(retryAfterMs || 0) / 1000));
  return withHeader(
    json({ error: "too_many_login_attempts", retry_after_ms: retryAfterSeconds * 1000 }, env, 429),
    "retry-after",
    String(retryAfterSeconds),
  );
}

export async function assetResponse(request, env) {
  const path = new URL(request.url).pathname;
  if (env.ASSETS) {
    const response = await env.ASSETS.fetch(request);
    if (isDownloadAssetPath(path) && looksLikeHtmlFallback(response)) {
      return withSecurityHeaders(new Response("download asset not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }), env);
    }
    return withSecurityHeaders(response, env);
  }
  if (isDownloadAssetPath(path)) {
    return withSecurityHeaders(new Response("download asset not configured", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }), env);
  }
  return withSecurityHeaders(new Response("Bridge Cloud", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  }), env);
}

function isDownloadAssetPath(pathname) {
  return /^\/downloads\/.+\.(?:dmg|exe|msi|pkg|zip)$/i.test(String(pathname || ""));
}

function looksLikeHtmlFallback(response) {
  return response.ok && /text\/html/i.test(response.headers.get("content-type") || "");
}

export function notFound(env) {
  return json({ error: "not_found" }, env, 404);
}

export function rejectBadOrigin(request, env) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  const { path } = requestPath(request, normalizePath);
  const origin = request.headers.get("origin");
  if (origin && allowedWebOrigins(env).includes(origin)) return null;
  if (!origin && allowsMissingOrigin(request, path)) return null;
  return json({ error: "invalid_origin" }, env, 403);
}

export function allowsMissingOrigin(request, path) {
  if (path === "/v1/selfhost/pairing-token") return true;
  if (path === "/v1/connectors/claim") return true;
  if (/^\/v1\/connectors(?:\/|$)/.test(path)) {
    return (request.headers.get("authorization") || "").startsWith("Bearer ");
  }
  if (/^\/v1\/products\/[^/]+\/delegated(?:\/|$)/.test(path)) {
    return Boolean(request.headers.get("x-bridge-signature"));
  }
  if (/^\/v1\/connect-intents\/[^/]+\/(?:claim|confirm)$/.test(path)) {
    return isLocalBridgeClient(request);
  }
  return false;
}

export function isLocalBridgeClient(request) {
  const value = (request.headers.get("x-bridge-local-client") || "").trim().toLowerCase();
  return value === "desktop" || value === "connector-cli";
}

export function isNativeConnectIntentClaim(request) {
  return !request.headers.get("origin") && isLocalBridgeClient(request);
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function publicErrorPayload(error) {
  return {
    error: error.message || "error",
    ...(error.public || {}),
  };
}

function redactedErrorMessage(error) {
  const text = error?.message || String(error);
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/(token|secret|password|cookie|authorization)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/"?(token|secret|password|cookie|authorization)"?\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"');
}

export async function readJson(request, env) {
  const text = await readJsonText(request, env);
  if (!text) return {};
  return parseJsonText(text);
}

export async function readJsonText(request, env) {
  if (!request.body) return "";
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw httpError("invalid_content_type", 415);
  }
  const limit = jsonBodyLimitBytes(env);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw requestTooLargeError(limit);
  }

  const reader = request.body.getReader?.();
  if (!reader) {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > limit) throw requestTooLargeError(limit);
    return text;
  }

  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > limit) throw requestTooLargeError(limit);
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw httpError("invalid_json", 400);
  }
}

export function requestTooLargeError(limit) {
  const error = httpError("request_body_too_large", 413);
  error.public = { limit_bytes: limit };
  return error;
}

export function jsonBodyLimitBytes(env) {
  return boundedInteger(env.BRIDGE_MAX_JSON_BODY_BYTES, DEFAULT_JSON_BODY_LIMIT_BYTES, 1024, MAX_JSON_BODY_LIMIT_BYTES);
}

export function webOrigin(env) {
  return env.BRIDGE_WEB_ORIGIN || "http://127.0.0.1:8787";
}

export function sourceOrigin(env) {
  return env.__bridgeRequestOrigin || webOrigin(env);
}

export function requestScopedEnv(request, env) {
  const origin = request.headers.get("origin");
  const selected = origin && allowedWebOrigins(env).includes(origin) ? origin : webOrigin(env);
  return { ...env, __bridgeRequestOrigin: selected };
}

export function allowedWebOrigins(env) {
  let productOrigins = [];
  try {
    productOrigins = officialServerCapabilityOrigins(env);
  } catch {
    productOrigins = [];
  }
  return [...new Set([
    webOrigin(env),
    ...productOrigins,
    ...splitOrigins(env.BRIDGE_ALLOWED_ORIGINS),
  ].filter(Boolean))];
}

export function splitOrigins(value) {
  return clean(value, 4000).split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

export function rejectProductOrigin(product, origin, env) {
  if (productAllowedOrigins(product, env).includes(origin)) return null;
  return json({
    error: "product_origin_mismatch",
    product_id: product.id,
    source_origin: origin,
  }, env, 403);
}

export function productAllowedOrigins(product, env) {
  return [...new Set([
    ...(product.official_origins || [product.official_origin]),
    ...productExtraAllowedOrigins(product.id, env),
  ].filter(Boolean))];
}

export function productExtraAllowedOrigins(productId, env) {
  const raw = clean(env.BRIDGE_PRODUCT_ALLOWED_ORIGINS, 20000);
  if (!raw) return [];
  try {
    const map = JSON.parse(raw);
    const value = map?.[productId];
    if (Array.isArray(value)) return value.map((item) => clean(item, 300)).filter(Boolean);
    return splitOrigins(value);
  } catch {
    return [];
  }
}

export function publicApiBase(env) {
  return env.BRIDGE_PUBLIC_API_BASE || "https://api.bridge.chaos-realms.cc";
}

export function desktopProtocol(env) {
  return env.BRIDGE_DESKTOP_PROTOCOL || "bridge";
}

function hasSupabase(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function passwordAttemptConfig(env) {
  return {
    maxFailedAttempts: boundedInteger(env.BRIDGE_PASSWORD_MAX_FAILED_ATTEMPTS, PASSWORD_MAX_FAILED_ATTEMPTS, 3, 20),
    windowMs: boundedInteger(env.BRIDGE_PASSWORD_ATTEMPT_WINDOW_MS, PASSWORD_ATTEMPT_WINDOW_MS, 1000, 1000 * 60 * 60),
    lockMs: boundedInteger(env.BRIDGE_PASSWORD_LOCK_MS, PASSWORD_LOCK_MS, 1000, 1000 * 60 * 60),
  };
}

export function passwordAttemptIdentifier(email) {
  return `email:${email}`;
}

export function retryAfterMsForAttempt(attempt) {
  const lockedUntilMs = Date.parse(attempt?.locked_until || "");
  if (!Number.isFinite(lockedUntilMs)) return 0;
  return Math.max(0, lockedUntilMs - Date.now());
}

export function productInfo(productId, env) {
  return serverCapabilityByProductId(productId, sourceOrigin(env), env);
}

export function canonicalProductOrigin(product, env) {
  return product.official_origin || product.origin || sourceOrigin(env);
}

export function requireOfficialProduct(productId, env) {
  const product = productInfo(productId, env);
  if (!product) throw httpError("unsupported_product", 403);
  return product;
}
