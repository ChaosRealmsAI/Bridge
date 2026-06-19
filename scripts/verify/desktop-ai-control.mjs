#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

import worker from "../../apps/cloud-worker/src/index.js";

const PRODUCT_ID = "panda-burn";
const PRODUCT_NAME = "Burn";
const TOKEN_BURN_ORIGIN = "https://token-burn.com";
const repoRoot = resolve(".");
const CONNECT_TOKEN_PATTERN = /\bpbi_[A-Za-z0-9._~-]+/g;
const evidenceDir = resolve("spec/L3/evidence/desktop-ai-control");
rmSync(evidenceDir, { recursive: true, force: true });
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(resolve(evidenceDir, "snapshots"), { recursive: true });
mkdirSync(resolve(evidenceDir, "screenshots"), { recursive: true });

const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-desktop-ai-control-"));
const desktopStatePath = resolve(temp, "desktop-state.json");
const verifyControlPath = resolve(temp, "verify-control.json");
const homePath = resolve(temp, "home");
mkdirSync(homePath, { recursive: true });

let desktop = null;
const workerServer = await startLocalWorker();
const apiBase = workerServer.apiBase;
const steps = [];

class CookieJar {
  #cookie = "";
  store(setCookie) {
    if (!setCookie) return;
    this.#cookie = setCookie.split(";")[0];
  }
  header() {
    return this.#cookie;
  }
}

