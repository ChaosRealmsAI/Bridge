#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { chromium } from "playwright";

const root = resolve(new URL("../..", import.meta.url).pathname);
const evidenceDir = resolve(root, "spec/L3/evidence/desktop-ui-smoke");
const RAW_EMAIL_LIKE_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const CONNECT_TOKEN_PATTERN = /\bpbi_[A-Za-z0-9._~-]+/g;
mkdirSync(evidenceDir, { recursive: true });
const indexSource = readFileSync(resolve(root, "apps/desktop/ui/index.html"), "utf8");
const cssSource = readFileSync(resolve(root, "apps/desktop/ui/styles.css"), "utf8");
const jsSource = readFileSync(resolve(root, "apps/desktop/ui/app.js"), "utf8");
const uiSource = [indexSource, cssSource, jsSource].join("\n");
const compiledHtml = indexSource
  .replace("__PANDA_BRIDGE_DESKTOP_CSS__", cssSource)
  .replace("__PANDA_BRIDGE_DESKTOP_JS__", jsSource);
assert.equal(compiledHtml.includes("__PANDA_BRIDGE_DESKTOP_CSS__"), false, "compiled smoke HTML must embed CSS");
assert.equal(compiledHtml.includes("__PANDA_BRIDGE_DESKTOP_JS__"), false, "compiled smoke HTML must embed JS");
const compiledHtmlPath = resolve(evidenceDir, "compiled-index.html");
writeFileSync(compiledHtmlPath, compiledHtml);
const htmlUrl = `file://${compiledHtmlPath}`;

const stalePermissionUiMarkers = [
  "fsRows",
  "dangerHtml",
  "dangerFromPreview",
  "pickRoot",
  "pick_local_root",
  "workspace_roots",
  "permission_preset",
  "permCwd",
  "permNet",
  "permSub",
  "dp-pick",
  "d.shell",
  "shell.run",
];
for (const marker of stalePermissionUiMarkers) {
  assert.equal(uiSource.includes(marker), false, `Desktop UI source must not contain stale permission UI marker: ${marker}`);
}

function assertNoRawEmailLikeStateText(item) {
  assert.equal(
    RAW_EMAIL_LIKE_PATTERN.test(item.state.text),
    false,
    `${item.name}: captured state text must not contain raw email-like values`,
  );
}

