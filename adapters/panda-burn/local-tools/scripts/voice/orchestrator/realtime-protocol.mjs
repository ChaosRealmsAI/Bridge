import { gunzipSync, gzipSync } from "node:zlib";

export const EventId = {
  StartConnection: 1,
  FinishConnection: 2,
  StartSession: 100,
  FinishSession: 102,
  TaskRequest: 200,
  EndASR: 400,
  ChatTextQuery: 501,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  SessionStarted: 150,
  SessionFailed: 153,
  UsageResponse: 154,
  TTSResponse: 352,
  TTSEnded: 359,
  ASRInfo: 450,
  ASRResponse: 451,
  ChatResponse: 550,
  ChatEnded: 559,
  DialogCommonError: 599,
};

export const EventNameById = Object.fromEntries(Object.entries(EventId).map(([name, id]) => [id, name]));

const VERSION = 0x1;
const HEADER_WORDS = 0x1;
const CLIENT_FULL_REQUEST = 0x1;
const CLIENT_AUDIO_ONLY_REQUEST = 0x2;
const SERVER_FULL_RESPONSE = 0x9;
const SERVER_AUDIO_ONLY_RESPONSE = 0xb;
const SERVER_ERROR_RESPONSE = 0xf;
const FLAG_WITH_EVENT = 0x4;
const SERIAL_NONE = 0x0;
const SERIAL_JSON = 0x1;
const COMP_NONE = 0x0;
const COMP_GZIP = 0x1;

export function encodeJsonEvent({ event, payload = {}, sessionId, compression = "none" }) {
  return encodeFrame({
    messageType: CLIENT_FULL_REQUEST,
    serialization: SERIAL_JSON,
    compression: compression === "gzip" ? COMP_GZIP : COMP_NONE,
    event,
    sessionId,
    payload: packJson(payload, compression),
  });
}

export function encodeAudioEvent({ event = EventId.TaskRequest, audio, sessionId, compression = "none" }) {
  const body = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
  return encodeFrame({
    messageType: CLIENT_AUDIO_ONLY_REQUEST,
    serialization: SERIAL_NONE,
    compression: compression === "gzip" ? COMP_GZIP : COMP_NONE,
    event,
    sessionId,
    payload: compression === "gzip" ? gzipSync(body) : body,
  });
}

export function encodeServerJsonEvent({ event, payload = {}, sessionId, compression = "none" }) {
  return encodeFrame({
    messageType: SERVER_FULL_RESPONSE,
    serialization: SERIAL_JSON,
    compression: compression === "gzip" ? COMP_GZIP : COMP_NONE,
    event,
    sessionId,
    payload: packJson(payload, compression),
  });
}

export function encodeServerAudioEvent({ event = EventId.TTSResponse, audio, sessionId }) {
  return encodeFrame({
    messageType: SERVER_AUDIO_ONLY_RESPONSE,
    serialization: SERIAL_NONE,
    compression: COMP_NONE,
    event,
    sessionId,
    payload: Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []),
  });
}

export function decodeServerFrame(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.length < 4) throw new Error("realtime_frame_too_short");
  const version = bytes[0] >> 4;
  const headerSize = (bytes[0] & 0x0f) * 4;
  const messageType = bytes[1] >> 4;
  const flags = bytes[1] & 0x0f;
  const serialization = bytes[2] >> 4;
  const compression = bytes[2] & 0x0f;
  let offset = headerSize;
  if (version !== VERSION || headerSize < 4 || headerSize > bytes.length) throw new Error("realtime_bad_header");

  if (messageType === SERVER_ERROR_RESPONSE) {
    const code = readU32(bytes, offset);
    offset += 4;
    const length = readU32(bytes, offset);
    offset += 4;
    const payload = decodePayload(bytes.subarray(offset, offset + length), serialization, compression);
    return { messageType, event: null, eventName: "ServerError", code, payload: payload.value, rawPayload: payload.raw };
  }

  let event = null;
  if (flags & FLAG_WITH_EVENT) {
    event = readU32(bytes, offset);
    offset += 4;
  }

  let sessionId = null;
  if (offset + 4 <= bytes.length && hasSessionId(bytes, offset)) {
    const length = readU32(bytes, offset);
    offset += 4;
    sessionId = bytes.subarray(offset, offset + length).toString("utf8");
    offset += length;
  }

  const length = offset + 4 <= bytes.length ? readU32(bytes, offset) : 0;
  offset += offset + 4 <= bytes.length ? 4 : 0;
  const payload = decodePayload(bytes.subarray(offset, offset + length), serialization, compression);
  return {
    messageType,
    isAudio: messageType === SERVER_AUDIO_ONLY_RESPONSE,
    event,
    eventName: EventNameById[event] || `Event${event ?? "Unknown"}`,
    sessionId,
    payload: payload.value,
    rawPayload: payload.raw,
  };
}

function encodeFrame({ messageType, serialization, compression, event, sessionId, payload }) {
  const session = sessionId ? Buffer.from(sessionId, "utf8") : null;
  const parts = [Buffer.from([(VERSION << 4) | HEADER_WORDS, (messageType << 4) | FLAG_WITH_EVENT, (serialization << 4) | compression, 0]), u32(event)];
  if (session) parts.push(u32(session.length), session);
  parts.push(u32(payload.length), payload);
  return Buffer.concat(parts);
}

function packJson(payload, compression) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return compression === "gzip" ? gzipSync(body) : body;
}

function decodePayload(rawPayload, serialization, compression) {
  const raw = compression === COMP_GZIP ? gunzipSync(rawPayload) : rawPayload;
  if (serialization === SERIAL_JSON && raw.length > 0) return { raw, value: JSON.parse(raw.toString("utf8")) };
  return { raw, value: null };
}

function hasSessionId(bytes, offset) {
  const length = readU32(bytes, offset);
  return length > 0 && length <= 256 && offset + 4 + length + 4 <= bytes.length;
}

function readU32(bytes, offset) {
  if (offset + 4 > bytes.length) return 0;
  return bytes.readUInt32BE(offset);
}

function u32(value) {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32BE(value);
  return out;
}
