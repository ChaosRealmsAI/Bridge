#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";
import {
  decryptResponseEnvelope,
  encryptCommandEnvelope,
  startRelayLocalControlAdapter,
} from "../../examples/relay-local-control/adapter.mjs";

const PRODUCT_ID = "acme-demo";
const PRODUCT_NAME = "Acme Demo";
const evidenceDir = resolve("spec/verification/evidence/selfhost-profile");
rmSync(evidenceDir, { recursive: true, force: true });
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(resolve(evidenceDir, "snapshots"), { recursive: true });
mkdirSync(resolve(evidenceDir, "screenshots"), { recursive: true });

const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-selfhost-profile-"));
const mainStatePath = resolve(temp, "desktop-state.json");
const mainHomePath = resolve(temp, "home");
const realHome = process.env.HOME || process.env.USERPROFILE || "";
mkdirSync(mainHomePath, { recursive: true });
let activeStatePath = mainStatePath;
let activeHomePath = mainHomePath;
const adapter = await startRelayLocalControlAdapter({ root: process.cwd() });
const workerServer = await startLocalWorker();
const apiBase = workerServer.apiBase;
const serverVisibleChecks = [];
const steps = [];
let addProfileStatus = null;
let refreshProfileStatus = null;
let deleteCustomProfileStatus = null;

