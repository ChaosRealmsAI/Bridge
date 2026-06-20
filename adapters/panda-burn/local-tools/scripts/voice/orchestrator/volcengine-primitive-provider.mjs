import { updateBilling, usageSnapshot } from "./billing.mjs";
import { emit, isTerminal } from "./events.mjs";
import { handleUserInput } from "./tools.mjs";
import { missingPrimitiveConfig } from "./voice-config.mjs";
import { createHeaderWebSocket } from "./websocket-client.mjs";
import { synthesizePrimitiveText, transcribePrimitivePcm } from "./volcengine-primitive-client.mjs";

const PROVIDER = "volcengine-primitive";
const SPEECH_RMS_FLOOR = 0.018;
const SPEECH_PEAK_FLOOR = 0.075;
const QUIET_RMS_FLOOR = 0.006;
const QUIET_PEAK_FLOOR = 0.035;
const END_MS = 850;
const MIN_MS = 520;
const BARGE_RMS_FLOOR = 0.22;
const BARGE_PEAK_FLOOR = 0.5;
const TTS_INPUT_SUPPRESSION_TAIL_MS = 550;
const TTS_INPUT_SUPPRESSION_MAX_AHEAD_MS = 2200;
const RECOVERABLE_ASR_ERRORS = new Set(["asr_result_timeout", "websocket_closed", "websocket_message_timeout"]);

export async function startVolcenginePrimitiveSession(options) {
  const session = new VolcenginePrimitiveSession(options);
  await session.start();
  return session;
}

export class VolcenginePrimitiveSession {
  constructor({ call, billing, toolBackend, config, transportFactory = createHeaderWebSocket }) {
    this.call = call;
    this.billing = billing;
    this.toolBackend = toolBackend;
    this.config = config;
    this.transportFactory = transportFactory;
    this.ready = false;
    this.closed = false;
    this.vad = emptyVadState();
    this.ttsActive = false;
    this.ttsSuppressedUntil = 0;
    this.inputSuppressedUntil = 0;
    this.suppressedAudioChunks = 0;
    this.suppressedAudioBytes = 0;
    this.suppressedTtsChunks = 0;
    this.suppressedTtsBytes = 0;
    this.ttsSinks = new Set();
    this.controlSinks = new Set();
  }

  async start() {
    const missing = missingPrimitiveConfig(this.config);
    if (missing.length) throw Object.assign(new Error(`provider_config_missing:${missing.join(",")}`), { code: "provider_config_missing", missing });
    this.call.status = "connecting";
    emit(this.call, "provider_connecting", { provider: PROVIDER, route: "asr_tts_primitive", auth_mode: "x-api-key" });
    this.ready = true;
    this.call.status = "listening";
    emit(this.call, "provider_session_started", {
      provider: PROVIDER,
      route: "asr_tts_primitive",
      asr_resource_id: this.config.asrResourceId,
      tts_resource_id: this.config.ttsResourceId,
      sample_rate: this.config.ttsSampleRate,
      tts_format: this.config.ttsFormat,
    });
    this.markUsage("usage_delta");
  }

  async handleTextInput({ text, forceTool = "", inputMode = "text", emitAsr = true } = {}) {
    if (!this.ready || this.closed || isTerminal(this.call) || !String(text || "").trim()) return;
    const clean = String(text);
    if (emitAsr) emit(this.call, "asr_final", { text: clean, role: "user", provider: PROVIDER, input_mode: inputMode });
    const result = await handleUserInput({
      call: this.call,
      text: clean,
      forceTool,
      billing: this.billing,
      toolBackend: this.toolBackend,
      emitAsr: false,
      emitMockAudio: false,
    });
    if (result?.answer) await this.synthesize(result.answer);
  }

  sendText(text, options = {}) {
    return this.handleTextInput({ text, ...options });
  }

