#!/usr/bin/env node
import { createServer } from "node:http";

import worker from "../../apps/cloud-worker/src/index.js";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_SESSION_COOKIE = "pb_session";

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const { command, args } = parseCommand(process.argv.slice(2));
  if (command === "help" || args.help) return printHelp();
  if (command === "serve") return await serve(args);
  if (command === "pair") return await pair(args);
  throw new Error(`Unknown bridge-server command: ${command}`);
}

async function serve(args) {
  const port = numberArg(args.port ?? env("PORT") ?? env("BRIDGE_SERVER_PORT"), DEFAULT_PORT);
  const host = stringArg(args.host ?? env("BRIDGE_SERVER_HOST"), DEFAULT_HOST);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await readIncoming(incoming);
      const localOrigin = localServerOrigin(server);
      const url = `${localOrigin}${incoming.url || "/"}`;
      const request = new Request(url, {
        method: incoming.method,
        headers: incomingHeaders(incoming.headers),
        body: body.length && incoming.method !== "GET" && incoming.method !== "HEAD" ? body : undefined,
      });
      const response = await worker.fetch(request, workerEnv(localOrigin), workerContext());
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      outgoing.end(JSON.stringify({ error: "bridge_server_proxy_error", message: error.message || String(error) }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const serverUrl = publicServerUrl(server, args.url);
  console.log(`Panda Bridge Server listening on ${localServerOrigin(server)}`);
  if (startupPairEnabled(args)) {
    await printStartupPairingToken(serverUrl, localServerOrigin(server));
  } else {
    printPairCommand(serverUrl);
  }

  process.once("SIGINT", () => server.close(() => process.exit(0)));
  process.once("SIGTERM", () => server.close(() => process.exit(0)));
}

async function pair(args) {
  const serverUrl = normalizeBaseUrl(
    args.url
      ?? env("BRIDGE_SERVER_URL")
      ?? env("BRIDGE_PUBLIC_API_BASE")
      ?? `http://127.0.0.1:${numberArg(env("PORT") ?? env("BRIDGE_SERVER_PORT"), DEFAULT_PORT)}`,
  );
  const adminToken = args.adminToken ?? env("BRIDGE_SELFHOST_ADMIN_TOKEN") ?? env("BRIDGE_ADMIN_TOKEN");
  if (!adminToken) {
    throw new Error("BRIDGE_SELFHOST_ADMIN_TOKEN is required for bridge-server pair.");
  }
  const payload = await requestPairingToken({
    serverUrl,
    adminToken,
    deviceName: args.deviceName ?? env("BRIDGE_PAIRING_DEVICE_NAME") ?? "Panda Bridge Desktop",
    ownerEmail: args.ownerEmail ?? env("BRIDGE_SELFHOST_OWNER_EMAIL"),
    ownerName: args.ownerName ?? env("BRIDGE_SELFHOST_OWNER_NAME"),
  });
  printPairingToken(serverUrl, payload);
}

async function printStartupPairingToken(serverUrl, localOrigin) {
  const adminToken = env("BRIDGE_SELFHOST_ADMIN_TOKEN") ?? env("BRIDGE_ADMIN_TOKEN");
  if (!adminToken) {
    console.log(`Server URL: ${serverUrl}`);
    console.log(`Pairing Token: run bridge-server pair --url ${serverUrl}`);
    console.log("Expires: not generated");
    return;
  }
  const payload = await requestPairingTokenFromWorker({
    serverUrl,
    localOrigin,
    adminToken,
    deviceName: env("BRIDGE_PAIRING_DEVICE_NAME") ?? "Panda Bridge Desktop",
    ownerEmail: env("BRIDGE_SELFHOST_OWNER_EMAIL"),
    ownerName: env("BRIDGE_SELFHOST_OWNER_NAME"),
  });
  printPairingToken(serverUrl, payload);
}

function printPairingToken(serverUrl, payload) {
  const token = payload?.token;
  const expires = payload?.pairing_token?.expires_at || (payload?.ttl_seconds ? `${payload.ttl_seconds} seconds` : "");
  if (!token || !expires) throw new Error(`Pairing endpoint returned an incomplete response: ${JSON.stringify(redactToken(payload))}`);
  console.log(`Server URL: ${serverUrl}`);
  console.log(`Pairing Token: ${token}`);
  console.log(`Expires: ${expires}`);
}

function printPairCommand(serverUrl) {
  console.log(`Server URL: ${serverUrl}`);
  console.log(`Pairing Token: run bridge-server pair --url ${serverUrl}`);
  console.log("Expires: not generated");
}

async function requestPairingToken({ serverUrl, adminToken, deviceName, ownerEmail, ownerName }) {
  const response = await fetch(joinUrl(serverUrl, "/v1/selfhost/pairing-token"), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-panda-bridge-selfhost-admin-token": adminToken,
    },
    body: JSON.stringify(pairingRequestBody({ deviceName, ownerEmail, ownerName })),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(`Pairing token request failed: ${response.status} ${payload.error || JSON.stringify(payload)}`);
  return payload;
}

async function requestPairingTokenFromWorker({ serverUrl, localOrigin, adminToken, deviceName, ownerEmail, ownerName }) {
  const request = new Request(joinUrl(localOrigin, "/v1/selfhost/pairing-token"), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-panda-bridge-selfhost-admin-token": adminToken,
    },
    body: JSON.stringify(pairingRequestBody({ deviceName, ownerEmail, ownerName })),
  });
  const response = await worker.fetch(request, workerEnv(localOrigin, serverUrl), workerContext());
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(`Startup pairing token request failed: ${response.status} ${payload.error || JSON.stringify(payload)}`);
  return payload;
}

