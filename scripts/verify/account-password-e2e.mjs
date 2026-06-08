#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";

const appUrl = (process.env.PANDA_BRIDGE_APP_URL || "https://bridge.otherline.cc").replace(/\/$/, "");
const evidenceDir = resolve(process.env.PANDA_BRIDGE_ACCOUNT_EVIDENCE_DIR || "spec/verification/evidence/account-password-e2e");
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-account-e2e-"));
const desktopState = resolve(temp, "desktop-state.json");
const controlState = resolve(temp, "verify-control.json");
const appExecutable = resolve(homedir(), "Applications", "Panda Bridge.app", "Contents", "MacOS", "Panda Bridge");
const testEmail = process.env.PANDA_BRIDGE_TEST_EMAIL || "panda-test-20260604@bridge.otherline.cc";
const testPassword = process.env.PANDA_BRIDGE_TEST_PASSWORD || "PandaTest-2026-0604!";
const otherEmail = `panda-other-${Date.now()}@bridge.otherline.cc`;
const otherPassword = "PandaOther-2026-0604!";
const deviceName = `Account Password E2E ${Date.now()}`;
const realCodex = process.env.PANDA_BRIDGE_REAL_CODEX === "1";
const skipMobile = process.env.PANDA_BRIDGE_SKIP_MOBILE === "1";

mkdirSync(evidenceDir, { recursive: true });
for (const name of [
  "summary.json",
  "desktop-initial.png",
  "desktop-final.png",
  "desktop-status.json",
  "desktop-status-ui.png",
  "owner-bound.png",
  "remote-device.png",
  "remote-reply.png",
  "mobile-device.png",
  "mobile-reply.png",
  "other-account-isolation.png",
  "failure.png",
  "failure.txt",
  "desktop-events.json",
  "job-events.json",
  "mobile-job-events.json",
]) rmSync(resolve(evidenceDir, name), { force: true });

run("npm", ["run", "desktop:install:mac"]);
stopDesktop();

