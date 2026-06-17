#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { chromium } from "playwright";

const root = resolve(new URL("../..", import.meta.url).pathname);
const htmlUrl = `file://${resolve(root, "apps/desktop/ui/index.html")}`;
const evidenceDir = resolve(root, "spec/verification/evidence/desktop-ui-smoke");
mkdirSync(evidenceDir, { recursive: true });

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
  await page.waitForTimeout(options.waitMs ?? 250);

  const screenshot = resolve(evidenceDir, `${name}.png`);
  await page.screenshot({ path: screenshot });
  const screenshotBytes = readFileSync(screenshot).byteLength;
  const state = await page.evaluate(() => {
    const text = document.body.innerText;
    const product = document.querySelector(".pnode")?.getBoundingClientRect();
    const empty = document.querySelector(".empty")?.getBoundingClientRect();
    const sheet = document.querySelector(".sheetwrap.on")?.getBoundingClientRect();
    return {
      text,
      productCount: document.querySelectorAll(".pnode").length,
      hasBurnSvg: Boolean(document.querySelector(".ptile svg")),
      hasEmptyLogo: Boolean(document.querySelector(".elogo svg")),
      hasSheet: Boolean(document.querySelector(".sheetwrap.on")),
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

const nativeStuck = await inspectScenario("native-stuck", {
  nativeStuck: true,
  waitMs: 150,
});
assert.match(nativeStuck.state.text, /Local engine .* starting/i);
assert.match(nativeStuck.state.text, /Connect Burn/);
assert.equal(nativeStuck.state.hasEmptyLogo, true, "native-stuck first frame must render Burn SVG");

const authSheet = await inspectScenario("authorization-sheet", {
  query: "?sheet=1&theme=dark",
  waitMs: 800,
});
assert.equal(authSheet.state.hasSheet, true, "authorization sheet should open");
assert.match(authSheet.state.text, /source_origin/);
assert.match(authSheet.state.text, /https:\/\/token-burn\.com/);
assert.match(authSheet.state.text, /product_authorization/);
assert.ok(authSheet.state.sheetBox?.height > 400, "authorization sheet should be visible");

const summary = {
  ok: true,
  checked_at: new Date().toISOString(),
  scenarios: [fallbackEmpty, nativeStuck, authSheet].map((item) => ({
    name: item.name,
    visible_at_ms: item.visibleAtMs,
    screenshot: item.screenshot,
    screenshot_bytes: item.screenshotBytes,
    product_count: item.state.productCount,
    has_burn_svg: item.state.hasBurnSvg,
    has_empty_logo: item.state.hasEmptyLogo,
    has_sheet: item.state.hasSheet,
  })),
};
writeFileSync(resolve(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log("[desktop-ui-smoke] pass");
