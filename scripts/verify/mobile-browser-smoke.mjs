#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";

const appUrl = (process.env.PANDA_BRIDGE_APP_URL || "https://bridge.otherline.cc").replace(/\/$/, "");
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-mobile-browser-smoke-"));
const statePath = resolve(temp, "desktop.json");
const evidenceDir = resolve("spec/verification/evidence/mobile-browser-smoke");
const testEmail = `mobile-smoke-${Date.now()}@bridge.otherline.cc`;
const testPassword = "PandaTest-2026-0604!";
mkdirSync(evidenceDir, { recursive: true });

const browser = await chromium.launch();
try {
  await verifyMobileBridgeStateMatrix(browser);

  const desktop = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  await desktop.goto(`${appUrl}?mobile_source=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await desktop.locator("[data-login-email]").fill(testEmail);
  await desktop.locator("[data-login-password]").fill(testPassword);
  await desktop.locator("[data-login-form] button[type='submit']").click();
  await desktop.waitForFunction((email) => document.querySelector("[data-session-status]")?.textContent?.includes(email), testEmail);

  await desktop.waitForSelector("[data-bridge-state='no_device']");
  const intent = await desktop.evaluate(async () => {
    const response = await fetch("/v1/connect-intents", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_id: "panda-chat", device_name: "Mobile Browser Smoke Connector" }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(payload));
    return payload.token;
  });
  assert.ok(intent, "connect intent not created");

  const claim = await runDesktop([
    "headless-connect",
    "--api",
    appUrl,
    "--intent",
    intent,
    "--device-name",
    "Mobile Browser Smoke Connector",
  ], {
    PANDA_BRIDGE_DESKTOP_STATE: statePath,
    PANDA_BRIDGE_FAKE_CODEX: "1",
  });
  assert.equal(claim.status, 0, childMessage(claim));

  await desktop.getByRole("button", { name: "刷新" }).click();
  await desktop.waitForFunction(() => document.querySelector("[data-device-status]")?.textContent?.includes("Mobile Browser Smoke Connector"));
  await desktop.waitForSelector("[data-bridge-state='ready']");
  await desktop.getByRole("button", { name: "手机同步" }).click();
  await desktop.waitForFunction(() => document.querySelector("[data-mobile-link]")?.href?.includes("join="));
  const joinUrl = await desktop.locator("[data-mobile-link]").getAttribute("href");
  await desktop.screenshot({ path: resolve(evidenceDir, "desktop-share-link.png"), fullPage: true });

  await mobile.goto(joinUrl, { waitUntil: "domcontentloaded" });
  await mobile.waitForFunction((email) => document.querySelector("[data-session-status]")?.textContent?.includes(email), testEmail);
  await mobile.waitForFunction(() => document.querySelector("[data-device-status]")?.textContent?.includes("Mobile Browser Smoke Connector"));
  await mobile.waitForSelector("[data-bridge-state='ready']");
  assert.equal(await mobile.locator("[data-primary-cta='true']").count(), 0, "mobile ready must not expose a primary CTA");
  await mobile.screenshot({ path: resolve(evidenceDir, "mobile-joined-device.png"), fullPage: true });

  const prompt = "hello from phone browser";
  await mobile.locator("[data-input]").fill(prompt);
  await mobile.getByRole("button", { name: "发送" }).click();
  await mobile.waitForFunction(() => [...document.querySelectorAll(".bubble")].some((item) => item.textContent?.includes("本机 Codex")));

  const poll = await runDesktop(["headless-poll"], {
    PANDA_BRIDGE_DESKTOP_STATE: statePath,
    PANDA_BRIDGE_FAKE_CODEX: "1",
  });
  assert.equal(poll.status, 0, childMessage(poll));

  await mobile.waitForFunction(() => [...document.querySelectorAll(".bubble")].some((item) => item.textContent?.includes("Panda Bridge fixture reply")), {
    timeout: 45000,
  });
  await mobile.screenshot({ path: resolve(evidenceDir, "mobile-chat-reply.png"), fullPage: true });

  const summary = {
    ok: true,
    app_url: appUrl,
    test_email: testEmail,
    state_path: statePath,
    join_url_shape: joinUrl?.replace(/join=[^&]+/, "join=[redacted]"),
    mobile_session_status: await mobile.locator("[data-session-status]").textContent(),
    saw_mobile_reply: true,
    checked_at: new Date().toISOString(),
  };
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}

async function verifyMobileBridgeStateMatrix(browser) {
  const cases = [
    { state: "no_session", cta: "登录", count: 1 },
    { state: "no_device", cta: "下载 Bridge", count: 1 },
    { state: "authorization_pending", cta: "去桌面端确认", count: 1 },
    { state: "authorized_offline", cta: "打开 Bridge", count: 1 },
    { state: "ready", cta: "", count: 0 },
  ];
  for (const item of cases) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await routeFixtureSdk(page, item.state);
    await page.goto(`${appUrl}?mobile_state_fixture=${item.state}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`[data-bridge-state='${item.state}']`);
    assert.equal(await page.locator("[data-primary-cta='true']").count(), item.count, `${item.state} primary CTA count`);
    if (item.cta) await page.getByText(item.cta, { exact: true }).waitFor();
    if (item.state === "no_device") {
      const href = await page.locator("[data-primary-cta='true']").getAttribute("href");
      assert.ok(href && href.includes("version=0.1.0"), `download href missing version: ${href}`);
      await page.getByText("macOS", { exact: true }).waitFor();
      await page.getByText("3.0 MB", { exact: true }).waitFor();
      await page.getByText("sha256", { exact: true }).waitFor();
    }
    if (item.state === "authorized_offline" || item.state === "ready") {
      assert.equal(await page.locator("[data-primary-cta='true']", { hasText: "授权" }).count(), 0, `${item.state} must not show authorize CTA`);
    }
    await page.close();
  }
}

