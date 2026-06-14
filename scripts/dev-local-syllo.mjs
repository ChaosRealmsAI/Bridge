#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import worker from "../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../packages/sdk/src/index.js";

const PRODUCT_ID = "panda-syllo";
const BRIDGE_RELAY_CAPABILITIES = ["relay.envelope", "relay.ack"];
const SYLLO_PRODUCT_PERMISSIONS = ["syllo.sessions", "syllo.chat", "syllo.issue", "syllo.highlight", "syllo.doc"];
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = parseArgs(process.argv.slice(2));
const sylloRoot = resolve(args.sylloRoot || process.env.SYLLO_REPO_ROOT || resolve(repoRoot, "../syllo"));
const host = args.host || process.env.HOST || "0.0.0.0";
const port = Number(args.port || process.env.PORT || 8799);
const pollIntervalMs = Number(args.pollIntervalMs || process.env.PANDA_BRIDGE_DEV_POLL_INTERVAL_MS || 1500);
const deviceName = args.deviceName || "Syllo Local Desktop";
const hostHome = process.env.HOME || "";

if (!hostHome) {
  console.error("[syllo:local] HOME is required so Codex/Claude can use the real local login state");
  process.exit(1);
}

const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-dev-syllo-"));
const statePath = resolve(temp, "desktop-state.json");
const pendingBackground = new Set();
const activeChildren = new Set();
let devSession = null;
let shuttingDown = false;
let desktopQueue = Promise.resolve();
let apiBase = "";
let sylloAdapter = null;
let phoneActionQueue = null;
const relayKeyBytes = randomBytes(32);
const relayKeyB64 = relayKeyBytes.toString("base64");

const server = createServer(async (request, response) => {
  try {
    await handle(request, response);
  } catch (error) {
    console.error("[syllo:local] request failed", error?.stack || error);
    if (!response.headersSent) {
      response.writeHead(Number(error?.status || 500), { "content-type": "application/json; charset=utf-8" });
    }
    response.end(JSON.stringify({ error: error?.message || "dev_local_syllo_server_error" }, null, 2) + "\n");
  }
});

installSignalHandlers();
try {
  await listen(server, host, port);
  apiBase = `http://127.0.0.1:${port}`;
  console.log("[syllo:local] worker listening in BRIDGE_LOCAL_MEMORY=1 mode");
  console.log(`[syllo:local] local: ${apiBase}`);
  for (const url of phoneUrls(port)) console.log(`[syllo:local] phone: ${url}`);
  if (!phoneUrls(port).length) console.log("[syllo:local] phone: no LAN IPv4 detected");
  console.log(`[syllo:local] desktop state: ${statePath}`);

  sylloAdapter = await startLocalSylloAdapter();
  console.log(`[syllo:local] syllo adapter: ${sylloAdapter.url}`);
  phoneActionQueue = await startLocalPhoneActionQueue();
  console.log(`[syllo:local] phone action queue: ${phoneActionQueue.url}`);

  devSession = await bindLocalDesktop({
    apiBase,
    displayName: "Syllo Local Dev",
    deviceName,
  });
  printReady(devSession);
  pollLoop();
} catch (error) {
  console.error("[syllo:local] startup failed", error?.stack || error);
  await shutdown(1);
}

