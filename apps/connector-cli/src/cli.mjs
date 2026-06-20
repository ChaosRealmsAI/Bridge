#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, resolve } from "node:path";

const VERSION = "bridge-connector-relay-v0.8";
const DEFAULT_API = (process.env.BRIDGE_API_BASE || "https://api.bridge.chaos-realms.cc").replace(/\/$/, "");
const DEFAULT_STATE = resolve(defaultStateDir(), "connector.json");
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "help";

try {
  if (command === "help" || args.help) printHelp();
  else if (command === "doctor") await doctor();
  else if (command === "claim-intent" || command === "connect") await claimIntent();
  else if (command === "confirm-intent") await confirmIntent();
  else if (command === "heartbeat") await heartbeat();
  else if (command === "poll-relay" || command === "poll") await pollRelay();
  else if (command === "ack-relay") await ackRelay();
  else if (command === "send-relay") await sendRelay();
  else throw new Error(`unknown command: ${command}`);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function claimIntent() {
  const api = apiBase();
  const token = required("intent");
  if (!args.yes && !args.assume_yes) {
    const preview = await getJson(`${api}/v1/connect-intents/${encodeURIComponent(token)}`);
    console.error(`Claiming ${preview.connect_intent?.product_id || "Bridge"} intent for ${deviceName()}.`);
  }
  const payload = await postJson(`${api}/v1/connect-intents/${encodeURIComponent(token)}/claim`, {
    device_name: args["device-name"] || deviceName(),
    app_version: VERSION,
    capabilities: capabilities(),
    local_state: localState(),
    install_id: installId(),
  }, null, localHeaders());
  const state = {
    api_base: api,
    device_id: payload.device.id,
    device_token: payload.device_token,
    install_id: installId(),
    authorized_products: payload.product ? [payload.product.id] : [],
    pending_intent: token,
    claimed_at: new Date().toISOString(),
  };
  writeJson(statePath(), state);
  console.log(JSON.stringify(redactState(state, payload), null, 2));
}

async function confirmIntent() {
  const state = loadState();
  const token = args.intent || state.pending_intent || required("intent");
  const payload = await postJson(`${state.api_base}/v1/connect-intents/${encodeURIComponent(token)}/confirm`, {
    confirmed: args.confirmed !== "false",
  }, state.device_token, localHeaders(state.install_id));
  const next = {
    ...state,
    authorized_products: payload.product ? [payload.product.id] : state.authorized_products || [],
    confirmed_at: new Date().toISOString(),
  };
  delete next.pending_intent;
  writeJson(statePath(), next);
  console.log(JSON.stringify(redactState(next, payload), null, 2));
}

async function heartbeat() {
  const state = loadState();
  const payload = await postJson(`${state.api_base}/v1/connectors/heartbeat`, {
    app_version: VERSION,
    capabilities: capabilities(),
    local_state: localState(),
  }, state.device_token, localHeaders(state.install_id));
  console.log(JSON.stringify(payload, null, 2));
}

async function pollRelay() {
  const state = loadState();
  const query = new URLSearchParams();
  for (const [arg, param] of [
    ["product-id", "product_id"],
    ["channel-id", "channel_id"],
    ["after-seq", "after_seq"],
    ["limit", "limit"],
    ["wait-ms", "wait_ms"],
    ["include-acked", "include_acked"],
  ]) {
    if (args[arg] != null) query.set(param, String(args[arg]));
  }
  const suffix = query.toString() ? `?${query}` : "";
  const payload = await getJson(`${state.api_base}/v1/connectors/relay/envelopes${suffix}`, state.device_token, localHeaders(state.install_id));
  console.log(JSON.stringify(payload, null, 2));
}

async function ackRelay() {
  const state = loadState();
  const envelopeId = required("envelope-id");
  const payload = await postJson(
    `${state.api_base}/v1/connectors/relay/envelopes/${encodeURIComponent(envelopeId)}/ack`,
    {},
    state.device_token,
    localHeaders(state.install_id),
  );
  console.log(JSON.stringify(payload, null, 2));
}

async function sendRelay() {
  const state = loadState();
  const payload = await postJson(`${state.api_base}/v1/connectors/relay/envelopes`, relayEnvelopeInput(), state.device_token, localHeaders(state.install_id));
  console.log(JSON.stringify(payload, null, 2));
}

async function doctor() {
  const path = statePath();
  const stateRead = readConnectorState(path);
  const api = String(stateRead.state?.api_base || apiBase()).replace(/\/$/, "");
  const health = await tryGetJson(`${api}/v1/health`);
  const diagnostics = await tryGetJson(`${api}/v1/diagnostics`);
  const ready = Boolean(
    health.ok
    && diagnostics.ok
    && stateRead.exists
    && stateRead.state?.device_id
    && stateRead.state?.device_token
  );
  console.log(JSON.stringify({
    ok: ready,
    relay_only: true,
    version: VERSION,
    api_base: api,
    state: {
      path: redactLocalPath(path),
      exists: stateRead.exists,
      readable: Boolean(stateRead.state),
      error: stateRead.error,
      device_id: stateRead.state?.device_id || null,
      token_present: Boolean(stateRead.state?.device_token),
      claimed_at: stateRead.state?.claimed_at || null,
      confirmed_at: stateRead.state?.confirmed_at || null,
    },
    cloud: {
      health_ok: Boolean(health.ok),
      diagnostics_ok: Boolean(diagnostics.ok),
      protocol: diagnostics.payload?.protocol || health.payload?.protocol || null,
      storage: diagnostics.payload?.storage || health.payload?.storage || null,
      products_count: Array.isArray(diagnostics.payload?.products) ? diagnostics.payload.products.length : 0,
      realtime_enabled: Boolean(diagnostics.payload?.realtime?.enabled),
      error: health.error || diagnostics.error || null,
    },
    local: localState(),
  }, null, 2));
}

function relayEnvelopeInput() {
  return {
    product_id: required("product-id"),
    channel_id: required("channel-id"),
    seq: Number(required("seq")),
    request_key: args["request-key"] || null,
    ciphertext: required("ciphertext"),
    aad: required("aad"),
    nonce: required("nonce"),
    algorithm: args.algorithm || "X25519-AES-GCM",
    sender_key_id: required("sender-key-id"),
    recipient_key_id: required("recipient-key-id"),
    meta: jsonArg("meta", {}),
  };
}

async function getJson(url, token = null, headers = {}) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      ...authHeader(token),
      ...headers,
    },
  });
  return readJsonResponse(response);
}

