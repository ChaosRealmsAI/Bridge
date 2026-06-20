#!/usr/bin/env node
// Focused regression check for the two reported cloud-server bugs:
//   1) "老是跳" — re-renders/probes used to snap the scroll to top and replace the
//      clickable card node under the cursor.
//   2) online/offline + latency refresh — health was frozen after the first probe.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(new URL("../..", import.meta.url).pathname);
const outDir = resolve(root, "spec/L3/evidence/desktop-server-list-interaction");
mkdirSync(outDir, { recursive: true });
// Self-contained: compile the desktop UI from source so this test doesn't depend on
// the smoke-test run order.
const indexSource = readFileSync(resolve(root, "apps/desktop/ui/index.html"), "utf8");
const cssSource = readFileSync(resolve(root, "apps/desktop/ui/styles.css"), "utf8");
const jsSource = readFileSync(resolve(root, "apps/desktop/ui/app.js"), "utf8");
// about.js is an optional sibling module the real build injects; tolerate its absence.
let aboutSource = "";
try { aboutSource = readFileSync(resolve(root, "apps/desktop/ui/about.js"), "utf8"); } catch {}
const compiled = resolve(outDir, "compiled-index.html");
writeFileSync(
  compiled,
  indexSource
    .replace("__PANDA_BRIDGE_DESKTOP_CSS__", cssSource)
    .replace("__PANDA_BRIDGE_DESKTOP_ABOUT_JS__", aboutSource)
    .replace("__PANDA_BRIDGE_DESKTOP_JS__", jsSource),
);
const htmlUrl = `file://${compiled}`;

// A roster long enough to scroll, with a server that flips offline -> online over time.
function seed(page) {
  return page.evaluate(() => {
    function mkProfile(i) {
      return {
        id: `srv_${i}`,
        name: `Server ${i}`,
        api_base: `http://10.0.0.${i}:8787`,
        web_origin: `http://10.0.0.${i}:8787`,
        source: "selfhost",
        updated_at: "",
        products: [],
      };
    }
    const profiles = [
      { id: "official", name: "Official Bridge Cloud", api_base: "https://api.bridge.chaos-realms.cc", web_origin: "https://bridge.chaos-realms.cc", source: "official", products: [] },
      ...Array.from({ length: 7 }, (_, i) => mkProfile(i + 1)),
    ];
    ui.view = "settings";
    ui.serverListExpanded = true; // render all cards so the pane scrolls
    ui.health = {};
    ui.serverBusy = {};
    ui.serverProbeBackoff = {};
    ui.settings = {
      ...ui.settings,
      api_base: profiles[1].api_base,
      cloud_profiles: profiles,
      selected_cloud_profile_id: "srv_1",
    };
    ui.status = {
      ...ui.status,
      worker_running: true,
      realtime_connected: true,
      selected_profile: {
        profile_id: "srv_1",
        label: "Server 1",
        api_base: profiles[1].api_base,
        server: { reachable: true, compatible: true, last_probe_at: new Date().toISOString(), error: null, source: "probe", probe_latency_ms: 42 },
        device: { paired: true, present: true, last_seen_at: new Date().toISOString(), device_id: "d", device_name: "Dev" },
        account: { authorized: true, authorization_state: "active", account_id: "a", account_display: "X", product_ids: ["panda-burn"] },
        local_engine: { running: true, adapter_health: "configured", adapter_configured: true, adapter_running: true, adapter_products: [] },
        transport: { realtime_state: "connected", polling_state: "active", realtime_connected: true, polling_active: true, degraded_reason: null },
      },
    };

    // Deterministic probe backend: srv_3 starts offline, then comes online; latency moves.
    window.__probeTick = 0;
    const original = window.PandaBridge.call.bind(window.PandaBridge);
    window.PandaBridge.call = (command, params = {}) => {
      if (command === "status") return Promise.resolve({ ...ui.status, settings: ui.settings, products: ui.products });
      if (command === "refresh_cloud_profile") {
        const id = params.profile_id;
        window.__probeTick += 1;
        const tick = window.__probeTick;
        const settings = JSON.parse(JSON.stringify(ui.settings));
        const prof = settings.cloud_profiles.find((p) => p.id === id);
        if (prof) {
          const override = window.__latencyFor && window.__latencyFor[id];
          if (id === "srv_3" && tick < 50) {
            prof.updated_at = "probe_error:unix:1|Server 3 still booting";
          } else {
            const latency = override != null ? override : 100 + (tick % 7) * 10; // moves so we can see latency refresh
            prof.updated_at = `probe:unix:1|latency_ms:${latency}`;
          }
        }
        return new Promise((r) => setTimeout(() => r(settings), 30));
      }
      return original(command, params);
    };
    render();
    probeAllServers();
  });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 820, height: 568 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
await page.goto(`${htmlUrl}?settings=1&theme=dark`, { waitUntil: "load" });
await page.waitForFunction(() => typeof ui !== "undefined" && !ui.booting && ui.status);
await seed(page);
await page.waitForTimeout(600); // let the initial staggered probes settle

// ---- Bug 1: scroll must NOT jump to top on re-render / probe ----
const scrollEl = ".setscroll";
await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 220; }, scrollEl);
const beforeTop = await page.evaluate((sel) => document.querySelector(sel).scrollTop, scrollEl);
assert.ok(beforeTop >= 200, `precondition: pane must be scrollable (got ${beforeTop})`);
await page.screenshot({ path: resolve(outDir, "scrolled-before.png") });

