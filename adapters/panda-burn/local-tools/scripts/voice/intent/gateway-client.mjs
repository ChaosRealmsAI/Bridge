// Thin gateway client for the AI-callable Burn voice intent tool.
//
// Posts a single voice-intent envelope to Burn Voice Cloud over HTTP using a
// scoped call token. It does not queue, retry, stream, or touch any provider —
// the cloud/gateway runtime owns delivery. The token is never echoed back in
// any returned object; only redacted forms are surfaced.

import { cleanString, coded, redactAuthorization, redactGatewayUrl } from "./voice-intent.mjs";

export const DEFAULT_INTENT_PATH = "/v1/voice/calls/{callId}/intents";
export const DEFAULT_GATEWAY_TIMEOUT_MS = 15000;

export function resolveGatewayConfig(input = {}, env = process.env) {
  const baseUrl = cleanString(input.gatewayUrl) || cleanString(env.BURN_VOICE_GATEWAY_URL);
  const path = cleanString(input.gatewayPath) || cleanString(env.BURN_VOICE_INTENT_PATH) || DEFAULT_INTENT_PATH;
  const token = cleanString(input.callToken) || cleanString(env.BURN_VOICE_CALL_TOKEN);
  const rawTimeout = Number(input.timeoutMs ?? env.BURN_VOICE_GATEWAY_TIMEOUT_MS ?? DEFAULT_GATEWAY_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_GATEWAY_TIMEOUT_MS;
  return { baseUrl, path, token, timeoutMs };
}

export function buildGatewayTarget(config, callId) {
  const baseUrl = cleanString(config?.baseUrl);
  if (!baseUrl) {
    throw coded("voice_gateway_url_missing", "gateway mode requires --gateway-url or BURN_VOICE_GATEWAY_URL");
  }
  const id = cleanString(callId);
  if (!id) throw coded("voice_intent_missing_call_id", "gateway target requires a callId");
  const path = (cleanString(config.path) || DEFAULT_INTENT_PATH).replace("{callId}", encodeURIComponent(id));
  // Preserve any base-url subpath (do not resolve against origin only).
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export async function postVoiceIntent({ envelope, config, fetchImpl }) {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw coded("voice_gateway_fetch_unavailable", "no fetch implementation available for gateway mode");
  }
  const callId = envelope?.intent?.callId;
  const url = buildGatewayTarget(config, callId);
  const request = {
    method: "POST",
    url: redactGatewayUrl(url),
    authorization: redactAuthorization(config.token),
    timeout_ms: config.timeoutMs,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response;
  let payload;
  let networkError;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        accept: "application/json",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    const raw = await response.text();
    payload = raw ? safeJsonParse(raw) : null;
  } catch (error) {
    networkError = error;
  } finally {
    clearTimeout(timer);
  }

  if (networkError) {
    const aborted = networkError?.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "voice_gateway_timeout" : "voice_gateway_post_failed",
      message: cleanString(networkError?.message) || (aborted ? "gateway request timed out" : "gateway request failed"),
      request,
    };
  }

  const ok = Boolean(response.ok) && payload?.ok !== false;
  return {
    ok,
    status: response.status,
    request,
    response: payload,
    ...(ok ? {} : { error: payload?.error || `gateway_http_${response.status}` }),
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "gateway_non_json_response", raw: cleanString(text).slice(0, 500) };
  }
}
