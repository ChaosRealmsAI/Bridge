import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { runVoiceIntentCli } from "./burn-voice-intent.mjs";
import {
  buildVoiceIntent,
  redactGatewayUrl,
  VOICE_INTENT_FIELDS,
  VOICE_INTENT_NAMES,
  VOICE_INTENT_SCHEMA,
  VOICE_INTENTS,
} from "./intent/voice-intent.mjs";

const fixedDeps = {
  idFactory: (prefix) => `${prefix}-X`,
  now: () => "2026-06-20T00:00:00.000Z",
};

test("buildVoiceIntent emits the exact stable field shape", () => {
  const intent = buildVoiceIntent({ name: "speak", callId: "call_1", text: "hello" }, fixedDeps);
  assert.deepEqual(Object.keys(intent), VOICE_INTENT_FIELDS);
  assert.deepEqual(intent, {
    intentId: "int-X",
    callId: "call_1",
    sessionId: "",
    generationId: "gen-X",
    nodeId: "node-X",
    segmentId: "seg-X",
    name: "speak",
    kind: "speech",
    priority: "normal",
    text: "hello",
    soundRef: "",
    source: "ai",
    params: {},
    createdAt: "2026-06-20T00:00:00.000Z",
  });
});

test("every required intent name builds and carries its declared kind/default priority", () => {
  assert.deepEqual(VOICE_INTENT_NAMES.sort(), ["ask", "cancel", "progress", "sound", "speak", "status", "wait"]);
  for (const name of VOICE_INTENT_NAMES) {
    const input = { name, callId: "call_1" };
    if (VOICE_INTENTS[name].requires === "text") input.text = "x";
    if (VOICE_INTENTS[name].requires === "soundRef") input.soundRef = "chime";
    const intent = buildVoiceIntent(input, fixedDeps);
    assert.equal(intent.kind, VOICE_INTENTS[name].kind);
    assert.equal(intent.priority, VOICE_INTENTS[name].priority);
    assert.equal(intent.source, "ai");
    assert.ok(intent.intentId && intent.generationId && intent.nodeId && intent.segmentId);
  }
});

const hasCode = (code) => (error) => error?.code === code;

test("validation rejects malformed intents with stable codes", () => {
  assert.throws(() => buildVoiceIntent({ name: "nope", callId: "c" }, fixedDeps), hasCode("voice_intent_unknown"));
  assert.throws(() => buildVoiceIntent({ name: "speak", text: "hi" }, fixedDeps), hasCode("voice_intent_missing_call_id"));
  assert.throws(() => buildVoiceIntent({ name: "speak", callId: "c" }, fixedDeps), hasCode("voice_intent_missing_text"));
  assert.throws(() => buildVoiceIntent({ name: "sound", callId: "c" }, fixedDeps), hasCode("voice_intent_missing_sound_ref"));
  assert.throws(() => buildVoiceIntent({ name: "speak", callId: "c", text: "x", priority: "loud" }, fixedDeps), hasCode("voice_intent_bad_priority"));
});

test("ask defaults expectsReply and cancel can target a stale generation", () => {
  const ask = buildVoiceIntent({ name: "ask", callId: "c", text: "ready?", params: { expectsReply: true } }, fixedDeps);
  assert.equal(ask.params.expectsReply, true);
  const cancel = buildVoiceIntent(
    { name: "cancel", callId: "c", generationId: "gen-stale", params: { targetGenerationId: "gen-stale", reason: "barge_in" } },
    fixedDeps,
  );
  assert.equal(cancel.priority, "high");
  assert.equal(cancel.generationId, "gen-stale");
  assert.equal(cancel.params.targetGenerationId, "gen-stale");
});

test("CLI dry-run proves the exact payload shape without network", async () => {
  const result = await runVoiceIntentCli(
    ["speak", "--call-id", "call_42", "--text", "hi there", "--seed", "7"],
    { env: {} },
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.dry_run, true);
  assert.equal(result.network, false);
  assert.equal(result.schema, VOICE_INTENT_SCHEMA);
  assert.equal(result.intent.callId, "call_42");
  assert.equal(result.intent.text, "hi there");
  // deterministic ids from --seed
  assert.equal(result.intent.intentId, "int-7-001");
  assert.equal(result.intent.generationId, "gen-7-002");
  assert.equal(result.intent.createdAt, "1970-01-01T00:00:00.000Z");
  assert.ok(!("gateway" in result));
});

test("CLI reads call/session id and ask hints from env and flags", async () => {
  const result = await runVoiceIntentCli(
    ["ask", "--text", "are you there", "--expects-reply", "--listen-timeout-ms", "8000", "--seed", "1"],
    { env: { BURN_VOICE_CALL_ID: "call_env", BURN_VOICE_SESSION_ID: "sess_env" } },
  );
  assert.equal(result.intent.callId, "call_env");
  assert.equal(result.intent.sessionId, "sess_env");
  assert.equal(result.intent.params.expectsReply, true);
  assert.equal(result.intent.params.listenTimeoutMs, 8000);
});

test("CLI rejects conflicting modes", async () => {
  await assert.rejects(
    () => runVoiceIntentCli(["speak", "--call-id", "c", "--text", "x", "--gateway", "--dry-run"], { env: {} }),
    hasCode("voice_intent_bad_mode"),
  );
});

test("redactGatewayUrl masks sensitive query params and userinfo", () => {
  assert.equal(
    redactGatewayUrl("https://u:p@gw.example.com/x?call_token=abc123&foo=1"),
    "https://***redacted***:***redacted***@gw.example.com/x?call_token=***redacted***&foo=1",
  );
});

test("CLI gateway mode posts the envelope with a Bearer token and never leaks it", async () => {
  const secret = "super-secret-call-token-zzz";
  const received = { auth: "", body: null };
  const server = createServer((req, res) => {
    received.auth = req.headers.authorization || "";
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, queued: true, segmentId: received.body.intent.segmentId }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const result = await runVoiceIntentCli(
      ["speak", "--call-id", "call_gw", "--text", "deliver this", "--gateway", "--seed", "9"],
      { env: { BURN_VOICE_GATEWAY_URL: `http://127.0.0.1:${port}`, BURN_VOICE_CALL_TOKEN: secret } },
    );

    // Real network path exercised end to end.
    assert.equal(result.ok, true);
    assert.equal(result.mode, "gateway");
    assert.equal(result.gateway.status, 200);
    assert.equal(result.gateway.response.queued, true);

    // Server actually received the real token + the full intent envelope.
    assert.equal(received.auth, `Bearer ${secret}`);
    assert.equal(received.body.schema, VOICE_INTENT_SCHEMA);
    assert.equal(received.body.intent.callId, "call_gw");
    assert.equal(received.body.intent.text, "deliver this");

    // The returned object only shows the redacted form, never the real token.
    assert.equal(result.gateway.request.authorization, "Bearer ***redacted***");
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.match(result.gateway.request.url, /127\.0\.0\.1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("CLI gateway mode surfaces a clean error when the gateway url is missing", async () => {
  await assert.rejects(
    () => runVoiceIntentCli(["speak", "--call-id", "c", "--text", "x", "--gateway"], { env: {} }),
    hasCode("voice_gateway_url_missing"),
  );
});
