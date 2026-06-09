#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

if (process.platform !== "darwin") {
  console.error("verify:desktop-ai-cli currently requires macOS installed app launch semantics.");
  process.exit(1);
}

const evidenceDir = resolve("spec/verification/evidence/desktop-ai-cli-control");
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-desktop-ai-cli-"));
const desktopState = resolve(temp, "desktop-state.json");
const controlState = resolve(temp, "verify-control.json");
const appPath = resolve(homedir(), "Applications", "Panda Bridge.app");
const summaryPath = resolve(evidenceDir, "summary.json");
mkdirSync(evidenceDir, { recursive: true });
for (const name of ["summary.json", "desktop-initial.png", "desktop-authorized.png"]) {
  rmSync(resolve(evidenceDir, name), { force: true });
}

let server;
try {
  run("npm", ["run", "desktop:install:mac"]);
  stopDesktop();
  startInstalledDesktop();
  const controlInfo = await waitForControl(controlState);
  const control = makeControlClient(controlInfo);

  const unauthorized = await fetch(`${controlInfo.base_url}/v1/status`);
  assert.equal(unauthorized.status, 401, "verify-control must reject missing token");

  const initialStatus = await control("GET", "/v1/status");
  assert.equal(initialStatus.codex_available, true, "Desktop must detect codex command");
  await control("POST", "/v1/actions", { action: "activate_app" });
  await control("POST", "/v1/actions", { action: "click_refresh_status" });
  const initialShot = await control("GET", "/v1/screenshot");
  assertScreenshot(initialShot, "desktop-initial.png");

  const apiBase = await startLocalBridgeApi();
  const client = makeClient(apiBase);
  const suffix = Date.now();
  const session = await client.auth.password(`desktop-ai-cli-${suffix}@pandart.cc`, "PandaAiCli-2026!", "Desktop AI CLI User");
  const intent = await client.connect.createIntent({ deviceName: "Desktop AI CLI Verifier" });
  await control("POST", "/v1/actions", { action: "open_deep_link", url: intent.deep_link });
  const claim = await control("POST", "/v1/actions", {
    action: "click_allow_intent",
    api: apiBase,
    intent: intent.token,
    device_name: "Desktop AI CLI Verifier",
  });
  assert.equal(claim.product_id, "panda-chat");
  assert.equal(claim.account_id, session.user.id);

  const authorizedStatus = await control("GET", "/v1/status");
  const product = (authorizedStatus.authorized_products || []).find((item) => item.id === "panda-chat");
  assert.ok(product, "Desktop status must include authorized panda-chat product");
  assert.equal(product.policy?.version, "AUTH-SCOPE-v1");
  assert.ok((product.accounts || []).some((account) => account.id === session.user.id));
  const authorizedShot = await control("GET", "/v1/screenshot");
  assertScreenshot(authorizedShot, "desktop-authorized.png");

  const revoke = await control("POST", "/v1/actions", {
    action: "click_revoke_authorization",
    product_id: "panda-chat",
    account_id: session.user.id,
    device_id: claim.device_id,
  });
  assert.equal(revoke.ok, true);
  assert.equal(revoke.remote_revoke_ok, true);
  const afterRevoke = await control("GET", "/v1/status");
  assert.equal((afterRevoke.authorized_products || []).some((item) => item.id === "panda-chat"), false);

  const events = await control("GET", "/v1/events");
  const summary = {
    ok: true,
    app_path: appPath,
    control_surface: "installed-app verify-control",
    operations: [
      "installed_app_launch",
      "GET /v1/status",
      "POST activate_app",
      "POST click_refresh_status",
      "GET /v1/screenshot",
      "POST open_deep_link",
      "POST click_allow_intent",
      "POST click_revoke_authorization",
      "401 without verify token",
    ],
    screenshots: {
      initial: summarizeShot(initialShot, "desktop-initial.png"),
      authorized: summarizeShot(authorizedShot, "desktop-authorized.png"),
    },
    claim: {
      account_id: claim.account_id,
      product_id: claim.product_id,
      device_id: claim.device_id,
      device_name: claim.device_name,
    },
    local_authorization_record: {
      product_id: product.id,
      product_name: product.name,
      origin: product.origin,
      capabilities: product.capabilities,
      policy_version: product.policy?.version,
      account_count: product.accounts?.length || 0,
    },
    revoke: { ok: revoke.ok, remote_revoke_ok: revoke.remote_revoke_ok },
    after_revoke_product_count: (afterRevoke.authorized_products || []).filter((item) => item.id === "panda-chat").length,
    event_actions: (events.items || []).filter((item) => item.type === "verify_action").map((item) => item.payload?.action),
    checked_at: new Date().toISOString(),
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  stopDesktop();
  unsetLaunchEnv();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.stdio || "inherit", env: options.env || process.env });
  if (result.status !== 0 && !options.optional) process.exit(result.status || 1);
  return result;
}

