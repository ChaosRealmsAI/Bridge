import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { updateBilling, usageSnapshot } from "./billing.mjs";
import { emit, isTerminal } from "./events.mjs";
import { handleUserInput, voiceToolIntent } from "./tools.mjs";
import { createHeaderWebSocket, WS_OPEN } from "./websocket-client.mjs";
import { decodeServerFrame, encodeAudioEvent, encodeJsonEvent, EventId } from "./realtime-protocol.mjs";
import { missingRealtimeConfig, providerHeaders } from "./voice-config.mjs";

const INPUT_PREROLL_CHUNKS = 4;
const SPEECH_RMS_FLOOR = 0.018;
const SPEECH_PEAK_FLOOR = 0.075;
const QUIET_RMS_FLOOR = 0.006;
const QUIET_PEAK_FLOOR = 0.035;
const END_MS = 850;
const MIN_MS = 520;
const RESPONSE_WAIT_RESET_MS = 8000;
const TTS_INPUT_SUPPRESSION_TAIL_MS = 550;
const TTS_INPUT_SUPPRESSION_MAX_AHEAD_MS = 2200;

export async function startDoubaoRealtimeSession(options) {
  const session = new DoubaoRealtimeSession(options);
  await session.start();
  return session;
}

export class DoubaoRealtimeSession {
  constructor({ call, billing, toolBackend, config, transportFactory = createHeaderWebSocket }) {
    this.call = call;
    this.billing = billing;
    this.toolBackend = toolBackend;
    this.config = config;
    this.transportFactory = transportFactory;
    this.sessionId = randomUUID();
    this.ready = false;
    this.closed = false;
    this.vad = emptyVadState();
    this.audioStats = emptyAudioStats();
    this.captureSeq = 0;
    this.ttsActive = false;
    this.inputSuppressedUntil = 0;
    this.ttsOutputSuppressedUntil = 0;
    this.suppressedAudioChunks = 0;
    this.suppressedAudioBytes = 0;
    this.suppressedTtsChunks = 0;
    this.suppressedTtsBytes = 0;
    this.ttsSinks = new Set();
    this.controlSinks = new Set();
    this.toolDedupe = new Map();
  }

  async start() {
    const missing = missingRealtimeConfig(this.config);
    if (missing.length) {
      const error = new Error(`provider_config_missing:${missing.join(",")}`);
      error.code = "provider_config_missing";
      error.missing = missing;
      throw error;
    }
    this.call.status = "connecting";
    emit(this.call, "provider_connecting", { provider: "doubao", auth_mode: this.config.apiKey ? "x-api-key" : "app-id-access-key" });
    const ready = this.waitForReady();
    this.connect();
    try {
      await ready;
    } catch (error) {
      this.closed = true;
      this.ready = false;
      this.transport?.close?.();
      throw error;
    }
  }

  sendText(text) {
    if (!this.ready || !text.trim()) return;
    this.call.usage.input_chars += text.length;
    emit(this.call, "asr_final", { text, role: "user", provider: "doubao", input_mode: "text" });
    this.sendJson(EventId.ChatTextQuery, { content: text });
  }

