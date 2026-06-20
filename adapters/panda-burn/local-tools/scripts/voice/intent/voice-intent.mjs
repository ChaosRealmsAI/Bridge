// Burn voice intent — pure payload builder, validation, and redaction helpers.
//
// This module is the product-neutral-shaped core of the AI-callable Burn voice
// tool. It only describes and validates the *intent* an AI worker wants to emit
// into Burn Voice Cloud for an active call. It deliberately knows nothing about
// ASR/TTS, queueing, provider access, or the network — those belong to the
// voice-cloud-queue-runtime lane and the orchestrator.

export const VOICE_INTENT_SCHEMA = "burn.voice.intent.v1";

export const VOICE_INTENT_PRIORITIES = ["low", "normal", "high", "urgent"];

// The minimum recognized intent surface. `kind` groups intents so the gateway
// can route without re-deriving product semantics; `requires` is the body field
// that must be present for the intent to be well-formed.
export const VOICE_INTENTS = {
  speak: { kind: "speech", priority: "normal", requires: "text", summary: "Speak generated text to the caller." },
  ask: { kind: "speech", priority: "normal", requires: "text", summary: "Speak a prompt and expect the caller to reply." },
  sound: { kind: "audio", priority: "normal", requires: "soundRef", summary: "Play a named or configured audio segment." },
  wait: { kind: "control", priority: "normal", requires: "none", summary: "Hold the floor or insert a paced gap." },
  cancel: { kind: "control", priority: "high", requires: "none", summary: "Cancel stale generation/segment for barge-in." },
  status: { kind: "query", priority: "low", requires: "none", summary: "Ask the gateway for current call/timeline status." },
  progress: { kind: "query", priority: "low", requires: "none", summary: "Ask the gateway for delivery/playback progress." },
};

export const VOICE_INTENT_NAMES = Object.keys(VOICE_INTENTS);

// Stable order of the canonical intent fields, documented so dry-run output
// "proves the exact payload shape".
export const VOICE_INTENT_FIELDS = [
  "intentId",
  "callId",
  "sessionId",
  "generationId",
  "nodeId",
  "segmentId",
  "name",
  "kind",
  "priority",
  "text",
  "soundRef",
  "source",
  "params",
  "createdAt",
];

export function buildVoiceIntent(input = {}, deps = {}) {
  const name = cleanString(input.name);
  const spec = VOICE_INTENTS[name];
  if (!spec) {
    throw coded(
      "voice_intent_unknown",
      `unknown voice intent: ${name || "(empty)"}; expected one of ${VOICE_INTENT_NAMES.join(", ")}`,
    );
  }

  const idFactory = deps.idFactory || createIdFactory();
  const now = deps.now || (() => new Date().toISOString());

  const callId = cleanString(input.callId);
  if (!callId) {
    throw coded("voice_intent_missing_call_id", "callId is required (pass --call-id or set BURN_VOICE_CALL_ID)");
  }

  const text = cleanString(input.text);
  const soundRef = cleanString(input.soundRef);
  if (spec.requires === "text" && !text) {
    throw coded("voice_intent_missing_text", `intent "${name}" requires non-empty --text`);
  }
  if (spec.requires === "soundRef" && !soundRef) {
    throw coded("voice_intent_missing_sound_ref", `intent "${name}" requires non-empty --sound-ref`);
  }

  const priority = cleanString(input.priority) || spec.priority;
  if (!VOICE_INTENT_PRIORITIES.includes(priority)) {
    throw coded(
      "voice_intent_bad_priority",
      `unknown priority: ${priority}; expected one of ${VOICE_INTENT_PRIORITIES.join(", ")}`,
    );
  }

  const source = cleanString(input.source) || "ai";

  return {
    intentId: cleanString(input.intentId) || idFactory("int"),
    callId,
    sessionId: cleanString(input.sessionId),
    generationId: cleanString(input.generationId) || idFactory("gen"),
    nodeId: cleanString(input.nodeId) || idFactory("node"),
    segmentId: cleanString(input.segmentId) || idFactory("seg"),
    name,
    kind: spec.kind,
    priority,
    text,
    soundRef,
    source,
    params: normalizeParams(input.params),
    createdAt: now(),
  };
}

export function buildVoiceIntentEnvelope(input = {}, deps = {}) {
  return { schema: VOICE_INTENT_SCHEMA, intent: buildVoiceIntent(input, deps) };
}

export function createIdFactory(options = {}) {
  if (options.seed != null && options.seed !== "") {
    // Deterministic ids for reproducible dry-run evidence/tests.
    const seed = String(options.seed);
    let counter = 0;
    return (prefix) => `${prefix}-${seed}-${String((counter += 1)).padStart(3, "0")}`;
  }
  return (prefix) => `${prefix}_${Date.now().toString(36)}_${randomSuffix()}`;
}

export function normalizeParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

// --- redaction ----------------------------------------------------------

export function redactToken(token) {
  return cleanString(token) ? "***redacted***" : "";
}

export function redactAuthorization(token) {
  return cleanString(token) ? "Bearer ***redacted***" : "none";
}

const SENSITIVE_QUERY_KEY = /token|key|secret|sig|signature|password|access|auth/i;

export function redactGatewayUrl(url) {
  const text = cleanString(url);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, "***redacted***");
    }
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***redacted***" : "";
      parsed.password = parsed.password ? "***redacted***" : "";
    }
    return parsed.toString();
  } catch {
    return text;
  }
}

// --- small shared utils -------------------------------------------------

export function cleanString(value) {
  return value == null ? "" : String(value).trim();
}

export function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function randomSuffix() {
  return Math.random().toString(16).slice(2, 10);
}
