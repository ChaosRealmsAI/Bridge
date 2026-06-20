import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptWebSocket({ request, socket, head = Buffer.alloc(0) }) {
  const key = request.headers["sec-websocket-key"];
  if (!key) throw new Error("websocket_missing_key");
  const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n"));
  const ws = new ServerWebSocket(socket);
  if (head.length) ws.onData(head);
  return ws;
}

export function rejectWebSocket(socket, status, message) {
  const body = `${message}\n`;
  socket.write([
    `HTTP/1.1 ${status} ${message}`,
    "Connection: close",
    "content-type: text/plain; charset=utf-8",
    `content-length: ${Buffer.byteLength(body)}`,
    "\r\n",
    body,
  ].join("\r\n"));
  socket.destroy();
}

class ServerWebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    socket.on("data", (data) => this.onData(data));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", () => {
      this.closed = true;
      this.emit("close");
    });
  }

  sendJson(payload) {
    this.sendText(JSON.stringify(payload));
  }

  sendText(text) {
    this.sendFrame(0x1, Buffer.from(String(text), "utf8"));
  }

  sendBinary(bytes) {
    this.sendFrame(0x2, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sendFrame(0x8, Buffer.alloc(0));
    } catch {
      // Closing is best-effort.
    }
    this.socket.end();
  }

  sendFrame(opcode, payload) {
    if (this.closed) return;
    this.socket.write(encodeServerFrame(opcode, payload));
  }

  onData(data) {
    try {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.readFrames();
    } catch (error) {
      this.emit("error", error);
      this.close();
    }
  }

  readFrames() {
    while (this.buffer.length >= 2) {
      const parsed = parseFrame(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.total);
      if (parsed.opcode === 0x8) {
        this.close();
        return;
      }
      if (parsed.opcode === 0x9) {
        this.sendFrame(0xA, parsed.payload);
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
  if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { fin: Boolean(first & 0x80), opcode: first & 0x0f, payload, total: offset + length };
}

function encodeServerFrame(opcode, payload) {
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length <= 0xffff ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) {
    header[1] = length;
  } else if (length <= 0xffff) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}