async function inspectScenario(name, options = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 820, height: 568 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  const logs = [];
  page.on("pageerror", (error) => errors.push(String(error.stack || error)));
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  if (options.nativeStuck) {
    await page.addInitScript(() => {
      window.ipc = { postMessage() {} };
    });
  }

  const started = Date.now();
  await page.goto(`${htmlUrl}${options.query || ""}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll(".pnode").length > 0);
  const visibleAtMs = Date.now() - started;
  if (options.action) await options.action(page);
  await page.waitForTimeout(options.waitMs ?? 250);

  const screenshot = `${name}.png`;
  const screenshotPath = resolve(evidenceDir, screenshot);
  await page.screenshot({ path: screenshotPath });
  const screenshotBytes = readFileSync(screenshotPath).byteLength;
  const state = await page.evaluate(() => {
    const text = document.body.innerText;
    const product = document.querySelector(".pnode")?.getBoundingClientRect();
    const empty = document.querySelector(".empty")?.getBoundingClientRect();
    const sheet = document.querySelector(".sheetwrap.on")?.getBoundingClientRect();
    return {
      text,
      productCount: document.querySelectorAll(".pnode").length,
      productNames: [...document.querySelectorAll(".pnode .pname")].map((item) => item.textContent.trim()),
      profileOptions: [...document.querySelectorAll("option")].map((item) => item.textContent.trim()),
      serverNames: [...document.querySelectorAll(".srv-name .nm")].map((item) => item.textContent.trim()),
      serverHealth: [...document.querySelectorAll(".srv-health")].map((item) => item.textContent.trim()),
      serverDetails: [...document.querySelectorAll(".srv-detail")].map((item) => item.textContent.trim()),
      localComputerName: document.querySelector(".local-name")?.textContent.trim() || "",
      localComputerSub: document.querySelector(".local-sub")?.textContent.trim() || "",
      localComputerFingerprint: document.querySelector(".local-fp")?.textContent.trim() || "",
      localDevice: typeof ui !== "undefined" ? ui.status?.local_device || null : null,
      selectedProfile: typeof ui !== "undefined" ? ui.status?.selected_profile || null : null,
      hasBurnSvg: Boolean(document.querySelector(".ptile svg")),
      hasEmptyLogo: Boolean(document.querySelector(".elogo svg")),
      hasSheet: Boolean(document.querySelector(".sheetwrap.on")),
      allowButtonBusy: document.querySelector("#allowIntentButton")?.getAttribute("aria-busy") === "true",
      allowButtonText: document.querySelector("#allowIntentButton")?.textContent.trim() || "",
      allowButtonDisabled: Boolean(document.querySelector("#allowIntentButton")?.disabled),
      productBox: product ? { width: product.width, height: product.height } : null,
      emptyBox: empty ? { width: empty.width, height: empty.height } : null,
      sheetBox: sheet ? { width: sheet.width, height: sheet.height } : null,
    };
  });
  await browser.close();

  assert.deepEqual(errors, [], `${name}: page errors must be empty`);
  assert.equal(state.productCount, 1, `${name}: one product tab should render`);
  assert.equal(state.hasBurnSvg, true, `${name}: Burn tab SVG should render`);
  assert.ok(screenshotBytes > 50_000, `${name}: screenshot should not be blank`);
  assert.ok(visibleAtMs < 1_000, `${name}: first product UI should appear within 1000ms`);

  return { name, visibleAtMs, screenshot, screenshotBytes, state, logs };
}

const fallbackEmpty = await inspectScenario("fallback-empty", {
  query: "?empty=1&theme=dark",
});
assert.match(fallbackEmpty.state.text, /Burn/);
assert.match(fallbackEmpty.state.text, /Open Burn/);
assert.match(fallbackEmpty.state.text, /waiting for connection requests/i);
assert.equal(fallbackEmpty.state.hasEmptyLogo, true, "empty state must render Burn SVG");
assert.ok(fallbackEmpty.state.emptyBox?.height > 300, "empty state should occupy the main pane");
assert.equal(fallbackEmpty.state.selectedProfile?.profile_id, "official", "fallback starts on official profile");
assert.equal(fallbackEmpty.state.selectedProfile?.server?.reachable, null, "fallback official profile must not imply production reachability");
assert.equal(fallbackEmpty.state.selectedProfile?.server?.compatible, null, "fallback official profile must not imply production compatibility");
assert.equal(fallbackEmpty.state.selectedProfile?.server?.probe_latency_ms ?? null, null, "fallback official profile must not invent production latency");
assert.equal(fallbackEmpty.state.selectedProfile?.server?.source, "demo_not_probed", "fallback official status must be clearly demo/unprobed");

const nativeStuck = await inspectScenario("native-stuck", {
  nativeStuck: true,
  waitMs: 150,
});
assert.match(nativeStuck.state.text, /Local engine .* starting/i);
assert.match(nativeStuck.state.text, /Connect Burn/);
assert.equal(nativeStuck.state.hasEmptyLogo, true, "native-stuck first frame must render Burn SVG");

const missingLocalDeviceSettings = await inspectScenario("missing-local-device-settings", {
  query: "?settings=1&theme=dark",
  async action(page) {
    await page.waitForFunction(() => typeof ui !== "undefined" && !ui.booting && ui.status && ui.settings);
    await page.waitForTimeout(350);
    await page.evaluate(() => {
      ui.view = "settings";
      ui.status = { ...ui.status, local_device: null };
      render();
    });
  },
});
assert.equal(missingLocalDeviceSettings.state.localDevice, null, "missing native status should keep local_device absent");
assert.match(missingLocalDeviceSettings.state.text, /Local computer unavailable|本机信息暂不可用|本機資訊暫不可用|ローカル情報を取得できません/);
assert.equal(missingLocalDeviceSettings.state.localComputerFingerprint, "--", "missing native local info must not render PB-UNKNOWN");
assert.doesNotMatch(missingLocalDeviceSettings.state.text, /PB-UNKNOWN|local_install/i, "missing native local info must not claim a local install identity");

const myServerSettings = await inspectScenario("my-server-settings", {
  query: "?settings=1&theme=dark",
  async action(page) {
    await page.evaluate(() => window.openServerSheet());
    await page.locator("#cloudApiInput").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator("#cloudApiInput").fill("http://127.0.0.1:8787");
    await page.locator("#pairTokenInput").fill("desktop-ui-smoke-token");
    await page.evaluate(async () => {
      ui.serverSheet = { api: "http://127.0.0.1:8787", token: "desktop-ui-smoke-token", busy: false, error: "" };
      await submitPairServer();
      await refresh();
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll(".srv-name .nm")].some((item) => item.textContent.trim() === "My Server"),
      undefined,
      { timeout: 15_000 },
    );
  },
});
assert.match(myServerSettings.state.text, /My Server/);
assert.ok(myServerSettings.state.productNames.includes("Burn"), "My Server route must keep the fixed Burn product tab visible");
assert.ok(myServerSettings.state.serverNames.includes("My Server"), "My Server should render as a server card");
assert.equal(myServerSettings.state.selectedProfile?.label, "My Server", "selected-profile status should follow My Server");
assert.equal(myServerSettings.state.selectedProfile?.server?.reachable, true, "My Server should expose a real probe-backed reachable status");
assert.equal(myServerSettings.state.selectedProfile?.server?.probe_latency_ms, 12, "smoke/demo self-host status should expose explicit demo probe latency");
assert.equal(myServerSettings.state.selectedProfile?.device?.paired, true, "My Server pairing should be shown separately from authorization");
assert.equal(myServerSettings.state.selectedProfile?.account?.authorized, false, "Pairing alone must not mark the account authorized");
assert.equal(myServerSettings.state.selectedProfile?.local_engine?.running, false, "unauthorized My Server must not show a running local engine");
assert.equal(myServerSettings.state.selectedProfile?.transport?.realtime_connected, false, "unauthorized My Server must not show realtime connected");
assert.equal(myServerSettings.state.selectedProfile?.transport?.polling_active, false, "unauthorized My Server must not show polling active");
assert.equal(myServerSettings.state.localDevice?.identity_source, "local_install", "settings status should expose local install identity source");
assert.match(myServerSettings.state.localDevice?.fingerprint || "", /^PB-[A-Z0-9]{8,24}$/, "settings status should expose public PB fingerprint");
assert.equal(myServerSettings.state.localComputerName, "Smoke Local Computer", "settings should render Local Computer display name");
assert.match(myServerSettings.state.localComputerSub, /Desktop|Mac|windows|macos|linux/i, "settings should render local model/system details");
assert.equal(myServerSettings.state.localComputerFingerprint, myServerSettings.state.localDevice.fingerprint, "settings should render the sanitized public fingerprint");
assert.doesNotMatch(JSON.stringify(myServerSettings.state.localDevice), /install-|Users\/|@|token|pbd_|pbi_/i, "local device info must not expose raw local secrets");
const myServerRowIndex = myServerSettings.state.serverNames.indexOf("My Server");
assert.notEqual(myServerRowIndex, -1, "My Server should have a detail row");
const myServerHealth = myServerSettings.state.serverHealth[myServerRowIndex] || "";
const myServerDetail = myServerSettings.state.serverDetails[myServerRowIndex] || "";
assert.match(myServerDetail, /\bNot authorized\b/i, "My Server detail should show Not authorized");
assert.ok(
  !/^Online\b/i.test(myServerHealth) && !/\bOnline\b/i.test(myServerDetail),
  "Pairing without account authorization must not render My Server as full Online",
);

const officialServerError = await inspectScenario("official-server-error", {
  query: "?settings=1&theme=dark&officialError=1",
});
assert.match(officialServerError.state.text, /Official server probe failed/);
assert.equal(officialServerError.state.selectedProfile?.profile_id, "official", "official error fallback must stay on the official profile");
assert.equal(officialServerError.state.selectedProfile?.server?.error, "Official server probe failed", "official server fallback must surface the sanitized live.server.error");
assert.equal(officialServerError.state.serverDetails[0], "Official server probe failed", "official server detail text should render the active profile error");
assert.equal(/\bOffline\b/i.test(officialServerError.state.serverDetails[0]), false, "official server detail should not collapse to a generic Offline label");

const officialServerPersistedError = await inspectScenario("official-server-persisted-error", {
  query: "?theme=dark",
  async action(page) {
    await page.waitForFunction(() => typeof ui !== "undefined" && !ui.booting && ui.status && ui.settings);
    await page.evaluate(() => {
      const official = {
        id: "official",
        name: "Official Cloud",
        api_base: "https://api.bridge.chaos-realms.cc",
        web_origin: "https://token-burn.com",
        source: "official",
        updated_at: "probe_error:unix:1|Official server probe failed",
        products: [],
      };
      const selfhost = {
        id: "selfhost_smoke",
        name: "My Server",
        api_base: "http://127.0.0.1:8787",
        web_origin: "http://127.0.0.1:8787",
        source: "selfhost",
        updated_at: "probe:unix:1|latency_ms:12",
        products: [],
      };
      ui.view = "settings";
      ui.health = {};
      ui.settings = {
        ...ui.settings,
        api_base: selfhost.api_base,
        cloud_profiles: [official, selfhost],
        selected_cloud_profile_id: selfhost.id,
      };
      ui.status = {
        ...ui.status,
        worker_running: true,
        realtime_connected: true,
        selected_profile: {
          profile_id: selfhost.id,
          label: "My Server",
          api_base: selfhost.api_base,
          server: {
            reachable: true,
            compatible: true,
            last_probe_at: new Date().toISOString(),
            error: null,
            source: "demo_profile_probe",
            probe_latency_ms: 12,
          },
          device: {
            paired: true,
            present: true,
            last_seen_at: new Date().toISOString(),
            device_id: "smoke_device",
            device_name: "Smoke Device",
          },
          account: {
            authorized: true,
            authorization_state: "active",
            account_id: "demo_burn",
            account_display: "Burn Demo Identity",
            product_ids: ["panda-burn"],
          },
          local_engine: {
            running: true,
            adapter_health: "configured",
            adapter_configured: true,
            adapter_running: true,
            adapter_products: [{ product_id: "panda-burn", state: "configured", configured: true, running: true, endpoint_source: "mock" }],
          },
          transport: {
            realtime_state: "connected",
            polling_state: "active",
            realtime_connected: true,
            polling_active: true,
            degraded_reason: null,
          },
        },
      };
      render();
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll(".srv-detail")].some((item) => item.textContent.trim() === "Official server probe failed"),
      undefined,
      { timeout: 15_000 },
    );
  },
});
assert.equal(officialServerPersistedError.state.selectedProfile?.profile_id, "selfhost_smoke", "persisted official error scenario must keep self-host selected");
const persistedOfficialRowIndex = officialServerPersistedError.state.serverNames.indexOf("Official Cloud");
assert.notEqual(persistedOfficialRowIndex, -1, "official card should remain visible when self-host is selected");
assert.equal(
  officialServerPersistedError.state.serverDetails[persistedOfficialRowIndex],
  "Official server probe failed",
  "non-selected official card should render persisted sanitized probe_error detail",
);
assert.match(officialServerPersistedError.state.serverHealth[persistedOfficialRowIndex] || "", /\bOffline\b/i, "persisted probe_error should not render as reachable");
assert.equal(/\b\d+ms\b/.test(officialServerPersistedError.state.serverHealth[persistedOfficialRowIndex] || ""), false, "persisted probe_error should not render latency");

const authSheet = await inspectScenario("authorization-sheet", {
  query: "?sheet=1&theme=dark",
  waitMs: 800,
});
assert.equal(authSheet.state.hasSheet, true, "authorization sheet should open");
assert.match(authSheet.state.text, /source_origin/);
assert.match(authSheet.state.text, /https:\/\/token-burn\.com/);
assert.match(authSheet.state.text, /product_authorization/);
assert.ok(authSheet.state.sheetBox?.height > 400, "authorization sheet should be visible");

const authSheetLoading = await inspectScenario("authorization-sheet-loading", {
  query: "?sheet=1&theme=dark&slowConfirm=1",
  waitMs: 150,
  async action(page) {
    await page.locator("#allowIntentButton").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator("#allowIntentButton").click();
    await page.locator("#allowIntentButton[aria-busy='true']").waitFor({ state: "visible", timeout: 2_000 });
  },
});
assert.equal(authSheetLoading.state.hasSheet, true, "authorization loading sheet should remain visible while confirming");
assert.equal(authSheetLoading.state.allowButtonBusy, true, "Allow button should expose aria-busy while confirming");
assert.equal(authSheetLoading.state.allowButtonDisabled, true, "Allow button should be disabled while confirming");
assert.match(authSheetLoading.state.allowButtonText, /Processing|处理中|處理中|処理中/);

const scenarios = [fallbackEmpty, nativeStuck, missingLocalDeviceSettings, myServerSettings, officialServerError, officialServerPersistedError, authSheet, authSheetLoading];
for (const item of scenarios) assertNoRawEmailLikeStateText(item);

const summary = {
  ok: true,
  checked_at: new Date().toISOString(),
  stale_permission_ui: {
    source_markers_absent: true,
    checked_markers: stalePermissionUiMarkers,
  },
  server_profile: {
    my_server_visible: true,
    fixed_burn_catalog_visible: true,
    official_server_error_visible: true,
    official_server_persisted_error_visible: true,
  },
  local_device_info: {
    rendered: Boolean(myServerSettings.state.localComputerName && myServerSettings.state.localComputerFingerprint),
    fingerprint: myServerSettings.state.localComputerFingerprint,
    identity_source: myServerSettings.state.localDevice?.identity_source,
  },
  redaction: {
    state_text_raw_email_like_absent: true,
    assertion: "captured state text contains no raw email-like values",
    checked_scenarios: scenarios.map((item) => item.name),
  },
  scenarios: scenarios.map((item) => ({
    name: item.name,
    visible_at_ms: item.visibleAtMs,
    screenshot: item.screenshot,
    screenshot_bytes: item.screenshotBytes,
    product_count: item.state.productCount,
    product_names: item.state.productNames,
    profile_options: item.state.profileOptions,
    server_names: item.state.serverNames,
    server_health: item.state.serverHealth,
    server_details: item.state.serverDetails,
    local_computer_name: item.state.localComputerName,
    local_computer_fingerprint: item.state.localComputerFingerprint,
    local_device: item.state.localDevice,
    selected_profile: item.state.selectedProfile,
    has_burn_svg: item.state.hasBurnSvg,
    has_empty_logo: item.state.hasEmptyLogo,
    has_sheet: item.state.hasSheet,
  })),
};
writeFileSync(resolve(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
assertDurableEvidenceRedacted(evidenceDir);
console.log("[desktop-ui-smoke] pass");

function assertDurableEvidenceRedacted(dir) {
  const leaks = [];
  for (const file of listJsonFiles(dir)) {
    const text = readFileSync(file, "utf8");
    if (CONNECT_TOKEN_PATTERN.test(text)) leaks.push(`${relative(root, file)}: raw connect token`);
    CONNECT_TOKEN_PATTERN.lastIndex = 0;
    if (text.includes(root)) leaks.push(`${relative(root, file)}: repo root path`);
  }
  assert.deepEqual(leaks, [], `durable desktop-ui-smoke evidence is not redacted:\n${leaks.join("\n")}`);
}

function listJsonFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) return listJsonFiles(full);
    return entry.endsWith(".json") ? [full] : [];
  });
}
