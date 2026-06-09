#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";

const appUrl = (process.env.PANDA_BRIDGE_APP_URL || "https://bridge.otherline.cc").replace(/\/$/, "");
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-browser-smoke-"));
const statePath = resolve(temp, "desktop.json");
const evidenceDir = resolve("spec/verification/evidence/browser-smoke");
const testEmail = `browser-smoke-${Date.now()}@bridge.otherline.cc`;
const testPassword = "PandaTest-2026-0604!";
mkdirSync(evidenceDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
try {
  await page.goto(`${appUrl}?browser_smoke=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-login-email]").fill(testEmail);
  await page.locator("[data-login-password]").fill(testPassword);
  await page.locator("[data-login-form] button[type='submit']").click();
  await page.waitForFunction((email) => document.querySelector("[data-session-status]")?.textContent?.includes(email), testEmail);

  await page.getByRole("button", { name: "连接本机" }).click();
  await page.waitForFunction(() => document.querySelector("[data-install-command]")?.textContent?.includes("--intent"));
  const command = await page.locator("[data-install-command]").textContent();
  const intent = command.match(/--intent '([^']+)'/)?.[1];
  assert.ok(intent, `connect intent not found in command: ${command}`);

  const claim = await runDesktop([
    "headless-connect",
    "--api",
    appUrl,
    "--intent",
    intent,
    "--device-name",
    "Browser Smoke Connector",
  ], {
    PANDA_BRIDGE_DESKTOP_STATE: statePath,
    PANDA_BRIDGE_FAKE_CODEX: "1",
  });
  assert.equal(claim.status, 0, childMessage(claim));

  await page.getByRole("button", { name: "刷新" }).click();
  await page.waitForFunction(() => document.querySelector("[data-device-status]")?.textContent?.includes("Browser Smoke Connector"));

  const prompt = "hello browser smoke";
  await page.locator("[data-input]").fill(prompt);
  await page.getByRole("button", { name: "发送" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".bubble")].some((item) => item.textContent?.includes("本机 Codex")));
  await page.waitForSelector("[data-cancel]:not([hidden])");

  const poll = await runDesktop(["headless-poll"], {
    PANDA_BRIDGE_DESKTOP_STATE: statePath,
    PANDA_BRIDGE_FAKE_CODEX: "1",
  });
  assert.equal(poll.status, 0, childMessage(poll));

  await page.waitForFunction(() => [...document.querySelectorAll(".bubble")].some((item) => item.textContent?.includes("Panda Bridge fixture reply")), {
    timeout: 45000,
  });
  await page.screenshot({ path: resolve(evidenceDir, "bridge-browser-e2e.png"), fullPage: true });

  const summary = {
    ok: true,
    app_url: appUrl,
    test_email: testEmail,
    state_path: statePath,
    saw_reply: true,
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
      env: { ...process.env, PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1", ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    let error = null;
    const timer = setTimeout(() => {
      error = new Error("child process timed out");
      child.kill("SIGTERM");
    }, 30000);
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