  async sendAudio(bytes) {
    if (!this.ready || isTerminal(this.call)) return;
    const audio = Buffer.from(bytes);
    const level = this.trackAudioStats(audio);
    const now = Date.now();
    if (looksInvalidInput(level)) {
      this.suppressedAudioChunks += 1;
      this.suppressedAudioBytes += audio.length;
      if (this.suppressedAudioChunks === 1 || this.suppressedAudioChunks % 20 === 0) {
        emit(this.call, "provider_input_rejected", {
          reason: "invalid_saturated_audio",
          rms: round(level.rms),
          peak: round(level.peak),
          total_bytes: this.suppressedAudioBytes,
          chunks: this.suppressedAudioChunks,
        });
      }
      if (this.vad.inSpeech && now - this.vad.lastSpeechAt >= END_MS && now - this.vad.startedAt >= MIN_MS) {
        this.endAsr(now, { rms: 0, peak: 0 }, vadThresholds(this.vad), "invalid_audio_after_speech");
      }
      return;
    }
    if (now < this.inputSuppressedUntil) {
      this.suppressedAudioChunks += 1;
      this.suppressedAudioBytes += audio.length;
      if (this.suppressedAudioChunks === 1 || this.suppressedAudioChunks % 20 === 0) {
        emit(this.call, "provider_input_suppressed", {
          reason: "assistant_tts_playing",
          bytes: audio.length,
          total_bytes: this.suppressedAudioBytes,
          chunks: this.suppressedAudioChunks,
          remaining_ms: Math.max(0, this.inputSuppressedUntil - now),
        });
      }
      return;
    }
    const vad = this.vad;
    updateNoiseFloor(vad, level);
    const thresholds = vadThresholds(vad);
    const speech = level.rms >= thresholds.speechRms || level.peak >= thresholds.speechPeak;
    const quiet = level.rms <= thresholds.quietRms && level.peak <= thresholds.quietPeak;

    if (vad.awaitingResponse) {
      if (now - vad.endAsrAt > RESPONSE_WAIT_RESET_MS) {
        vad.awaitingResponse = false;
        vad.inSpeech = false;
        vad.preRoll = [];
        emit(this.call, "provider_vad_reset", { reason: "response_timeout" });
      } else if (level.rms >= Math.max(thresholds.speechRms * 1.35, 0.105) && now - vad.endAsrAt > 650) {
        vad.awaitingResponse = false;
        vad.inSpeech = false;
        vad.preRoll = [];
        vad.cooldownUntil = now;
        emit(this.call, "provider_vad_reset", { reason: "new_speech_during_response_wait", rms: round(level.rms), peak: round(level.peak) });
      } else {
        return;
      }
    }

    if (!vad.inSpeech && !speech) {
      vad.preRoll.push(audio);
      if (vad.preRoll.length > INPUT_PREROLL_CHUNKS) vad.preRoll.shift();
      return;
    }

    if (speech) {
      vad.lastSpeechAt = now;
      if (!vad.inSpeech && now >= vad.cooldownUntil) {
        vad.inSpeech = true;
        vad.startedAt = now;
        vad.captureChunks = [];
        emit(this.call, "provider_speech_start", {
          rms: round(level.rms),
          peak: round(level.peak),
          speech_rms: round(thresholds.speechRms),
          speech_peak: round(thresholds.speechPeak),
          noise_rms: round(vad.noiseRms),
          noise_peak: round(vad.noisePeak),
        });
        for (const chunk of vad.preRoll) this.sendAudioFrame(chunk);
        vad.preRoll = [];
      }
    }

    if (!vad.inSpeech) return;
    this.sendAudioFrame(audio);
    if (quiet && now - vad.lastSpeechAt >= END_MS && now - vad.startedAt >= MIN_MS) this.endAsr(now, level, thresholds);
  }

  end() {
    this.closed = true;
    try {
      if (this.ready) this.sendJson(EventId.FinishSession, {});
      if (this.transport?.readyState === WS_OPEN) this.transport.send(encodeJsonEvent({ event: EventId.FinishConnection, payload: {} }));
    } catch {
    }
    this.transport?.close?.();
    this.ready = false;
  }

  connect() {
    this.transport = this.transportFactory(this.config.baseUrl, {
      headers: providerHeaders(this.config, this.call.id),
      timeoutMs: this.config.connectTimeoutMs,
    });
    this.transport.on("open", () => {
      emit(this.call, "provider_open", { provider: "doubao" });
      this.transport.send(encodeJsonEvent({ event: EventId.StartConnection, payload: {}, compression: this.config.compression }));
    });
    this.transport.on("message", (data) => this.handleFrame(data));
    this.transport.on("error", (error) => this.providerError(error));
    this.transport.on("close", () => {
      if (!isTerminal(this.call) && this.call.status !== "error") emit(this.call, "provider_closed", { provider: "doubao" });
    });
  }