  async sendAudio(bytes) {
    if (!this.ready || this.closed || isTerminal(this.call)) return;
    const audio = Buffer.from(bytes);
    const level = audioLevel(audio);
    const now = Date.now();
    const vad = this.vad;
    const strongBarge = level.rms >= BARGE_RMS_FLOOR || level.peak >= BARGE_PEAK_FLOOR;
    if ((this.ttsActive || now < this.inputSuppressedUntil) && !strongBarge) {
      this.suppressInput(audio, level, now);
      return;
    }
    if ((this.ttsActive || now < this.inputSuppressedUntil) && strongBarge) {
      this.markClientBargeIn({ source: "provider_audio", rms: level.rms, peak: level.peak });
    }
    const speech = level.rms >= SPEECH_RMS_FLOOR || level.peak >= SPEECH_PEAK_FLOOR;
    const quiet = level.rms <= QUIET_RMS_FLOOR && level.peak <= QUIET_PEAK_FLOOR;
    if (!vad.inSpeech && !speech) return;
    if (speech) {
      vad.lastSpeechAt = now;
      if (!vad.inSpeech) {
        vad.inSpeech = true;
        vad.startedAt = now;
        vad.chunks = [];
        emit(this.call, "provider_speech_start", { provider: PROVIDER, rms: round(level.rms), peak: round(level.peak) });
      }
    }
    if (!vad.inSpeech) return;
    vad.chunks.push(audio);
    if (quiet && now - vad.lastSpeechAt >= END_MS && now - vad.startedAt >= MIN_MS) await this.flushAsr("local_vad_silence", level);
  }

  suppressInput(audio, level, now) {
    this.suppressedAudioChunks += 1;
    this.suppressedAudioBytes += audio.length;
    if (this.suppressedAudioChunks === 1 || this.suppressedAudioChunks % 20 === 0) {
      emit(this.call, "provider_input_suppressed", {
        provider: PROVIDER,
        reason: this.ttsActive ? "assistant_tts_playing" : "assistant_tts_draining",
        bytes: audio.length,
        total_bytes: this.suppressedAudioBytes,
        chunks: this.suppressedAudioChunks,
        remaining_ms: Math.max(0, this.inputSuppressedUntil - now),
        rms: round(level.rms),
        peak: round(level.peak),
      });
    }
  }

  async flushAsr(reason, level = { rms: 0, peak: 0 }) {
    const pcm = Buffer.concat(this.vad.chunks || []);
    this.vad = emptyVadState();
    if (!pcm.length) return;
    emit(this.call, "provider_end_asr", { provider: PROVIDER, reason, bytes: pcm.length, rms: round(level.rms), peak: round(level.peak), mode: "buffered_utterance" });
    try {
      const result = await transcribePrimitivePcm({
        config: this.config,
        pcm,
        transportFactory: this.transportFactory,
        onEvent: (event) => this.onAsrEvent(event),
      });
      this.addProviderRef(`asr:${result.logid || result.request_id}`);
      this.markUsage("provider_usage", { provider_usage: { asr: { request_id: result.request_id, logid: result.logid, audio_bytes: result.audio_bytes, mode: "buffered_utterance" } } });
      if (result.text) {
        await this.handleTextInput({ text: result.text, inputMode: "audio", emitAsr: false });
      } else if (result.no_speech) {
        if (!isTerminal(this.call) && !this.ttsActive) this.call.status = "listening";
        emit(this.call, "provider_asr_no_speech", {
          provider: PROVIDER,
          reason: result.reason || "no_text",
          request_id: result.request_id,
          logid: result.logid,
          audio_bytes: result.audio_bytes,
        });
      }
    } catch (error) {
      this.providerError(error, "asr");
    }
  }

  async synthesize(text) {
    if (this.closed || isTerminal(this.call) || !String(text || "").trim()) return;
    try {
      const result = await synthesizePrimitiveText({
        config: this.config,
        text,
        transportFactory: this.transportFactory,
        onEvent: (event) => this.onTtsEvent(event),
        onAudio: (audio, meta) => this.handleTts(audio, meta),
      });
      this.finishTts("provider_tts_ended");
      this.addProviderRef(`tts:${result.logid || result.connect_id}`);
      this.markUsage("provider_usage", { provider_usage: { tts: result } });
    } catch (error) {
      this.providerError(error, "tts");
    }
  }

