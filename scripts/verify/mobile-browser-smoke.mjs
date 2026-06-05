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
const evidenceDir = resolve("spec/evidence/mobile-browser-smoke");
const testEmail = `mobile-smoke-${Date.now()}@bridge.otherline.cc`;
const testPassword = "PandaTest-2026-0604!";
mkdirSync(evidenceDir, { recursive: true });

const browser = await chromium.launch();
const desktop = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

try {
  await desktop.goto(`${appUrl}?mobile_source=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await desktop.locator("[data-login-email]").fill(testEmail);
  await desktop.locator("[data-login-password]").fill(testPassword);
  await desktop.locator("[data-login-form] button[type='submit']").click();
  await desktop.waitForFunction((email) => document.querySelector("[data-session-status]")?.textContent?.includes(email), testEmail);

  await desktop.getByRole("button", { name: "连接本机" }).click();
  await desktop.waitForFunction(() => document.querySelector("[data-install-command]")?.textContent?.includes("--intent"));
  const command = await desktop.locator("[data-install-command]").textContent();
  const intent = command.match(/--intent '([^']+)'/)?.[1];
  assert.ok(intent, `connect intent not found in command: ${command}`);

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
  await desktop.getByRole("button", { name: "手机同步" }).click();
  await desktop.waitForFunction(() => document.querySelector("[data-mobile-link]")?.href?.includes("join="));
  const joinUrl = await desktop.locator("[data-mobile-link]").getAttribute("href");
  await desktop.screenshot({ path: resolve(evidenceDir, "desktop-share-link.png"), fullPage: true });

  await mobile.goto(joinUrl, { waitUntil: "domcontentloaded" });
  await mobile.waitForFunction((email) => document.querySelector("[data-session-status]")?.textContent?.includes(email), testEmail);
  await mobile.waitForFunction(() => document.querySelector("[data-device-status]")?.textContent?.includes("Mobile Browser Smoke Connector"));
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

function runDesktop(args, extraEnv = {}) {
  return new Promise((resolveChild) => {
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
      env: { ...process.env, ...extraEnv },
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