  waitForReady() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("provider_session_timeout"), { code: "provider_session_timeout" })), this.config.connectTimeoutMs);
      this.readyResolve = () => { clearTimeout(timer); resolve(); };
      this.readyReject = (error) => { clearTimeout(timer); reject(error); };
    });
  }

  handleFrame(data) {
    if (this.closed || isTerminal(this.call)) return;
    let frame;
    try {
      frame = decodeServerFrame(data);
    } catch (error) {
      return this.providerError(Object.assign(error, { code: "provider_decode_failed" }));
    }
    emit(this.call, "provider_event", { event: frame.event, event_name: frame.eventName, summary: summarizeFrame(frame) });
    if (frame.event === EventId.ConnectionStarted) return this.sendStartSession();
    if ([EventId.ConnectionFailed, EventId.SessionFailed, EventId.DialogCommonError].includes(frame.event)) {
      return this.providerError(Object.assign(new Error(frame.eventName), { code: frame.eventName, payload: frame.payload }));
    }
    if (frame.event === EventId.SessionStarted) return this.markReady();
    if (frame.event === EventId.ASRInfo) return this.handleAsrInfo();
    if (frame.event === EventId.ASRResponse) return this.handleAsr(extractText(frame.payload), isInterimAsr(frame.payload));
    if (frame.event === EventId.ChatResponse || frame.event === EventId.ChatEnded) return this.handleAssistantText(extractText(frame.payload));
    if (frame.event === EventId.TTSResponse && frame.rawPayload?.length) return this.handleTts(frame.rawPayload);
    if (frame.event === EventId.TTSEnded) return this.finishTts();
    if (frame.event === EventId.UsageResponse) return this.markUsage("provider_usage", { provider_usage: scrub(frame.payload) });
  }

  sendStartSession() {
    this.transport.send(encodeJsonEvent({
      event: EventId.StartSession,
      sessionId: this.sessionId,
      payload: startSessionPayload(this.call.context, this.config),
      compression: this.config.compression,
    }));
    emit(this.call, "provider_session_start_sent", { model: this.config.model, tts_format: this.config.ttsFormat });
  }

  markReady() {
    if (this.closed) return;
    this.ready = true;
    this.call.status = "listening";
    emit(this.call, "provider_session_started", { provider: "doubao", model: this.config.model, sample_rate: this.config.ttsSampleRate });
    this.readyResolve?.();
  }

  async handleAsr(text, interim = false) {
    if (this.closed) return;
    this.vad.awaitingResponse = false;
    if (!text) return;
    if (interim) {
      emit(this.call, "asr_partial", { text, role: "user", provider: "doubao" });
      return;
    }
    this.call.status = "thinking";
    this.call.usage.input_chars += text.length;
    emit(this.call, "asr_final", { text, role: "user", provider: "doubao" });
    const toolName = voiceToolIntent(text);
    if (toolName) {
      if (this.shouldSuppressTool(toolName)) {
        emit(this.call, "tool_call_suppressed", { name: toolName, reason: "duplicate_realtime_asr" });
        return;
      }
      await handleUserInput({ call: this.call, text, billing: this.billing, toolBackend: this.toolBackend, emitAsr: false, toolOnly: true, countInput: false });
    }
  }

  handleAsrInfo() {
    if (this.closed) return;
    this.vad.awaitingResponse = false;
    if (this.ttsActive || Date.now() < this.inputSuppressedUntil) this.beginBargeIn("provider_asr_info");
  }

  shouldSuppressTool(toolName) {
    const now = Date.now();
    const last = this.toolDedupe.get(toolName) || 0;
    this.toolDedupe.set(toolName, now);
    return now - last < 30000;
  }

  handleAssistantText(text) {
    if (this.closed) return;
    this.vad.awaitingResponse = false;
    if (!text) return;
    this.call.status = "speaking";
    this.call.usage.output_chars += text.length;
    emit(this.call, "assistant_text", { text, role: "assistant", provider: "doubao" });
    this.markUsage("usage_delta");
    this.call.status = "listening";
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
    this.beginBargeIn("client_barge_in", {
      rms: numberOrNull(message.rms ?? message.level?.rms),
      peak: numberOrNull(message.peak ?? message.level?.peak),
      source: message.source || "client",
      utterance_id: message.utterance_id || "",
    });
  }

  markClientSpeechEnd(message = {}) {
    if (!this.ready || this.closed || isTerminal(this.call)) return;
    const now = Date.now();
    const level = levelFromMessage(message);
    if (this.vad.inSpeech) {
      this.endAsr(now, level, vadThresholds(this.vad), "client_speech_end");
      return;
    }
    emit(this.call, "provider_vad_reset", {
      reason: "client_speech_end_without_active_speech",
      rms: round(level.rms),
      peak: round(level.peak),
    });
  }

  beginBargeIn(reason, detail = {}) {
    if (this.closed) return;
    const now = Date.now();
    this.ttsActive = false;
    this.inputSuppressedUntil = 0;
    this.ttsOutputSuppressedUntil = Math.max(this.ttsOutputSuppressedUntil, now + 12000);
    this.call.status = "listening";
    emit(this.call, reason === "client_barge_in" ? "client_barge_in" : "provider_barge_in", {
      reason,
      output_suppressed_ms: Math.max(0, this.ttsOutputSuppressedUntil - now),
      ...detail,
    });
    if (reason !== "client_barge_in") {
      this.sendControl({ type: "control", action: "barge_in", reason });
    }
  }

  handleTts(audio) {
    if (this.closed) return;
    const bytes = audio.length;
    if (Date.now() < this.ttsOutputSuppressedUntil) {
      this.suppressedTtsChunks += 1;
      this.suppressedTtsBytes += bytes;
      if (this.suppressedTtsChunks === 1 || this.suppressedTtsChunks % 20 === 0) {
        emit(this.call, "assistant_audio_suppressed", {
          reason: "barge_in",
          bytes,
          total_bytes: this.suppressedTtsBytes,
          chunks: this.suppressedTtsChunks,
          remaining_ms: Math.max(0, this.ttsOutputSuppressedUntil - Date.now()),
        });
      }
      return;
    }
    if (!this.ttsActive) {
      this.ttsActive = true;
      this.call.status = "speaking";
      emit(this.call, "assistant_audio_started", { codec: this.config.ttsFormat, sample_rate: this.config.ttsSampleRate, provider: "doubao" });
    }
    emit(this.call, "assistant_audio_chunk", { bytes, provider: "doubao" });
    this.extendInputSuppression(bytes);
    for (const sink of this.ttsSinks) {
      try {
        sink(Buffer.from(audio));
      } catch (error) {
        emit(this.call, "assistant_audio_sink_error", { message: String(error?.message || error) });
      }
    }
  }

  finishTts() {
    if (this.closed) return;
    if (Date.now() < this.ttsOutputSuppressedUntil) {
      this.ttsOutputSuppressedUntil = 0;
      this.ttsActive = false;
      this.call.status = "listening";
      emit(this.call, "assistant_audio_suppressed_end", {
        reason: "barge_in",
        chunks: this.suppressedTtsChunks,
        bytes: this.suppressedTtsBytes,
      });
      this.sendControl({ type: "control", action: "tts_ended", reason: "suppressed_end" });
      return;
    }
    this.ttsActive = false;
    this.inputSuppressedUntil = Date.now() + TTS_INPUT_SUPPRESSION_TAIL_MS;
    this.call.status = "listening";
    emit(this.call, "assistant_audio_ended", { provider: "doubao" });
    this.sendControl({ type: "control", action: "tts_ended", reason: "provider_tts_ended" });
    this.markUsage("usage_delta");
  }

  sendControl(message) {
    for (const sink of this.controlSinks) {
      try {
        sink(message);
      } catch (error) {
        emit(this.call, "voice_control_sink_error", { message: String(error?.message || error), action: message?.action || "" });
      }
    }
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

  endAsr(now, level, thresholds = {}, reason = "local_vad_silence") {
    this.sendJson(EventId.EndASR, {});
    emit(this.call, "provider_end_asr", {
      reason,
      ms_since_speech: now - this.vad.lastSpeechAt,
      rms: round(level.rms),
      peak: round(level.peak),
      quiet_rms: round(thresholds.quietRms || QUIET_RMS_FLOOR),
      quiet_peak: round(thresholds.quietPeak || QUIET_PEAK_FLOOR),
    });
    this.flushInputCapture(reason);
    this.vad = emptyVadState(now + 700);
    this.vad.awaitingResponse = true;
    this.vad.endAsrAt = now;
  }

  sendJson(event, payload) {
    this.transport.send(encodeJsonEvent({ event, sessionId: this.sessionId, payload, compression: this.config.compression }));
  }

  sendAudioFrame(audio) {
    if (this.vad.captureChunks) this.vad.captureChunks.push(Buffer.from(audio));
    this.transport.send(encodeAudioEvent({ event: EventId.TaskRequest, audio, sessionId: this.sessionId, compression: this.config.compression }));
  }

  trackAudioStats(audio) {
    const stats = this.audioStats;
    stats.chunks += 1;
    stats.bytes += audio.length;
    let peak = 0;
    let sumSq = 0;
    let samples = 0;
    for (let offset = 0; offset + 1 < audio.length; offset += 2) {
      const value = audio.readInt16LE(offset) / 32768;
      const abs = Math.abs(value);
      peak = Math.max(peak, abs);
      sumSq += value * value;
      samples += 1;
    }
    stats.samples += samples;
    stats.sumSq += sumSq;
    stats.peak = Math.max(stats.peak, peak);

    const now = Date.now();
    if (now - stats.lastLogAt >= 2000) {
      emit(this.call, "provider_audio_level", {
        chunks: stats.chunks,
        bytes: stats.bytes,
        samples: stats.samples,
        rms: stats.samples ? round(Math.sqrt(stats.sumSq / stats.samples)) : 0,
        peak: round(stats.peak),
        noise_rms: round(this.vad.noiseRms),
        noise_peak: round(this.vad.noisePeak),
      });
      this.audioStats = emptyAudioStats(now);
    }
    return { rms: samples ? Math.sqrt(sumSq / samples) : 0, peak };
  }

  flushInputCapture(reason) {
    const chunks = this.vad.captureChunks || [];
    if (!chunks.length) return;
    const pcm = Buffer.concat(chunks);
    const dir = path.resolve("spec/L4/evidence/spec-code-rebuild-v1/voice/input-captures");
    fs.mkdirSync(dir, { recursive: true });
    this.captureSeq += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `input-${stamp}-${this.call.id.slice(-8)}-${this.captureSeq}`;
    const pcmPath = path.join(dir, `${base}.pcm`);
    const wavPath = path.join(dir, `${base}.wav`);
    fs.writeFileSync(pcmPath, pcm);
    fs.writeFileSync(wavPath, makeWavPcm16(pcm, 16000, 1));
    emit(this.call, "provider_input_capture", {
      reason,
      bytes: pcm.length,
      pcm_path: path.relative(process.cwd(), pcmPath),
      wav_path: path.relative(process.cwd(), wavPath),
    });
  }

  providerError(error) {
    if (this.closed) return;
    const code = error?.code || "provider_error";
    this.closed = true;
    this.ready = false;
    emit(this.call, "provider_error", { provider: "doubao", error: code, message: String(error?.message || error) });
    this.call.status = "error";
    this.transport?.close?.();
    this.readyReject?.(Object.assign(new Error(code), { code, cause: error }));
  }

  markUsage(type, extra = {}) {
    updateBilling(this.call, this.billing);
    emit(this.call, type, { ...usageSnapshot(this.call, this.billing), ...extra });
  }
}

