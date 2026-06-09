import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import worker from "../src/index.js";

const env = {
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_WEB_ORIGIN: "http://local.test",
  BRIDGE_OTHERLINE_DELEGATION_SECRET: "otherline-delegation-test-secret",
  BRIDGE_PRODUCT_DELEGATION_SECRETS: JSON.stringify({ "panda-dev": "panda-dev-delegation-test-secret" }),
};
const jar = {};

async function apiRaw(method, path, body, token = "", extraHeaders = {}) {
  const headers = new Headers({ accept: "application/json" });
  if (body) headers.set("content-type", "application/json");
  if (jar.cookie) headers.set("cookie", jar.cookie);
  if (token) headers.set("authorization", `Bearer ${token}`);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("origin")) {
    headers.set("origin", env.BRIDGE_WEB_ORIGIN);
  }
  const response = await worker.fetch(new Request(`http://local.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) jar.cookie = setCookie.split(";")[0];
  const payload = JSON.parse(await response.text());
  return { response, payload, setCookie };
}

async function apiRawText(method, path, bodyText, token = "", extraHeaders = {}) {
  const headers = new Headers({ accept: "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (jar.cookie) headers.set("cookie", jar.cookie);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("origin")) {
    headers.set("origin", env.BRIDGE_WEB_ORIGIN);
  }
  const response = await worker.fetch(new Request(`http://local.test${path}`, {
    method,
    headers,
    body: bodyText && method !== "GET" && method !== "HEAD" ? bodyText : undefined,
  }), env);
  const payload = JSON.parse(await response.text());
  return { response, payload };
}