try {
  const authorizePage = await fetchText(`${apiBase}/authorize`);
  assert.match(authorizePage, /Token Burn/);
  step("ai-control-authorize-page", {
    action: "Open Token Burn authorize page",
    expected: "visible authorize page exists before a connect intent is created",
    actual: `${apiBase}/authorize`,
    evidence: snapshot("authorize-page", { url: `${apiBase}/authorize`, html_bytes: authorizePage.length }),
  });

  const jar = new CookieJar();
  const session = await workerJson(jar, "POST", "/v1/sessions/guest", {
    display_name: "Token Burn User",
  });
  assert.equal(session.authenticated, true);
  const intent = await workerJson(jar, "POST", "/v1/connect-intents", {
    product_id: PRODUCT_ID,
    device_name: "AI Control Token Burn Device",
    install_id: "install-ai-control-token-burn",
    policy: {
      source_origin: TOKEN_BURN_ORIGIN,
      capabilities: ["relay.envelope", "relay.ack"],
      product_authorization: {
        owner: "product-adapter",
        enforcement: "product-adapter",
        control: "computer-control",
      },
    },
  });
  assert.equal(intent.connect_intent.product_id, PRODUCT_ID);
  assert.equal(intent.connect_intent.source_origin, TOKEN_BURN_ORIGIN);
  assert.equal(intent.connect_intent.policy.source_origin, TOKEN_BURN_ORIGIN);
  step("ai-control-create-intent", {
    action: "Create connect intent as Token Burn",
    expected: "Bridge Cloud binds source_origin to https://token-burn.com",
    actual: `product=${intent.connect_intent.product_id}; source_origin=${intent.connect_intent.source_origin}`,
    evidence: snapshot("connect-intent", redactConnectIntent(intent)),
  });

  const build = spawnSync("cargo", ["build", "--manifest-path", "apps/desktop/Cargo.toml"], {
    cwd: resolve("."),
    env: process.env,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `desktop build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`);

  const desktopBinary = resolve("apps/desktop/target/debug/panda-bridge-desktop");
  desktop = spawn(desktopBinary, [], {
    cwd: resolve("."),
    env: {
      ...process.env,
      HOME: homePath,
      PANDA_BRIDGE_DESKTOP_STATE: desktopStatePath,
      PANDA_BRIDGE_SKIP_KEYCHAIN: "1",
      PANDA_BRIDGE_VERIFY: "1",
      PANDA_BRIDGE_VERIFY_CONTROL_STATE: verifyControlPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const desktopLogs = [];
  desktop.stdout.on("data", (chunk) => desktopLogs.push(String(chunk)));
  desktop.stderr.on("data", (chunk) => desktopLogs.push(String(chunk)));

  const control = await waitForControlFile(verifyControlPath, desktopLogs);
  assert.equal(control.ok, true);
  assert.match(control.base_url, /^http:\/\/127\.0\.0\.1:/);
  step("ai-control-started", {
    action: "Start Desktop with PANDA_BRIDGE_VERIFY=1",
    expected: "desktop writes formal AI control endpoint with token",
    actual: control.base_url,
    evidence: snapshot("verify-control", redactControl(control)),
  });

  const initialStatus = await controlJson(control, "GET", "/v1/status");
  const initialBurn = initialStatus.products.find((product) => product.id === PRODUCT_ID);
  assert.ok(initialBurn, "AI control status must expose Burn product");
  assert.equal(initialBurn.web_url, "https://token-burn.com/authorize");
  assert.equal(initialBurn.accounts.length, 0);
  assert.equal(initialStatus.selected_profile.profile_id, "official");
  assert.equal(initialStatus.selected_profile.account.authorized, false);
  step("ai-control-status-initial", {
    action: "Read Desktop status through AI control interface",
    expected: "Burn is visible, has token-burn authorize URL, and no account is authorized yet",
    actual: `web_url=${initialBurn.web_url}; accounts=${initialBurn.accounts.length}`,
    evidence: snapshot("initial-status", initialStatus),
  });

  const pending = await controlJson(control, "POST", "/v1/actions", {
    action: "claim_intent_preview",
    api: apiBase,
    intent: intent.token,
    device_name: "AI Control Token Burn Device",
  });
  assert.equal(pending.status, "pending");
  assert.equal(pending.product.id, PRODUCT_ID);
  assert.equal(pending.product.name, PRODUCT_NAME);
  assert.equal(pending.authorization.source_origin, TOKEN_BURN_ORIGIN);
  assert.deepEqual(pending.policy_capabilities, ["relay.envelope", "relay.ack"]);
  step("ai-control-preview", {
    action: "AI clicks authorization preview/allow staging action",
    expected: "Desktop stores pending authorization preview with product_authorization and source_origin",
    actual: `pending=${pending.pending_id}; source_origin=${pending.authorization.source_origin}`,
    evidence: snapshot("pending-preview", pending),
  });

  const previewScreenshot = await controlJson(control, "GET", "/v1/screenshot");
  assert.equal(previewScreenshot.ok, true);
  assert.ok(existsSync(previewScreenshot.path), "preview screenshot file must exist");
  assert.match(JSON.stringify(previewScreenshot.snapshot), /pending_authorizations/);
  const previewScreenshotEvidence = durableScreenshot("preview-screenshot", previewScreenshot);
  step("ai-control-preview-screenshot", {
    action: "AI captures Desktop screenshot after preview",
    expected: "built-in desktop screenshot captures pending authorization state",
    actual: previewScreenshotEvidence.path,
    evidence: snapshot("preview-screenshot", {
      path: previewScreenshotEvidence.path,
      bytes: previewScreenshotEvidence.bytes,
      pending_count: previewScreenshot.snapshot.pending_authorizations.length,
    }),
  });

  const confirmed = await controlJson(control, "POST", "/v1/actions", {
    action: "confirm_pending_intent",
    pending_id: pending.pending_id,
    intent: intent.token,
  });
  snapshot("confirmed", confirmed);
  assert.equal(confirmed.product_id, PRODUCT_ID);
  assert.equal(confirmed.product_name, PRODUCT_NAME);
  const confirmedGrant = confirmed.authorized_products.find((product) => product.id === PRODUCT_ID);
  assert.ok(confirmedGrant, "confirmed result must include Burn grant");
  assert.equal(confirmedGrant.authorization, "active");
  step("ai-control-confirm", {
    action: "AI confirms pending authorization",
    expected: "Desktop confirms Token Burn intent and starts local worker",
    actual: `device=${confirmed.device_id}; authorization=${confirmedGrant.authorization}`,
    evidence: "snapshots/confirmed.json",
  });

  const finalStatus = await waitForAuthorizedStatus(control);
  const finalBurn = finalStatus.products.find((product) => product.id === PRODUCT_ID);
  assert.ok(finalBurn, "final status must expose Burn product");
  assert.equal(finalBurn.name, PRODUCT_NAME);
  assert.equal(finalBurn.origin, TOKEN_BURN_ORIGIN);
  assert.equal(finalBurn.accounts.length, 1);
  assert.match(finalBurn.accounts[0].email, /Token Burn User|token burn|burn/i);
  assert.ok(["connected", "reconnecting", "offline"].includes(finalBurn.connection));
  assert.equal(finalStatus.selected_profile.api_base, apiBase);
  assert.equal(finalStatus.selected_profile.server.reachable, true);
  assert.equal(finalStatus.selected_profile.server.compatible, true);
  assert.equal(finalStatus.selected_profile.device.paired, true);
  assert.equal(finalStatus.selected_profile.account.authorized, true);
  assert.ok(["connected", "degraded"].includes(finalStatus.selected_profile.transport.realtime_state));
  step("ai-control-final-status", {
    action: "Read final Desktop connection state through AI control",
    expected: "Burn shows one authorized account after confirm",
    actual: `accounts=${finalBurn.accounts.length}; connection=${finalBurn.connection}; origin=${finalBurn.origin}`,
    evidence: snapshot("final-status", finalStatus),
  });

  const finalScreenshot = await controlJson(control, "GET", "/v1/screenshot");
  assert.equal(finalScreenshot.ok, true);
  assert.ok(existsSync(finalScreenshot.path), "final screenshot file must exist");
  const finalScreenshotEvidence = durableScreenshot("final-screenshot", finalScreenshot);
  step("ai-control-final-screenshot", {
    action: "AI captures Desktop screenshot after authorization",
    expected: "built-in desktop renderer captures final status",
    actual: finalScreenshotEvidence.path,
    evidence: snapshot("final-screenshot", {
      path: finalScreenshotEvidence.path,
      bytes: finalScreenshotEvidence.bytes,
      authorized_products: finalScreenshot.snapshot.status.authorized_products.map((product) => product.id),
    }),
  });

  const negative = await controlJson(control, "POST", "/v1/actions", {
    action: "missing_action_for_negative_probe",
  }, { expectOk: false });
  assert.equal(negative.error, "verify_action_failed");
  step("ai-control-structured-error", {
    action: "Call invalid AI control action",
    expected: "Desktop returns structured JSON error instead of hanging/closing",
    actual: negative.error,
    evidence: snapshot("structured-error", negative),
  });

  const summary = {
    ok: true,
    api_base: apiBase,
    token_burn_origin: TOKEN_BURN_ORIGIN,
    product_id: PRODUCT_ID,
    desktop_state_path: sanitizeString(desktopStatePath),
    verify_control: redactControl(control),
    device_id: confirmed.device_id,
    final_connection: finalBurn.connection,
    evidence: {
      steps: steps.map((item) => item.id),
      snapshots_dir: "snapshots",
    },
    checked_at: new Date().toISOString(),
  };
  writeFileSync(resolve(evidenceDir, "manifest.json"), `${JSON.stringify(sanitizeEvidence({ ok: true, steps }), null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, "summary.json"), `${JSON.stringify(sanitizeEvidence(summary), null, 2)}\n`);
  assertDurableEvidenceRedacted(evidenceDir);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (desktop) {
    desktop.kill("SIGINT");
    await new Promise((resolveDone) => {
      const timer = setTimeout(() => {
        desktop.kill("SIGKILL");
        resolveDone();
      }, 3000);
      desktop.once("exit", () => {
        clearTimeout(timer);
        resolveDone();
      });
    });
  }
  await workerServer.close();
}

function snapshot(name, payload) {
  const relative = `snapshots/${name}.json`;
  writeFileSync(resolve(evidenceDir, relative), `${JSON.stringify(sanitizeEvidence(payload), null, 2)}\n`);
  return relative;
}

function step(id, { action, expected, actual, evidence = [], result = "pass" }) {
  steps.push({
    id,
    action,
    expected,
    actual,
    evidence: Array.isArray(evidence) ? evidence : [evidence],
    result,
  });
}

function redactControl(control) {
  return {
    ok: control.ok,
    base_url: control.base_url,
    token: "[redacted]",
    pid: control.pid,
    created_at: control.created_at,
  };
}

function redactConnectIntent(payload) {
  const redacted = sanitizeEvidence(payload);
  if (redacted?.token) redacted.token = "[redacted-connect-token]";
  if (redacted?.deep_link) redacted.deep_link = "[redacted-connect-link]";
  if (redacted?.connect_intent?.token) redacted.connect_intent.token = "[redacted-connect-token]";
  if (redacted?.connect_intent?.deep_link) redacted.connect_intent.deep_link = "[redacted-connect-link]";
  return redacted;
}

function durableScreenshot(name, screenshot) {
  const target = `screenshots/${name}.png`;
  copyFileSync(screenshot.path, resolve(evidenceDir, target));
  return {
    path: target,
    bytes: readFileSync(resolve(evidenceDir, target)).byteLength,
  };
}

function sanitizeEvidence(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, sanitizeEvidence(child)]),
    );
  }
  return value;
}

function sanitizeString(value) {
  let next = value.replace(CONNECT_TOKEN_PATTERN, "[redacted-connect-token]");
  if (next.startsWith(`${repoRoot}/`)) return relative(repoRoot, next);
  if (next === repoRoot) return "[repo]";
  if (next.includes(repoRoot)) next = next.split(repoRoot).join("[repo]");
  if (next.startsWith(`${temp}/`)) return `[temp]/${relative(temp, next)}`;
  if (next === temp) return "[temp]";
  if (next.includes(temp)) next = next.split(temp).join("[temp]");
  return next;
}

function assertDurableEvidenceRedacted(dir) {
  const leaks = [];
  for (const file of listJsonFiles(dir)) {
    const text = readFileSync(file, "utf8");
    if (CONNECT_TOKEN_PATTERN.test(text)) leaks.push(`${relative(repoRoot, file)}: raw connect token`);
    CONNECT_TOKEN_PATTERN.lastIndex = 0;
    if (text.includes(repoRoot)) leaks.push(`${relative(repoRoot, file)}: repo root path`);
    if (text.includes(temp)) leaks.push(`${relative(repoRoot, file)}: temp root path`);
  }
  assert.deepEqual(leaks, [], `durable desktop-ai-control evidence is not redacted:\n${leaks.join("\n")}`);
}

function listJsonFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) return listJsonFiles(full);
    return entry.endsWith(".json") ? [full] : [];
  });
}

async function waitForAuthorizedStatus(control) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const status = await controlJson(control, "GET", "/v1/status");
    const burn = status.products.find((product) => product.id === PRODUCT_ID);
    if (burn?.accounts?.length) return status;
    await delay(250);
  }
  throw new Error("timed out waiting for authorized Burn account");
}

async function waitForControlFile(path, logs = []) {
  const started = Date.now();
  let lastText = "";
  while (Date.now() - started < 30_000) {
    if (existsSync(path)) {
      lastText = readFileSync(path, "utf8");
      if (lastText.trim()) return JSON.parse(lastText);
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for verify control file: ${path}; last=${lastText}; desktop_logs=${logs.join("").split(/\r?\n/).slice(-40).join("\n")}`);
}

async function controlJson(control, method, path, body = null, options = {}) {
  const response = await fetch(`${control.base_url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-panda-bridge-verify-token": control.token,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (options.expectOk === false) {
    assert.equal(response.ok, false, `${method} ${path} unexpectedly succeeded`);
    return payload;
  }
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function workerJson(jar, method, path, body) {
  const headers = {
    accept: "application/json",
    origin: TOKEN_BURN_ORIGIN,
    "content-type": "application/json",
  };
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  jar.store(response.headers.get("set-cookie"));
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function fetchText(url) {
  const response = await fetch(url);
  assert.ok(response.ok, `GET ${url}: ${response.status}`);
  return response.text();
}

async function startLocalWorker() {
  const env = {
    BRIDGE_LOCAL_MEMORY: "1",
    BRIDGE_ALLOWED_ORIGINS: `${TOKEN_BURN_ORIGIN} http://127.0.0.1:0`,
    BRIDGE_WEB_ORIGIN: TOKEN_BURN_ORIGIN,
    BRIDGE_PUBLIC_API_BASE: "http://127.0.0.1:0",
    BRIDGE_PRODUCT_REGISTRY_MODE: "replace",
    SESSION_COOKIE_NAME: "pb_session",
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await readIncoming(incoming);
      const port = server.address().port;
      const origin = `http://127.0.0.1:${port}`;
      const url = `${origin}${incoming.url}`;
      const path = new URL(url).pathname;
      if (incoming.method === "GET" && path === "/authorize") {
        outgoing.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "access-control-allow-origin": TOKEN_BURN_ORIGIN,
        });
        outgoing.end(`<!doctype html><html><head><title>Token Burn Authorization</title></head><body><main><h1>Token Burn</h1><button>Connect this computer</button><p>Bridge Desktop authorization for Burn.</p></main></body></html>`);
        return;
      }
      const request = new Request(url, {
        method: incoming.method,
        headers: incomingHeaders(incoming.headers),
        body: body.length && incoming.method !== "GET" && incoming.method !== "HEAD" ? body : undefined,
      });
      const response = await worker.fetch(request, {
        ...env,
        BRIDGE_PUBLIC_API_BASE: origin,
        BRIDGE_PRODUCT_REGISTRY_JSON: JSON.stringify({
          products: [{
            id: PRODUCT_ID,
            name: PRODUCT_NAME,
            official_origin: TOKEN_BURN_ORIGIN,
            official_origins: [TOKEN_BURN_ORIGIN],
            web_url: "https://token-burn.com/authorize",
            adapter_id: PRODUCT_ID,
          }],
        }),
        BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({ [PRODUCT_ID]: [TOKEN_BURN_ORIGIN] }),
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      outgoing.end(JSON.stringify({ error: "desktop_ai_control_proxy_error", message: error.message || String(error) }));
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function incomingHeaders(headers) {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result.set(key, value.join(", "));
    else if (value != null) result.set(key, value);
  }
  return result;
}

async function readIncoming(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