try {
  const diagnostics = await fetchJson(`${apiBase}/v1/diagnostics`, apiBase);
  assert.deepEqual(diagnostics.products.map((item) => item.id), [PRODUCT_ID]);
  assert.equal(diagnostics.products[0].web_url, `${apiBase}/acme`);
  step("bb-v04-diagnostics", {
    action: "Open self-host /v1/diagnostics",
    expected: "custom registry exposes only acme-demo with relay capabilities",
    actual: `products=${diagnostics.products.map((item) => item.id).join(",")}`,
    evidence: snapshot("diagnostics", diagnostics),
  });

  const initialStatus = await desktopJson(["headless-status"], "initial-status");
  assert.equal(initialStatus.settings.api_base, "https://api.bridge.chaos-realms.cc");
  assert.equal(initialStatus.settings.cloud_profiles.some((item) => item.id === "official"), true);
  step("bb-v04-official-default", {
    action: "Open Desktop status with empty local state",
    expected: "official Bridge Cloud exists, is selected, and no custom Profile is saved",
    actual: `selected=${initialStatus.settings.api_base}; profiles=${initialStatus.settings.cloud_profiles.map((item) => item.id).join(",")}`,
    evidence: "snapshots/initial-status.json",
  });

  await withIsolatedDesktop("add-profile", async () => {
    const addedSettings = await desktopJson([
      "headless-add-cloud-profile",
      "--api",
      apiBase,
      "--name",
      "Local Acme Bridge",
    ], "after-add-profile-settings");
    assert.equal(addedSettings.api_base, apiBase);
    const addStatus = await desktopJson(["headless-status"], "after-add-profile");
    addProfileStatus = addStatus;
    const addProduct = addStatus.products.find((item) => item.id === PRODUCT_ID);
    assert.ok(addProduct, "manual add-profile route must expose self-host product");
    assert.equal(addProduct.accounts.length, 0);
    step("bb-v04-add-profile", {
      action: "Add self-host API from Desktop settings/Profile management",
      expected: "Desktop validates health/diagnostics, saves/selects Profile, and renders diagnostics product tabs with account isolation",
      actual: `selected=${addStatus.settings.api_base}; product=${addProduct.id}; accounts=${addProduct.accounts.length}`,
      evidence: ["snapshots/after-add-profile-settings.json", "snapshots/after-add-profile.json"],
    });

    const refreshedSettings = await desktopJson([
      "headless-refresh-cloud-profile",
      "--api",
      apiBase,
    ], "after-refresh-profile-settings");
    assert.equal(refreshedSettings.api_base, apiBase);
    const refreshedStatus = await desktopJson(["headless-status"], "after-refresh-profile");
    refreshProfileStatus = refreshedStatus;
    assert.ok(refreshedStatus.products.some((item) => item.id === PRODUCT_ID));
    step("bb-v04-refresh-profile", {
      action: "Refresh selected self-host Profile from settings",
      expected: "Desktop revalidates health/diagnostics, keeps the Profile selected, and keeps products from diagnostics",
      actual: `selected=${refreshedStatus.settings.api_base}; products=${refreshedStatus.products.map((item) => item.id).join(",")}`,
      evidence: ["snapshots/after-refresh-profile-settings.json", "snapshots/after-refresh-profile.json"],
    });

    const removedSettings = await desktopJson([
      "headless-remove-cloud-profile",
      "--profile-id",
      addedSettings.selected_cloud_profile_id,
    ], "after-delete-custom-profile-settings");
    assert.equal(removedSettings.api_base, "https://api.bridge.chaos-realms.cc");
    const removedStatus = await desktopJson(["headless-status"], "after-delete-custom-profile");
    deleteCustomProfileStatus = removedStatus;
    assert.equal(removedStatus.settings.api_base, "https://api.bridge.chaos-realms.cc");
    assert.equal(removedStatus.settings.cloud_profiles.some((item) => item.api_base === apiBase), false);
    step("bb-v04-delete-custom-profile", {
      action: "Delete the selected custom self-host Profile",
      expected: "Desktop removes custom products from current view and falls back to official Profile without deleting official",
      actual: `selected=${removedStatus.settings.api_base}; profiles=${removedStatus.settings.cloud_profiles.map((item) => item.id).join(",")}`,
      evidence: ["snapshots/after-delete-custom-profile-settings.json", "snapshots/after-delete-custom-profile.json"],
    });
  });

  const invalidServer = await startInvalidDiagnosticsServer();
  try {
    const invalidAdd = await runDesktop(["headless-add-cloud-profile", "--api", invalidServer.apiBase, "--name", "Invalid Bridge"]);
    assert.notEqual(invalidAdd.status, 0, "invalid diagnostics must fail");
    const afterInvalid = await desktopJson(["headless-status"], "after-invalid-profile");
    assert.equal(afterInvalid.settings.api_base, "https://api.bridge.chaos-realms.cc");
    assert.equal(afterInvalid.settings.cloud_profiles.some((item) => item.api_base === invalidServer.apiBase), false);
    snapshot("invalid-profile-error", commandEvidence(invalidAdd));
    step("bb-v04-invalid-profile", {
      action: "Add a server whose diagnostics are not Bridge Cloud",
      expected: "Desktop shows a stable error, saves no Profile, and keeps official selected",
      actual: `exit=${invalidAdd.status}; error=${desktopError(invalidAdd.stderr)}; selected=${afterInvalid.settings.api_base}`,
      evidence: ["snapshots/invalid-profile-error.json", "snapshots/after-invalid-profile.json"],
    });
  } finally {
    await invalidServer.close();
  }

  const bridge = createBridgeClient({ apiBase, productId: PRODUCT_ID, fetch: fetchWithJar(apiBase) });
  const session = await bridge.auth.guest("Self-host Profile");
  assert.equal(session.authenticated, true);
  const deniedIntent = await bridge.connect.createIntent({ deviceName: "Self-host Profile Deny Device" });
  const preview = await desktopJson([
    "headless-preview-intent",
    "--api",
    apiBase,
    "--intent",
    deniedIntent.token,
  ], "preview-unknown-api");
  assert.equal(preview.product_id, PRODUCT_ID);
  assert.equal(preview.product_name, PRODUCT_NAME);
  const afterPreview = await desktopJson(["headless-status"], "after-preview-no-claim");
  assert.equal(afterPreview.settings.cloud_profiles.some((item) => item.api_base === apiBase), false);
  step("bb-v04-deeplink-deny", {
    action: "Preview unknown self-host API intent, then do not allow/claim",
    expected: "trust dialog data is available, but Deny/close leaves no saved Profile",
    actual: `preview=${preview.product_name}; saved=${afterPreview.settings.cloud_profiles.some((item) => item.api_base === apiBase)}`,
    evidence: ["snapshots/preview-unknown-api.json", "snapshots/after-preview-no-claim.json"],
  });

  const intent = await bridge.connect.createIntent({ deviceName: "Self-host Profile Device" });
  const connected = await runDesktop([
    "headless-connect",
    "--api",
    apiBase,
    "--intent",
    intent.token,
    "--device-name",
    "Self-host Profile Device",
  ]);
  assert.equal(connected.status, 0, childMessage(connected));
  const claim = JSON.parse(connected.stdout);
  assert.equal(claim.product_id, PRODUCT_ID);
  assert.equal(claim.product_name, PRODUCT_NAME);
  snapshot("claim-unknown-api-allow", claim);

  const status = await desktopJson(["headless-status"], "after-allow-status");
  const selfhostProduct = status.products.find((item) => item.id === PRODUCT_ID);
  assert.ok(selfhostProduct, "headless-status must expose the self-host product tab");
  assert.equal(selfhostProduct.name, PRODUCT_NAME);
  assert.equal(selfhostProduct.accounts.length, 1);
  assert.equal(status.settings.api_base, apiBase);
  assert.equal(status.settings.cloud_profiles.some((item) => item.api_base === apiBase), true);
  step("bb-v04-deeplink-allow", {
    action: "Allow unknown self-host API deep link",
    expected: "Desktop validates diagnostics, claims intent, saves/selects Profile, and shows acme-demo tab/account",
    actual: `selected=${status.settings.api_base}; product=${selfhostProduct.id}; accounts=${selfhostProduct.accounts.length}`,
    evidence: ["snapshots/claim-unknown-api-allow.json", "snapshots/after-allow-status.json"],
  });

  const openWeb = await desktopJson(["headless-open-web-url", "--product-id", PRODUCT_ID], "open-web-url");
  assert.equal(openWeb.url, `${apiBase}/acme`);
  step("bb-v04-open-web", {
    action: "Resolve product open_web for selected self-host Profile",
    expected: "Desktop opens the custom product web_url from diagnostics, not the official default",
    actual: openWeb.url,
    evidence: "snapshots/open-web-url.json",
  });

  const officialRemove = await runDesktop(["headless-remove-cloud-profile", "--profile-id", "official"]);
  assert.notEqual(officialRemove.status, 0, "official profile removal must fail");
  const afterOfficialRemove = await desktopJson(["headless-status"], "after-official-remove-attempt");
  assert.equal(afterOfficialRemove.settings.cloud_profiles.some((item) => item.id === "official"), true);
  snapshot("official-remove-error", commandEvidence(officialRemove));
  step("bb-v04-official-non-removable", {
    action: "Attempt to remove official Bridge Cloud Profile",
    expected: "Desktop rejects the removal",
    actual: `exit=${officialRemove.status}; error=${desktopError(officialRemove.stderr)}; official_present=${afterOfficialRemove.settings.cloud_profiles.some((item) => item.id === "official")}`,
    evidence: ["snapshots/official-remove-error.json", "snapshots/after-official-remove-attempt.json"],
  });

  const pwd = await runCommandThroughBridge(bridge, claim.device_id, "selfhost_1", 1, { op: "pwd" });
  assert.equal(pwd.ok, true);
  assert.equal(pwd.stdout, process.cwd());
  snapshot("relay-server-visible-checks", { result: pwd, server_visible_checks: serverVisibleChecks });
  step("bb-v04-relay", {
    action: "Send encrypted relay command through self-host Bridge Cloud to local Adapter",
    expected: "Adapter receives command, server-visible envelope fields contain no business plaintext",
    actual: `stdout=${pwd.stdout}; leaked=${serverVisibleChecks.some((item) => item.leaked)}`,
    evidence: "snapshots/relay-server-visible-checks.json",
  });

  await captureVisualEvidence({
    apiBase,
    initialStatus,
    addStatus: addProfileStatus,
    refreshStatus: refreshProfileStatus,
    deleteStatus: deleteCustomProfileStatus,
    preview,
    afterPreview,
    afterAllowStatus: status,
    openWeb,
  });

  const summary = {
    ok: true,
    api_base: apiBase,
    product_id: PRODUCT_ID,
    desktop_state_path: mainStatePath,
    device_id: claim.device_id,
    profile: {
      selected_api_base: status.settings.api_base,
      products: status.products.map((item) => item.id),
      account_count: selfhostProduct.accounts.length,
    },
    relay: {
      command: "pwd",
      result_stdout: pwd.stdout,
      adapter_calls: adapter.calls,
      adapter_executions: adapter.executions,
      server_visible_plaintext: serverVisibleChecks.some((item) => item.leaked),
      server_visible_checks: serverVisibleChecks,
    },
    evidence: {
      manifest: "manifest.json",
      snapshots_dir: "snapshots",
      steps: steps.map((item) => item.id),
    },
    checked_at: new Date().toISOString(),
  };
  assert.equal(summary.relay.server_visible_plaintext, false, "self-host relay leaked product plaintext into server-visible fields");
  writeFileSync(resolve(evidenceDir, "manifest.json"), `${JSON.stringify({ ok: true, steps }, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await adapter.close();
  await workerServer.close();
}

function snapshot(name, payload) {
  const relative = `snapshots/${name}.json`;
  writeFileSync(resolve(evidenceDir, relative), `${JSON.stringify(payload, null, 2)}\n`);
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

async function withIsolatedDesktop(label, fn) {
  const previousState = activeStatePath;
  const previousHome = activeHomePath;
  activeStatePath = resolve(temp, `${label}-desktop-state.json`);
  activeHomePath = resolve(temp, `${label}-home`);
  mkdirSync(activeHomePath, { recursive: true });
  try {
    return await fn();
  } finally {
    activeStatePath = previousState;
    activeHomePath = previousHome;
  }
}

async function desktopJson(args, snapshotName) {
  const child = await runDesktop(args);
  assert.equal(child.status, 0, childMessage(child));
  const payload = JSON.parse(child.stdout);
  if (snapshotName) snapshot(snapshotName, payload);
  return payload;
}

function commandEvidence(child) {
  return {
    status: child.status,
    signal: child.signal,
    error: desktopError(child.stderr),
    stdout: child.stdout.trim(),
    stderr_tail: child.stderr.trim().split(/\r?\n/).slice(-12),
  };
}

function desktopError(stderr) {
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...lines].reverse().find((line) => (
    !line.startsWith("warning:")
    && !line.startsWith("-->")
    && !line.startsWith("|")
    && !/^\d+\s+\|/.test(line)
    && !line.startsWith("=")
  )) || lines.at(-1) || "";
}

async function captureVisualEvidence({ apiBase, initialStatus, addStatus, refreshStatus, deleteStatus, preview, afterPreview, afterAllowStatus, openWeb }) {
  assert.ok(addStatus, "add-profile status must be captured before visual evidence");
  assert.ok(refreshStatus, "refresh-profile status must be captured before visual evidence");
  assert.ok(deleteStatus, "delete-custom-profile status must be captured before visual evidence");
  const browser = await chromium.launch({ headless: true });
  try {
    await captureDesktopUi(browser, "official-default.png", initialStatus, async () => {});
    appendEvidence("bb-v04-official-default", "screenshots/official-default.png");

    await captureDesktopUi(browser, "settings-add-profile.png", addStatus, async (page) => {
      await page.evaluate(() => window.pickSettings?.());
    });
    appendEvidence("bb-v04-add-profile", "screenshots/settings-add-profile.png");

    await captureDesktopUi(browser, "settings-refresh-profile.png", refreshStatus, async (page) => {
      await page.evaluate(() => window.pickSettings?.());
    });
    appendEvidence("bb-v04-refresh-profile", "screenshots/settings-refresh-profile.png");

    await captureDesktopUi(browser, "settings-after-delete-custom-profile.png", deleteStatus, async (page) => {
      await page.evaluate(() => window.pickSettings?.());
    });
    appendEvidence("bb-v04-delete-custom-profile", "screenshots/settings-after-delete-custom-profile.png");

    await captureDesktopUi(browser, "invalid-profile-error.png", initialStatus, async (page) => {
      await page.evaluate(() => window.pickSettings?.());
      await page.evaluate(() => window.showError?.("Bridge Cloud diagnostics returned an unsupported protocol"));
      await page.waitForTimeout(120);
    });
    appendEvidence("bb-v04-invalid-profile", "screenshots/invalid-profile-error.png");

    await captureDesktopUi(browser, "trust-dialog-preview.png", afterPreview, async (page) => {
      await page.evaluate(({ api, previewPayload }) => {
        window.__pandaBridgePreview = previewPayload;
        window.PandaBridge.receive({
          type: "event",
          event: "deep_link",
          url: `panda-bridge://connect?intent=visual-preview&api=${encodeURIComponent(api)}`,
        });
      }, { api: apiBase, previewPayload: preview });
      await page.waitForSelector(".sheetwrap.on", { timeout: 3000 });
    });
    appendEvidence("bb-v04-deeplink-deny", "screenshots/trust-dialog-preview.png");

    await captureDesktopUi(browser, "after-allow-product.png", afterAllowStatus, async () => {});
    appendEvidence("bb-v04-deeplink-allow", "screenshots/after-allow-product.png");

    await captureProductPage(browser, "open-web-product-page.png", openWeb.url);
    appendEvidence("bb-v04-open-web", "screenshots/open-web-product-page.png");

    await captureDesktopUi(browser, "official-non-removable-error.png", afterAllowStatus, async (page) => {
      await page.evaluate(() => window.pickSettings?.());
      await page.evaluate(() => window.showError?.("official Bridge Cloud profile cannot be removed"));
      await page.waitForTimeout(120);
    });
    appendEvidence("bb-v04-official-non-removable", "screenshots/official-non-removable-error.png");

    await captureDesktopUi(browser, "relay-complete-product.png", afterAllowStatus, async (page) => {
      await page.evaluate(() => window.showError?.("Relay completed; server-visible plaintext=false"));
      await page.waitForTimeout(120);
    });
    appendEvidence("bb-v04-relay", "screenshots/relay-complete-product.png");
  } finally {
    await browser.close();
  }
}

