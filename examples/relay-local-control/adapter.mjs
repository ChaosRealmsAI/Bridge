import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readdir, realpath, stat } from "node:fs/promises";
import { cwd } from "node:process";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function startRelayLocalControlAdapter(options = {}) {
  const keyBytes = options.keyBytes || await randomKeyBytes();
  const root = await realpath(options.root || cwd());
  const host = options.host || "127.0.0.1";
  const port = Number(options.port || 0);
  const calls = [];
  const executions = [];
  const responseCache = new Map();

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || new URL(request.url, "http://local.test").pathname !== "/v1/relay-envelope") {
        return writeJson(response, 404, { ok: false, error: "not_found" });
      }
      const envelope = await readJson(request);
      const replayKey = envelopeReplayKey(envelope);
      const cached = responseCache.get(replayKey);
      if (cached) {
        calls.push({ envelope_id: envelope.id || null, op: cached.op, ok: cached.ok, replay: true });
        return writeJson(response, 200, { ok: true, response_envelope: cached.response_envelope, replay: true });
      }
      const command = await decryptEnvelope(envelope, keyBytes);
      const result = await runAllowedCommand(command, root);
      const responseEnvelope = await encryptResponseEnvelope(envelope, result, keyBytes);
      const item = {
        op: command.op,
        ok: result.ok === true,
        response_envelope: responseEnvelope,
      };
      responseCache.set(replayKey, item);
      calls.push({ envelope_id: envelope.id || null, op: command.op, ok: result.ok === true, replay: false });
      executions.push({ envelope_id: envelope.id || null, op: command.op, ok: result.ok === true });
      writeJson(response, 200, { ok: true, response_envelope: responseEnvelope });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: "adapter_denied", reason: String(error?.message || error) });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  return {
    keyBytes,
    root,
    calls,
    executions,
    url: `http://${address.address}:${address.port}/v1/relay-envelope`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function encryptCommandEnvelope(input, keyBytes, fields = {}) {
  const payload = textEncoder.encode(JSON.stringify(input));
  const aadText = stableAad({
    product_id: fields.product_id || "bridge-demo",
    device_id: fields.device_id || "",
    channel_id: fields.channel_id || "relay-local-control",
    direction: "product_to_device",
    seq: Number(fields.seq || 1),
  });
  const aad = textEncoder.encode(aadText);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyBytes);
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: aad,
  }, key, payload));
  return {
    product_id: fields.product_id || "bridge-demo",
    device_id: fields.device_id || "",
    channel_id: fields.channel_id || "relay-local-control",
    direction: "product_to_device",
    seq: Number(fields.seq || 1),
    request_key: fields.request_key || null,
    ciphertext: b64(ciphertext),
    aad: b64(aad),
    nonce: b64(nonce),
    algorithm: "AES-GCM-256",
    sender_key_id: "relay-local-control-product",
    recipient_key_id: "relay-local-control-adapter",
    ttl_ms: 300000,
    meta: {
      adapter_id: "relay-local-control",
      trace_id: fields.trace_id || `trace-${Date.now()}`,
    },
  };
}

export async function decryptResponseEnvelope(envelope, keyBytes) {
  return decryptEnvelope(envelope, keyBytes);
}

async function decryptEnvelope(envelope, keyBytes) {
  const key = await aesKey(keyBytes);
  const opened = await globalThis.crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: unb64(envelope.nonce),
    additionalData: unb64(envelope.aad),
  }, key, unb64(envelope.ciphertext));
  return JSON.parse(textDecoder.decode(opened));
}

async function encryptResponseEnvelope(requestEnvelope, payload, keyBytes) {
  const seq = Number(requestEnvelope.seq || 0) + 1;
  const aadText = stableAad({
    product_id: requestEnvelope.product_id,
    device_id: requestEnvelope.device_id,
    channel_id: requestEnvelope.channel_id,
    direction: "device_to_product",
    seq,
  });
  const aad = textEncoder.encode(aadText);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyBytes);
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: aad,
  }, key, textEncoder.encode(JSON.stringify(payload))));
  return {
    product_id: requestEnvelope.product_id,
    device_id: requestEnvelope.device_id,
    channel_id: requestEnvelope.channel_id,
    direction: "device_to_product",
    seq,
    request_key: `${requestEnvelope.request_key || requestEnvelope.id || "relay-local-control"}:response`,
    ciphertext: b64(ciphertext),
    aad: b64(aad),
    nonce: b64(nonce),
    algorithm: "AES-GCM-256",
    sender_key_id: requestEnvelope.recipient_key_id || "relay-local-control-adapter",
    recipient_key_id: requestEnvelope.sender_key_id || "relay-local-control-product",
    ttl_ms: 300000,
    meta: {
      adapter_id: "relay-local-control",
      trace_id: requestEnvelope.meta?.trace_id || `trace-${Date.now()}`,
    },
  };
}

async function runAllowedCommand(command, root) {
  if (!command || typeof command !== "object") throw new Error("invalid_command");
  if (command.op === "pwd") {
    const stdout = await exec("pwd", [], { cwd: root });
    return { ok: true, op: "pwd", stdout: stdout.trim() };
  }
  if (command.op === "ls") {
    if (command.path && command.path !== ".") throw new Error("path_denied");
    const stdout = await exec("ls", ["-1", "."], { cwd: root });
    const entries = await Promise.all((await readdir(root)).slice(0, 50).map(async (name) => ({
      name,
      type: (await stat(`${root}/${name}`)).isDirectory() ? "dir" : "file",
    })));
    return { ok: true, op: "ls", path: ".", stdout, entries };
  }
  throw new Error("command_not_allowed");
}

function exec(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message));
      resolve(stdout);
    });
  });
}

async function randomKeyBytes() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

async function aesKey(keyBytes) {
  return globalThis.crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function stableAad(fields) {
  return [
    `product:${fields.product_id}`,
    `device:${fields.device_id}`,
    `channel:${fields.channel_id}`,
    `direction:${fields.direction}`,
    `seq:${fields.seq}`,
  ].join("|");
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function envelopeReplayKey(envelope) {
  return String(envelope?.id || envelope?.request_key || "");
}

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function unb64(value) {
  return Buffer.from(String(value || ""), "base64");
}