async function apiMissingOrigin(method, path, body = null, token = "", extraHeaders = {}) {
  const headers = new Headers({ accept: "application/json" });
  if (body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  const response = await worker.fetch(new Request(`http://local.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const payload = JSON.parse(await response.text());
  return { response, payload };
}

async function api(method, path, body, token = "", extraHeaders = {}) {
  const { response, payload } = await apiRaw(method, path, body, token, extraHeaders);
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function nativeClaimIntentRaw(token, body, bearer = "", extraHeaders = {}) {
  return apiMissingOrigin("POST", `/v1/connect-intents/${encodeURIComponent(token)}/claim`, body, bearer, {
    "x-panda-bridge-local-client": "desktop",
    ...extraHeaders,
  });
}

async function nativeClaimIntent(token, body, bearer = "", extraHeaders = {}) {
  const { response, payload } = await nativeClaimIntentRaw(token, body, bearer, extraHeaders);
  assert.ok(response.ok, `POST /v1/connect-intents/:token/claim: ${JSON.stringify(payload)}`);
  return payload;
}

function delegationSecret(productId) {
  if (productId === "otherline") return env.BRIDGE_OTHERLINE_DELEGATION_SECRET;
  return JSON.parse(env.BRIDGE_PRODUCT_DELEGATION_SECRETS)[productId];
}

async function delegatedApiRaw(method, path, body, userId, deviceId, nonce = randomUUID(), options = {}) {
  const bodyText = body ? JSON.stringify(body) : "";
  return delegatedApiRawText(method, path, bodyText, userId, deviceId, nonce, options);
}

async function delegatedApiRawText(method, path, bodyText, userId, deviceId, nonce = randomUUID(), options = {}) {
  const productId = options.productId || "otherline";
  const bodyHash = createHash("sha256").update(bodyText).digest("hex");
  const timestamp = options.timestamp || new Date().toISOString();
  const signingPayload = [
    method.toUpperCase(),
    options.signaturePath || path,
    productId,
    userId,
    deviceId,
    timestamp,
    nonce,
    options.bodyHash || bodyHash,
  ].join("\n");
  const signature = options.signature || createHmac("sha256", delegationSecret(productId)).update(signingPayload).digest("hex");
  return apiRawText(method, path, bodyText, "", {
    "x-panda-bridge-product-id": productId,
    "x-panda-bridge-user-id": userId,
    "x-panda-bridge-device-id": deviceId,
    "x-panda-bridge-request-timestamp": timestamp,
    "x-panda-bridge-request-nonce": nonce,
    "x-panda-bridge-body-sha256": options.bodyHash || bodyHash,
    "x-panda-bridge-signature": signature,
    "content-type": "application/json",
  });
}

async function delegatedApi(method, path, body, userId, deviceId, nonce = randomUUID(), options = {}) {
  const { response, payload } = await delegatedApiRaw(method, path, body, userId, deviceId, nonce, options);
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

const badOrigin = await apiRaw("POST", "/v1/sessions/guest", { display_name: "Bad Origin" }, "", { origin: "https://evil.example" });
assert.equal(badOrigin.response.status, 403);
assert.equal(badOrigin.payload.error, "invalid_origin");
assert.match(badOrigin.response.headers.get("content-security-policy"), /frame-src 'self' panda-bridge:/);
assert.match(badOrigin.response.headers.get("content-security-policy"), /connect-src/);
assert.match(badOrigin.response.headers.get("content-security-policy"), /wss?:\/\/local\.test/);
assert.match(badOrigin.response.headers.get("content-security-policy"), /object-src 'none'/);
assert.equal(badOrigin.response.headers.get("x-frame-options"), "DENY");
assert.equal(badOrigin.response.headers.get("referrer-policy"), "no-referrer");
assert.equal(badOrigin.response.headers.get("strict-transport-security"), null);

const missingOriginBrowserWrite = await apiMissingOrigin("POST", "/v1/sessions/guest", { display_name: "Missing Origin" });
assert.equal(missingOriginBrowserWrite.response.status, 403);
assert.equal(missingOriginBrowserWrite.payload.error, "invalid_origin");
const missingOriginForgedBearer = await apiMissingOrigin("POST", "/v1/sessions/guest", { display_name: "Forged Bearer" }, "fake-token");
assert.equal(missingOriginForgedBearer.response.status, 403);
assert.equal(missingOriginForgedBearer.payload.error, "invalid_origin");
const missingOriginForgedSignature = await apiMissingOrigin("POST", "/v1/sessions/guest", { display_name: "Forged Signature" }, "", {
  "x-panda-bridge-signature": "fake-signature",
});
assert.equal(missingOriginForgedSignature.response.status, 403);
assert.equal(missingOriginForgedSignature.payload.error, "invalid_origin");

const assetRaw = await worker.fetch(new Request("http://local.test/"), env);
assert.equal(assetRaw.status, 200);
assert.match(assetRaw.headers.get("content-security-policy"), /frame-src 'self' panda-bridge:/);
assert.equal(assetRaw.headers.get("x-content-type-options"), "nosniff");

const secureHealthRaw = await worker.fetch(new Request("https://bridge.otherline.cc/v1/health"), {
  ...env,
  BRIDGE_WEB_ORIGIN: "https://bridge.otherline.cc",
});
assert.ok(secureHealthRaw.ok);
assert.match(secureHealthRaw.headers.get("strict-transport-security"), /max-age=31536000/);
assert.match(secureHealthRaw.headers.get("content-security-policy"), /wss:\/\/api\.bridge\.otherline\.cc/);

const diagnostics = await api("GET", "/v1/diagnostics");
assert.equal(diagnostics.ok, true);
assert.equal(diagnostics.protocol, "panda-bridge-protocol-v0.1");
assert.equal(diagnostics.storage, "memory");
assert.ok(diagnostics.products.some((item) => item.id === "panda-chat" && item.capabilities.includes("codex.chat")));
assert.ok(diagnostics.jobs.supported_kinds.includes("saas.custom.run"));
assert.ok(diagnostics.jobs.event_types.includes("queued"));
assert.equal(diagnostics.jobs.queue_limits.device_max_running, 1);
assert.equal(diagnostics.connector.device_token_prefix, "pbd_");
assert.equal(diagnostics.realtime.route_template, "/v1/realtime/devices/{device_id}");
const diagnosticsText = JSON.stringify(diagnostics);
assert.doesNotMatch(diagnosticsText, /device_token"\s*:/);
assert.doesNotMatch(diagnosticsText, /session_cookie/i);

const unauthenticatedQueueSummary = await apiRaw("GET", "/v1/queue/summary");
assert.equal(unauthenticatedQueueSummary.response.status, 401);
assert.equal(unauthenticatedQueueSummary.payload.error, "unauthorized");

const invalidContentType = await apiRawText("POST", "/v1/sessions/guest", JSON.stringify({ display_name: "Plain Text" }), "", {
  "content-type": "text/plain",
});
assert.equal(invalidContentType.response.status, 415);
assert.equal(invalidContentType.payload.error, "invalid_content_type");

const malformedJson = await apiRawText("POST", "/v1/sessions/guest", "{\"display_name\":", "", {
  "content-type": "application/json",
});
assert.equal(malformedJson.response.status, 400);
assert.equal(malformedJson.payload.error, "invalid_json");
assert.equal("message" in malformedJson.payload, false);

env.BRIDGE_MAX_JSON_BODY_BYTES = "64";
const oversizedBody = JSON.stringify({ display_name: "x".repeat(1400) });
const oversized = await apiRawText("POST", "/v1/sessions/guest", oversizedBody, "", {
  "content-type": "application/json",
  "content-length": String(oversizedBody.length),
});
assert.equal(oversized.response.status, 413);
assert.equal(oversized.payload.error, "request_body_too_large");
assert.equal(oversized.payload.limit_bytes, 1024);
delete env.BRIDGE_MAX_JSON_BODY_BYTES;

env.BRIDGE_ALLOWED_ORIGINS = "http://chat.local.test http://dev.local.test";
const allowedOriginRaw = await apiRaw("POST", "/v1/sessions/guest", { display_name: "Allowed Origin" }, "", { origin: "http://chat.local.test" });
assert.equal(allowedOriginRaw.response.status, 201);
assert.equal(allowedOriginRaw.response.headers.get("access-control-allow-origin"), "http://chat.local.test");
assert.match(allowedOriginRaw.response.headers.get("vary"), /Origin/);
jar.cookie = "";

const guestLoginRaw = await apiRaw("POST", "/v1/sessions/guest", { display_name: "Tester" });
assert.ok(guestLoginRaw.response.ok);
assert.equal(guestLoginRaw.payload.authenticated, true);
assert.match(guestLoginRaw.setCookie, /SameSite=Lax/);
assert.match(guestLoginRaw.response.headers.get("content-security-policy"), /form-action 'self'/);
assert.match(jar.cookie, /^pb_session=/);
const products = await api("GET", "/v1/products");
assert.ok(products.items.some((item) => item.id === "panda-chat" && item.capabilities.includes("codex.chat")));
assert.ok(products.items.some((item) => item.id === "panda-dev" && item.capabilities.includes("codex.rpc")));
assert.ok(products.items.some((item) => item.id === "otherline" && item.capabilities.length === 1 && item.capabilities.includes("codex.chat")));
const pairing = await api("POST", "/v1/devices/pairing-codes", { device_name: "Local Test Device" });
const claim = await api("POST", "/v1/connectors/claim", {
  code: pairing.code,
  device_name: "Local Test Device",
  capabilities: { codex: ["codex.chat", "codex.run"] },
});
const deniedBrowserAuth = await apiRaw("POST", "/v1/products/panda-chat/authorization/request", { device_id: claim.device.id });
assert.equal(deniedBrowserAuth.response.status, 403);
assert.equal(deniedBrowserAuth.payload.error, "desktop_authorization_required");

const nativeIntent = await api("POST", "/v1/connect-intents", { product_id: "panda-chat", device_name: "Native No-Origin Device" });
const nativeClaimWithoutHeader = await apiMissingOrigin("POST", `/v1/connect-intents/${encodeURIComponent(nativeIntent.token)}/claim`, {
  device_name: "Native No-Origin Device",
  capabilities: { codex: ["codex.chat"] },
}, claim.device_token);
assert.equal(nativeClaimWithoutHeader.response.status, 403);
assert.equal(nativeClaimWithoutHeader.payload.error, "invalid_origin");
const nativeClaimWithHeader = await apiMissingOrigin("POST", `/v1/connect-intents/${encodeURIComponent(nativeIntent.token)}/claim`, {
  device_name: "Native No-Origin Device",
  capabilities: { codex: ["codex.chat"] },
}, claim.device_token, { "x-panda-bridge-local-client": "desktop" });
assert.equal(nativeClaimWithHeader.response.status, 201);
assert.equal(nativeClaimWithHeader.payload.device.id, claim.device.id);

const localIntent = await api("POST", "/v1/connect-intents", { product_id: "panda-chat", device_name: "Local Test Device" });
const localIntentClaim = await nativeClaimIntent(localIntent.token, {
  device_name: "Local Test Device",
  capabilities: { codex: ["codex.chat", "codex.run"] },
}, claim.device_token);
assert.equal(localIntentClaim.device.id, claim.device.id);
const created = await api("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: localIntentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "hello" },
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(created.job.status, "queued");
assert.ok(created.job.queued_at);
assert.equal(created.job.timing.total_job_ms, null);
const accepted = await api("POST", `/v1/connectors/jobs/${created.job.id}/accept`, { transport: "websocket" }, localIntentClaim.device_token);
assert.equal(accepted.accepted, true);
assert.equal(accepted.job.status, "running");
assert.ok(accepted.job.accepted_at);
const acceptedAgain = await api("POST", `/v1/connectors/jobs/${created.job.id}/accept`, { transport: "websocket" }, localIntentClaim.device_token);
assert.equal(acceptedAgain.accepted, false);
const jobs = await api("GET", "/v1/connectors/jobs", null, localIntentClaim.device_token);
assert.equal(jobs.items.length, 0);
const queuedBehind = await api("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: localIntentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "queued behind running" },
  request_key: "queued-behind-running",
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(queuedBehind.job.status, "queued");
assert.equal(queuedBehind.queue.max_running, 1);
const busyAccept = await api("POST", `/v1/connectors/jobs/${queuedBehind.job.id}/accept`, { transport: "websocket" }, localIntentClaim.device_token);
assert.equal(busyAccept.accepted, false);
assert.equal(busyAccept.reason, "device_busy");
await api("POST", `/v1/connectors/jobs/${created.job.id}/events`, { type: "text_delta", payload: { delta: "hi" } }, localIntentClaim.device_token);
await api("POST", `/v1/connectors/jobs/${created.job.id}/ack`, { status: "succeeded", result: { ok: true, reply: "hi" } }, localIntentClaim.device_token);
const queuedBehindAccept = await api("POST", `/v1/connectors/jobs/${queuedBehind.job.id}/accept`, { transport: "websocket" }, localIntentClaim.device_token);
assert.equal(queuedBehindAccept.accepted, true);
await api("POST", `/v1/connectors/jobs/${queuedBehind.job.id}/ack`, { status: "succeeded", result: { ok: true, reply: "queued behind running" } }, localIntentClaim.device_token);
const final = await api("GET", `/v1/jobs/${created.job.id}`);
assert.equal(final.job.status, "succeeded");
assert.ok(final.job.first_delta_at);
assert.ok(final.job.completed_at);
assert.ok(Number.isFinite(final.job.timing.queued_to_claimed_ms));
assert.ok(Number.isFinite(final.job.timing.total_job_ms));
const events = await api("GET", `/v1/jobs/${created.job.id}/events`);
assert.ok(events.items.length >= 3);
const queueSummary = await api("GET", "/v1/queue/summary");
assert.equal(queueSummary.limits.device_max_running, 1);
assert.equal(queueSummary.counts.total, 2);
assert.equal(queueSummary.counts.succeeded, 2);
assert.equal(queueSummary.counts.active, 0);
assert.equal(queueSummary.products["panda-chat"].succeeded, 2);
assert.ok(queueSummary.devices.some((item) => item.device.id === localIntentClaim.device.id));
const localDeviceQueue = queueSummary.devices.find((item) => item.device.id === localIntentClaim.device.id).queue;
assert.equal(localDeviceQueue.max_running, 1);
assert.equal(localDeviceQueue.max_queued, 150);
assert.equal(localDeviceQueue.active, 0);
assert.equal(queueSummary.timing.completed_count, 2);
assert.ok(Number.isFinite(queueSummary.timing.average_ms.queued_to_claimed_ms));
assert.ok(Number.isFinite(queueSummary.timing.average_ms.total_job_ms));
const queueSummaryText = JSON.stringify(queueSummary);
assert.doesNotMatch(queueSummaryText, /device_token"\s*:/);
assert.doesNotMatch(queueSummaryText, /pb_session/i);

const intent = await api("POST", "/v1/connect-intents", { product_id: "panda-chat", device_name: "Intent Test Device" }, "", { origin: "http://chat.local.test" });
assert.ok(intent.token);
assert.equal(intent.product.name, "Panda Chat");
assert.equal(intent.connect_intent.source_origin, "http://chat.local.test");
const inspected = await api("GET", `/v1/connect-intents/${encodeURIComponent(intent.token)}`);
assert.equal(inspected.connect_intent.product_id, "panda-chat");
assert.equal(inspected.connect_intent.source_origin, "http://chat.local.test");
assert.equal(inspected.account.display_name, "Tester");
const browserIntentClaim = await apiRaw("POST", `/v1/connect-intents/${encodeURIComponent(intent.token)}/claim`, {
  device_name: "Browser Must Not Claim",
  capabilities: { codex: ["codex.chat"] },
});
assert.equal(browserIntentClaim.response.status, 403);
assert.equal(browserIntentClaim.payload.error, "desktop_claim_required");
const intentClaim = await nativeClaimIntent(intent.token, {
  device_name: "Intent Test Device",
  capabilities: { codex: ["codex.chat", "codex.run"] },
});
assert.equal(intentClaim.device.device_name, "Intent Test Device");
assert.equal(intentClaim.account.display_name, "Tester");
assert.equal(intentClaim.product.id, "panda-chat");
assert.equal(intentClaim.authorization.source_origin, "http://chat.local.test");
assert.equal(intentClaim.authorization.policy.version, "AUTH-SCOPE-v1");
assert.equal(intentClaim.authorization.policy.product_id, "panda-chat");
assert.deepEqual(intentClaim.authorization.policy.capabilities, ["codex.chat", "codex.run"]);
assert.match(intentClaim.device_token, /^pbd_/);
assert.ok(intentClaim.token_expires_at);
const consumedIntentInspect = await apiRaw("GET", `/v1/connect-intents/${encodeURIComponent(intent.token)}`);
assert.equal(consumedIntentInspect.response.status, 400);
assert.equal(consumedIntentInspect.payload.error, "invalid_connect_intent");
const consumedIntentClaim = await nativeClaimIntentRaw(intent.token, {
  device_name: "Consumed Intent Device",
  capabilities: { codex: ["codex.chat"] },
});
assert.equal(consumedIntentClaim.response.status, 400);
assert.equal(consumedIntentClaim.payload.error, "invalid_connect_intent");
env.BRIDGE_CONNECT_INTENT_TTL_MS = "1";
const expiringIntent = await api("POST", "/v1/connect-intents", { product_id: "panda-chat", device_name: "Expiring Intent" });
await new Promise((resolve) => setTimeout(resolve, 5));
const expiredIntentClaim = await nativeClaimIntentRaw(expiringIntent.token, {
  device_name: "Expired Intent Device",
  capabilities: { codex: ["codex.chat"] },
});
assert.equal(expiredIntentClaim.response.status, 400);
assert.equal(expiredIntentClaim.payload.error, "invalid_connect_intent");
delete env.BRIDGE_CONNECT_INTENT_TTL_MS;

env.BRIDGE_DEVICE_TOKEN_ROTATION_GRACE_MS = "0";
const rotatedToken = await api("POST", "/v1/connectors/token/rotate", {
  app_version: "rotation-test",
  capabilities: { codex: ["codex.chat", "codex.run"] },
  local_state: { platform: "test" },
}, intentClaim.device_token);
assert.equal(rotatedToken.ok, true);
assert.match(rotatedToken.device_token, /^pbd_/);
assert.notEqual(rotatedToken.device_token, intentClaim.device_token);
await api("POST", "/v1/connectors/heartbeat", {}, rotatedToken.device_token);
await new Promise((resolve) => setTimeout(resolve, 5));
const oldTokenHeartbeat = await apiRaw("POST", "/v1/connectors/heartbeat", {}, intentClaim.device_token);
assert.equal(oldTokenHeartbeat.response.status, 401);
assert.equal(oldTokenHeartbeat.payload.error, "unauthorized");
delete env.BRIDGE_DEVICE_TOKEN_ROTATION_GRACE_MS;
intentClaim.device_token = rotatedToken.device_token;

const intentJob = await api("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: intentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "intent hello" },
  policy: { token_budget: 1000, timeout_ms: 60000 },
}, "", { origin: "http://chat.local.test" });
assert.equal(intentJob.job.status, "queued");
assert.equal(intentJob.job.source_origin, "http://chat.local.test");
const cancelAccept = await api("POST", `/v1/connectors/jobs/${intentJob.job.id}/accept`, { transport: "websocket" }, intentClaim.device_token);
assert.equal(cancelAccept.accepted, true);
const cancelledJob = await api("POST", `/v1/jobs/${intentJob.job.id}/cancel`, {});
assert.equal(cancelledJob.cancelled, true);
assert.equal(cancelledJob.job.status, "cancelled");
const lateEvent = await api("POST", `/v1/connectors/jobs/${intentJob.job.id}/events`, { type: "text_delta", payload: { delta: "late" } }, intentClaim.device_token);
assert.equal(lateEvent.ignored, true);
const lateAck = await api("POST", `/v1/connectors/jobs/${intentJob.job.id}/ack`, { status: "succeeded", result: { ok: true, reply: "late" } }, intentClaim.device_token);
assert.equal(lateAck.ignored, true);
assert.equal(lateAck.job.status, "cancelled");
const finalCancelled = await api("GET", `/v1/jobs/${intentJob.job.id}`);
assert.equal(finalCancelled.job.status, "cancelled");
assert.equal(finalCancelled.job.result.reply, undefined);

const queuedBeforeConnectorRevoke = await api("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: intentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "queued before connector revoke" },
  request_key: "queued-before-connector-revoke",
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(queuedBeforeConnectorRevoke.job.status, "queued");
const runningBeforeConnectorRevoke = await api("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: intentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "running before connector revoke" },
  request_key: "running-before-connector-revoke",
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
const runningBeforeConnectorRevokeAccept = await api("POST", `/v1/connectors/jobs/${runningBeforeConnectorRevoke.job.id}/accept`, { transport: "websocket" }, intentClaim.device_token);
assert.equal(runningBeforeConnectorRevokeAccept.accepted, true);
assert.equal(runningBeforeConnectorRevokeAccept.job.status, "running");
const connectorRevokedChat = await api("DELETE", "/v1/connectors/products/panda-chat/authorization", null, intentClaim.device_token);
assert.equal(connectorRevokedChat.authorization.status, "revoked");
assert.equal(connectorRevokedChat.authorization.product_id, "panda-chat");
assert.equal(connectorRevokedChat.cancelled_jobs, 2);
const cancelledAfterConnectorRevoke = await api("GET", `/v1/jobs/${queuedBeforeConnectorRevoke.job.id}`);
assert.equal(cancelledAfterConnectorRevoke.job.status, "cancelled");
assert.equal(cancelledAfterConnectorRevoke.job.result.error, "product_not_authorized");
const runningCancelledAfterConnectorRevoke = await api("GET", `/v1/jobs/${runningBeforeConnectorRevoke.job.id}`);
assert.equal(runningCancelledAfterConnectorRevoke.job.status, "cancelled");
assert.equal(runningCancelledAfterConnectorRevoke.job.result.error, "product_not_authorized");
const lateRunningAck = await apiRaw("POST", `/v1/connectors/jobs/${runningBeforeConnectorRevoke.job.id}/ack`, { status: "succeeded", result: { ok: true, reply: "should not win" } }, intentClaim.device_token);
assert.equal(lateRunningAck.response.status, 403);
assert.equal(lateRunningAck.payload.error, "product_not_authorized");
assert.equal(lateRunningAck.payload.job.status, "cancelled");
assert.equal(lateRunningAck.payload.job.result.reply, undefined);
await api("POST", "/v1/connectors/heartbeat", {}, intentClaim.device_token);
const authAfterConnectorRevoke = await api("GET", `/v1/products/panda-chat/authorization?device_id=${encodeURIComponent(intentClaim.device.id)}`);
assert.equal(authAfterConnectorRevoke.authorization, null);
const jobAfterConnectorRevoke = await apiRaw("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: intentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "chat after connector revoke" },
  request_key: "chat-after-connector-revoke",
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(jobAfterConnectorRevoke.response.status, 403);
assert.equal(jobAfterConnectorRevoke.payload.error, "product_not_authorized");
const connectorJobsAfterRevoke = await api("GET", "/v1/connectors/jobs", null, intentClaim.device_token);
assert.equal(connectorJobsAfterRevoke.items.length, 0);
const reconnectIntent = await api("POST", "/v1/connect-intents", { product_id: "panda-chat", device_name: "Intent Test Device" }, "", { origin: "http://chat.local.test" });
const reconnectClaim = await nativeClaimIntent(reconnectIntent.token, {
  device_name: "Intent Test Device",
  capabilities: { codex: ["codex.chat", "codex.run"] },
}, intentClaim.device_token);
assert.equal(reconnectClaim.device.id, intentClaim.device.id);
assert.equal(reconnectClaim.authorization.status, "active");
intentClaim.device_token = reconnectClaim.device_token;
const authAfterExplicitReconnect = await api("GET", `/v1/products/panda-chat/authorization?device_id=${encodeURIComponent(intentClaim.device.id)}`);
assert.equal(authAfterExplicitReconnect.authorization.status, "active");

const chatRpc = await apiRaw("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.rpc",
  device_id: intentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { calls: [{ method: "initialize" }] },
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(chatRpc.response.status, 403);
assert.equal(chatRpc.payload.error, "scope_insufficient");

const unauthorizedDevJob = await apiRaw("POST", "/v1/products/panda-dev/jobs", {
  kind: "codex.run",
  device_id: intentClaim.device.id,
  product_id: "panda-dev",
  workspace_ref: "default",
  input: { prompt: "dev before authorization" },
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(unauthorizedDevJob.response.status, 403);
assert.equal(unauthorizedDevJob.payload.error, "product_not_authorized");

const devIntent = await api("POST", "/v1/connect-intents", { product_id: "panda-dev", device_name: "Intent Test Device" }, "", { origin: "http://dev.local.test" });
assert.equal(devIntent.connect_intent.source_origin, "http://dev.local.test");
const devClaim = await nativeClaimIntent(devIntent.token, {
  device_name: "Intent Test Device",
  capabilities: { codex: ["codex.chat"] },
}, intentClaim.device_token);
assert.equal(devClaim.device.id, intentClaim.device.id);
assert.equal(devClaim.product.id, "panda-dev");
assert.equal(devClaim.authorization.source_origin, "http://dev.local.test");
const devRpcJob = await api("POST", "/v1/products/panda-dev/jobs", {
  kind: "codex.rpc",
  device_id: intentClaim.device.id,
  product_id: "panda-dev",
  workspace_ref: "default",
  input: { calls: [{ method: "initialize" }] },
  policy: { token_budget: 1000, timeout_ms: 60000 },
}, "", { origin: "http://dev.local.test" });
assert.equal(devRpcJob.job.status, "queued");
assert.equal(devRpcJob.job.source_origin, "http://dev.local.test");

const otherlineIntent = await api("POST", "/v1/connect-intents", { product_id: "otherline", device_name: "Intent Test Device" }, "", { origin: "https://otherline.cc" });
assert.equal(otherlineIntent.product.id, "otherline");
const otherlineClaim = await nativeClaimIntent(otherlineIntent.token, {
  device_name: "Intent Test Device",
  capabilities: { codex: ["codex.chat"] },
}, intentClaim.device_token);
assert.equal(otherlineClaim.device.id, intentClaim.device.id);
assert.equal(otherlineClaim.authorization.product_id, "otherline");
const delegatedMalformedJson = await delegatedApiRawText("POST", "/v1/products/otherline/delegated/jobs", "{", otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedMalformedJson.response.status, 400);
assert.equal(delegatedMalformedJson.payload.error, "invalid_json");
const delegatedAuthorization = await delegatedApi("GET", `/v1/products/otherline/delegated/authorization?device_id=${encodeURIComponent(otherlineClaim.device.id)}`, null, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedAuthorization.authorization.product_id, "otherline");
assert.equal(delegatedAuthorization.device.status, "online");

const replayNonce = randomUUID();
const replayPath = `/v1/products/otherline/delegated/authorization?device_id=${encodeURIComponent(otherlineClaim.device.id)}`;
const replayFirst = await delegatedApiRaw("GET", replayPath, null, otherlineClaim.account.id, otherlineClaim.device.id, replayNonce);
assert.equal(replayFirst.response.status, 200);
const replaySecond = await delegatedApiRaw("GET", replayPath, null, otherlineClaim.account.id, otherlineClaim.device.id, replayNonce);
assert.equal(replaySecond.response.status, 401);
assert.equal(replaySecond.payload.error, "product_delegation_replay");
const signedWithoutQuery = await delegatedApiRaw("GET", replayPath, null, otherlineClaim.account.id, otherlineClaim.device.id, randomUUID(), {
  signaturePath: "/v1/products/otherline/delegated/authorization",
});
assert.equal(signedWithoutQuery.response.status, 401);
assert.equal(signedWithoutQuery.payload.error, "product_delegation_signature_invalid");
const staleTimestamp = await delegatedApiRaw("GET", replayPath, null, otherlineClaim.account.id, otherlineClaim.device.id, randomUUID(), {
  timestamp: "2020-01-01T00:00:00.000Z",
});
assert.equal(staleTimestamp.response.status, 401);
assert.equal(staleTimestamp.payload.error, "product_delegation_timestamp_invalid");
const badBodyHash = await delegatedApiRaw("POST", "/v1/products/otherline/delegated/jobs", {
  kind: "codex.chat",
  device_id: otherlineClaim.device.id,
  product_id: "otherline",
  workspace_ref: "default",
  input: { prompt: "bad body hash" },
  request_key: "otherline-bad-body-hash",
  policy: { token_budget: 1000, timeout_ms: 60000 },
}, otherlineClaim.account.id, otherlineClaim.device.id, randomUUID(), {
  bodyHash: "0".repeat(64),
});
assert.equal(badBodyHash.response.status, 401);
assert.equal(badBodyHash.payload.error, "product_delegation_body_hash_invalid");

const externalDelegatedUser = randomUUID();
const otherlineScopedUser = await delegatedApi("POST", "/v1/products/otherline/delegated/connect-intents", {
  account: { display_name: "Same External User" },
  device_name: "Otherline Scoped User",
}, externalDelegatedUser, "pending");
const devScopedUser = await delegatedApi("POST", "/v1/products/panda-dev/delegated/connect-intents", {
  account: { display_name: "Same External User" },
  device_name: "Dev Scoped User",
}, externalDelegatedUser, "pending", randomUUID(), { productId: "panda-dev" });
assert.notEqual(otherlineScopedUser.account.id, devScopedUser.account.id);
assert.equal(otherlineScopedUser.account.display_name, "Same External User");
assert.equal(devScopedUser.account.display_name, "Same External User");
assert.equal(otherlineScopedUser.connect_intent.source_origin, "https://otherline.cc");
assert.equal(devScopedUser.connect_intent.source_origin, "https://bridge.otherline.cc");

const delegatedIntent = await delegatedApi("POST", "/v1/products/otherline/delegated/connect-intents", {
  account: { display_name: "Delegated Otherline User" },
  device_name: "Delegated Intent Device",
}, otherlineClaim.account.id, "pending");
assert.match(delegatedIntent.token, /^pbi_/);
assert.notEqual(delegatedIntent.account.id, otherlineClaim.account.id);
assert.equal(delegatedIntent.product.id, "otherline");
assert.equal(delegatedIntent.connect_intent.source_origin, "https://otherline.cc");
const delegatedIntentClaim = await nativeClaimIntent(delegatedIntent.token, {
  device_name: "Delegated Intent Device",
  capabilities: { codex: ["codex.chat"] },
}, otherlineClaim.device_token);
assert.notEqual(delegatedIntentClaim.device.id, otherlineClaim.device.id);
assert.equal(delegatedIntentClaim.authorization.product_id, "otherline");
assert.equal(delegatedIntentClaim.authorization.policy.version, "AUTH-SCOPE-v1");
assert.equal(delegatedIntentClaim.authorization.policy.source_origin, "https://otherline.cc");
const delegatedIntentInspect = await delegatedApi("GET", `/v1/products/otherline/delegated/connect-intents/${encodeURIComponent(delegatedIntent.token)}`, null, otherlineClaim.account.id, "pending");
assert.ok(delegatedIntentInspect.connect_intent.consumed_at);
assert.equal(delegatedIntentInspect.connect_intent.device_id, delegatedIntentClaim.device.id);
assert.equal(delegatedIntentInspect.device.id, delegatedIntentClaim.device.id);
assert.equal(delegatedIntentInspect.authorization.status, "active");
const missingImportProof = await delegatedApiRaw("POST", "/v1/products/otherline/delegated/authorization/claim", {}, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(missingImportProof.response.status, 400);
assert.equal(missingImportProof.payload.error, "authorization_import_proof_required");
const importProof = await api("POST", "/v1/products/otherline/authorization/import-proof", { device_id: otherlineClaim.device.id });
assert.match(importProof.proof.token, /^pbip_/);
assert.equal(importProof.authorization.product_id, "otherline");
const claimedAuthorization = await delegatedApi("POST", "/v1/products/otherline/delegated/authorization/claim", {
  proof_token: importProof.proof.token,
}, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(claimedAuthorization.authorization.product_id, "otherline");
assert.equal(claimedAuthorization.device.id, otherlineClaim.device.id);
assert.ok(claimedAuthorization.proof.consumed_at);
const reusedImportProof = await delegatedApiRaw("POST", "/v1/products/otherline/delegated/authorization/claim", {
  proof_token: importProof.proof.token,
}, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(reusedImportProof.response.status, 409);
assert.equal(reusedImportProof.payload.error, "invalid_authorization_import_proof");
const mismatchImportProof = await api("POST", "/v1/products/otherline/authorization/import-proof", { device_id: otherlineClaim.device.id });
const missingDelegation = await apiRaw("POST", "/v1/products/otherline/delegated/jobs", {
  kind: "codex.chat",
  device_id: otherlineClaim.device.id,
  product_id: "otherline",
  workspace_ref: "default",
  input: { prompt: "delegated missing signature" },
  request_key: "otherline-delegation-missing",
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(missingDelegation.response.status, 401);
assert.equal(missingDelegation.payload.error, "product_delegation_unauthorized");
const delegatedJobBody = {
  kind: "codex.chat",
  device_id: otherlineClaim.device.id,
  product_id: "otherline",
  workspace_ref: "default",
  input: { prompt: "delegated hello" },
  request_key: "otherline-delegated-chat",
  policy: { token_budget: 1000, timeout_ms: 60000 },
};
const delegatedJob = await delegatedApi("POST", "/v1/products/otherline/delegated/jobs", delegatedJobBody, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedJob.job.status, "queued");
assert.equal(delegatedJob.job.product_id, "otherline");
assert.equal(delegatedJob.job.source_origin, "https://otherline.cc");
const delegatedDuplicate = await delegatedApi("POST", "/v1/products/otherline/delegated/jobs", delegatedJobBody, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedDuplicate.reused, true);
assert.equal(delegatedDuplicate.job.id, delegatedJob.job.id);
const delegatedConflict = await delegatedApiRaw("POST", "/v1/products/otherline/delegated/jobs", {
  ...delegatedJobBody,
  input: { prompt: "delegated changed body" },
}, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedConflict.response.status, 409);
assert.equal(delegatedConflict.payload.error, "idempotency_key_conflict");
const delegatedRpcBlocked = await delegatedApiRaw("POST", "/v1/products/otherline/delegated/jobs", {
  kind: "codex.rpc",
  device_id: otherlineClaim.device.id,
  product_id: "otherline",
  workspace_ref: "default",
  input: { calls: [{ method: "shell/exec" }] },
  request_key: "otherline-disallowed-rpc",
  policy: { token_budget: 1000, timeout_ms: 60000 },
}, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedRpcBlocked.response.status, 403);
assert.equal(delegatedRpcBlocked.payload.error, "scope_insufficient");
const delegatedRead = await delegatedApi("GET", `/v1/products/otherline/delegated/jobs/${encodeURIComponent(delegatedJob.job.id)}`, null, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedRead.job.id, delegatedJob.job.id);
const delegatedEvents = await delegatedApi("GET", `/v1/products/otherline/delegated/jobs/${encodeURIComponent(delegatedJob.job.id)}/events`, null, otherlineClaim.account.id, otherlineClaim.device.id);
assert.ok(delegatedEvents.items.some((item) => item.type === "queued"));
const delegatedCancel = await delegatedApi("POST", `/v1/products/otherline/delegated/jobs/${encodeURIComponent(delegatedJob.job.id)}/cancel`, {}, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedCancel.cancelled, true);
assert.equal(delegatedCancel.job.status, "cancelled");
const delegatedQueuedBeforeRevoke = await delegatedApi("POST", "/v1/products/otherline/delegated/jobs", {
  kind: "codex.chat",
  device_id: otherlineClaim.device.id,
  product_id: "otherline",
  workspace_ref: "default",
  input: { prompt: "delegated queued before revoke" },
  request_key: "otherline-delegated-before-revoke",
  policy: { token_budget: 1000, timeout_ms: 60000 },
}, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedQueuedBeforeRevoke.job.status, "queued");
const delegatedRevoke = await delegatedApi("DELETE", `/v1/products/otherline/delegated/authorization?device_id=${encodeURIComponent(otherlineClaim.device.id)}`, null, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedRevoke.authorization.status, "revoked");
assert.equal(delegatedRevoke.cancelled_jobs, 1);
const delegatedAfterRevoke = await delegatedApiRaw("POST", "/v1/products/otherline/delegated/jobs", {
  kind: "codex.chat",
  device_id: otherlineClaim.device.id,
  product_id: "otherline",
  workspace_ref: "default",
  input: { prompt: "delegated after revoke" },
  request_key: "otherline-delegated-after-revoke",
  policy: { token_budget: 1000, timeout_ms: 60000 },
}, otherlineClaim.account.id, otherlineClaim.device.id);
assert.equal(delegatedAfterRevoke.response.status, 403);
assert.equal(delegatedAfterRevoke.payload.error, "product_not_authorized");
const delegatedReconnect = await delegatedApi("POST", "/v1/products/otherline/delegated/connect-intents", {
  account: { display_name: "Delegated Otherline User" },
  device_name: "Delegated Intent Device",
}, otherlineClaim.account.id, "pending");
await nativeClaimIntent(delegatedReconnect.token, {
  device_name: "Delegated Intent Device",
  capabilities: { codex: ["codex.chat"] },
}, otherlineClaim.device_token);

const otherlineOwnerCookie = jar.cookie;
jar.cookie = "";
const otherlineCrossUser = await api("POST", "/v1/sessions/guest", { display_name: "Otherline Cross User" });
const crossDelegatedClaim = await delegatedApiRaw("POST", "/v1/products/otherline/delegated/authorization/claim", {
  proof_token: mismatchImportProof.proof.token,
}, otherlineCrossUser.user.id, otherlineClaim.device.id);
assert.equal(crossDelegatedClaim.response.status, 403);
assert.equal(crossDelegatedClaim.payload.error, "delegated_authorization_proof_mismatch");
const crossDelegatedRead = await delegatedApiRaw("GET", `/v1/products/otherline/delegated/jobs/${encodeURIComponent(delegatedJob.job.id)}`, null, otherlineCrossUser.user.id, otherlineClaim.device.id);
assert.equal(crossDelegatedRead.response.status, 404);
assert.equal(crossDelegatedRead.payload.error, "job_not_found");
jar.cookie = otherlineOwnerCookie;

const revokedDev = await api("DELETE", `/v1/products/panda-dev/authorization?device_id=${encodeURIComponent(intentClaim.device.id)}`);
assert.equal(revokedDev.authorization.status, "revoked");
const revokedDevJob = await apiRaw("POST", "/v1/products/panda-dev/jobs", {
  kind: "codex.run",
  device_id: intentClaim.device.id,
  product_id: "panda-dev",
  workspace_ref: "default",
  input: { prompt: "dev after revoke" },
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(revokedDevJob.response.status, 403);
assert.equal(revokedDevJob.payload.error, "product_not_authorized");
const chatAfterDevRevoke = await api("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: intentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "chat after dev revoke" },
  policy: { token_budget: 1000, timeout_ms: 60000 },
}, "", { origin: "http://chat.local.test" });
assert.equal(chatAfterDevRevoke.job.status, "queued");
assert.equal(chatAfterDevRevoke.job.product_id, "panda-chat");

const devConcurrencyIntent = await api("POST", "/v1/connect-intents", { product_id: "panda-dev", device_name: "Intent Test Device" }, "", { origin: "http://dev.local.test" });
await nativeClaimIntent(devConcurrencyIntent.token, {
  device_name: "Intent Test Device",
  capabilities: { codex: ["codex.chat", "codex.run", "codex.rpc"] },
}, intentClaim.device_token);
const ownerConcurrencyCookie = jar.cookie;
const concurrentJobs = await Promise.all(Array.from({ length: 50 }, (_, index) => {
  const isDev = index % 2 === 1;
  const product = isDev ? "panda-dev" : "panda-chat";
  const origin = isDev ? "http://dev.local.test" : "http://chat.local.test";
  return api("POST", `/v1/products/${product}/jobs`, {
    kind: "codex.run",
    device_id: intentClaim.device.id,
    product_id: product,
    workspace_ref: "default",
    input: { prompt: `concurrent ${product} ${index}` },
    request_key: `concurrent-${product}-${index}`,
    policy: { token_budget: 1000, timeout_ms: 60000 },
  }, "", { cookie: ownerConcurrencyCookie, origin });
}));
assert.equal(concurrentJobs.length, 50);
assert.equal(new Set(concurrentJobs.map((item) => item.job.id)).size, 50);
assert.equal(concurrentJobs.filter((item) => item.job.product_id === "panda-chat").length, 25);
assert.equal(concurrentJobs.filter((item) => item.job.product_id === "panda-dev").length, 25);
assert.ok(concurrentJobs.every((item) => item.job.status === "queued"));
assert.ok(concurrentJobs.every((item) => item.job.source_origin === (item.job.product_id === "panda-dev" ? "http://dev.local.test" : "http://chat.local.test")));

const duplicateKey = `duplicate-key-${Date.now()}`;
const duplicateJobs = await Promise.all(Array.from({ length: 10 }, () => api("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: intentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "duplicate request" },
  request_key: duplicateKey,
  policy: { token_budget: 1000, timeout_ms: 60000 },
}, "", { cookie: ownerConcurrencyCookie, origin: "http://chat.local.test" })));
assert.equal(new Set(duplicateJobs.map((item) => item.job.id)).size, 1);
assert.ok(duplicateJobs.filter((item) => item.reused === true).length >= 1);

jar.cookie = "";
await api("POST", "/v1/sessions/guest", { display_name: "Concurrent Other" });
const otherConcurrencyCookie = jar.cookie;
const crossAccountCreates = await Promise.all(Array.from({ length: 20 }, (_, index) => apiRaw("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: intentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: `cross concurrent ${index}` },
  request_key: `cross-concurrent-${index}`,
  policy: { token_budget: 1000, timeout_ms: 60000 },
}, "", { cookie: otherConcurrencyCookie, origin: "http://chat.local.test" })));
assert.ok(crossAccountCreates.every((item) => item.response.status === 404 && item.payload.error === "device_not_found"));
const ownerJobId = concurrentJobs[0].job.id;
const crossGetJob = await apiRaw("GET", `/v1/jobs/${encodeURIComponent(ownerJobId)}`, null, "", { cookie: otherConcurrencyCookie });
assert.equal(crossGetJob.response.status, 404);
assert.equal(crossGetJob.payload.error, "job_not_found");
const crossEvents = await apiRaw("GET", `/v1/jobs/${encodeURIComponent(ownerJobId)}/events`, null, "", { cookie: otherConcurrencyCookie });
assert.equal(crossEvents.response.status, 404);
assert.equal(crossEvents.payload.error, "job_not_found");
const crossCancel = await apiRaw("POST", `/v1/jobs/${encodeURIComponent(ownerJobId)}/cancel`, {}, "", { cookie: otherConcurrencyCookie });
assert.equal(crossCancel.response.status, 404);
assert.equal(crossCancel.payload.error, "job_not_found");
const crossQueueSummary = await api("GET", "/v1/queue/summary");
assert.equal(crossQueueSummary.counts.total, 0);
assert.equal(crossQueueSummary.devices.some((item) => item.device.id === intentClaim.device.id), false);
jar.cookie = ownerConcurrencyCookie;

const installBoundIntent = await api("POST", "/v1/connect-intents", { product_id: "panda-chat", device_name: "Install Bound Device" });
const installBoundClaim = await nativeClaimIntentRaw(installBoundIntent.token, {
  device_name: "Install Bound Device",
  install_id: "install-one",
  capabilities: { codex: ["codex.chat"] },
}, "", { "x-panda-bridge-install-id": "install-one" });
assert.equal(installBoundClaim.response.status, 201);
assert.equal(installBoundClaim.payload.device.device_name, "Install Bound Device");
const installBoundToken = installBoundClaim.payload.device_token;
const missingInstallHeartbeat = await apiRaw("POST", "/v1/connectors/heartbeat", {}, installBoundToken);
assert.equal(missingInstallHeartbeat.response.status, 401);
assert.equal(missingInstallHeartbeat.payload.error, "unauthorized");
const wrongInstallHeartbeat = await apiRaw("POST", "/v1/connectors/heartbeat", {}, installBoundToken, { "x-panda-bridge-install-id": "install-two" });
assert.equal(wrongInstallHeartbeat.response.status, 401);
assert.equal(wrongInstallHeartbeat.payload.error, "unauthorized");
const correctInstallHeartbeat = await apiRaw("POST", "/v1/connectors/heartbeat", {}, installBoundToken, { "x-panda-bridge-install-id": "install-one" });
assert.equal(correctInstallHeartbeat.response.status, 200);
const installBoundJob = await api("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: installBoundClaim.payload.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "install bound" },
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
const wrongInstallAccept = await apiRaw("POST", `/v1/connectors/jobs/${installBoundJob.job.id}/accept`, { transport: "websocket" }, installBoundToken, { "x-panda-bridge-install-id": "install-two" });
assert.equal(wrongInstallAccept.response.status, 401);
const correctInstallAccept = await apiRaw("POST", `/v1/connectors/jobs/${installBoundJob.job.id}/accept`, { transport: "websocket" }, installBoundToken, { "x-panda-bridge-install-id": "install-one" });
assert.equal(correctInstallAccept.response.status, 200);
assert.equal(correctInstallAccept.payload.accepted, true);

await new Promise((resolve) => setTimeout(resolve, 5));
env.BRIDGE_DEVICE_ONLINE_GRACE_MS = "0";
const offlineJob = await apiRaw("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: intentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "offline device" },
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(offlineJob.response.status, 409);
assert.equal(offlineJob.payload.error, "device_offline");
delete env.BRIDGE_DEVICE_ONLINE_GRACE_MS;

const unsupportedIntent = await apiRaw("POST", "/v1/connect-intents", { product_id: "third-party-app" });
assert.equal(unsupportedIntent.response.status, 403);
assert.equal(unsupportedIntent.payload.error, "unsupported_product");

const firstAccountCookie = jar.cookie;
await api("POST", "/v1/sessions/guest", { display_name: "Other Tester" });
const otherDevices = await api("GET", "/v1/devices");
assert.equal(otherDevices.items.some((item) => item.id === intentClaim.device.id), false);
const crossAccountJob = await apiRaw("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: intentClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "cross account" },
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(crossAccountJob.response.status, 404);
assert.equal(crossAccountJob.payload.error, "device_not_found");
jar.cookie = firstAccountCookie;

const share = await api("POST", "/v1/sessions/share", {});
assert.ok(share.join_url.includes("join="));
jar.cookie = "";
await api("POST", "/v1/sessions/join", { token: share.token });
const joinedDevices = await api("GET", "/v1/devices");
assert.ok(joinedDevices.items.some((item) => item.id === intentClaim.device.id));
jar.cookie = "";
await api("POST", "/v1/sessions/join", { token: share.token });
const rejoinedDevices = await api("GET", "/v1/devices");
assert.ok(rejoinedDevices.items.some((item) => item.id === intentClaim.device.id));

jar.cookie = "";
const passwordEmail = "password-flow@bridge.otherline.cc";
const password = "PandaTest-2026-0604!";
const passwordLogin = await api("POST", "/v1/sessions/password", { email: passwordEmail, password, display_name: "Password Flow" });
assert.equal(passwordLogin.user.email, passwordEmail);
const passwordPairing = await api("POST", "/v1/devices/pairing-codes", { device_name: "Password Device" });
const passwordClaim = await api("POST", "/v1/connectors/claim", {
  code: passwordPairing.code,
  device_name: "Password Device",
  capabilities: { codex: ["codex.chat"] },
});
jar.cookie = "";
const passwordLoginAgain = await api("POST", "/v1/sessions/password", { email: passwordEmail, password });
assert.equal(passwordLoginAgain.user.id, passwordLogin.user.id);
const passwordDevices = await api("GET", "/v1/devices");
assert.ok(passwordDevices.items.some((item) => item.id === passwordClaim.device.id));
env.BRIDGE_DEVICE_MAX_QUEUED_JOBS = "1";
const queueLimitIntent = await api("POST", "/v1/connect-intents", { product_id: "panda-chat", device_name: "Queue Limit Device" });
const queueLimitClaim = await nativeClaimIntent(queueLimitIntent.token, {
  device_name: "Queue Limit Device",
  capabilities: { codex: ["codex.chat"] },
});
const queueLimitFirst = await api("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: queueLimitClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "queue first" },
  request_key: "queue-limit-first",
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(queueLimitFirst.queue.max_queued, 1);
const queueLimitSummary = await api("GET", "/v1/queue/summary");
assert.equal(queueLimitSummary.limits.device_max_queued, 1);
assert.equal(queueLimitSummary.devices.find((item) => item.device.id === queueLimitClaim.device.id).queue.max_queued, 1);
const queueLimitSecond = await apiRaw("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: queueLimitClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "queue second" },
  request_key: "queue-limit-second",
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(queueLimitSecond.response.status, 429);
assert.equal(queueLimitSecond.payload.error, "device_queue_full");
delete env.BRIDGE_DEVICE_MAX_QUEUED_JOBS;
const passwordOwnerCookie = jar.cookie;
jar.cookie = "";
await api("POST", "/v1/sessions/password", { email: "password-other@bridge.otherline.cc", password: "PandaOther-2026-0604!" });
const crossRevoke = await apiRaw("DELETE", `/v1/devices/${encodeURIComponent(passwordClaim.device.id)}`);
assert.equal(crossRevoke.response.status, 404);
assert.equal(crossRevoke.payload.error, "device_not_found");
jar.cookie = passwordOwnerCookie;
const revokedPasswordDevice = await api("DELETE", `/v1/devices/${encodeURIComponent(passwordClaim.device.id)}`);
assert.equal(revokedPasswordDevice.device.status, "revoked");
const revokedPasswordDevices = await api("GET", "/v1/devices");
assert.ok(revokedPasswordDevices.items.some((item) => item.id === passwordClaim.device.id && item.status === "revoked"));
const heartbeatAfterRevoke = await apiRaw("POST", "/v1/connectors/heartbeat", {}, passwordClaim.device_token);
assert.equal(heartbeatAfterRevoke.response.status, 401);
assert.equal(heartbeatAfterRevoke.payload.error, "unauthorized");
const jobAfterDeviceRevoke = await apiRaw("POST", "/v1/products/panda-chat/jobs", {
  kind: "codex.chat",
  device_id: passwordClaim.device.id,
  product_id: "panda-chat",
  workspace_ref: "default",
  input: { prompt: "revoked device" },
  policy: { token_budget: 1000, timeout_ms: 60000 },
});
assert.equal(jobAfterDeviceRevoke.response.status, 404);
assert.equal(jobAfterDeviceRevoke.payload.error, "device_not_found");
jar.cookie = "";
const wrongPassword = await apiRaw("POST", "/v1/sessions/password", { email: passwordEmail, password: "wrong-password" });
assert.equal(wrongPassword.response.status, 401);
assert.equal(wrongPassword.payload.error, "invalid_credentials");

jar.cookie = "";
env.BRIDGE_PASSWORD_MAX_FAILED_ATTEMPTS = "3";
env.BRIDGE_PASSWORD_LOCK_MS = "1000";
env.BRIDGE_PASSWORD_ATTEMPT_WINDOW_MS = "60000";
const limitedEmail = "password-limit@bridge.otherline.cc";
const limitedPassword = "PandaLimit-2026-0604!";
const limitedLogin = await api("POST", "/v1/sessions/password", { email: limitedEmail, password: limitedPassword });
assert.equal(limitedLogin.user.email, limitedEmail);
jar.cookie = "";
for (let index = 0; index < 2; index += 1) {
  const failed = await apiRaw("POST", "/v1/sessions/password", { email: limitedEmail, password: "wrong-password" });
  assert.equal(failed.response.status, 401);
  assert.equal(failed.payload.error, "invalid_credentials");
}
const locked = await apiRaw("POST", "/v1/sessions/password", { email: limitedEmail, password: "wrong-password" });
assert.equal(locked.response.status, 429);
assert.equal(locked.payload.error, "too_many_login_attempts");
assert.match(locked.response.headers.get("retry-after"), /^\d+$/);
const correctWhileLocked = await apiRaw("POST", "/v1/sessions/password", { email: limitedEmail, password: limitedPassword });
assert.equal(correctWhileLocked.response.status, 429);
assert.equal(correctWhileLocked.payload.error, "too_many_login_attempts");
await new Promise((resolve) => setTimeout(resolve, 1100));
const correctAfterLock = await api("POST", "/v1/sessions/password", { email: limitedEmail, password: limitedPassword });
assert.equal(correctAfterLock.user.id, limitedLogin.user.id);
jar.cookie = "";
const wrongAfterReset = await apiRaw("POST", "/v1/sessions/password", { email: limitedEmail, password: "wrong-password" });
assert.equal(wrongAfterReset.response.status, 401);
assert.equal(wrongAfterReset.payload.error, "invalid_credentials");
delete env.BRIDGE_PASSWORD_MAX_FAILED_ATTEMPTS;
delete env.BRIDGE_PASSWORD_LOCK_MS;
delete env.BRIDGE_PASSWORD_ATTEMPT_WINDOW_MS;

jar.cookie = "";
const logoutEmail = "logout-flow@bridge.otherline.cc";
await api("POST", "/v1/sessions/password", { email: logoutEmail, password: "PandaLogout-2026-0604!" });
assert.match(jar.cookie, /^pb_session=/);
const logoutRaw = await apiRaw("POST", "/v1/sessions/logout", {});
assert.equal(logoutRaw.response.status, 200);
assert.equal(logoutRaw.payload.authenticated, false);
assert.match(logoutRaw.setCookie, /Max-Age=0/);
const sessionAfterLogout = await apiRaw("GET", "/v1/session");
assert.equal(sessionAfterLogout.response.status, 401);
assert.equal(sessionAfterLogout.payload.authenticated, false);
const devicesAfterLogout = await apiRaw("GET", "/v1/devices");
assert.equal(devicesAfterLogout.response.status, 401);
assert.equal(devicesAfterLogout.payload.error, "unauthorized");

jar.cookie = "";
env.BRIDGE_SESSION_TTL_MS = "1";
await api("POST", "/v1/sessions/password", { email: "session-expiry@bridge.otherline.cc", password: "PandaExpiry-2026-0604!" });
assert.match(jar.cookie, /^pb_session=/);
await new Promise((resolve) => setTimeout(resolve, 5));
const expiredSession = await apiRaw("GET", "/v1/session");
assert.equal(expiredSession.response.status, 401);
assert.equal(expiredSession.payload.authenticated, false);
const expiredSessionDevices = await apiRaw("GET", "/v1/devices");
assert.equal(expiredSessionDevices.response.status, 401);
assert.equal(expiredSessionDevices.payload.error, "unauthorized");
await worker.scheduled({}, env, {});
delete env.BRIDGE_SESSION_TTL_MS;

console.log("[worker.test] pass");