function pairingRequestBody({ deviceName, ownerEmail, ownerName }) {
  return Object.fromEntries(Object.entries({
    device_name: deviceName,
    owner_email: ownerEmail,
    owner_name: ownerName,
  }).filter(([, value]) => value != null && String(value).trim() !== ""));
}

function workerEnv(localOrigin, publicOrigin = null) {
  const persistentConfigured = Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));
  const publicBase = normalizeBaseUrl(
    publicOrigin
      ?? env("BRIDGE_PUBLIC_API_BASE")
      ?? env("BRIDGE_SERVER_URL")
      ?? localOrigin,
  );
  const webOrigin = normalizeBaseUrl(env("BRIDGE_WEB_ORIGIN") ?? publicBase);
  return {
    ...process.env,
    BRIDGE_ENV: env("BRIDGE_ENV") ?? (persistentConfigured ? "selfhost" : "local"),
    BRIDGE_LOCAL_MEMORY: env("BRIDGE_LOCAL_MEMORY") ?? (persistentConfigured ? "" : "1"),
    BRIDGE_PUBLIC_API_BASE: publicBase,
    BRIDGE_WEB_ORIGIN: webOrigin,
    BRIDGE_PRODUCT_REGISTRY_MODE: env("BRIDGE_PRODUCT_REGISTRY_MODE") ?? (env("BRIDGE_PRODUCT_REGISTRY_JSON") ? "replace" : "builtin"),
    SESSION_COOKIE_NAME: env("SESSION_COOKIE_NAME") ?? DEFAULT_SESSION_COOKIE,
  };
}

function workerContext() {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}

function parseCommand(argv) {
  const next = [...argv];
  const command = next[0] && !next[0].startsWith("-") ? next.shift() : "serve";
  const args = {};
  for (let index = 0; index < next.length; index += 1) {
    const item = next[index];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item === "--no-startup-pair") args.noStartupPair = true;
    else if (item === "--startup-pair") args.startupPair = true;
    else if (item === "--url") args.url = requiredValue(item, next[++index]);
    else if (item === "--host") args.host = requiredValue(item, next[++index]);
    else if (item === "--port") args.port = requiredValue(item, next[++index]);
    else if (item === "--admin-token") args.adminToken = requiredValue(item, next[++index]);
    else if (item === "--device-name") args.deviceName = requiredValue(item, next[++index]);
    else if (item === "--owner-email") args.ownerEmail = requiredValue(item, next[++index]);
    else if (item === "--owner-name") args.ownerName = requiredValue(item, next[++index]);
    else throw new Error(`Unknown argument: ${item}`);
  }
  return { command, args };
}

function requiredValue(flag, value) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function startupPairEnabled(args) {
  if (args.noStartupPair) return false;
  if (args.startupPair) return true;
  return env("BRIDGE_SERVER_STARTUP_PAIR") !== "0";
}

function publicServerUrl(server, explicitUrl) {
  return normalizeBaseUrl(
    explicitUrl
      ?? env("BRIDGE_SERVER_URL")
      ?? env("BRIDGE_PUBLIC_API_BASE")
      ?? localServerOrigin(server).replace("0.0.0.0", "127.0.0.1"),
  );
}

function localServerOrigin(server) {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Server URL is required.");
  return raw.replace(/\/+$/, "");
}

function joinUrl(base, path) {
  return `${normalizeBaseUrl(base)}${path.startsWith("/") ? path : `/${path}`}`;
}

function numberArg(value, fallback) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error(`Invalid port: ${value}`);
  return number;
}

function stringArg(value, fallback) {
  return String(value || fallback).trim();
}

function env(key) {
  const value = process.env[key];
  return value == null || value === "" ? undefined : value;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: "invalid_json_response", body: text.slice(0, 400) };
  }
}

async function readIncoming(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function incomingHeaders(headers) {
  const next = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) next.set(key, value.join(", "));
    else if (value != null) next.set(key, String(value));
  }
  return next;
}

function redactToken(payload) {
  if (!payload || typeof payload !== "object") return payload;
  return { ...payload, token: payload.token ? "[redacted-pairing-token]" : payload.token };
}

function printHelp() {
  console.log(`Usage:
  bridge-server serve [--host 0.0.0.0] [--port 8787] [--url http://127.0.0.1:8787]
  bridge-server pair --url http://127.0.0.1:8787

Environment:
  BRIDGE_SELFHOST_ADMIN_TOKEN   Required for pair token generation.
  BRIDGE_SERVER_URL             Public URL printed for Desktop pairing.
  BRIDGE_SERVER_STARTUP_PAIR    Set to 0 to skip startup token generation.
  BRIDGE_LOCAL_MEMORY           Defaults to 1 unless Supabase credentials are configured.
`);
}