const desktop = spawn(appExecutable, [], {
  env: {
    ...process.env,
    PANDA_BRIDGE_VERIFY: "1",
    ...(realCodex ? {} : { PANDA_BRIDGE_FAKE_CODEX: "1" }),
    PANDA_BRIDGE_DESKTOP_STATE: desktopState,
    PANDA_BRIDGE_VERIFY_CONTROL_STATE: controlState,
    PANDA_BRIDGE_TOKEN_ROTATION_INTERVAL_SECONDS: "0",
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

let browser;
let control;
let failedPage = null;
let lastDeviceId = null;
let lastJobId = null;
let lastRemoteReplyMs = null;
let lastJobPayload = null;
let lastExpected = null;
let lastCreateJobVisibleMs = null;
let lastJobEvents = null;
let lastMobileJobId = null;
let lastMobileReplyMs = null;
let lastMobileExpected = null;
let lastMobileJobPayload = null;
let lastMobileJobEvents = null;
let workerReconnected = false;
try {
  const controlInfo = await waitForControl(controlState);
  hideDesktop();
  control = makeControlClient(controlInfo);
  const status = await control("GET", "/v1/status");
  assert.equal(status.codex_available, true, "desktop did not detect codex command");
  const desktopInitial = await control("GET", "/v1/screenshot");
  copyEvidenceFile(desktopInitial.path, "desktop-initial.png");

  browser = await chromium.launch();
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage({ viewport: { width: 1280, height: 720 } });
  failedPage = owner;
  await owner.goto(`${appUrl}?account_owner=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await login(owner, testEmail, testPassword);

  await owner.getByRole("button", { name: "连接本机" }).click();
  await owner.waitForFunction(() => document.querySelector("[data-install-command]")?.textContent?.includes("--intent"));
  const command = await owner.locator("[data-install-command]").textContent();
  const intent = command.match(/--intent '([^']+)'/)?.[1];
  assert.ok(intent, `connect intent not found in command: ${command}`);

  const claimed = await control("POST", "/v1/actions", {
    action: "claim_intent",
    api: appUrl,
    intent,
    device_name: deviceName,
  });
  assert.equal(claimed.device_name, deviceName);
  lastDeviceId = claimed.device_id;
  await waitFor(async () => (await control("GET", "/v1/status")).worker_running === true, "desktop worker did not start");
  await waitForDesktopEvent(control, "device_token_rotated", 30000);
  await waitForDesktopEvent(control, "realtime_connected", 30000);
  await control("POST", "/v1/actions", { action: "stop_worker" });
  await waitFor(async () => (await control("GET", "/v1/status")).worker_running === false, "desktop worker did not stop");
  await control("POST", "/v1/actions", { action: "start_worker" });
  await waitFor(async () => {
    const next = await control("GET", "/v1/status");
    return next.worker_running === true && next.realtime_connected === true;
  }, "desktop worker did not reconnect realtime");
  await waitForDesktopEventCount(control, "realtime_connected", 2, 30000);
  workerReconnected = true;
  const boundDesktopStatus = await control("GET", "/v1/status");
  assert.ok(String(boundDesktopStatus.account_display || "").includes(testEmail), `desktop account display did not include ${testEmail}`);
  assert.ok((boundDesktopStatus.authorized_products || []).some((item) => item.id === "panda-chat"), "desktop did not show panda-chat authorization");
  writeFileSync(resolve(evidenceDir, "desktop-status.json"), JSON.stringify(boundDesktopStatus, null, 2) + "\n");
  await renderDesktopStatusEvidence(browser, boundDesktopStatus);
  await owner.getByRole("button", { name: "刷新" }).click();
  await selectDevice(owner, deviceName);
  await owner.waitForFunction((name) => document.querySelector("[data-device-status]")?.textContent?.includes(name), deviceName);
  let codex_warmed = false;
  if (realCodex) {
    await waitForDesktopEvent(control, "codex_warmed", 120000);
    codex_warmed = true;
  }
  await owner.screenshot({ path: resolve(evidenceDir, "owner-bound.png"), fullPage: true });

  const remoteContext = await browser.newContext();
  const remote = await remoteContext.newPage({ viewport: { width: 1280, height: 720 } });
  failedPage = remote;
  await remote.goto(`${appUrl}?remote_login=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await login(remote, testEmail, testPassword);
  await selectDevice(remote, deviceName);
  await remote.waitForFunction((name) => document.querySelector("[data-device-status]")?.textContent?.includes(name), deviceName);
  await remote.screenshot({ path: resolve(evidenceDir, "remote-device.png"), fullPage: true });

  const expected = realCodex ? `PB_ACCOUNT_REMOTE_OK_${Date.now()}` : "Panda Bridge fixture reply: account password remote";
  lastExpected = expected;
  const prompt = realCodex ? `请只回复这一段文本，不要解释：${expected}` : "account password remote";
  await remote.locator("[data-input]").fill(prompt);
  const remoteSendStartedAt = Date.now();
  await remote.locator("[data-send]").click();
  const jobId = await waitForJobId(remote, realCodex ? 60000 : 30000);
  assert.ok(jobId, "remote page did not expose the created job id");
  lastJobId = jobId;
  const create_job_visible_ms = Date.now() - remoteSendStartedAt;
  lastCreateJobVisibleMs = create_job_visible_ms;
  await waitForAssistantReply(remote, expected, realCodex ? 240000 : 90000);
  await waitForAssistantSettled(remote, realCodex ? 120000 : 30000);
  const remote_reply_ms = Date.now() - remoteSendStartedAt;
  lastRemoteReplyMs = remote_reply_ms;
  const finalJobPayload = await remote.evaluate(async (id) => {
    const response = await fetch(`/v1/jobs/${encodeURIComponent(id)}`, { credentials: "include" });
    return response.json();
  }, jobId);
  lastJobPayload = finalJobPayload;
  assert.equal(finalJobPayload.job?.status, "succeeded");
  assert.ok(isOfficialSourceOrigin(finalJobPayload.job?.source_origin), `unexpected remote source_origin: ${finalJobPayload.job?.source_origin}`);
  const jobEventsPayload = await fetchJobEvents(remote, jobId);
  lastJobEvents = jobEventsPayload.items || [];
  writeFileSync(resolve(evidenceDir, "job-events.json"), JSON.stringify(jobEventsPayload, null, 2) + "\n");
  const jobEventTypes = assertJobEventCoverage(lastJobEvents, "remote");
  const stream_metrics = assertStreamingMetrics(lastJobEvents, "remote", realCodex);
  const timing = finalJobPayload.job?.timing || {};
  await remote.screenshot({ path: resolve(evidenceDir, "remote-reply.png"), fullPage: true });
  assert.ok(create_job_visible_ms <= 10000, `create_job_visible_ms too slow: ${create_job_visible_ms}`);
  assert.ok(timing.queued_to_claimed_ms <= 2000, `queued_to_claimed_ms too slow: ${timing.queued_to_claimed_ms}`);
  assert.ok(timing.claimed_to_started_ms <= 3000, `claimed_to_started_ms too slow: ${timing.claimed_to_started_ms}`);
  if (!realCodex) assert.ok(remote_reply_ms <= 15000, `fake Codex realtime reply too slow: ${remote_reply_ms}`);

  let mobile_same_account_reply = false;
  let mobile_reply_ms = null;
  let mobile_job_id = null;
  let mobile_timing = null;
  let mobile_event_types = null;
  let mobile_event_count = null;
  let mobile_expected = null;
  let mobile_stream_metrics = null;
  if (!skipMobile) {
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await mobileContext.newPage();
    failedPage = mobile;
    await mobile.goto(`${appUrl}?mobile_login=${Date.now()}`, { waitUntil: "domcontentloaded" });
    await login(mobile, testEmail, testPassword);
    await selectDevice(mobile, deviceName);
    await mobile.waitForFunction((name) => document.querySelector("[data-device-status]")?.textContent?.includes(name), deviceName);
    await mobile.screenshot({ path: resolve(evidenceDir, "mobile-device.png"), fullPage: true });

    mobile_expected = realCodex ? `PB_ACCOUNT_MOBILE_OK_${Date.now()}` : "Panda Bridge fixture reply: account password mobile";
    lastMobileExpected = mobile_expected;
    const mobilePrompt = realCodex ? `请只回复这一段文本，不要解释：${mobile_expected}` : "account password mobile";
    await mobile.locator("[data-input]").fill(mobilePrompt);
    const mobileSendStartedAt = Date.now();
    await mobile.locator("[data-send]").click();
    mobile_job_id = await waitForJobId(mobile, realCodex ? 60000 : 30000);
    lastMobileJobId = mobile_job_id;
    await waitForAssistantReply(mobile, mobile_expected, realCodex ? 240000 : 90000);
    await waitForAssistantSettled(mobile, realCodex ? 120000 : 30000);
    mobile_reply_ms = Date.now() - mobileSendStartedAt;
    lastMobileReplyMs = mobile_reply_ms;
    const mobileJobPayload = await fetchJob(mobile, mobile_job_id);
    lastMobileJobPayload = mobileJobPayload;
    assert.equal(mobileJobPayload.job?.status, "succeeded");
    assert.ok(isOfficialSourceOrigin(mobileJobPayload.job?.source_origin), `unexpected mobile source_origin: ${mobileJobPayload.job?.source_origin}`);
    const mobileEventsPayload = await fetchJobEvents(mobile, mobile_job_id);
    lastMobileJobEvents = mobileEventsPayload.items || [];
    writeFileSync(resolve(evidenceDir, "mobile-job-events.json"), JSON.stringify(mobileEventsPayload, null, 2) + "\n");
    mobile_event_types = assertJobEventCoverage(lastMobileJobEvents, "mobile");
    mobile_event_count = mobile_event_types.length;
    mobile_stream_metrics = assertStreamingMetrics(lastMobileJobEvents, "mobile", realCodex);
    mobile_timing = mobileJobPayload.job?.timing || {};
    mobile_same_account_reply = true;
    await mobile.screenshot({ path: resolve(evidenceDir, "mobile-reply.png"), fullPage: true });
  }

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage({ viewport: { width: 1280, height: 720 } });
  failedPage = other;
  await other.goto(`${appUrl}?other_account=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await login(other, otherEmail, otherPassword);
  await other.waitForTimeout(1000);
  const otherText = await other.locator("body").innerText();
  assert.equal(otherText.includes(deviceName), false, "other account can see the bound connector");
  await other.screenshot({ path: resolve(evidenceDir, "other-account-isolation.png"), fullPage: true });

  const desktopFinal = await control("GET", "/v1/screenshot");
  copyEvidenceFile(desktopFinal.path, "desktop-final.png");
  const events = await control("GET", "/v1/events");
  writeFileSync(resolve(evidenceDir, "desktop-events.json"), JSON.stringify(events, null, 2) + "\n");
  const desktopEvents = events.items || [];
  const realtime_connected = desktopEvents.some((item) => item.type === "realtime_connected");
  const realtime_job = desktopEvents.some((item) => item.type === "realtime_job");
  const device_token_rotated = desktopEvents.some((item) => item.type === "device_token_rotated");
  const install_identity_bound = desktopEvents.some((item) => item.type === "device_token_rotated" && item.payload?.install_identity_bound === true);
  assert.equal(realtime_connected, true, "desktop did not connect realtime websocket");
  assert.equal(realtime_job, true, "desktop did not receive the remote job over realtime websocket");
  assert.equal(device_token_rotated, true, "desktop did not rotate its device token before starting worker");
  assert.equal(install_identity_bound, true, "cloud did not bind the connector token to the desktop install identity");
  const summary = {
    ok: true,
    app_url: appUrl,
    app_executable: appExecutable,
    test_email: testEmail,
    other_email: otherEmail,
    device_name: deviceName,
    device_id: claimed.device_id,
    job_id: jobId,
    remote_same_account_reply: true,
    mobile_same_account_reply,
    other_account_isolated: true,
    realtime_connected,
    realtime_job,
    worker_reconnected: workerReconnected,
    device_token_rotated,
    install_identity_bound,
    codex_warmed,
    create_job_visible_ms,
    remote_reply_ms,
    timing,
    source_origin: finalJobPayload.job?.source_origin || null,
    stream_metrics,
    job_event_types: jobEventTypes,
    job_event_count: jobEventTypes.length,
    mobile_job_id,
    mobile_expected,
    mobile_reply_ms,
    mobile_timing,
    mobile_source_origin: lastMobileJobPayload?.job?.source_origin || null,
    mobile_stream_metrics,
    mobile_event_types,
    mobile_event_count,
    real_codex: realCodex,
    expected,
    evidence_dir: evidenceDir,
    checked_at: new Date().toISOString(),
  };
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (failedPage) {
    await failedPage.screenshot({ path: resolve(evidenceDir, "failure.png"), fullPage: true }).catch(() => {});
    const text = await failedPage.locator("body").innerText().catch(() => "");
    writeFileSync(resolve(evidenceDir, "failure.txt"), text);
  }
  const events = control ? await control("GET", "/v1/events").catch((eventError) => ({ error: String(eventError) })) : null;
  if (events) writeFileSync(resolve(evidenceDir, "desktop-events.json"), JSON.stringify(events, null, 2) + "\n");
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify({
    ok: false,
    app_url: appUrl,
    app_executable: appExecutable,
    test_email: testEmail,
    device_name: deviceName,
    device_id: lastDeviceId,
    job_id: lastJobId,
    create_job_visible_ms: lastCreateJobVisibleMs,
    remote_reply_ms: lastRemoteReplyMs,
    timing: lastJobPayload?.job?.timing || null,
    source_origin: lastJobPayload?.job?.source_origin || null,
    stream_metrics: lastJobEvents ? streamingMetrics(lastJobEvents) : null,
    final_status: lastJobPayload?.job?.status || null,
    job_event_types: lastJobEvents?.map((item) => item.type) || null,
    job_event_count: lastJobEvents?.length || null,
    mobile_job_id: lastMobileJobId,
    mobile_reply_ms: lastMobileReplyMs,
    mobile_timing: lastMobileJobPayload?.job?.timing || null,
    mobile_source_origin: lastMobileJobPayload?.job?.source_origin || null,
    mobile_stream_metrics: lastMobileJobEvents ? streamingMetrics(lastMobileJobEvents) : null,
    mobile_final_status: lastMobileJobPayload?.job?.status || null,
    mobile_expected: lastMobileExpected,
    mobile_event_types: lastMobileJobEvents?.map((item) => item.type) || null,
    mobile_event_count: lastMobileJobEvents?.length || null,
    real_codex: realCodex,
    expected: lastExpected,
    error: error?.message || String(error),
    evidence_dir: evidenceDir,
    checked_at: new Date().toISOString(),
  }, null, 2) + "\n");
  throw error;
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

function hideDesktop() {
  spawnSync("osascript", ["-e", "tell application \"Panda Bridge\" to hide"], { stdio: "ignore" });
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

async function login(page, email, password) {
  await page.locator("[data-login-email]").fill(email);
  await page.locator("[data-login-password]").fill(password);
  await page.locator("[data-login-form] button[type='submit']").click();
  await page.waitForFunction((expectedEmail) => {
    return document.querySelector("[data-session-status]")?.textContent?.includes(expectedEmail);
  }, email, { timeout: 30000 });
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

async function renderDesktopStatusEvidence(browser, status) {
  const page = await browser.newPage({ viewport: { width: 760, height: 640 }, deviceScaleFactor: 1 });
  const products = Array.isArray(status.authorized_products) && status.authorized_products.length
    ? status.authorized_products.map((item) => item.name || item.id).join(", ")
    : status.product_name || "未连接";
  await page.setContent(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    :root { color-scheme: light; --bg: #f6f8f7; --panel: #fff; --line: #d8e2dd; --text: #17231d; --muted: #5b6a62; --green: #209b64; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    .app { width: 720px; min-height: 600px; padding: 24px; display: grid; gap: 16px; align-content: start; }
    header { display: flex; align-items: center; gap: 12px; }
    .mark { width: 42px; height: 42px; border-radius: 8px; display: grid; place-items: center; color: #fff; background: var(--green); font-weight: 800; }
    h1, p { margin: 0; }
    h1 { font-size: 22px; }
    p { color: var(--muted); line-height: 1.5; }
    .hero, .panel { border: 1px solid var(--line); background: var(--panel); padding: 16px; display: grid; gap: 10px; }
    .hero strong { font-size: 20px; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; color: var(--muted); }
    .row strong { color: var(--text); text-align: right; max-width: 430px; overflow-wrap: anywhere; }
    .subtle { font-size: 13px; color: var(--muted); }
  </style>
</head>
<body>
  <main class="app">
    <header>
      <div class="mark">PC</div>
      <div>
        <h1>Panda Connector</h1>
        <p>让你的 Panda 账号使用这台电脑上的 Codex</p>
      </div>
    </header>
    <section class="hero">
      <strong>本机 AI 已就绪</strong>
      <p>${escapeHtml(products)} 可以通过账号 ${escapeHtml(status.account_display || "Panda Account")} 使用这台电脑。</p>
    </section>
    <section class="panel">
      <div class="row"><span>账号</span><strong>${escapeHtml(status.account_display || "未登录")}</strong></div>
      <div class="row"><span>允许产品</span><strong>${escapeHtml(products)}</strong></div>
      <div class="row"><span>本机 Codex</span><strong>${status.codex_available ? "已就绪" : "未检测到"}</strong></div>
      <div class="row"><span>状态</span><strong>${status.worker_running ? (status.realtime_connected ? "已连接 · 实时" : "已连接 · 轮询兜底") : "已暂停"}</strong></div>
    </section>
    <section class="panel">
      <div class="row"><span>云端</span><strong>${escapeHtml(status.cloud_origin || status.api_base || "未连接")}</strong></div>
      <div class="row"><span>设备</span><strong>${escapeHtml(status.device_name || "Panda Connector")} · online</strong></div>
      <p class="subtle">Evidence generated from the live desktop control status after account authorization.</p>
    </section>
  </main>
</body>
</html>`, { waitUntil: "load" });
  await page.screenshot({ path: resolve(evidenceDir, "desktop-status-ui.png"), fullPage: true });
  await page.close();
}

async function waitForAssistantReply(page, expected, timeout) {
  await page.waitForFunction((reply) => {
    return [...document.querySelectorAll("[data-message-role='assistant'][data-message-text]")]
      .some((item) => item.dataset.messageText?.includes(reply));
  }, expected, { timeout });
}

async function waitForJobId(page, timeout) {
  await page.waitForFunction(() => {
    return Boolean(document.querySelector("[data-job-id]")?.getAttribute("data-job-id"));
  }, null, { timeout });
  return page.locator("[data-job-id]").last().getAttribute("data-job-id");
}

async function waitForAssistantSettled(page, timeout) {
  await page.waitForFunction(() => {
    return document.querySelector("[data-send]")?.disabled === false;
  }, null, { timeout });
}

async function fetchJob(page, jobId) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/v1/jobs/${encodeURIComponent(id)}`, { credentials: "include" });
    return response.json();
  }, jobId);
}

async function fetchJobEvents(page, jobId) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/v1/jobs/${encodeURIComponent(id)}/events`, { credentials: "include" });
    return response.json();
  }, jobId);
}

