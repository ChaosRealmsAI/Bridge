#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";

const version = "v8-pandart-real-codex-model-e2e";
const appUrl = (process.env.PANDA_BRIDGE_APP_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
const evidenceDir = resolve("spec/verification/evidence", version);
const temp = mkdtempSync(resolve(tmpdir(), "pandart-real-codex-"));
const statePath = resolve(temp, "desktop-state.json");
const desktopBin = resolve("apps/desktop/target/debug/panda-bridge-desktop");
const testEmail = process.env.PANDART_TEST_EMAIL || "chaos@pandart.cc";
const testPassword = process.env.PANDART_TEST_PASSWORD || "Pandart-Local-2026!";
const deviceName = `Pandart Real Codex ${Date.now()}`;
const expected = process.env.PANDART_REAL_CODEX_EXPECTED || "pandart-real-codex-ok";
const prompt = "For Pandart real model verification, join these four lowercase words with hyphens and reply only that token: pandart real codex ok.";
const strippedPath = process.env.PANDA_BRIDGE_STRIPPED_PATH || "/usr/bin:/bin:/usr/sbin:/sbin";

mkdirSync(evidenceDir, { recursive: true });
for (const name of [
  "summary.json",
  "desktop-build.log",
  "headless-connect.json",
  "headless-poll.json",
  "pandart-real-codex-ui.png",
  "pandart-real-codex-failure.png",
]) {
  rmSync(resolve(evidenceDir, name), { force: true });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

try {
  const health = await getJson(`${appUrl}/__pandart/health`);
  assert.equal(health.ok, true, "Pandart local health endpoint is not ready");

  const build = await runProcess("cargo", ["build", "--manifest-path", "apps/desktop/Cargo.toml"], process.env, 180000);
  writeFileSync(resolve(evidenceDir, "desktop-build.log"), childMessage(build));
  assert.equal(build.status, 0, childMessage(build));
  assert.equal(existsSync(desktopBin), true, `desktop binary missing after build: ${desktopBin}`);

  await page.goto(`${appUrl}?v8_real_codex=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-login-email]").fill(testEmail);
  await page.locator("[data-login-password]").fill(testPassword);
  await page.locator("[data-login-form] button[type='submit']").click();
  await page.waitForFunction((email) => document.querySelector("[data-session-status]")?.textContent?.includes(email), testEmail);

  const intent = await page.evaluate(async () => {
    const response = await fetch("/v1/connect-intents", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_id: "panda-chat", device_name: "Pandart Real Codex Connector" }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(payload));
    return payload.token;
  });
  assert.ok(intent, "connect intent not created");

  const connect = await runDesktop(["headless-connect", "--api", appUrl, "--intent", intent, "--device-name", deviceName], 120000);
  writeFileSync(resolve(evidenceDir, "headless-connect.json"), childPayload(connect));
  assert.equal(connect.status, 0, childMessage(connect));

  await page.getByRole("button", { name: "刷新" }).click();
  await page.waitForFunction((needle) => document.querySelector("[data-device-status]")?.textContent?.includes(needle), deviceName, { timeout: 60000 });
  await page.waitForSelector("[data-bridge-state='ready']", { timeout: 60000 });

  await page.locator("[data-input]").fill(prompt);
  await page.getByRole("button", { name: "发送" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".bubble")].some((item) => item.textContent?.includes("本机 Codex")));

  const poll = await runDesktop(["headless-poll"], 300000);
  writeFileSync(resolve(evidenceDir, "headless-poll.json"), childPayload(poll));
  assert.equal(poll.status, 0, childMessage(poll));

  await page.waitForFunction((needle) => [...document.querySelectorAll(".bubble[data-message-role='assistant']")].some((item) => item.textContent?.includes(needle)), expected, {
    timeout: 180000,
  });
  await page.screenshot({ path: resolve(evidenceDir, "pandart-real-codex-ui.png"), fullPage: true });

  const assistantText = await page.evaluate((needle) => {
    const bubbles = [...document.querySelectorAll(".bubble[data-message-role='assistant']")].map((item) => item.textContent || "");
    return bubbles.find((text) => text.includes(needle)) || "";
  }, expected);
  const summary = {
    ok: true,
    version,
    app_url: appUrl,
    health_product: health.product,
    test_email: testEmail,
    device_name: deviceName,
    expected_reply_token: expected,
    assistant_text: assistantText,
    desktop_binary: desktopBin,
    stripped_path: strippedPath,
    fake_codex: false,
    real_codex: true,
    evidence_dir: evidenceDir,
    checked_at: new Date().toISOString(),
  };
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(evidenceDir, "pandart-real-codex-failure.png"), fullPage: true }).catch(() => {});
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify({
    ok: false,
    version,
    app_url: appUrl,
    test_email: testEmail,
    device_name: deviceName,
    expected_reply_token: expected,
    error: error?.message || String(error),
    evidence_dir: evidenceDir,
    checked_at: new Date().toISOString(),
  }, null, 2) + "\n");
  throw error;
} finally {
  await browser.close();
  rmSync(temp, { recursive: true, force: true });
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  assert.ok(response.ok, `${url}: ${JSON.stringify(payload)}`);
  return payload;
}

function runDesktop(args, timeoutMs) {
  const env = {
    ...process.env,
    PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1",
    PANDA_BRIDGE_DESKTOP_STATE: statePath,
    PANDA_BRIDGE_CODEX_CWD: resolve("."),
    PATH: strippedPath,
  };
  delete env.PANDA_BRIDGE_CODEX_BIN;
  delete env.PANDA_BRIDGE_FAKE_CODEX;
  return runProcess(desktopBin, args, env, timeoutMs);
}

function runProcess(command, args, env, timeoutMs) {
  return new Promise((resolveChild) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    let error = null;
    const timer = setTimeout(() => {
      error = new Error("child process timed out");
      child.kill("SIGTERM");
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
      resolveChild({ status, signal, stdout, stderr, error });
    });
  });
}

function childPayload(result) {
  if (result.stdout?.trim()) return result.stdout.trim().endsWith("\n") ? result.stdout : `${result.stdout}\n`;
  return `${childMessage(result)}\n`;
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