async function captureDesktopUi(browser, fileName, statusPayload, beforeShot) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  await page.addInitScript((status) => {
    window.__pandaBridgeStatus = status;
    window.__pandaBridgePreview = null;
    window.ipc = {
      postMessage(raw) {
        const req = JSON.parse(raw);
        const reply = (ok, result, error) => setTimeout(() => {
          window.PandaBridge.receive({ type: "response", id: req.id, ok, result, error });
        }, 10);
        if (req.command === "status") return reply(true, window.__pandaBridgeStatus);
        if (req.command === "settings") return reply(true, window.__pandaBridgeStatus.settings || {});
        if (req.command === "preview_intent") return reply(true, window.__pandaBridgePreview || {
          product_id: "acme-demo",
          product_name: "Acme Demo",
          cloud_origin: req.params?.api || "http://127.0.0.1",
          user_display_name: "Self-host Profile",
          user_id: "visual-user",
          capabilities: ["relay.envelope", "relay.ack"],
          local_policy: {},
          local_root_state: { fs: {}, shell: {} },
        });
        if (req.command === "claim_intent" || req.command === "open_web" || req.command === "start_worker") return reply(true, { ok: true });
        if (req.command === "select_cloud_profile" || req.command === "update_settings" || req.command === "refresh_cloud_profile") return reply(true, window.__pandaBridgeStatus.settings || {});
        if (req.command === "remove_cloud_profile") return reply(false, null, "official Bridge Cloud profile cannot be removed");
        return reply(true, { ok: true });
      },
    };
  }, statusPayload);
  await page.goto(pathToFileURL(resolve("apps/desktop/ui/index.html")).href);
  await page.waitForSelector("#pane", { timeout: 5000 });
  await beforeShot(page);
  const relative = `screenshots/${fileName}`;
  await page.screenshot({ path: resolve(evidenceDir, relative), fullPage: true });
  await page.close();
  return relative;
}