// (a) A full render must keep the scroll position (this is what used to snap to top).
await page.evaluate(() => { render(); });
const afterRenderTop = await page.evaluate((sel) => document.querySelector(sel).scrollTop, scrollEl);
assert.ok(Math.abs(afterRenderTop - beforeTop) <= 2, `scroll must be preserved across a full render (before=${beforeTop}, after=${afterRenderTop})`);

// (b) A background probe on a NON-selected card must patch in place — the clickable
//     card node (the thing the user is about to click) must NOT be rebuilt.
const targetSel = `.srv[data-pid="srv_7"]`;
await page.evaluate((s) => { document.querySelector(s).setAttribute("data-probe-marker", "anchor"); }, targetSel);
await page.evaluate(() => {
  setServerProbeBackoff("srv_7", 0);
  for (const id of Object.keys(ui.health)) if (ui.health[id]) ui.health[id].at = 0;
  probeServer(null, "srv_7", { silent: true }); // non-selected → surgical patch, no refresh()
});
await page.waitForTimeout(250);

const afterTop = await page.evaluate((sel) => document.querySelector(sel).scrollTop, scrollEl);
assert.ok(Math.abs(afterTop - beforeTop) <= 2, `scroll must be preserved across a probe (before=${beforeTop}, after=${afterTop})`);
const markerSurvived = await page.evaluate((s) => document.querySelector(s)?.getAttribute("data-probe-marker") === "anchor", targetSel);
await page.screenshot({ path: resolve(outDir, "scrolled-after.png") });

// ---- Bug 2: online/offline + latency must refresh over time ----
// srv_3 begins offline; advance the tick past the flip and let the interval-style re-probe run.
const srv3Before = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".srv")].find((x) => x.dataset.pid === "srv_3");
  return el?.querySelector(".srv-health")?.textContent.trim() || "";
});
// Make srv_3 eligible to re-probe immediately (simulate TTL elapsed + tick past flip).
await page.evaluate(() => {
  window.__probeTick = 100; // past the offline->online flip
  for (const id of Object.keys(ui.health)) {
    if (ui.health[id]) ui.health[id].at = 0; // mark every cached probe stale
  }
  setServerProbeBackoff("srv_3", 0);
  probeAllServers({ silent: true });
});
await page.waitForTimeout(500);
const srv3After = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".srv")].find((x) => x.dataset.pid === "srv_3");
  return el?.querySelector(".srv-health")?.textContent.trim() || "";
});

// Latency must actually move when the backend reports a new value.
const latBefore = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".srv")].find((x) => x.dataset.pid === "srv_2");
  return el?.querySelector(".srv-health")?.textContent.trim() || "";
});
await page.evaluate(() => {
  window.__probeTick = 5; // mock increments to 6 -> latency 100 + (6%7)*10 = 160
  for (const id of Object.keys(ui.health)) if (ui.health[id]) ui.health[id].at = 0;
  setServerProbeBackoff("srv_2", 0);
  probeServer(null, "srv_2", { silent: true });
});
await page.waitForTimeout(300);
const latAfter = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".srv")].find((x) => x.dataset.pid === "srv_2");
  return el?.querySelector(".srv-health")?.textContent.trim() || "";
});

