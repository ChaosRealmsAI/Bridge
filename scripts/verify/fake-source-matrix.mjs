#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const VERSION = "v13-fake-source-matrix-console";
const evidenceDir = resolve("spec/verification/evidence", VERSION);
mkdirSync(evidenceDir, { recursive: true });

const matrix = [
  {
    id: "forge-chat",
    label: "Forge Chat Configured",
    product_id: "panda-forge-chat-configured",
    origin: "http://forge-configured.fake.test",
    accounts: [
      { id: "forge-chat-acct-1", email: "forge-one@fake.pandart.cc", display_name: "Forge One" },
      { id: "forge-chat-acct-2", email: "forge-two@fake.pandart.cc", display_name: "Forge Two" },
    ],
  },
  {
    id: "atlas-dev",
    label: "Atlas Dev Configured",
    product_id: "panda-atlas-dev-configured",
    origin: "http://atlas-configured.fake.test",
    accounts: [
      { id: "atlas-dev-acct-1", email: "atlas-one@fake.pandart.cc", display_name: "Atlas One" },
      { id: "atlas-dev-acct-2", email: "atlas-two@fake.pandart.cc", display_name: "Atlas Two" },
    ],
  },
  {
    id: "nova-lab",
    label: "Nova Lab Configured",
    product_id: "panda-nova-lab-configured",
    origin: "http://nova-configured.fake.test",
    accounts: [
      { id: "nova-lab-acct-1", email: "nova-one@fake.pandart.cc", display_name: "Nova One" },
      { id: "nova-lab-acct-2", email: "nova-two@fake.pandart.cc", display_name: "Nova Two" },
    ],
  },
];

const server = await startMatrixServer();
const browser = await chromium.launch();
const desktopPage = await browser.newPage({ viewport: { width: 1440, height: 920 } });
const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