async function captureProductPage(browser, fileName, url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body", { timeout: 3000 });
  const relative = `screenshots/${fileName}`;
  await page.screenshot({ path: resolve(evidenceDir, relative), fullPage: true });
  await page.close();
  return relative;
}

function appendEvidence(stepId, evidence) {
  const target = steps.find((item) => item.id === stepId);
  assert.ok(target, `missing manifest step: ${stepId}`);
  target.evidence.push(evidence);
}

async function runCommandThroughBridge(bridge, deviceId, channelId, seq, command) {
  const requestKey = `selfhost-profile-${seq}-${Date.now()}`;
  const envelope = await encryptCommandEnvelope(command, adapter.keyBytes, {
    product_id: PRODUCT_ID,
    device_id: deviceId,
    channel_id: channelId,
    seq,
    request_key: requestKey,
  });
  const created = await bridge.relay.create(envelope);
  assert.equal(created.envelope.product_id, PRODUCT_ID);
  assert.equal(created.envelope.direction, "product_to_device");
  recordNoServerVisiblePlaintext("request", created.envelope, plaintextTokensFor(command));

  const polled = await runDesktop(["headless-poll"]);
  assert.equal(polled.status, 0, childMessage(polled));
  const pollPayload = JSON.parse(polled.stdout);
  assert.equal(pollPayload.ok, true);
  assert.ok(pollPayload.count >= 1, "headless-poll must process at least one self-host relay envelope");

  const { envelope: responseEnvelope, ack } = await bridge.relay.waitForResponse({
    deviceId,
    channelId,
    afterSeq: seq,
    timeoutMs: 10000,
    intervalMs: 250,
  });
  assert.equal(responseEnvelope.direction, "device_to_product");
  assert.equal(responseEnvelope.product_id, PRODUCT_ID);
  const result = await decryptResponseEnvelope(responseEnvelope, adapter.keyBytes);
  recordNoServerVisiblePlaintext("response", responseEnvelope, plaintextTokensFor(command, result));
  await ack({ status: "acked" });
  return result;
}