function stopDesktop() {
  spawnSync("osascript", ["-e", "tell application \"Panda Bridge\" to quit"], { stdio: "ignore" });
  spawnSync("pkill", ["-f", `${appPath}/Contents/MacOS/Panda Bridge`], { stdio: "ignore" });
}

function setLaunchEnv() {
  run("launchctl", ["setenv", "PANDA_BRIDGE_VERIFY", "1"], { stdio: "ignore" });
  run("launchctl", ["setenv", "PANDA_BRIDGE_VERIFY_CONTROL_STATE", controlState], { stdio: "ignore" });
  run("launchctl", ["setenv", "PANDA_BRIDGE_DESKTOP_STATE", desktopState], { stdio: "ignore" });
  run("launchctl", ["setenv", "PANDA_BRIDGE_FAKE_CODEX", "1"], { stdio: "ignore" });
}

function unsetLaunchEnv() {
  for (const key of ["PANDA_BRIDGE_VERIFY", "PANDA_BRIDGE_VERIFY_CONTROL_STATE", "PANDA_BRIDGE_DESKTOP_STATE", "PANDA_BRIDGE_FAKE_CODEX"]) {
    run("launchctl", ["unsetenv", key], { stdio: "ignore", optional: true });
  }
}

function startInstalledDesktop() {
  setLaunchEnv();
  run("open", ["-n", appPath], { stdio: "ignore" });
}

async function waitForControl(path) {
  return waitFor(() => {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  }, "verify-control file was not created", 30000);
}

function makeControlClient(info) {
  return async (method, path, body = null) => {
    const response = await fetch(`${info.base_url}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "x-panda-bridge-verify-token": info.token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
    return payload;
  };
}

function assertScreenshot(payload, outputName) {
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.method, "builtin_app_png", "screenshot must be generated by Desktop built-in renderer");
  assert.equal(payload.source, "desktop_builtin_renderer", "screenshot source must be Desktop built-in renderer");
  assert.ok(payload.path, "screenshot response must include path");
  const bytes = readFileSync(payload.path);
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(bytes.subarray(0, pngHeader.length).equals(pngHeader), "screenshot must be PNG");
  assert.ok(bytes.length > 1024, "screenshot PNG must not be empty");
  copyFileSync(payload.path, resolve(evidenceDir, outputName));
}

function summarizeShot(payload, outputName) {
  return {
    ok: payload.ok,
    method: payload.method,
    source: payload.source,
    evidence: resolve(evidenceDir, outputName),
  };
}

async function startLocalBridgeApi() {
  const env = {
    BRIDGE_LOCAL_MEMORY: "1",
    BRIDGE_WEB_ORIGIN: "http://chat.local.test",
    BRIDGE_ALLOWED_ORIGINS: "http://chat.local.test http://127.0.0.1",
    BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({
      "panda-chat": ["http://chat.local.test"],
    }),
    BRIDGE_PUBLIC_API_BASE: "http://127.0.0.1:0",
    SESSION_COOKIE_NAME: "pb_session",
  };
  server = createServer(async (incoming, outgoing) => {
    try {
      const body = await readIncoming(incoming);
      const port = server.address().port;
      const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
        method: incoming.method,
        headers: incomingHeaders(incoming.headers),
        body: body.length && incoming.method !== "GET" && incoming.method !== "HEAD" ? body : undefined,
      });
      const response = await worker.fetch(request, { ...env, BRIDGE_PUBLIC_API_BASE: `http://127.0.0.1:${port}` });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      outgoing.end(JSON.stringify({ error: "desktop_ai_cli_proxy_error", message: error.message || String(error) }));
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return `http://127.0.0.1:${server.address().port}`;
}

function makeClient(apiBase) {
  const jar = { cookie: "" };
  return createBridgeClient({
    apiBase,
    productId: "panda-chat",
    fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers || {});
      headers.set("origin", "http://chat.local.test");
      if (jar.cookie) headers.set("cookie", jar.cookie);
      const response = await fetch(url, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) jar.cookie = setCookie.split(";")[0];
      return response;
    },
  });
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

async function waitFor(probe, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message || lastError}` : ""}`);
}
