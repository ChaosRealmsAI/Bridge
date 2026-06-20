import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

export const WS_OPEN = 1;
export const WS_CLOSED = 3;

export function createHeaderWebSocket(url, options = {}) {
  const socket = new HeaderWebSocket(url, options);
  socket.connect();
  return socket;
}

class HeaderWebSocket extends EventEmitter {
  constructor(url, options = {}) {
    super();
    this.url = new URL(url);
    this.headers = options.headers || {};
    this.timeoutMs = Number(options.timeoutMs || 12000);
    this.readyState = 0;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.handshakeTimer = null;
  }

  connect() {
    const port = Number(this.url.port || (this.url.protocol === "wss:" ? 443 : 80));
    const host = this.url.hostname;
    const raw = this.url.protocol === "wss:"
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    this.socket = raw;
    this.handshakeTimer = setTimeout(() => this.fail(new Error("websocket_timeout")), this.timeoutMs);
    raw.once("connect", () => raw.write(this.handshake()));
    raw.on("data", (data) => this.onData(data));
    raw.on("error", (error) => this.fail(error));
    raw.on("close", () => {
      this.readyState = WS_CLOSED;
      this.emit("close");
    });
  }

  send(data) {
    if (this.readyState !== WS_OPEN) throw new Error("websocket_not_open");
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    this.socket.write(encodeFrame(Buffer.isBuffer(data) ? 0x2 : 0x1, payload));
  }

  close() {
    if (!this.socket || this.readyState === WS_CLOSED) return;
    try {
      if (this.readyState === WS_OPEN) this.socket.write(encodeFrame(0x8, Buffer.alloc(0)));
    } catch {
      // Closing is best-effort.
    }
    clearTimeout(this.handshakeTimer);
    this.socket.end();
  }

  handshake() {
    this.key = randomBytes(16).toString("base64");
    const path = `${this.url.pathname || "/"}${this.url.search || ""}`;
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${this.url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${this.key}`,
      "Sec-WebSocket-Version: 13",
    ];
    for (const [key, value] of Object.entries(this.headers)) lines.push(`${key}: ${value}`);
    return `${lines.join("\r\n")}\r\n\r\n`;
  }

  onData(data) {
    try {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.readyState !== WS_OPEN) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = this.buffer.subarray(0, headerEnd).toString("utf8");
        this.buffer = this.buffer.subarray(headerEnd + 4);
        this.verifyHandshake(header);
        this.readyState = WS_OPEN;
        clearTimeout(this.handshakeTimer);
        this.emit("open");
      }
      this.readFrames();
    } catch (error) {
      this.fail(error);
    }
  }

  verifyHandshake(header) {
    if (!/^HTTP\/1\.1 101\b/m.test(header)) throw new Error(`websocket_upgrade_failed:${header.split(/\r?\n/)[0] || "no_status"}`);
    this.responseHeaders = parseHeaders(header);
    const accept = header.match(/^sec-websocket-accept:\s*(.+)$/im)?.[1]?.trim();
    const expected = createHash("sha1").update(`${this.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    if (!accept) throw new Error("websocket_missing_accept");
    if (accept && accept !== expected) throw new Error("websocket_bad_accept");
  }

  readFrames() {
    while (this.buffer.length >= 2) {
      const parsed = parseFrame(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.total);
      if (parsed.opcode === 0x8) return this.close();
      if (parsed.opcode === 0x9) {
        this.socket.write(encodeFrame(0xA, parsed.payload));
        continue;
      }
      if (parsed.opcode === 0x0) {
        this.fragments.push(parsed.payload);
        if (parsed.fin) this.emitMessage(Buffer.concat(this.fragments), this.fragmentOpcode);
        continue;
      }
      if (!parsed.fin) {
        this.fragmentOpcode = parsed.opcode;
        this.fragments = [parsed.payload];
        continue;
      }
      this.emitMessage(parsed.payload, parsed.opcode);
    }
  }

  emitMessage(payload, opcode) {
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.emit("message", opcode === 0x1 ? payload.toString("utf8") : payload);
  }

  fail(error) {
    clearTimeout(this.handshakeTimer);
    if (this.readyState !== WS_CLOSED) this.emit("error", error);
    this.readyState = WS_CLOSED;
    this.socket?.destroy();
  }
}

function parseFrame(buffer) {
  const first = buffer[0];
  const second = buffer[1];
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("websocket_frame_too_large");
    length = Number(big);
    offset = 10;
  }
  const masked = Boolean(second & 0x80);
  const maskOffset = masked ? 4 : 0;
  if (buffer.length < offset + maskOffset + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += maskOffset;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { fin: Boolean(first & 0x80), opcode: first & 0x0f, payload, total: offset + length };
}

function encodeFrame(opcode, payload) {
  const mask = randomBytes(4);
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length <= 0xffff ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) {
    header[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i += 1) out[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, out]);
}

function parseHeaders(header) {
  const out = {};
  for (const line of header.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    out[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return out;
}