function startSessionPayload(context, config) {
  const summary = context.chat_summary || context.preview || context.title || "当前会话暂无摘要";
  return {
    asr: { extra: { end_smooth_window_ms: 800, enable_custom_vad: false, enable_asr_twopass: false, context: {} } },
    tts: { speaker: config.speaker, audio_config: { channel: 1, format: config.ttsFormat, sample_rate: config.ttsSampleRate }, extra: { speech_rate: 0, loudness_rate: 0 } },
    dialog: {
      bot_name: "Burn",
      system_role: [
        "你是 Burn 的实时语音助手，像电话里的人一样自然、简短地和用户对话。",
        "你只能围绕当前 Burn Chat 会话回答；需要写入或发送时，等待 Burn 工具结果，不要编造已操作。",
        `当前 Chat：project=${context.project || ""}; source=${context.source || context.agent || ""}; session=${context.chat_session_id || context.session_id || ""}; summary=${summary}`,
      ].join("\n"),
      speaking_style: "口语化、短句、自然停顿。不要朗读 JSON。",
      extra: { strict_audit: false, input_mod: "keep_alive", enable_music: false, model: config.model },
    },
  };
}

function makeWavPcm16(pcm, sampleRate, channels) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function emptyAudioStats(lastLogAt = Date.now()) {
  return {
    chunks: 0,
    bytes: 0,
    samples: 0,
    sumSq: 0,
    peak: 0,
    lastLogAt,
  };
}