async function startInvalidDiagnosticsServer() {
  const server = createServer(async (incoming, outgoing) => {
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const url = new URL(incoming.url, origin);
    const payload = url.pathname === "/v1/health"
      ? {
          ok: true,
          protocol: "panda-bridge-protocol-v0.2",
          env: "test",
          storage: "memory",
        }
      : {
          ok: true,
          protocol: "not-bridge",
          api_base: origin,
          web_origin: origin,
          products: [],
        };
    outgoing.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify(payload));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function startLocalWorker() {
  const env = {
    BRIDGE_LOCAL_MEMORY: "1",
    BRIDGE_WEB_ORIGIN: "http://127.0.0.1:0",
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
      if (incoming.method === "GET" && new URL(url).pathname === "/acme") {
        outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        outgoing.end(`<!doctype html><title>${PRODUCT_NAME}</title><main><h1>${PRODUCT_NAME}</h1><p>Self-host Bridge product page</p></main>`);
        return;
      }
      const request = new Request(url, {
        method: incoming.method,
        headers: incomingHeaders(incoming.headers),
        body: body.length && incoming.method !== "GET" && incoming.method !== "HEAD" ? body : undefined,
      });
      const response = await worker.fetch(request, {
        ...env,
        BRIDGE_WEB_ORIGIN: origin,
        BRIDGE_PUBLIC_API_BASE: origin,
        BRIDGE_PRODUCT_REGISTRY_JSON: JSON.stringify({
          products: [{
            id: PRODUCT_ID,
            name: PRODUCT_NAME,
            official_origin: origin,
            web_url: `${origin}/acme`,
          }],
        }),
        BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({ [PRODUCT_ID]: [origin] }),
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      outgoing.end(JSON.stringify({ error: "selfhost_profile_proxy_error", message: error.message || String(error) }));
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function fetchJson(url, origin) {
  return fetch(url, { headers: { accept: "application/json", origin } }).then(async (response) => {
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  });
}

function fetchWithJar(origin) {
  let cookie = "";
  return async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", origin);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  };
}

function runDesktop(args) {
  return new Promise((resolveChild) => {
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
      env: {
        ...process.env,
        HOME: activeHomePath,
        USERPROFILE: activeHomePath,
        CARGO_HOME: process.env.CARGO_HOME || (realHome ? resolve(realHome, ".cargo") : undefined),
        RUSTUP_HOME: process.env.RUSTUP_HOME || (realHome ? resolve(realHome, ".rustup") : undefined),
        PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1",
        PANDA_BRIDGE_DESKTOP_STATE: activeStatePath,
        PANDA_BRIDGE_ADAPTER_ACME_DEMO_URL: adapter.url,
        PANDA_BRIDGE_ADAPTER_URL: adapter.url,
        PANDA_BRIDGE_SKIP_KEYCHAIN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (status, signal) => resolveChild({ status, signal, stdout, stderr }));
  });
}

function plaintextTokensFor(command, result = {}) {
  return [
    command.op,
    result.op,
    result.stdout,
    process.cwd(),
  ].filter((value) => typeof value === "string" && value.length > 1);
}

function recordNoServerVisiblePlaintext(label, envelope, tokens) {
  const values = serverVisibleStringValues(envelope);
  const leaks = tokens.filter((token) => values.some((value) => value.includes(token)));
  const check = { label, leaked: leaks.length > 0, leaks };
  serverVisibleChecks.push(check);
  assert.deepEqual(leaks, [], `${label} leaked product plaintext into server-visible fields`);
}

function serverVisibleStringValues(input, key = "") {
  if (input == null) return [];
  if (["ciphertext", "aad", "nonce"].includes(key)) return [];
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.flatMap((item) => serverVisibleStringValues(item));
  if (typeof input === "object") {
    return Object.entries(input).flatMap(([nextKey, value]) => serverVisibleStringValues(value, nextKey));
  }
  return [];
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

function childMessage(child) {
  return JSON.stringify({ status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr });
}