// ---- Polish: a silent poll that finds NO change must not disturb the badge; a
//      genuine change must rewrite + play the gentle one-shot "bump". ----
const churn = await page.evaluate(() => {
  const id = "srv_4";
  ui.health[id] = { state: "online", latency: 222, at: Date.now() };
  patchServerCard(id);
  const el = [...document.querySelectorAll(".srv")].find((x) => x.dataset.pid === id);
  const badge = el.querySelector(".srv-health");
  badge.querySelector(".d").setAttribute("data-stable", "yes");
  badge.classList.remove("bumped");
  // same value again -> must be a no-op (no rewrite, no animation)
  ui.health[id] = { state: "online", latency: 222, at: Date.now() };
  patchServerCard(id);
  const stableAfterNoChange = badge.querySelector(".d")?.getAttribute("data-stable") === "yes";
  const bumpedAfterNoChange = badge.classList.contains("bumped");
  // genuine change -> rewrite + bump
  ui.health[id] = { state: "online", latency: 999, at: Date.now() };
  patchServerCard(id);
  return { stableAfterNoChange, bumpedAfterNoChange, bumpedAfterChange: badge.classList.contains("bumped"), text: badge.textContent.trim() };
});

// ---- Polish: returning focus to the window forces a re-check even for a "fresh" server. ----
// Drain probes still in flight from earlier steps so srv_5 has a single writer.
await page.waitForTimeout(1300);
await page.evaluate(() => { ui.serverBusy = {}; });
const focusForced = await page.evaluate(async () => {
  const id = "srv_5";
  window.__latencyFor = { [id]: 137 }; // pin srv_5's measured latency regardless of probe order
  setServerProbeBackoff(id, 0);
  ui.health[id] = { state: "online", latency: 111, at: Date.now() }; // fresh -> a normal poll would skip it
  window.PandaBridge.receive({ type: "event", event: "focus" }); // native window-focus path
  // focus debounce (220ms) + staggered probe (srv_5 is index 6 -> ~780ms) + network.
  await new Promise((r) => setTimeout(r, 1400));
  const el = [...document.querySelectorAll(".srv")].find((x) => x.dataset.pid === id);
  return el?.querySelector(".srv-health")?.textContent.trim() || "";
});

await browser.close();

assert.deepEqual(errors, [], `page errors must be empty:\n${errors.join("\n")}`);
assert.equal(markerSurvived, true, "clickable server card node must survive a silent probe (no innerHTML rebuild under the cursor)");
assert.match(srv3Before, /Offline|离线|離線|オフライン/i, `srv_3 should start offline (got "${srv3Before}")`);
assert.match(srv3After, /Online|在线|在線|オンライン/i, `srv_3 should auto-recover to online after re-probe (got "${srv3After}")`);
assert.match(latAfter, /\b160ms\b/, `latency should refresh to the new measured value (before="${latBefore}", after="${latAfter}")`);
assert.notEqual(latAfter, latBefore, "latency text must actually change when the server reports a new value");
assert.equal(churn.stableAfterNoChange, true, "an unchanged silent poll must not rewrite the health badge (zero churn)");
assert.equal(churn.bumpedAfterNoChange, false, "an unchanged poll must not play the change animation");
assert.equal(churn.bumpedAfterChange, true, "a genuine value change must play the gentle bump animation");
assert.match(churn.text, /999ms/, "changed latency must be reflected after a real change");
assert.match(focusForced, /\b137ms\b/, `window focus should force a re-check even for a 'fresh' server (got "${focusForced}")`);
assert.doesNotMatch(focusForced, /\b111ms\b/, "window focus must replace the stale 'fresh' value, not keep it");

console.log("[desktop-server-list-interaction] pass");
console.log(JSON.stringify({ beforeTop, afterTop, markerSurvived, srv3Before, srv3After, latBefore, latAfter, churn, focusForced }, null, 2));