async function handle(request, response) {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);

  if (request.method === "OPTIONS" && (requestUrl.pathname.startsWith("/dev/") || requestUrl.pathname === "/authorize")) {
    sendCors(response, null, 204);
    return;
  }

  if (requestUrl.pathname === "/dev/session" && request.method === "GET") {
    if (!devSession?.cookie || !devSession?.deviceId) {
      sendCorsJson(response, { error: "dev_session_not_ready" }, 503);
      return;
    }
    sendCorsJson(response, {
      baseUrl: requestUrl.origin,
      cookie: devSession.cookie,
      deviceId: devSession.deviceId,
      productId: PRODUCT_ID,
      relayKeyB64,
      senderKeyId: "syllo-android",
      recipientKeyId: "syllo-adapter",
      channelPrefix: "syllo-android",
      phoneActionBaseUrl: phoneActionBaseUrlFor(requestUrl),
      phoneActionToken: phoneActionQueue?.appToken || "",
    });
    return;
  }

  if (requestUrl.pathname === "/authorize" && request.method === "GET") {
    sendHtml(response, authorizeHtml(requestUrl.origin));
    return;
  }

  if (requestUrl.pathname === "/dev/authorize" && request.method === "POST") {
    const body = await readJsonIncoming(request);
    const displayName = cleanText(body.displayName || body.display_name, 100) || "Syllo Local Dev";
    devSession = await bindLocalDesktop({
      apiBase,
      displayName,
      deviceName: cleanText(body.deviceName || body.device_name, 120) || deviceName,
    });
    sendCorsJson(response, {
      ok: true,
      baseUrl: requestUrl.origin,
      cookie: devSession.cookie,
      deviceId: devSession.deviceId,
      productId: PRODUCT_ID,
      relayKeyB64,
      senderKeyId: "syllo-android",
      recipientKeyId: "syllo-adapter",
      channelPrefix: "syllo-android",
      phoneActionBaseUrl: phoneActionBaseUrlFor(requestUrl),
      phoneActionToken: phoneActionQueue?.appToken || "",
    }, 201);
    return;
  }

  if (requestUrl.pathname === "/__syllo/health" && request.method === "GET") {
    sendCorsJson(response, {
      ok: true,
      productId: PRODUCT_ID,
      mode: "local-memory",
      apiBase,
      deviceId: devSession?.deviceId || null,
      pollIntervalMs,
      pendingBackground: pendingBackground.size,
      phoneActionReady: Boolean(phoneActionQueue),
      phoneActionBaseUrl: phoneActionBaseUrlFor(requestUrl),
      checkedAt: new Date().toISOString(),
    });
    return;
  }

  if (requestUrl.pathname.startsWith("/v1/")) {
    await handleWorker(request, response, requestUrl);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found\n");
}

async function handleWorker(incoming, outgoing, requestUrl) {
  const headers = incomingHeaders(incoming.headers);
  if (
    !headers.get("origin") &&
    !headers.get("x-panda-bridge-local-client") &&
    !["GET", "HEAD", "OPTIONS"].includes(incoming.method || "GET")
  ) {
    headers.set("origin", requestUrl.origin);
  }

  const init = {
    method: incoming.method,
    headers,
  };
  if (!["GET", "HEAD"].includes(incoming.method || "GET")) {
    init.body = Readable.toWeb(incoming);
    init.duplex = "half";
  }

  const workerRequest = new Request(requestUrl.href, init);
  const workerResponse = await worker.fetch(workerRequest, localWorkerEnv(requestUrl.origin), localExecutionContext());
  outgoing.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers.entries()));
  if (!workerResponse.body || incoming.method === "HEAD") {
    outgoing.end();
    return;
  }
  Readable.fromWeb(workerResponse.body).pipe(outgoing);
}

async function bindLocalDesktop({ apiBase: nextApiBase, displayName, deviceName: nextDeviceName }) {
  const jar = cookieJar(nextApiBase);
  const bridge = createBridgeClient({ apiBase: nextApiBase, productId: PRODUCT_ID, fetch: jar.fetch });
  const session = await bridge.auth.guest(displayName);
  if (!session?.authenticated) throw new Error("failed to create local guest session");

  const intent = await bridge.connect.createIntent({
    deviceName: nextDeviceName,
    permissions: sylloPermissions(nextApiBase),
  });
  if (!String(intent?.token || "").startsWith("pbi_")) {
    throw new Error(`connect-intent did not return a token: ${JSON.stringify(intent)}`);
  }

  const connected = await enqueueDesktop([
    "headless-connect",
    "--api",
    nextApiBase,
    "--intent",
    intent.token,
    "--device-name",
    nextDeviceName,
  ], { label: "headless-connect", timeoutMs: 240000 });
  if (connected.status !== 0) throw new Error(childMessage(connected));
  const claim = parseJson(connected.stdout, "headless-connect");
  const deviceId = claim.device_id || claim.device?.id;
  if (!deviceId) throw new Error(`headless-connect did not return device_id: ${connected.stdout}`);
  const deviceToken = claim.device_token || claim.token || "";
  if (!deviceToken) throw new Error(`headless-connect did not return device_token: ${connected.stdout}`);
  await confirmLocalDesktopAuthorization(nextApiBase, intent.token, deviceToken);

  await bridge.ensureReady({ wait: true, timeoutMs: 10000, intervalMs: 250 });
  return {
    cookie: jar.cookie,
    deviceId,
    account: session.user || null,
    apiBase: nextApiBase,
    createdAt: new Date().toISOString(),
  };
}

