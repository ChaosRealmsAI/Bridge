import { randomUUID } from "node:crypto";

import {
  decodeAsrFrame,
  decodeTtsEventFrame,
  encodeAsrAudioOnly,
  encodeAsrFullRequest,
  encodeTtsEventFrame,
  extractAsrText,
  publicAsrFrame,
  publicTtsEvent,
} from "./primitive-protocol.mjs";
import { primitiveProviderHeaders } from "./voice-config.mjs";
import { createHeaderWebSocket, WS_OPEN } from "./websocket-client.mjs";

export async function transcribePrimitivePcm({ config, pcm, transportFactory = createHeaderWebSocket, onEvent = () => {} }) {
  const requestId = randomUUID();
  const ws = transportFactory(config.asrUrl, {
    headers: primitiveProviderHeaders(config, "asr", requestId),
    timeoutMs: config.connectTimeoutMs,
  });
  await waitOpen(ws, config.connectTimeoutMs);
  const logid = providerLogid(ws);
  onEvent({ type: "connected", request_id: requestId, connect_id: requestId, logid, audio_bytes: pcm.length });
  const inbox = makeWsInbox(ws);
  ws.send(encodeAsrFullRequest(1, asrRequest(config, requestId)));
  let sequence = 2;
  for (let offset = 0; offset < pcm.length; offset += 6400) {
    const chunk = pcm.subarray(offset, Math.min(offset + 6400, pcm.length));
    ws.send(encodeAsrAudioOnly(chunk, { sequence, last: offset + 6400 >= pcm.length }));
    sequence += 1;
  }
  const result = await collectAsr({ inbox, timeoutMs: config.connectTimeoutMs * 3, onEvent });
  ws.close?.();
  return { ...result, request_id: requestId, connect_id: requestId, logid, audio_bytes: pcm.length };
}

export async function synthesizePrimitiveText({ config, text, transportFactory = createHeaderWebSocket, onEvent = () => {}, onAudio = () => {} }) {
  const connectId = randomUUID();
  const sessionId = randomUUID();
  const ws = transportFactory(config.ttsUrl, {
    headers: primitiveProviderHeaders(config, "tts", connectId),
    timeoutMs: config.connectTimeoutMs,
  });
  await waitOpen(ws, config.connectTimeoutMs);
  const logid = providerLogid(ws);
  const inbox = makeWsInbox(ws);
  onEvent({ type: "connected", connect_id: connectId, session_id: sessionId, logid, text_chars: text.length });
  const events = [];
  ws.send(encodeTtsEventFrame({ event: 1, payload: {} }));
  await waitForTtsEvent(inbox, events, 50, config.connectTimeoutMs, onEvent);
  ws.send(encodeTtsEventFrame({ event: 100, sessionId, payload: { event: 100, req_params: ttsParams(config) } }));
  await waitForTtsEvent(inbox, events, 150, config.connectTimeoutMs, onEvent);
  ws.send(encodeTtsEventFrame({ event: 200, sessionId, payload: { event: 200, req_params: { ...ttsParams(config), text } } }));
  ws.send(encodeTtsEventFrame({ event: 102, sessionId, payload: { event: 102 } }));
  const usage = await collectTts(inbox, events, (audio) => onAudio(audio, { logid, connect_id: connectId }), config.connectTimeoutMs * 3, onEvent);
  ws.close?.();
  return { connect_id: connectId, session_id: sessionId, logid, events, usage };
}

async function collectAsr({ inbox, timeoutMs, onEvent }) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  let sawFrame = false;
  while (Date.now() < deadline) {
    let data;
    try {
      data = await inbox.next(Math.max(250, deadline - Date.now()));
    } catch (error) {
      if (isWebSocketClosed(error) && sawFrame && !text) return { text: "", no_speech: true, reason: "websocket_closed_without_text" };
      throw error;
    }
    const frame = decodeAsrFrame(data);
    sawFrame = true;
    onEvent({ type: "frame", frame: publicAsrFrame(frame), text: extractAsrText(frame.payload), final: frame.final });
    if (frame.error) throw Object.assign(new Error("asr_provider_error"), { code: "asr_provider_error", payload: frame.error });
    const nextText = extractAsrText(frame.payload);
    if (nextText) text = nextText;
    if (frame.final) {
      if (text) return { text };
      return { text: "", no_speech: true, reason: "final_without_text" };
    }
  }
  throw Object.assign(new Error("asr_result_timeout"), { code: "asr_result_timeout" });
}