async function postJson(url, body, token = null, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...authHeader(token),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return readJsonResponse(response);
}

async function readJsonResponse(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload.error || `Bridge API ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function tryGetJson(url) {
  try {
    return { ok: true, payload: await getJson(url) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: error?.status || 0,
      payload: error?.payload || null,
    };
  }
}

function capabilities() {
  return {
    relay: ["relay.envelope", "relay.ack"],
  };
}

function localState() {
  return {
    platform: platform(),
    relay: {
      envelopes: true,
      ack: true,
    },
    adapter_router: {
      configured: true,
      mode: "external_http",
      products: jsonArg("adapter-products", {}),
    },
  };
}

function readConnectorState(path) {
  if (!existsSync(path)) return { exists: false, state: null, error: null };
  try {
    return { exists: true, state: JSON.parse(readFileSync(path, "utf8")), error: null };
  } catch (error) {
    return { exists: true, state: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function loadState() {
  const path = statePath();
  const read = readConnectorState(path);
  if (!read.state) throw new Error(`connector state not readable: ${path}`);
  if (!read.state.device_token) throw new Error(`connector state missing device token: ${path}`);
  return read.state;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  setPrivatePermissions(dirname(path), 0o700);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  setPrivatePermissions(path, 0o600);
}

function redactState(state, payload = {}) {
  return {
    ...payload,
    state: {
      api_base: state.api_base,
      device_id: state.device_id,
      install_id: state.install_id,
      authorized_products: state.authorized_products || [],
      pending_intent: state.pending_intent || null,
      claimed_at: state.claimed_at,
      confirmed_at: state.confirmed_at || null,
      token_present: Boolean(state.device_token),
    },
  };
}

function apiBase() {
  return String(args.api || DEFAULT_API).replace(/\/$/, "");
}

function statePath() {
  return resolve(args.state || process.env.BRIDGE_CONNECTOR_STATE || DEFAULT_STATE);
}

function defaultStateDir() {
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "Bridge", "state");
  }
  if (process.platform === "win32") {
    return resolve(process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"), "Bridge", "state");
  }
  return resolve(process.env.XDG_STATE_HOME || resolve(homedir(), ".local", "state"), "bridge");
}

function deviceName() {
  return args["device-name"] || `${hostname()} ${platform()} Bridge`;
}

function installId() {
  return args["install-id"] || process.env.BRIDGE_INSTALL_ID || `connector-${hostname()}-${platform()}`;
}

function localHeaders(value = installId()) {
  return {
    "x-bridge-local-client": "connector-cli",
    "x-bridge-install-id": value,
  };
}

function setPrivatePermissions(path, mode) {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort hardening; write failures are still surfaced by writeFileSync.
  }
}

function authHeader(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function required(name) {
  const value = args[name];
  if (value == null || value === "") throw new Error(`missing --${name}`);
  return String(value);
}

function jsonArg(name, fallback) {
  const raw = args[name];
  if (raw == null || raw === "") return fallback;
  try {
    const value = JSON.parse(String(raw));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    throw new Error(`invalid JSON for --${name}`);
  }
}

function redactLocalPath(path) {
  return String(path).replace(homedir(), "~");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      out._.push(item);
      continue;
    }
    const eq = item.indexOf("=");
    const key = item.slice(2, eq > -1 ? eq : undefined);
    if (eq > -1) {
      out[key] = item.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function printHelp() {
  console.log(`
bridge connector relay CLI

Usage:
  bridge doctor [--api URL] [--state PATH]
  bridge claim-intent --intent TOKEN [--yes] [--api URL] [--state PATH]
  bridge confirm-intent --intent TOKEN [--state PATH]
  bridge heartbeat [--state PATH]
  bridge poll-relay [--product-id ID] [--channel-id ID] [--wait-ms 3000] [--state PATH]
  bridge ack-relay --envelope-id ID [--state PATH]
  bridge send-relay --product-id ID --channel-id ID --seq 2 --ciphertext B64 --aad B64 --nonce B64 --sender-key-id ID --recipient-key-id ID [--state PATH]

This tool is relay-only: it claims a Bridge device, reports generic adapter
router status, reads opaque product_to_device envelopes, ACKs them, and sends
opaque device_to_product envelopes. Product execution lives in product adapters.
`.trim());
}
