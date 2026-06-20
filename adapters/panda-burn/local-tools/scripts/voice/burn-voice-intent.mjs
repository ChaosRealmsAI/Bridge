#!/usr/bin/env node
// burn.voice.intent — AI-callable Burn voice intent emitter.
//
// An AI worker inside an active call calls this to emit a named voice intent
// (speak / wait / sound / cancel / status / progress / ask) into Burn Voice
// Cloud. The surface is intentionally thin: it builds and validates a stable
// JSON intent and either prints it (dry-run, no network) or POSTs it to the
// gateway with a scoped, redacted call token. It never performs ASR/TTS,
// queueing, or provider access.

import {
  buildVoiceIntent,
  cleanString,
  coded,
  createIdFactory,
  VOICE_INTENT_FIELDS,
  VOICE_INTENT_NAMES,
  VOICE_INTENT_PRIORITIES,
  VOICE_INTENT_SCHEMA,
  VOICE_INTENTS,
} from "./intent/voice-intent.mjs";
import { postVoiceIntent, resolveGatewayConfig } from "./intent/gateway-client.mjs";

const REDACTION_NOTE = {
  call_token: "redacted from output and logs; only Bearer ***redacted*** is shown",
  gateway_url: "sensitive query params and userinfo are masked in surfaced urls",
  payload: "voice intent carries speech/audio/control intent only — no provider keys or secrets",
};

const BOOLEAN_FLAGS = new Set(["gateway", "dry-run", "help", "json", "expects-reply", "loop", "barge-in"]);

// Curated intent params surfaced as first-class flags. Anything else can be
// passed via repeatable `--param key=value`.
const PARAM_FLAGS = {
  "duration-ms": ["durationMs", Number],
  "target-generation": ["targetGenerationId", String],
  "target-segment": ["targetSegmentId", String],
  "reason": ["reason", String],
  "listen-timeout-ms": ["listenTimeoutMs", Number],
  "voice": ["voice", String],
  "locale": ["locale", String],
  "gain": ["gain", Number],
};

export async function runVoiceIntentCli(argv = [], { env = process.env, fetchImpl } = {}) {
  const { positionals, options, params } = parseArgs(argv);
  const name = cleanString(options.name) || cleanString(positionals[0]);

  const wantsGateway = Boolean(options.gateway);
  const wantsDryRun = Boolean(options["dry-run"]);
  if (wantsGateway && wantsDryRun) {
    throw coded("voice_intent_bad_mode", "choose either --gateway or --dry-run, not both");
  }
  const mode = wantsGateway ? "gateway" : "dry-run";

  const seed = options.seed;
  const idFactory = createIdFactory({ seed });
  const now = seed != null && seed !== ""
    ? () => cleanString(options["created-at"]) || "1970-01-01T00:00:00.000Z"
    : () => new Date().toISOString();

  const intent = buildVoiceIntent(
    {
      name,
      callId: cleanString(options["call-id"]) || cleanString(env.BURN_VOICE_CALL_ID),
      sessionId: cleanString(options["session-id"]) || cleanString(env.BURN_VOICE_SESSION_ID),
      source: cleanString(options.source) || cleanString(env.BURN_VOICE_SOURCE),
      priority: options.priority,
      text: options.text,
      soundRef: options["sound-ref"] ?? options.sound,
      generationId: options["generation-id"],
      nodeId: options["node-id"],
      segmentId: options["segment-id"],
      intentId: options["intent-id"],
      params: collectParams(name, options, params),
    },
    { idFactory, now },
  );

  if (mode === "dry-run") {
    return {
      ok: true,
      schema: VOICE_INTENT_SCHEMA,
      mode,
      dry_run: true,
      network: false,
      intent,
      redaction: REDACTION_NOTE,
    };
  }

  const config = resolveGatewayConfig(
    {
      gatewayUrl: options["gateway-url"],
      gatewayPath: options["gateway-path"],
      callToken: options["call-token"],
      timeoutMs: options["timeout-ms"],
    },
    env,
  );
  const gateway = await postVoiceIntent({ envelope: { schema: VOICE_INTENT_SCHEMA, intent }, config, fetchImpl });

  return {
    ok: Boolean(gateway.ok),
    schema: VOICE_INTENT_SCHEMA,
    mode,
    intent,
    gateway,
    redaction: REDACTION_NOTE,
    ...(gateway.ok ? {} : { error: gateway.error, message: gateway.message }),
  };
}

