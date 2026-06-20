import {
  bridgeAdapterAuthorizationContextDenial,
  bridgeAuthorizationContextFromMirror,
  normalizeBridgeAuthorizationContext,
} from "./bridge-adapter-sdk.mjs";
import { cleanText } from "./utils.mjs";

export function adapterAuthorizationDenial(_command, authorizationMirror) {
  if (!authorizationMirror) {
    return {
      error: "authorization_mirror_required",
      message: "authorization_mirror_required",
    };
  }
  const status = cleanText(authorizationMirror.status || "");
  if (status !== "active" && status !== "authorized") {
    return {
      error: status === "revoked" ? "authorization_revoked" : "authorization_not_active",
      message: status || "authorization_not_active",
    };
  }
  return null;
}

export function adapterAuthorizationContextDenial(context, authorizationMirror, activeRelayContext = null) {
  return bridgeAdapterAuthorizationContextDenial(context, authorizationMirror, activeRelayContext);
}

export function productAuthorizationContext(authorizationMirror) {
  return bridgeAuthorizationContextFromMirror(authorizationMirror);
}

export function normalizeRelayAuthorizationContext(context) {
  return normalizeBridgeAuthorizationContext(context);
}

export function adapterDeniedResponse(command, denial) {
  return {
    ok: false,
    version: command.version || "burn-relay-v1",
    type: command.type || "unknown",
    request_id: command.request_id || null,
    error: denial.error,
    code: denial.error,
    cause_code: denial.error,
    message: denial.message || denial.error,
    ...(denial.context_field ? { context_field: denial.context_field } : {}),
  };
}

export function normalizeAuthorizationMirror(input) {
  if (!input) return null;
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (typeof input === "object") return input;
  return null;
}