async function waitForTtsEvent(inbox, events, event, timeoutMs, onEvent) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = decodeTtsEventFrame(await inbox.next(Math.max(250, deadline - Date.now())));
    const publicFrame = publicTtsEvent(frame);
    events.push(publicFrame);
    onEvent({ type: "event", frame: publicFrame });
    emitIfError(frame, "tts_provider_error");
    if (frame.event === event) return frame;
  }
  throw Object.assign(new Error(`tts_event_timeout:${event}`), { code: "tts_event_timeout" });
}

async function collectTts(inbox, events, onAudio, timeoutMs, onEvent) {
  const deadline = Date.now() + timeoutMs;
  let usage = null;
  while (Date.now() < deadline) {
    const frame = decodeTtsEventFrame(await inbox.next(Math.max(250, deadline - Date.now())));
    const publicFrame = publicTtsEvent(frame);
    events.push(publicFrame);
    onEvent({ type: "event", frame: publicFrame });
    emitIfError(frame, "tts_provider_error");
    if (frame.isAudio && frame.event === 352 && frame.rawPayload.length) onAudio(frame.rawPayload);
    if (frame.event === 152) {
      usage = frame.payload?.usage || frame.payload || null;
      break;
    }
  }
  return usage;
}

function asrRequest(config, requestId) {
  return {
    user: { uid: `burn-${requestId.slice(0, 8)}` },
    audio: { format: "pcm", codec: "raw", rate: config.asrSampleRate, bits: 16, channel: 1, language: "zh-CN" },
    request: { model_name: "bigmodel", enable_nonstream: true, enable_itn: true, enable_punc: true, result_type: "full", show_utterances: true, end_window_size: 800 },
  };
}

function ttsParams(config) {
  return { speaker: config.speaker, audio_params: { format: config.ttsFormat, sample_rate: config.ttsSampleRate } };
}

function makeWsInbox(ws) {
  const messages = [];
  const waiters = [];
  let closed = false;
  ws.on("message", (data) => { messages.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); settle(); });
  ws.on("close", () => { closed = true; settle(); });
  ws.on("error", (error) => { messages.push(error); settle(); });
  function settle() {
    while (waiters.length && (messages.length || closed)) {
      const waiter = waiters.shift();
      const next = messages.shift();
      if (next instanceof Error) waiter.reject(next);
      else if (next) waiter.resolve(next);
      else waiter.reject(Object.assign(new Error("websocket_closed"), { code: "websocket_closed" }));
    }
  }
  return { next: (timeoutMs) => waitMessage(messages, waiters, () => closed, timeoutMs) };
}

function waitMessage(messages, waiters, isClosed, timeoutMs) {
  if (messages.length) return Promise.resolve(messages.shift());
  if (isClosed()) return Promise.reject(Object.assign(new Error("websocket_closed"), { code: "websocket_closed" }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("websocket_message_timeout"), { code: "websocket_message_timeout" })), timeoutMs);
    waiters.push({ resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  });
}

function waitOpen(ws, timeoutMs) {
  if (ws.readyState === WS_OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("websocket_open_timeout"), { code: "websocket_open_timeout" })), timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
    ws.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function providerLogid(ws) {
  return ws.responseHeaders?.["x-tt-logid"] || ws.responseHeaders?.["x-tt-log-id"] || "";
}

function emitIfError(frame, code) {
  if (frame.messageType === 15) throw Object.assign(new Error(code), { code, payload: frame.payload });
}

function isWebSocketClosed(error) {
  return error?.code === "websocket_closed" || error?.message === "websocket_closed";
}