function collectParams(name, options, paramPairs) {
  const params = {};
  for (const [flag, [key, cast]] of Object.entries(PARAM_FLAGS)) {
    if (options[flag] != null) params[key] = cast(options[flag]);
  }
  if (options["expects-reply"]) params.expectsReply = true;
  if (name === "ask" && params.expectsReply == null) params.expectsReply = true;
  if (options.loop) params.loop = true;
  if (options["barge-in"]) params.bargeIn = true;
  for (const pair of paramPairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    params[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return params;
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  const params = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq >= 0 ? eq : undefined);
    if (key === "param") {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[(index += 1)];
      if (value != null) params.push(value);
      continue;
    }
    if (BOOLEAN_FLAGS.has(key)) {
      options[key] = true;
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[(index += 1)];
    if (value === undefined) throw coded("voice_intent_usage", `missing value for --${key}`);
    options[key] = value;
  }
  return { positionals, options, params };
}

export function usage() {
  const intentLines = VOICE_INTENT_NAMES
    .map((name) => `    ${name.padEnd(9)} [${VOICE_INTENTS[name].kind}] ${VOICE_INTENTS[name].summary}`)
    .join("\n");
  return `burn.voice.intent — AI-callable Burn voice intent emitter

Usage:
  burn-voice-intent <intent> [flags]

Intents:
${intentLines}

Identity flags (stable ids; auto-generated when omitted):
  --call-id ID         active call id (or env BURN_VOICE_CALL_ID) [required]
  --session-id ID      chat/session id when available (or env BURN_VOICE_SESSION_ID)
  --generation-id ID   generation this intent belongs to / targets
  --node-id ID         dialog/timeline node id
  --segment-id ID      segment id within the generation
  --intent-id ID       idempotency id for this emission
  --source S           emitter identity (default "ai")
  --priority P         one of ${VOICE_INTENT_PRIORITIES.join("|")} (intent default otherwise)

Body flags:
  --text TEXT          spoken text (speak/ask)
  --sound-ref REF      audio segment reference (sound)
  --param key=value    extra intent param (repeatable)
  --duration-ms N      wait duration / pacing gap
  --target-generation ID, --target-segment ID, --reason TEXT   cancel targets
  --expects-reply, --listen-timeout-ms N                        ask hints
  --voice V, --locale L, --loop, --gain N, --barge-in           speech/audio hints

Modes:
  --dry-run            (default) build + print the exact JSON payload, no network
  --gateway            POST the envelope to Burn Voice Cloud
  --gateway-url URL    gateway base url (or env BURN_VOICE_GATEWAY_URL)
  --gateway-path P     intent path, default /v1/voice/calls/{callId}/intents (or env BURN_VOICE_INTENT_PATH)
  --call-token T       scoped call token (or env BURN_VOICE_CALL_TOKEN); always redacted in output
  --timeout-ms N       gateway request timeout (or env BURN_VOICE_GATEWAY_TIMEOUT_MS)

Determinism:
  --seed S [--created-at ISO]   deterministic ids + timestamp for reproducible payloads

Output is a single JSON object on stdout. Intent fields: ${VOICE_INTENT_FIELDS.join(", ")}.
`;
}

async function main(argv) {
  if (!argv.length || argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  try {
    const result = await runVoiceIntentCli(argv);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: cleanString(error?.message), code: error?.code || "voice_intent_error" }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
