#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";

const appUrl = (process.env.PANDA_BRIDGE_APP_URL || "https://bridge.otherline.cc").replace(/\/$/, "");
const evidenceDir = resolve("spec/evidence/installed-desktop-e2e");
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-installed-e2e-"));
const desktopState = resolve(temp, "desktop-state.json");
const controlState = resolve(temp, "verify-control.json");
const appExecutable = resolve(homedir(), "Applications", "Panda Bridge.app", "Contents", "MacOS", "Panda Bridge");
const deviceName = `Installed Desktop E2E ${Date.now()}`;
const realCodex = process.env.PANDA_BRIDGE_REAL_CODEX === "1";
const testEmail = process.env.PANDA_BRIDGE_TEST_EMAIL || `installed-e2e-${Date.now()}@bridge.otherline.cc`;
const testPassword = process.env.PANDA_BRIDGE_TEST_PASSWORD || "PandaTest-2026-0604!";
mkdirSync(evidenceDir, { recursive: true });
for (const name of [
  "summary.json",
  "web-reply.png",
  "mobile-reply.png",
  "web-timeout.png",
  "web-timeout.txt",
  "web-timeout-events.json",
  "mobile-timeout.png",
  "mobile-timeout.txt",
  "mobile-timeout-events.json",
]) {
  rmSync(resolve(evidenceDir, name), { force: true });
}

run("npm", ["run", "desktop:install:mac"]);
stopDesktop();