function assertJobEventCoverage(events, label) {
  const eventTypes = events.map((item) => item.type);
  assert.ok(eventTypes.includes("queued"), `${label} job events missing queued: ${eventTypes.join(",")}`);
  assert.ok(eventTypes.includes("claimed"), `${label} job events missing claimed: ${eventTypes.join(",")}`);
  assert.ok(eventTypes.includes("started"), `${label} job events missing started: ${eventTypes.join(",")}`);
  assert.ok(
    eventTypes.includes("text_delta") || eventTypes.includes("app_server_event"),
    `${label} job events missing progress event: ${eventTypes.join(",")}`,
  );
  assert.ok(
    eventTypes.includes("completed") || eventTypes.includes("failed"),
    `${label} job events missing terminal event: ${eventTypes.join(",")}`,
  );
  return eventTypes;
}

function assertStreamingMetrics(events, label, expectRealStream) {
  const metrics = streamingMetrics(events);
  assert.ok(metrics.progress_event_count > 0, `${label} job has no progress events`);
  assert.ok(metrics.max_progress_gap_ms === null || metrics.max_progress_gap_ms <= 30000,
    `${label} progress stream stalled for ${metrics.max_progress_gap_ms}ms`);
  if (expectRealStream) {
    assert.ok(metrics.text_delta_count > 0, `${label} real Codex job emitted no text_delta events`);
    assert.ok(metrics.text_delta_chars > 0, `${label} real Codex job emitted empty text_delta text`);
  }
  return metrics;
}