function emptyVadState(cooldownUntil = 0) {
  return {
    inSpeech: false,
    startedAt: 0,
    lastSpeechAt: 0,
    endAsrAt: 0,
    awaitingResponse: false,
    preRoll: [],
    captureChunks: null,
    cooldownUntil,
    noiseRms: 0.003,
    noisePeak: 0.018,
  };
}

function updateNoiseFloor(vad, level) {
  if (vad.inSpeech || vad.awaitingResponse) return;
  const alpha = 0.08;
  vad.noiseRms = vad.noiseRms * (1 - alpha) + Math.min(level.rms, 0.02) * alpha;
  vad.noisePeak = vad.noisePeak * (1 - alpha) + Math.min(level.peak, 0.09) * alpha;
}

function vadThresholds(vad) {
  return {
    speechRms: Math.max(SPEECH_RMS_FLOOR, vad.noiseRms * 4.2),
    speechPeak: Math.max(SPEECH_PEAK_FLOOR, vad.noisePeak * 3.4),
    quietRms: Math.max(QUIET_RMS_FLOOR, vad.noiseRms * 1.9),
    quietPeak: Math.max(QUIET_PEAK_FLOOR, vad.noisePeak * 2.2),
  };
}

function looksInvalidInput(level) {
  return level.rms >= 0.65 && level.peak >= 0.999;
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

function extractText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(" ");
  if (typeof value !== "object") return "";
  for (const key of ["text", "content", "sentence", "utterance", "query", "answer", "message"]) {
    const text = extractText(value[key]);
    if (text) return text;
  }
  for (const key of ["results", "alternatives"]) {
    const text = extractText(value[key]);
    if (text) return text;
  }
  return "";
}

function isInterimAsr(value) {
  if (!value || typeof value !== "object") return false;
  if (value.is_interim === true) return true;
  if (value.isInterim === true) return true;
  for (const key of ["results", "alternatives"]) {
    const arr = value[key];
    if (Array.isArray(arr) && arr.some(isInterimAsr)) return true;
  }
  return false;
}

function summarizeFrame(frame) {
  if (frame.rawPayload?.length && frame.event === EventId.TTSResponse) return { audio_bytes: frame.rawPayload.length };
  return scrub(frame.payload);
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, /token|secret|key/i.test(key) ? "<redacted>" : scrub(val)]));
}

function round(value) {
  return Number(value.toFixed(6));
}