  onAsrEvent(event) {
    if (event.type === "connected") {
      const { type, ...detail } = event;
      emit(this.call, "provider_asr_connected", { provider: PROVIDER, ...detail });
      return;
    }
    emit(this.call, "provider_asr_event", { provider: PROVIDER, ...event.frame });
    if (event.text && !event.final) emit(this.call, "asr_partial", { text: event.text, role: "user", provider: PROVIDER });
    if (event.text && event.final) emit(this.call, "asr_final", { text: event.text, role: "user", provider: PROVIDER });
  }

  onTtsEvent(event) {
    if (event.type === "connected") {
      const { type, ...detail } = event;
      emit(this.call, "provider_tts_connected", { provider: PROVIDER, ...detail });
    } else {
      emit(this.call, "provider_tts_event", { provider: PROVIDER, ...event.frame });
    }
  }

  handleTts(audio, meta = {}) {
    if (Date.now() < this.ttsSuppressedUntil) {
      this.suppressedTtsChunks += 1;
      this.suppressedTtsBytes += audio.length;
      if (this.suppressedTtsChunks === 1 || this.suppressedTtsChunks % 20 === 0) {
        emit(this.call, "assistant_audio_suppressed", {
          provider: PROVIDER,
          reason: "client_barge_in",
          bytes: audio.length,
          total_bytes: this.suppressedTtsBytes,
          chunks: this.suppressedTtsChunks,
          remaining_ms: Math.max(0, this.ttsSuppressedUntil - Date.now()),
        });
      }
      return;
    }
    if (!this.ttsActive) {
      this.ttsActive = true;
      this.call.status = "speaking";
      emit(this.call, "assistant_audio_started", { provider: PROVIDER, codec: this.config.ttsFormat, sample_rate: this.config.ttsSampleRate, logid: meta.logid, connect_id: meta.connect_id });
    }
    emit(this.call, "assistant_audio_chunk", { provider: PROVIDER, bytes: audio.length, logid: meta.logid, connect_id: meta.connect_id });
    this.extendInputSuppression(audio.length);
    for (const sink of this.ttsSinks) sink(Buffer.from(audio));
  }

  finishTts(reason) {
    if (Date.now() < this.ttsSuppressedUntil || this.suppressedTtsChunks > 0) {
      this.ttsActive = false;
      this.ttsSuppressedUntil = 0;
      if (!isTerminal(this.call)) this.call.status = "listening";
      emit(this.call, "assistant_audio_suppressed_end", {
        provider: PROVIDER,
        reason: "client_barge_in",
        chunks: this.suppressedTtsChunks,
        bytes: this.suppressedTtsBytes,
      });
      this.suppressedTtsChunks = 0;
      this.suppressedTtsBytes = 0;
      this.sendControl({ type: "control", action: "tts_ended", reason: "suppressed_end" });
      return;
    }
    this.ttsActive = false;
    this.inputSuppressedUntil = Date.now() + TTS_INPUT_SUPPRESSION_TAIL_MS;
    if (!isTerminal(this.call)) this.call.status = "listening";
    emit(this.call, "assistant_audio_ended", { provider: PROVIDER, reason });
    this.sendControl({ type: "control", action: "tts_ended", reason });
  }

  extendInputSuppression(bytes) {
    const sampleRate = Number(this.config.ttsSampleRate || 24000);
    const bytesPerSecond = Math.max(1, sampleRate * 2);
    const durationMs = Math.max(1, Math.ceil((bytes / bytesPerSecond) * 1000));
    const now = Date.now();
    const activeAudioUntil = Math.max(now, this.inputSuppressedUntil - TTS_INPUT_SUPPRESSION_TAIL_MS);
    this.inputSuppressedUntil = Math.min(
      activeAudioUntil + durationMs + TTS_INPUT_SUPPRESSION_TAIL_MS,
      now + TTS_INPUT_SUPPRESSION_MAX_AHEAD_MS,
    );
  }