function isOfficialSourceOrigin(origin) {
  return [
    "https://bridge.otherline.cc",
    "https://panda.otherline.cc",
    "https://dev.otherline.cc",
    "https://spec.otherline.cc",
    "https://otherline.cc",
  ].includes(origin);
}

function streamingMetrics(events) {
  const progressEvents = events
    .filter((event) => ["app_server_event", "text_delta", "completed", "failed"].includes(event.type))
    .map((event) => ({ ...event, at: timestampMs(event.created_at) }))
    .filter((event) => Number.isFinite(event.at))
    .sort((a, b) => a.seq - b.seq);
  const textDeltas = progressEvents.filter((event) => event.type === "text_delta");
  const deltaGaps = gaps(textDeltas.map((event) => event.at));
  const progressGaps = gaps(progressEvents.map((event) => event.at));
  const firstDeltaAt = textDeltas[0]?.at || null;
  const lastDeltaAt = textDeltas[textDeltas.length - 1]?.at || null;
  const text = textDeltas.map((event) => event.payload?.delta || "").join("");
  return {
    progress_event_count: progressEvents.filter((event) => event.type !== "completed" && event.type !== "failed").length,
    max_progress_gap_ms: progressGaps.length ? Math.max(...progressGaps) : null,
    text_delta_count: textDeltas.length,
    text_delta_chars: text.length,
    first_to_last_delta_ms: firstDeltaAt && lastDeltaAt ? Math.max(0, lastDeltaAt - firstDeltaAt) : null,
    text_delta_gap_p50_ms: deltaGaps.length ? percentile(deltaGaps, 0.5) : null,
    text_delta_gap_p95_ms: deltaGaps.length ? percentile(deltaGaps, 0.95) : null,
    text_delta_gap_max_ms: deltaGaps.length ? Math.max(...deltaGaps) : null,
  };
}

function gaps(values) {
  const out = [];
  for (let index = 1; index < values.length; index += 1) out.push(values[index] - values[index - 1]);
  return out;
}

function timestampMs(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function percentile(values, percent) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percent) - 1);
  return sorted[index];
}

async function waitForDesktopEvent(control, eventType, timeout = 90000) {
  await waitFor(async () => {
    const events = await control("GET", "/v1/events");
    return (events.items || []).some((item) => item.type === eventType);
  }, `desktop event ${eventType} did not appear`, timeout);
}

async function waitForDesktopEventCount(control, eventType, count, timeout = 90000) {
  await waitFor(async () => {
    const events = await control("GET", "/v1/events");
    return (events.items || []).filter((item) => item.type === eventType).length >= count;
  }, `desktop event ${eventType} did not appear ${count} times`, timeout);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
