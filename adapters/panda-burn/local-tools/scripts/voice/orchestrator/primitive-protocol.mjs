import { gunzipSync, gzipSync } from "node:zlib";

const VERSION = 0x1;
const HEADER_WORDS = 0x1;
const CLIENT_FULL_REQUEST = 0x1;
const CLIENT_AUDIO_ONLY_REQUEST = 0x2;
const SERVER_FULL_RESPONSE = 0x9;
const SERVER_AUDIO_ONLY_RESPONSE = 0xb;
const SERVER_ERROR_RESPONSE = 0xf;
const FLAG_EVENT = 0x4;
const SERIAL_NONE = 0x0;
const SERIAL_JSON = 0x1;
const COMP_NONE = 0x0;
const COMP_GZIP = 0x1;

export function encodeTtsEventFrame({ event, payload = {}, sessionId }) {
  return encodeEventFrame({
    messageType: CLIENT_FULL_REQUEST,
    serialization: SERIAL_JSON,
    compression: COMP_NONE,
    event,
    sessionId,
    payload: Buffer.from(JSON.stringify(payload), "utf8"),
  });
}

export function encodeTtsServerEvent({ event, payload = {}, sessionId = "fake-session", audio }) {
  const isAudio = Buffer.isBuffer(audio);
  return encodeEventFrame({
    messageType: isAudio ? SERVER_AUDIO_ONLY_RESPONSE : SERVER_FULL_RESPONSE,
    serialization: isAudio ? SERIAL_NONE : SERIAL_JSON,
    compression: COMP_NONE,
    event,
    sessionId,
    payload: isAudio ? audio : Buffer.from(JSON.stringify(payload), "utf8"),
  });
}

export function decodeTtsEventFrame(data) {
  const bytes = Buffer.from(data);
  const messageType = bytes[1] >> 4;
  const flags = bytes[1] & 0x0f;
  const serialization = bytes[2] >> 4;
  const compression = bytes[2] & 0x0f;
  let offset = (bytes[0] & 0x0f) * 4;
  if (messageType === SERVER_ERROR_RESPONSE) {
    const code = readU32(bytes, offset);
    offset += 4;
    const length = readU32(bytes, offset);
    offset += 4;
    const rawPayload = bytes.subarray(offset, offset + length);
    return { messageType, event: null, code, payload: decodePayload(rawPayload, serialization, compression), rawPayload };
  }
  let event = null;
  if (flags & FLAG_EVENT) {
    event = readU32(bytes, offset);
    offset += 4;
  }
  let sessionId = "";
  if (offset + 4 <= bytes.length && hasSessionId(bytes, offset)) {
    const length = readU32(bytes, offset);
    offset += 4;
    sessionId = bytes.subarray(offset, offset + length).toString("utf8");
    offset += length;
  }
  const length = offset + 4 <= bytes.length ? readU32(bytes, offset) : 0;
  offset += offset + 4 <= bytes.length ? 4 : 0;
  const rawPayload = bytes.subarray(offset, offset + length);
  return {
    messageType,
    isAudio: messageType === SERVER_AUDIO_ONLY_RESPONSE,
    event,
    sessionId,
    payload: decodePayload(rawPayload, serialization, compression),
    rawPayload,
  };
}

export function encodeAsrFullRequest(sequence, payload) {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const seq = Buffer.allocUnsafe(4);
  seq.writeInt32BE(sequence);
  return Buffer.concat([Buffer.from([0x11, 0x11, 0x11, 0x00]), seq, u32(body.length), body]);
}

export function encodeAsrAudioOnly(audio, { sequence, last = false }) {
  const body = gzipSync(Buffer.from(audio));
  const seq = Buffer.allocUnsafe(4);
  seq.writeInt32BE(last ? -Math.abs(sequence) : Math.abs(sequence));
  return Buffer.concat([Buffer.from([0x11, last ? 0x23 : 0x21, 0x01, 0x00]), seq, u32(body.length), body]);
}

export function encodeAsrServerResponse({ sequence = 1, final = false, payload = {} }) {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const seq = Buffer.allocUnsafe(4);
  seq.writeInt32BE(sequence);
  return Buffer.concat([Buffer.from([0x11, final ? 0x93 : 0x91, 0x11, 0x00]), seq, u32(body.length), body]);
}

export function decodeAsrFrame(data) {
  const bytes = Buffer.from(data);
  const messageType = bytes[1] >> 4;
  const flags = bytes[1] & 0x0f;
  const serialization = bytes[2] >> 4;
  const compression = bytes[2] & 0x0f;
  let offset = (bytes[0] & 0x0f) * 4;
  if (messageType === SERVER_ERROR_RESPONSE) {
    const code = readU32(bytes, offset);
    offset += 4;
    const length = readU32(bytes, offset);
    offset += 4;
    const raw = bytes.subarray(offset, offset + length);
    return { messageType, flags, final: true, error: { code, payload: decodePayload(raw, serialization, compression) } };
  }
  let sequence = null;
  if (flags === 1 || flags === 3) {
    sequence = bytes.readInt32BE(offset);
    offset += 4;
  }
  const length = readU32(bytes, offset);
  offset += 4;
  const raw = bytes.subarray(offset, offset + length);
  return {
    messageType,
    flags,
    sequence,
    final: flags === 2 || flags === 3 || (typeof sequence === "number" && sequence < 0),
    payload: decodePayload(raw, serialization, compression),
  };
}

export function extractAsrText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const result = payload.result;
  if (typeof result?.text === "string") return result.text;
  if (Array.isArray(result)) return result.map((item) => item?.text || "").filter(Boolean).join("");
  return "";
}

export function publicTtsEvent(frame) {
  return {
    message_type: frame.messageType,
    event: frame.event,
    session: Boolean(frame.sessionId),
    audio_bytes: frame.isAudio ? frame.rawPayload.length : 0,
    payload_keys: frame.payload && typeof frame.payload === "object" && !Buffer.isBuffer(frame.payload) ? Object.keys(frame.payload).slice(0, 12) : [],
  };
}

export function publicAsrFrame(frame) {
  return {
    message_type: frame.messageType,
    flags: frame.flags,
    sequence: frame.sequence,
    final: frame.final,
    text: extractAsrText(frame.payload),
    error: frame.error ? { code: frame.error.code, payload: frame.error.payload } : undefined,
  };
}

function encodeEventFrame({ messageType, serialization, compression, event, sessionId, payload }) {
  const session = sessionId ? Buffer.from(sessionId, "utf8") : null;
  const parts = [Buffer.from([(VERSION << 4) | HEADER_WORDS, (messageType << 4) | FLAG_EVENT, (serialization << 4) | compression, 0]), u32(event)];
  if (session) parts.push(u32(session.length), session);
  parts.push(u32(payload.length), payload);
  return Buffer.concat(parts);
}

function decodePayload(raw, serialization, compression) {
  const body = compression === COMP_GZIP ? gunzipSync(raw) : raw;
  if (serialization === SERIAL_JSON && body.length) {
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      return body.toString("utf8");
    }
  }
  return body;
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
  out.writeUInt32BE(value >>> 0);
  return out;
}