try {
  await desktopPage.goto(`${server.url}?verify=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await desktopPage.waitForSelector("[data-source-tab]");
  await assertInitialMatrix(desktopPage);

  const clicked = [];
  for (const source of matrix) {
    await desktopPage.locator(`[data-source-tab="${source.id}"]`).click();
    clicked.push(`source:${source.id}`);
    await desktopPage.locator('[data-source-field="label"]').fill(source.label);
    await desktopPage.locator('[data-source-field="product_id"]').fill(source.product_id);
    await desktopPage.locator('[data-source-field="origin"]').fill(source.origin);
    await desktopPage.locator('[data-source-field="prompt"]').fill(`v13 browser configured ${source.label}`);

    for (const [index, account] of source.accounts.entries()) {
      const row = desktopPage.locator(`[data-account-row="${account.id}"]`);
      await row.click({ position: { x: 190, y: 16 } });
      clicked.push(`account-row:${source.id}:${account.id}`);
      await row.locator(`[data-account-index="${index}"][data-account-field="email"]`).fill(account.email);
      await row.locator(`[data-account-index="${index}"][data-account-field="display_name"]`).fill(account.display_name);
      await row.locator(`[data-account-focus="${source.id}:${account.id}"]`).click();
      clicked.push(`account-focus:${source.id}:${account.id}`);
    }

    const firstCheckbox = desktopPage.locator(`[data-account-row="${source.accounts[0].id}"] input[data-account-field="enabled"]`);
    await firstCheckbox.click();
    await firstCheckbox.click();
    clicked.push(`account-toggle:${source.id}:${source.accounts[0].id}`);
  }

  await desktopPage.locator('[data-action="save-config"]').click();
  await desktopPage.waitForFunction(() => document.querySelector("[data-log]")?.textContent?.includes("Config saved."));
  const saved = await getJson(`${server.url}/api/config`);
  assert.equal(saved.config.sources.length, 3);
  for (const source of matrix) {
    const savedSource = saved.config.sources.find((item) => item.id === source.id);
    assert.ok(savedSource, `missing saved source ${source.id}`);
    assert.equal(savedSource.label, source.label);
    assert.equal(savedSource.product_id, source.product_id);
    assert.equal(savedSource.origin, source.origin);
    assert.equal(savedSource.accounts.filter((account) => account.enabled).length, 2);
  }

  await desktopPage.screenshot({ path: resolve(evidenceDir, "fake-source-matrix-configured-desktop.png"), fullPage: true });
  await desktopPage.locator('[data-action="run-all"]').click();
  await desktopPage.waitForFunction(() => document.querySelector("[data-run-status]")?.textContent === "complete", null, { timeout: 180000 });
  await desktopPage.waitForFunction(() => document.querySelectorAll("[data-result-row]").length === 6);
  await desktopPage.screenshot({ path: resolve(evidenceDir, "fake-source-matrix-run-desktop.png"), fullPage: true });

  await mobilePage.goto(`${server.url}?mobile_verify=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await mobilePage.waitForSelector("[data-source-tab]");
  await mobilePage.waitForFunction(() => document.querySelectorAll("[data-result-row]").length === 6);
  await mobilePage.screenshot({ path: resolve(evidenceDir, "fake-source-matrix-run-mobile.png"), fullPage: true });

  const lastRunPayload = await getJson(`${server.url}/api/last-run`);
  const run = lastRunPayload.last_run;
  assert.equal(run.ok, true);
  assert.equal(run.source_count, 3);
  assert.equal(run.route_count, 6);
  assert.deepEqual(run.accounts_per_source.map((item) => item.enabled_accounts), [2, 2, 2]);
  assert.equal(run.final_jobs.length, 6);
  assert.equal(run.realtime_connected_devices.length >= 6, true);
  assert.equal(run.realtime_jobs.length >= 6, true);

  const expectedOrigins = new Set(matrix.map((source) => source.origin));
  for (const job of run.final_jobs) {
    assert.equal(job.status, "succeeded");
    assert.equal(job.transport, "websocket");
    assert.equal(expectedOrigins.has(job.origin), true, `unexpected origin ${job.origin}`);
  }
  for (const source of matrix) {
    const jobs = run.final_jobs.filter((job) => job.source_id === source.id);
    assert.equal(jobs.length, 2, `expected two jobs for ${source.id}`);
    assert.deepEqual(new Set(jobs.map((job) => job.account_email)), new Set(source.accounts.map((account) => account.email)));
  }

  const summary = {
    ok: true,
    version: VERSION,
    operation_surface: server.url,
    source_count: run.source_count,
    accounts_per_source: run.accounts_per_source,
    route_count: run.route_count,
    final_job_count: run.final_jobs.length,
    websocket_job_count: run.final_jobs.filter((job) => job.transport === "websocket").length,
    clicked,
    configured_sources: matrix.map((source) => ({
      id: source.id,
      product_id: source.product_id,
      origin: source.origin,
      account_emails: source.accounts.map((account) => account.email),
    })),
    screenshots: [
      `spec/verification/evidence/${VERSION}/fake-source-matrix-configured-desktop.png`,
      `spec/verification/evidence/${VERSION}/fake-source-matrix-run-desktop.png`,
      `spec/verification/evidence/${VERSION}/fake-source-matrix-run-mobile.png`,
    ],
    last_run_summary: `spec/verification/evidence/${VERSION}/matrix-run-summary.json`,
    locked_regression: "npm run verify:fake-source-matrix",
    source_access: "Browser-only operation of the fake matrix UI plus public /api/last-run after the user-visible run completed; no source, test internals, Desktop storage, or hidden state used as the pass oracle.",
    checked_at: new Date().toISOString(),
  };
  writeFileSync(resolve(evidenceDir, "browser-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  await desktopPage.screenshot({ path: resolve(evidenceDir, "fake-source-matrix-failure-desktop.png"), fullPage: true }).catch(() => null);
  writeFileSync(resolve(evidenceDir, "browser-summary.json"), JSON.stringify({
    ok: false,
    version: VERSION,
    operation_surface: server.url,
    error: error?.message || String(error),
    checked_at: new Date().toISOString(),
  }, null, 2) + "\n");
  throw error;
} finally {
  await browser.close();
  await stopMatrixServer(server);
}

async function assertInitialMatrix(page) {
  const initial = await page.evaluate(() => ({
    sourceTabs: [...document.querySelectorAll("[data-source-tab]")].map((item) => item.dataset.sourceTab),
    routes: Number(document.querySelector("[data-metric-routes]")?.textContent || 0),
  }));
  assert.deepEqual(initial.sourceTabs, ["forge-chat", "atlas-dev", "nova-lab"]);
  assert.equal(initial.routes, 6);
}

function startMatrixServer() {
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn("node", ["scripts/fake-source-matrix.mjs", "--port", "0"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectStart(new Error(`fake source matrix server did not start\nstdout=${stdout}\nstderr=${stderr}`));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line);
          if (payload.ready && payload.url) {
            clearTimeout(timer);
            resolveStart({ child, url: payload.url, stdout: () => stdout, stderr: () => stderr });
          }
        } catch {
          // keep collecting startup output
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectStart(error);
    });
    child.on("exit", (status, signal) => {
      if (!stdout.includes('"ready":true')) {
        clearTimeout(timer);
        rejectStart(new Error(`fake source matrix server exited status=${status} signal=${signal}\nstdout=${stdout}\nstderr=${stderr}`));
      }
    });
  });
}

async function stopMatrixServer(server) {
  if (!server?.child || server.child.killed) return;
  await new Promise((resolveStop) => {
    server.child.once("exit", resolveStop);
    server.child.kill("SIGTERM");
    setTimeout(resolveStop, 2000).unref();
  });
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  assert.ok(response.ok, `${url}: ${JSON.stringify(payload)}`);
  return payload;
}