async function routeFixtureSdk(page, bridgeState) {
  await page.route("**/sdk/index.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: fixtureSdkModule(bridgeState),
    });
  });
}

function fixtureSdkModule(bridgeState) {
  const now = new Date().toISOString();
  const session = bridgeState === "no_session" ? null : { authenticated: true, user: { email: "fixture@pandart.cc" } };
  const install = {
    download_url: "/downloads/panda-bridge-macos.dmg",
    version: "0.1.0",
    size_bytes: 3167118,
    sha256: "e65e04f08373ffe2363616dc1426516b74f12123f52c71d7225af4bac7225962",
    platform: "macos",
    open_url: "panda-bridge://open",
  };
  const devices = bridgeState === "no_device" ? [] : [{
    id: "fixture-device",
    name: "Fixture Mac",
    online: bridgeState === "ready" || bridgeState === "not_authorized",
    last_seen_at: now,
    current: true,
  }];
  const model = {
    bridge_state: bridgeState,
    session,
    install,
    devices,
    authorization: bridgeState === "ready" || bridgeState === "authorized_offline" ? { status: "active", authorized_at: now } : null,
    intent: bridgeState === "authorization_pending" ? { token: "pbi_fixture", expires_at: now, deep_link: "panda-bridge://connect?intent=pbi_fixture" } : null,
    actions: [{ kind: bridgeState === "no_device" ? "download" : bridgeState === "ready" ? "ready" : bridgeState === "authorized_offline" ? "open_desktop" : "confirm_on_desktop" }],
  };
  return `
    export function createBridgeClient() {
      const model = ${JSON.stringify(model)};
      return {
        state: async () => model,
        watchState: async function* () { yield model; },
        install: async () => model.install,
        auth: { session: async () => model.session, join: async () => model.session, password: async () => model.session, logout: async () => ({}) },
        devices: { list: async () => ({ items: [] }), revoke: async () => ({}) },
        products: { authorization: async () => ({ authorization: model.authorization }), revokeAuthorization: async () => ({}) },
        jobs: {},
        codex: {},
      };
    }
  `;
}

function runDesktop(args, extraEnv = {}) {
  return new Promise((resolveChild) => {
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
      env: { ...process.env, PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1", ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    let error = null;
    const timer = setTimeout(() => {
      error = new Error("desktop child timed out");
      child.kill("SIGTERM");
    }, 60000);
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
      resolveChild({ status, signal, stdout, stderr, error });
    });
  });
}

function childMessage(result) {
  return [
    `status=${result.status}`,
    result.signal ? `signal=${result.signal}` : "",
    result.error ? `error=${result.error.message}` : "",
    result.stderr ? `stderr=${result.stderr}` : "",
    result.stdout ? `stdout=${result.stdout}` : "",
  ].filter(Boolean).join("\n");
}