async function confirmLocalDesktopAuthorization(nextApiBase, token, deviceToken) {
  const response = await fetch(`${nextApiBase}/v1/connect-intents/${encodeURIComponent(token)}/confirm`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deviceToken}`,
      "content-type": "application/json",
      "x-panda-bridge-local-client": "desktop",
    },
    body: JSON.stringify({ confirmed: true }),
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(`connect-intent confirm failed: http ${response.status} ${JSON.stringify(payload)}`);
  }
  if (!["active", "authorized"].includes(String(payload.authorization?.status || ""))) {
    throw new Error(`connect-intent confirm did not activate authorization: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function pollLoop() {
  while (!shuttingDown) {
    try {
      const polled = await enqueueDesktop(["headless-poll"], { label: "headless-poll", timeoutMs: 900000 });
      if (polled.status !== 0) {
        console.error(`[syllo:local] headless-poll failed\n${childMessage(polled)}`);
      } else {
        const payload = parseJson(polled.stdout, "headless-poll");
        if (Number(payload.count || 0) > 0 || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
          console.log(`[syllo:local] ${payload.message || `worker tick ok, jobs=${payload.count || 0}`}`);
        }
      }
    } catch (error) {
      if (!shuttingDown) console.error("[syllo:local] poll loop error", error?.stack || error);
    }
    await sleep(pollIntervalMs);
  }
}

function enqueueDesktop(args, options = {}) {
  const task = desktopQueue.then(() => runDesktop(args, options));
  desktopQueue = task.catch(() => {});
  return task;
}

function runDesktop(args, options = {}) {
  return new Promise((resolveChild) => {
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", resolve(repoRoot, "apps/desktop/Cargo.toml"), "--", ...args], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        HOME: hostHome,
        CODEX_HOME: process.env.CODEX_HOME || resolve(hostHome, ".codex"),
        ...((process.env.RUSTUP_HOME || hostHome)
          ? { RUSTUP_HOME: process.env.RUSTUP_HOME || resolve(hostHome, ".rustup") }
          : {}),
        ...((process.env.CARGO_HOME || hostHome)
          ? { CARGO_HOME: process.env.CARGO_HOME || resolve(hostHome, ".cargo") }
          : {}),
        PANDA_BRIDGE_DESKTOP_STATE: statePath,
        PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1",
        ...(sylloAdapter?.url ? {
          PANDA_BRIDGE_ADAPTER_PANDA_SYLLO_URL: sylloAdapter.url,
          PANDA_BRIDGE_ADAPTER_URL: sylloAdapter.url,
        } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let error = null;
    const timeoutMs = Number(options.timeoutMs || 240000);
    const timer = setTimeout(() => {
      error = new Error(`desktop child timed out: ${args.join(" ")}`);
      killChild(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (nextError) => {
      error = nextError;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolveChild({ status, signal, stdout, stderr, error, label: options.label || args[0] || "desktop" });
    });
  });
}

async function startLocalSylloAdapter() {
  const modulePath = resolve(sylloRoot, "scripts/bridge/syllo-relay-adapter.mjs");
  const { startSylloRelayAdapter } = await import(pathToFileURL(modulePath).href);
  return startSylloRelayAdapter({ keyBytes: relayKeyBytes, root: sylloRoot });
}

async function startLocalPhoneActionQueue() {
  const modulePath = resolve(sylloRoot, "scripts/bridge/syllo-phone-action-queue.mjs");
  const { startPhoneActionQueue } = await import(pathToFileURL(modulePath).href);
  return startPhoneActionQueue({
    host: args.phoneActionHost || process.env.SYLLO_PHONE_ACTION_HOST || "0.0.0.0",
    port: Number(args.phoneActionPort || process.env.SYLLO_PHONE_ACTION_PORT || 8798),
    enqueueToken: process.env.SYLLO_PHONE_ACTION_TOKEN || randomBytes(24).toString("base64url"),
    appToken: process.env.SYLLO_PHONE_ACTION_APP_TOKEN || randomBytes(24).toString("base64url"),
  });
}

function phoneActionBaseUrlFor(requestUrl) {
  if (!phoneActionQueue) return "";
  return `${requestUrl.protocol}//${requestUrl.hostname}:${phoneActionQueue.port}`;
}

function localWorkerEnv(origin) {
  const localOrigins = [...new Set([
    origin,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://10.0.2.2:${port}`,
    ...lanAddresses().map((ip) => `http://${ip}:${port}`),
  ])];
  return {
    BRIDGE_ENV: "syllo-local",
    BRIDGE_LOCAL_MEMORY: "1",
    BRIDGE_WEB_ORIGIN: origin,
    BRIDGE_ALLOWED_ORIGINS: localOrigins.join(","),
    BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({
      [PRODUCT_ID]: localOrigins,
    }),
    BRIDGE_PUBLIC_API_BASE: origin,
    BRIDGE_DESKTOP_PROTOCOL: "panda-bridge",
    SESSION_COOKIE_NAME: "pb_session",
  };
}

function localExecutionContext() {
  return {
    waitUntil(promise) {
      const guarded = Promise.resolve(promise).catch((error) => {
        console.error("[syllo:local] background task failed", error?.stack || error);
      });
      pendingBackground.add(guarded);
      guarded.finally(() => pendingBackground.delete(guarded));
    },
  };
}

function sylloPermissions(sourceOrigin) {
  return {
    version: "AUTH-SCOPE-v2",
    preset: "syllo-local-dev",
    request_source: "syllo_local_dev",
    product_id: PRODUCT_ID,
    source_origin: sourceOrigin,
    capabilities: BRIDGE_RELAY_CAPABILITIES,
    product_authorization: {
      owner: "panda-syllo",
      enforcement: "syllo-product-adapter",
      capabilities: SYLLO_PRODUCT_PERMISSIONS,
      roots: [{ id: "default", path_display: "[local]/default" }],
    },
    workspace_roots: [{ id: "default", path_display: "[local]/default" }],
    sandbox_floor: "workspace-write",
    approval_policy_floor: "on-request",
    allow_approval_never: false,
    allow_developer_instructions: false,
  };
}

function cookieJar(origin) {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers || {});
      headers.set("origin", origin);
      if (cookie) headers.set("cookie", cookie);
      const response = await fetch(url, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return response;
    },
  };
}

function authorizeHtml(origin) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Syllo Local Bridge Authorization</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #1f2328; }
    main { width: min(520px, calc(100vw - 32px)); border: 1px solid #d8dee4; border-radius: 8px; padding: 24px; background: #fff; box-shadow: 0 12px 35px rgba(31, 35, 40, .08); }
    h1 { margin: 0 0 8px; font-size: 22px; letter-spacing: 0; }
    p { margin: 0 0 18px; color: #57606a; line-height: 1.5; }
    label { display: grid; gap: 6px; margin-bottom: 14px; font-size: 13px; font-weight: 650; }
    input { border: 1px solid #d0d7de; border-radius: 6px; padding: 10px 12px; font: inherit; }
    button { border: 0; border-radius: 6px; padding: 10px 14px; font: inherit; font-weight: 700; color: #fff; background: #0969da; cursor: pointer; }
    button:disabled { opacity: .6; cursor: progress; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 16px 0 0; padding: 12px; border-radius: 6px; background: #f6f8fa; color: #24292f; font-size: 12px; }
    @media (prefers-color-scheme: dark) {
      body { background: #0d1117; color: #e6edf3; }
      main { background: #161b22; border-color: #30363d; box-shadow: none; }
      p { color: #8b949e; }
      input { background: #0d1117; color: #e6edf3; border-color: #30363d; }
      pre { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Syllo 本地 Bridge 授权</h1>
    <p>登录一个本地开发账号，并把这台电脑授权给 Syllo。当前 Bridge: ${escapeHtml(origin)}</p>
    <label>
      账号显示名
      <input id="displayName" value="Syllo Local Dev" autocomplete="name">
    </label>
    <button id="authorize">授权这台电脑</button>
    <pre id="result">${devSession ? escapeHtml(JSON.stringify({
      baseUrl: origin,
      cookie: devSession.cookie,
      deviceId: devSession.deviceId,
      productId: PRODUCT_ID,
    }, null, 2)) : "等待本地授权..."}</pre>
  </main>
  <script>
    const button = document.getElementById("authorize");
    const result = document.getElementById("result");
    button.addEventListener("click", async () => {
      button.disabled = true;
      result.textContent = "授权中...";
      try {
        const response = await fetch("/dev/authorize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: document.getElementById("displayName").value })
        });
        const text = await response.text();
        result.textContent = text;
      } catch (error) {
        result.textContent = String(error && error.message || error);
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function printReady(session) {
  console.log(`[syllo:local] desktop bound: deviceId=${session.deviceId}`);
  console.log("[syllo:local] dev session:");
  console.log(`  curl http://127.0.0.1:${port}/dev/session`);
  console.log("[syllo:local] authorize page:");
  console.log(`  http://127.0.0.1:${port}/authorize`);
  console.log("[syllo:local] phone connect:");
  console.log(`  Android emulator: http://10.0.2.2:${port}`);
  if (phoneActionQueue) console.log(`  Android phone action queue: http://10.0.2.2:${phoneActionQueue.port}`);
  if (phoneActionQueue) console.log(`  AI enqueue env: SYLLO_PHONE_ACTION_URL=http://127.0.0.1:${phoneActionQueue.port} SYLLO_PHONE_ACTION_TOKEN=${phoneActionQueue.enqueueToken}`);
  for (const url of phoneUrls(port)) console.log(`  Physical device: ${url}`);
  console.log("[syllo:local] press Ctrl-C to stop the local worker and desktop poller");
}

function phoneUrls(selectedPort) {
  return lanAddresses().map((ip) => `http://${ip}:${selectedPort}`);
}

function lanAddresses() {
  const addresses = [];
  for (const items of Object.values(networkInterfaces())) {
    for (const item of items || []) {
      if (item.family !== "IPv4" || item.internal) continue;
      if (item.address.startsWith("169.254.")) continue;
      addresses.push(item.address);
    }
  }
  return [...new Set(addresses)].sort();
}

function listen(nextServer, nextHost, nextPort) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      nextServer.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      nextServer.off("error", onError);
      resolveListen();
    };
    nextServer.once("error", onError);
    nextServer.once("listening", onListening);
    nextServer.listen(nextPort, nextHost);
  });
}

function readIncoming(incoming) {
  return new Promise((resolveRead, rejectRead) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => resolveRead(Buffer.concat(chunks)));
    incoming.on("error", rejectRead);
  });
}

async function readJsonIncoming(incoming) {
  const body = await readIncoming(incoming);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.status = 400;
    throw error;
  }
}

function incomingHeaders(raw) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw || {})) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value != null) headers.set(key, String(value));
  }
  return headers;
}

function sendJson(response, payload, status = 200, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(payload, null, 2) + "\n");
}

function sendCorsJson(response, payload, status = 200) {
  sendJson(response, payload, status, corsHeaders());
}

function sendCors(response, payload = null, status = 200) {
  response.writeHead(status, corsHeaders());
  response.end(payload || undefined);
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON from ${label}: ${error.message}\n${text}`);
  }
}

function childMessage(result) {
  return [
    `${result.label || "desktop"} status=${result.status}`,
    result.signal ? `signal=${result.signal}` : "",
    result.error ? `error=${result.error.message}` : "",
    result.stderr ? `stderr=${result.stderr}` : "",
    result.stdout ? `stdout=${result.stdout}` : "",
  ].filter(Boolean).join("\n");
}

function cleanText(value, max = 200) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function killChild(child) {
  if (!child || child.killed) return;
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Child is already gone.
    }
  }
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      console.log(`\n[syllo:local] received ${signal}, shutting down`);
      shutdown(0);
    });
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of activeChildren) killChild(child);
  if (sylloAdapter) await sylloAdapter.close();
  if (phoneActionQueue) await phoneActionQueue.close();
  await new Promise((resolveClose) => server.close(() => resolveClose()));
  process.exit(code);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