  addTtsSink(sink) {
    this.ttsSinks.add(sink);
    return () => this.ttsSinks.delete(sink);
  }

  addControlSink(sink) {
    this.controlSinks.add(sink);
    return () => this.controlSinks.delete(sink);
  }

  markClientBargeIn(message = {}) {
    const now = Date.now();
    const hadOutput = this.ttsActive || now < this.ttsSuppressedUntil;
    this.ttsSuppressedUntil = Date.now() + 12000;
    this.inputSuppressedUntil = 0;
    this.ttsActive = false;
    this.call.status = "listening";
    emit(this.call, "client_barge_in", {
      provider: PROVIDER,
      source: message.source || "client",
      utterance_id: message.utterance_id || "",
      rms: numberOrNull(message.rms ?? message.level?.rms),
      peak: numberOrNull(message.peak ?? message.level?.peak),
    });
    if (hadOutput && this.suppressedTtsChunks === 0) {
      emit(this.call, "assistant_audio_suppressed", {
        provider: PROVIDER,
        reason: "client_barge_in",
        bytes: 0,
        total_bytes: 0,
        chunks: 0,
        remaining_ms: Math.max(0, this.ttsSuppressedUntil - now),
      });
    }
  }

  async markClientSpeechEnd(message = {}) {
    const level = levelFromMessage(message);
    if (this.vad.inSpeech && this.vad.chunks?.length) {
      await this.flushAsr("client_speech_end", level);
      return;
    }
    emit(this.call, "provider_vad_reset", {
      provider: PROVIDER,
      reason: "client_speech_end_without_active_speech",
      rms: round(level.rms),
      peak: round(level.peak),
    });
  }

  end() {
    this.closed = true;
    this.ready = false;
  }

  sendControl(message) {
    for (const sink of this.controlSinks) sink(message);
  }

  addProviderRef(ref) {
    const record = this.billing.get(this.call.id);
    if (record && ref && !record.provider_refs.includes(ref)) record.provider_refs.push(ref);
  }

  markUsage(type, extra = {}) {
    updateBilling(this.call, this.billing);
    const record = this.billing.get(this.call.id);
    emit(this.call, type, { ...usageSnapshot(this.call, this.billing), provider_refs: record?.provider_refs || [], ...extra });
  }

  providerError(error, stage) {
    const recoverable = isRecoverableProviderError(error, stage);
    emit(this.call, "provider_error", {
      provider: PROVIDER,
      stage,
      error: error?.code || "provider_error",
      message: scrubError(error, this.config),
      recoverable,
      terminal: !recoverable,
      status: recoverable ? "listening" : "error",
    });
    if (recoverable) {
      if (!isTerminal(this.call) && !this.ttsActive) this.call.status = "listening";
      return;
    }
    this.call.status = "error";
  }
}

function audioLevel(audio) {
  let peak = 0;
  let sumSq = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < audio.length; offset += 2) {
    const value = audio.readInt16LE(offset) / 32768;
    peak = Math.max(peak, Math.abs(value));
    sumSq += value * value;
    samples += 1;
  }
  return { rms: samples ? Math.sqrt(sumSq / samples) : 0, peak };
}

function emptyVadState() {
  return { inSpeech: false, startedAt: 0, lastSpeechAt: 0, chunks: [] };
}

function scrubError(error, config) {
  return String(error?.message || error || "").replaceAll(config.apiKey || "\u0000", "<redacted>");
}

function isRecoverableProviderError(error, stage) {
  return stage === "asr" && RECOVERABLE_ASR_ERRORS.has(error?.code || "");
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function levelFromMessage(message = {}) {
  return {
    rms: numberOrNull(message.rms ?? message.level?.rms) ?? 0,
    peak: numberOrNull(message.peak ?? message.level?.peak) ?? 0,
  };
}

function round(value) {
  return Number(value.toFixed(6));
}