const desktop = spawn(appExecutable, [], {
  env: {
    ...process.env,
    PANDA_BRIDGE_VERIFY: "1",
    ...(realCodex ? {} : { PANDA_BRIDGE_FAKE_CODEX: "1" }),
    PANDA_BRIDGE_DESKTOP_STATE: desktopState,
    PANDA_BRIDGE_VERIFY_CONTROL_STATE: controlState,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let desktopStdout = "";
let desktopStderr = "";
desktop.stdout.on("data", (chunk) => {
  desktopStdout += String(chunk);
});
desktop.stderr.on("data", (chunk) => {
  desktopStderr += String(chunk);
});

let controlInfo;
let browser;
try {
  controlInfo = await waitForControl(controlState);
  assert.ok(controlInfo.base_url, "verify control did not write base_url");
  assert.ok(controlInfo.token, "verify control did not write token");
  const control = makeControlClient(controlInfo);
  const initialStatus = await control("GET", "/v1/status");
  assert.equal(initialStatus.codex_available, true, "desktop did not detect codex command");
  const desktopShot = await control("GET", "/v1/screenshot");
  copyEvidenceFile(desktopShot.path, "desktop.png");

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${appUrl}?installed_desktop_e2e=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-login-email]").fill(testEmail);
  await page.locator("[data-login-password]").fill(testPassword);
  await page.locator("[data-login-form] button[type='submit']").click();
  await page.waitForFunction((email) => document.querySelector("[data-session-status]")?.textContent?.includes(email), testEmail);

  await page.getByRole("button", { name: "连接本机" }).click();
  await page.waitForFunction(() => document.querySelector("[data-install-command]")?.textContent?.includes("--intent"));
  const command = await page.locator("[data-install-command]").textContent();
  const intent = command.match(/--intent '([^']+)'/)?.[1];
  assert.ok(intent, `connect intent not found in command: ${command}`);

  const claimed = await control("POST", "/v1/actions", {
    action: "claim_intent",
    api: appUrl,
    intent,
    device_name: deviceName,
  });
  assert.equal(claimed.device_name, deviceName);
  await waitFor(async () => (await control("GET", "/v1/status")).worker_running === true, "desktop worker did not start");

  await page.getByRole("button", { name: "刷新" }).click();
  await selectDevice(page, deviceName);
  await page.waitForFunction((name) => document.querySelector("[data-device-status]")?.textContent?.includes(name), deviceName);

  const webExpected = realCodex ? `PB_REAL_WEB_OK_${Date.now()}` : "Panda Bridge fixture reply: installed desktop auto worker reply";
  const prompt = realCodex ? `请只回复这一段文本，不要解释：${webExpected}` : "installed desktop auto worker reply";
  await page.locator("[data-input]").fill(prompt);
  await page.locator("[data-send]").click();
  await waitForAssistantReply(page, webExpected, realCodex ? 240000 : 90000)
    .catch((error) => captureFailure("web", page, control, error));
  await page.screenshot({ path: resolve(evidenceDir, "web-reply.png"), fullPage: true });

  await page.getByRole("button", { name: "手机同步" }).click();
  await page.waitForFunction(() => document.querySelector("[data-mobile-link]")?.href?.includes("join="));
  const joinUrl = await page.locator("[data-mobile-link]").getAttribute("href");

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto(joinUrl, { waitUntil: "domcontentloaded" });
  await mobile.waitForFunction((email) => document.querySelector("[data-session-status]")?.textContent?.includes(email), testEmail);
  const repeatMobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await repeatMobile.goto(joinUrl, { waitUntil: "domcontentloaded" });
  await repeatMobile.waitForFunction((email) => document.querySelector("[data-session-status]")?.textContent?.includes(email), testEmail);
  await repeatMobile.screenshot({ path: resolve(evidenceDir, "mobile-repeat-link.png"), fullPage: true });
  await repeatMobile.close();
  await selectDevice(mobile, deviceName);
  await mobile.waitForFunction((name) => document.querySelector("[data-device-status]")?.textContent?.includes(name), deviceName);
  const mobileExpected = realCodex ? `PB_REAL_PHONE_OK_${Date.now()}` : "Panda Bridge fixture reply: phone to installed desktop";
  const mobilePrompt = realCodex ? `请只回复这一段文本，不要解释：${mobileExpected}` : "phone to installed desktop";
  await mobile.locator("[data-input]").fill(mobilePrompt);
  await mobile.locator("[data-send]").click();
  await waitForAssistantReply(mobile, mobileExpected, realCodex ? 240000 : 90000)
    .catch((error) => captureFailure("mobile", mobile, control, error));
  await mobile.screenshot({ path: resolve(evidenceDir, "mobile-reply.png"), fullPage: true });

  const finalDesktopShot = await control("GET", "/v1/screenshot");
  copyEvidenceFile(finalDesktopShot.path, "desktop-final.png");
  const events = await control("GET", "/v1/events");
  writeFileSync(resolve(evidenceDir, "desktop-events.json"), JSON.stringify(events, null, 2) + "\n");
  const summary = {
    ok: true,
    app_url: appUrl,
    app_executable: appExecutable,
    test_email: testEmail,
    device_name: deviceName,
    device_id: claimed.device_id,
    session_link_reopen: true,
    web_reply: true,
    mobile_reply: true,
    real_codex: realCodex,
    web_expected: webExpected,
    mobile_expected: mobileExpected,
    evidence_dir: evidenceDir,
    checked_at: new Date().toISOString(),
  };
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (browser) await browser.close();
  desktop.kill("SIGTERM");
  writeFileSync(resolve(evidenceDir, "desktop-stdout.log"), desktopStdout);
  writeFileSync(resolve(evidenceDir, "desktop-stderr.log"), desktopStderr);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

function stopDesktop() {
  spawnSync("osascript", ["-e", "tell application \"Panda Bridge\" to quit"], { stdio: "ignore" });
  spawnSync("pkill", ["-f", "/Applications/Panda Bridge.app/Contents/MacOS/Panda Bridge"], { stdio: "ignore" });
  spawnSync("pkill", ["-f", `${homedir()}/Applications/Panda Bridge.app/Contents/MacOS/Panda Bridge`], { stdio: "ignore" });
}

async function waitForControl(path) {
  return waitFor(() => {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  }, "verify control file was not created", 30000);
}

function makeControlClient(info) {
  return async (method, path, body = null) => {
    const response = await fetch(`${info.base_url}${path}`, {
      method,
      headers: {
        "accept": "application/json",
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

async function selectDevice(page, name) {
  await page.waitForFunction((deviceName) => {
    const select = document.querySelector("[data-device-select]");
    return select && [...select.options].some((option) => option.textContent?.includes(deviceName));
  }, name, { timeout: 30000 });
  await page.evaluate((deviceName) => {
    const select = document.querySelector("[data-device-select]");
    const option = [...select.options].find((item) => item.textContent?.includes(deviceName));
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, name);
}

async function waitForAssistantReply(page, expected, timeout) {
  await page.waitForFunction((reply) => {
    return [...document.querySelectorAll("[data-message-role='assistant'][data-message-text]")]
      .some((item) => item.dataset.messageText?.includes(reply));
  }, expected, { timeout });
}

async function captureFailure(label, page, control, error) {
  await page.screenshot({ path: resolve(evidenceDir, `${label}-timeout.png`), fullPage: true }).catch(() => {});
  const text = await page.locator("body").innerText().catch(() => "");
  writeFileSync(resolve(evidenceDir, `${label}-timeout.txt`), text);
  const events = await control("GET", "/v1/events").catch((eventError) => ({ error: String(eventError) }));
  writeFileSync(resolve(evidenceDir, `${label}-timeout-events.json`), JSON.stringify(events, null, 2) + "\n");
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify({
    ok: false,
    app_url: appUrl,
    app_executable: appExecutable,
    device_name: deviceName,
    real_codex: realCodex,
    failed_route: label,
    error: error?.message || String(error),
    evidence_dir: evidenceDir,
    checked_at: new Date().toISOString(),
  }, null, 2) + "\n");
  throw error;
}

async function waitFor(fn, message, timeoutMs = 90000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${message}${last ? `: ${JSON.stringify(last)}` : ""}`);
}

function copyEvidenceFile(source, name) {
  if (source && existsSync(source)) copyFileSync(source, resolve(evidenceDir, name));
}
