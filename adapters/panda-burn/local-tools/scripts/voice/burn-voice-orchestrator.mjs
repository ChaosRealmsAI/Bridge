import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { endCall, loadLedger, persistLedger, reconcileCall, updateBilling } from "./orchestrator/billing.mjs";
import { createCall } from "./orchestrator/calls.mjs";
import { emit, isTerminal, publicCall } from "./orchestrator/events.mjs";
import { readBytes, readJson, writeJson } from "./orchestrator/http.mjs";
import { startDoubaoRealtimeSession } from "./orchestrator/doubao-provider.mjs";
import { handleUserInput, mockToolBackend, voiceToolIntent } from "./orchestrator/tools.mjs";
import { startVolcenginePrimitiveSession } from "./orchestrator/volcengine-primitive-provider.mjs";
import { loadVoiceEnvFile, missingPrimitiveConfig, missingRealtimeConfig, primitiveConfig, publicPrimitiveConfig, publicRealtimeConfig, realtimeConfig } from "./orchestrator/voice-config.mjs";
import { acceptWebSocket, rejectWebSocket } from "./orchestrator/websocket-server.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultLedgerPath = resolve(repoRoot, "spec/L4/evidence/spec-code-rebuild-v1/voice/voice-ledger.json");

export async function startVoiceOrchestrator(options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number(options.port || process.env.PORT || 0);
  const requestedProvider = String(options.provider || process.env.BURN_VOICE_PROVIDER || "mock").toLowerCase();
  const provider = normalizeProvider(requestedProvider);
  const ledgerPath = options.ledgerPath || defaultLedgerPath;
  const calls = new Map();
  const billing = new Map();
  const toolBackend = options.toolBackend || mockToolBackend();
  const env = options.env || process.env;
  loadVoiceEnvFile(options.envFile || env.BURN_VOICE_ENV_FILE || "", env);
  const doubaoConfig = options.realtimeConfig || realtimeConfig(env);
  const volcPrimitiveConfig = options.primitiveConfig || primitiveConfig(env);
  const activeProviderConfig = isPrimitiveProvider(provider) ? volcPrimitiveConfig : doubaoConfig;

  await loadLedger(ledgerPath, billing);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://burn.voice");
      if (request.method === "GET" && url.pathname === "/health") {
        return writeJson(response, 200, {
          ok: true,
          provider,
          provider_alias: requestedProvider !== provider ? requestedProvider : "",
          calls: calls.size,
          billing_records: billing.size,
          primitive: isPrimitiveProvider(provider) ? publicPrimitiveConfig(volcPrimitiveConfig) : null,
          realtime: isRealtimeProvider(provider) ? publicRealtimeConfig(doubaoConfig) : null,
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/voice/calls") {
        const body = await readJson(request);
        const missing = missingProviderConfig(provider, volcPrimitiveConfig, doubaoConfig);
        if (missing.length) {
          return writeJson(response, 503, { ok: false, error: "provider_config_missing", provider, missing });
        }
        const call = createCall({ body, provider, calls, billing });
        if (isRealProvider(provider)) {
          const started = await startProviderCall({ provider, call, billing, toolBackend, doubaoConfig, volcPrimitiveConfig, options });
          if (started.ok === false) {
            await persistLedger(ledgerPath, billing);
            return writeJson(response, 502, { ok: false, error: started.error, call_id: call.id });
          }
        }
        await persistLedger(ledgerPath, billing);
        return writeJson(response, 200, {
          ok: true,
          call_id: call.id,
          provider,
          status: call.status,
          events_url: `/v1/voice/calls/${call.id}/events`,
          input_url: `/v1/voice/calls/${call.id}/input`,
          audio_url: `/v1/voice/calls/${call.id}/audio`,
        });
      }

      const match = url.pathname.match(/^\/v1\/voice\/calls\/([^/]+)\/([^/]+)$/);
      if (match) {
        const call = calls.get(match[1]);
        if (!call) return writeJson(response, 404, { ok: false, error: "call_not_found" });
        const action = match[2];
        if (request.method === "GET" && action === "events") {
          const after = Number(url.searchParams.get("after_seq") || 0);
          const items = call.events.filter((event) => event.seq > after);
          return writeJson(response, 200, { ok: true, call: publicCall(call), cursor: call.seq, items });
        }
        if (request.method === "POST" && action === "input") {
          if (isTerminal(call)) return writeJson(response, 409, { ok: false, error: "call_ended" });
          const body = await readJson(request);
          const text = String(body.text || "");
          const forceTool = body.force_tool || "";
          await routeTextInput({ call, text, forceTool, billing, toolBackend });
          await persistLedger(ledgerPath, billing);
          return writeJson(response, 200, { ok: true, call: publicCall(call), cursor: call.seq });
        }
        if (request.method === "POST" && action === "audio") {
          if (isTerminal(call)) return writeJson(response, 409, { ok: false, error: "call_ended" });
          const bytes = await readBytes(request);
          call.audioBytes += bytes.length;
          emit(call, "audio_received", { bytes: bytes.length, total_bytes: call.audioBytes });
          if (call.runtime) {
            await call.runtime.sendAudio(bytes);
          } else if (call.audioBytes >= 3200 && !call.autoAudioHandled) {
            call.autoAudioHandled = true;
            await handleUserInput({ call, text: "帮我看一下当前项目状态", forceTool: "burn.context.snapshot", billing, toolBackend });
          }
          await persistLedger(ledgerPath, billing);
          return writeJson(response, 200, { ok: true, bytes: bytes.length, total_bytes: call.audioBytes, cursor: call.seq });
        }
        if (request.method === "POST" && action === "end") {
          call.runtime?.end?.();
          endCall(call, billing);
          await persistLedger(ledgerPath, billing);
          return writeJson(response, 200, { ok: true, call: publicCall(call), billing: billing.get(call.id) });
        }
        if (request.method === "POST" && action === "reconcile") {
          const body = await readJson(request);
          const reconciled = reconcileCall(call, billing, body);
          await persistLedger(ledgerPath, billing);
          if (reconciled.ok === false) return writeJson(response, 409, reconciled);
          return writeJson(response, 200, { ok: true, call: publicCall(call), billing: billing.get(call.id) });
        }
      }

      if (request.method === "GET" && url.pathname === "/v1/billing/voice") {
        return writeJson(response, 200, { ok: true, records: [...billing.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)) });
      }
      return writeJson(response, 404, { ok: false, error: "not_found" });
    } catch (error) {
      return writeJson(response, 500, { ok: false, error: "voice_orchestrator_error", message: String(error?.message || error) });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://burn.voice");
    const match = url.pathname.match(/^\/v1\/voice\/calls\/([^/]+)\/ws$/);
    if (!match) return rejectWebSocket(socket, 404, "not_found");
    const call = calls.get(decodeURIComponent(match[1]));
    if (!call) return rejectWebSocket(socket, 404, "call_not_found");
    if (isTerminal(call)) return rejectWebSocket(socket, 409, "call_ended");
    let ws;
    try {
      ws = acceptWebSocket({ request, socket, head });
    } catch (error) {
      return rejectWebSocket(socket, 400, error?.message || "websocket_bad_request");
    }
    attachVoiceSocket({ ws, call, billing, ledgerPath, providerConfig: activeProviderConfig, toolBackend });
  });

  await new Promise((resolveListen) => server.listen(port, host, resolveListen));
  const address = server.address();
  return {
    url: `http://${address.address}:${address.port}`,
    provider,
    calls,
    billing,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function attachVoiceSocket({ ws, call, billing, ledgerPath, providerConfig, toolBackend }) {
  let audioChunks = 0;
  let ttsChunks = 0;
  let ttsBytes = 0;
  const unsubscribeTts = call.runtime?.addTtsSink?.((audio) => {
    ttsChunks += 1;
    ttsBytes += audio.length;
    try {
      ws.sendBinary(audio);
      if (ttsChunks === 1 || ttsChunks % 20 === 0) {
        emit(call, "voice_ws_tts_sent", { bytes: audio.length, total_bytes: ttsBytes, chunks: ttsChunks });
      }
    } catch (error) {
      emit(call, "voice_ws_tts_send_failed", { message: String(error?.message || error), bytes: audio.length, chunks: ttsChunks });
    }
  }) || (() => {});
  const unsubscribeControl = call.runtime?.addControlSink?.((message) => {
    try {
      ws.sendJson(message);
    } catch (error) {
      emit(call, "voice_ws_control_send_failed", { message: String(error?.message || error), action: message?.action || "" });
    }
  }) || (() => {});
  emit(call, "voice_ws_connected", { sample_rate: 16000, tts_sample_rate: providerConfig.ttsSampleRate, tts_format: providerConfig.ttsFormat });
  ws.sendJson({
    type: "hello",
    call_id: call.id,
    status: call.status,
    input_sample_rate: 16000,
    tts_sample_rate: providerConfig.ttsSampleRate,
    tts_format: providerConfig.ttsFormat,
  });
  ws.on("message", async (message) => {
    try {
      if (Buffer.isBuffer(message)) {
        if (isTerminal(call)) return;
        call.audioBytes += message.length;
        audioChunks += 1;
        if (audioChunks === 1 || audioChunks % 20 === 0) emit(call, "audio_received", { bytes: message.length, total_bytes: call.audioBytes, chunks: audioChunks, route: "voice_ws" });
        if (call.runtime) await call.runtime.sendAudio(message);
        updateBilling(call, billing);
        return;
      }
      const body = JSON.parse(String(message || "{}"));
      if (body.type === "hangup") {
        call.runtime?.end?.();
        endCall(call, billing);
        await persistLedger(ledgerPath, billing);
        ws.close();
        return;
      }
      if (body.type === "client_barge_in") {
        const ack = emit(call, "client_barge_in_ack", {
          source: body.source || "client",
          utterance_id: body.utterance_id || "",
          rms: numberOrNull(body.rms ?? body.level?.rms),
          peak: numberOrNull(body.peak ?? body.level?.peak),
          noise_floor: numberOrNull(body.noise_floor),
          status: "listening",
          summary: "gateway acknowledged client barge-in",
        });
        ws.sendJson({
          type: "client_barge_in_ack",
          seq: ack.seq,
          source: ack.source,
          utterance_id: ack.utterance_id,
          rms: ack.rms,
          peak: ack.peak,
          noise_floor: ack.noise_floor,
          status: ack.status,
          summary: ack.summary,
        });
        call.runtime?.markClientBargeIn?.(body);
        updateBilling(call, billing);
        return;
      }
      if (body.type === "client_speech_end") {
        emit(call, "client_speech_end", {
          source: body.source || "client",
          utterance_id: body.utterance_id || "",
          rms: numberOrNull(body.rms ?? body.level?.rms),
          peak: numberOrNull(body.peak ?? body.level?.peak),
          noise_floor: numberOrNull(body.noise_floor),
          reason: body.reason || "client_vad_end",
        });
        await call.runtime?.markClientSpeechEnd?.(body);
        updateBilling(call, billing);
        return;
      }
      if (body.type === "text" && body.text) {
        await routeTextInput({ call, text: String(body.text), forceTool: body.force_tool || "", billing, toolBackend });
        await persistLedger(ledgerPath, billing);
      }
    } catch (error) {
      emit(call, "voice_ws_error", { message: String(error?.message || error) });
      ws.sendJson({ type: "error", error: String(error?.message || error) });
    }
  });
  ws.on("close", () => {
    unsubscribeTts();
    unsubscribeControl();
    emit(call, "voice_ws_closed", { chunks: audioChunks, total_bytes: call.audioBytes, tts_chunks: ttsChunks, tts_bytes: ttsBytes });
    updateBilling(call, billing);
    persistLedger(ledgerPath, billing).catch(() => {});
  });
  ws.on("error", (error) => {
    emit(call, "voice_ws_error", { message: String(error?.message || error) });
  });
}

async function routeTextInput({ call, text, forceTool, billing, toolBackend }) {
  if (call.runtime?.handleTextInput) {
    await call.runtime.handleTextInput({ text, forceTool });
  } else if (call.runtime && !forceTool && !voiceToolIntent(text)) {
    call.runtime.sendText(text);
  } else {
    await handleUserInput({ call, text, forceTool, billing, toolBackend });
  }
}

async function startProviderCall({ provider, call, billing, toolBackend, doubaoConfig, volcPrimitiveConfig, options }) {
  try {
    if (isPrimitiveProvider(provider)) {
      call.runtime = await startVolcenginePrimitiveSession({
        call,
        billing,
        toolBackend,
        config: volcPrimitiveConfig,
        transportFactory: options.primitiveTransportFactory || options.transportFactory,
      });
    } else {
      call.runtime = await startDoubaoRealtimeSession({
        call,
        billing,
        toolBackend,
        config: doubaoConfig,
        transportFactory: options.transportFactory,
      });
    }
    return { ok: true };
  } catch (error) {
    call.status = "error";
    emit(call, "provider_error", { provider, error: error.code || "provider_start_failed", message: String(error?.message || error) });
    const record = billing.get(call.id);
    if (record) {
      record.ended_at = new Date().toISOString();
      record.reconciliation_status = "provider_failed";
      record.summary = `provider failed: ${error.code || error.message || "unknown"}`;
    }
    return { ok: false, error: error.code || "provider_start_failed" };
  }
}

function normalizeProvider(provider) {
  if (["doubao", "volcengine", "volcengine-primitive", "volcengine_primitive"].includes(provider)) return "volcengine-primitive";
  if (["doubao-realtime-legacy", "legacy-doubao-realtime", "doubao-legacy"].includes(provider)) return "doubao-realtime-legacy";
  return provider || "mock";
}

function isPrimitiveProvider(provider) { return provider === "volcengine-primitive"; }

function isRealtimeProvider(provider) { return provider === "doubao-realtime-legacy"; }

function isRealProvider(provider) { return isPrimitiveProvider(provider) || isRealtimeProvider(provider); }

function missingProviderConfig(provider, primitive, realtime) {
  if (isPrimitiveProvider(provider)) return missingPrimitiveConfig(primitive);
  if (isRealtimeProvider(provider)) return missingRealtimeConfig(realtime);
  return [];
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startVoiceOrchestrator({ port: Number(process.env.PORT || 8892) });
  console.log(JSON.stringify({ ok: true, url: server.url, provider: server.provider }, null, 2));
}
