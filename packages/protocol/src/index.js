export const BRIDGE_PROTOCOL_VERSION = "panda-bridge-protocol-v0.1";

export const EVENT_TYPES = Object.freeze([
  "queued",
  "claimed",
  "started",
  "status",
  "text_delta",
  "app_server_event",
  "completed",
  "failed",
  "cancelled",
]);

export function normalizeBridgeJob(input = {}) {
  const kind = normalizeKind(input.kind || input.job_kind);
  const productId = stringValue(input.productId || input.product_id, 80);
  const deviceId = stringValue(input.deviceId || input.device_id || input.connector_id, 80);
  const workspaceRef = stringPassthrough(input.workspaceRef ?? input.workspace_ref);
  const requestKey = stringValue(input.requestKey || input.request_key, 160);
  const body = objectValue(input.input || input.payload);
  const policy = normalizePolicy(input.policy || {});
  return {
    kind,
    product_id: productId,
    device_id: deviceId,
    workspace_ref: workspaceRef || null,
    request_key: requestKey || null,
    input: body,
    policy,
  };
}

export function validateBridgeJob(input = {}) {
  const job = normalizeBridgeJob(input);
  const errors = [];
  if (!job.kind) errors.push("missing_kind");
  if (!job.product_id) errors.push("missing_product_id");
  if (!job.device_id) errors.push("missing_device_id");
  return { ok: errors.length === 0, errors, job };
}

export function normalizePolicy(input = {}) {
  return objectValue(input);
}

export function normalizeKind(kind) {
  return stringPassthrough(kind);
}

export function bridgeEvent(type, payload = {}) {
  return {
    type: EVENT_TYPES.includes(type) ? type : "status",
    payload: objectValue(payload),
    created_at: new Date().toISOString(),
  };
}

export function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function stringValue(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function stringPassthrough(value) {
  return typeof value === "string" ? value : "";
}

export function integerValue(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}
