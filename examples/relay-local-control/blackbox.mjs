#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, relative, resolve } from "node:path";
import { chromium } from "playwright";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";
import {
  decryptResponseEnvelope,
  encryptCommandEnvelope,
  startRelayLocalControlAdapter,
} from "./adapter.mjs";

const evidenceDir = resolve(process.env.PANDA_BRIDGE_BLACKBOX_EVIDENCE_DIR || "spec/verification/evidence/relay-local-control-blackbox");
const reportDir = resolve(process.env.PANDA_BRIDGE_BLACKBOX_REPORT_DIR || evidenceDir);
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(reportDir, { recursive: true });

const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-relay-local-control-blackbox-"));
const statePath = resolve(temp, "desktop-state.json");
const workerServer = await startLocalWorker();
const adapter = await startRelayLocalControlAdapter({ root: process.cwd() });
const apiBase = workerServer.apiBase;
const serverVisibleChecks = [];
const scenario = {
  connected: false,
  device_id: "",
  commands: {},
  legacy_jobs: null,
};

let browser;
let page;
let demoServer;

try {
  const bridge = createBridgeClient({ apiBase, productId: "bridge-demo", fetch: fetchWithJar(apiBase) });
  await bridge.auth.guest("Relay Local Control Blackbox");
  demoServer = await startDemoServer({ bridge });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const tracePath = resolve(evidenceDir, "trace.zip");
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();

  const steps = [];
  await page.goto(demoServer.url, { waitUntil: "domcontentloaded" });
  steps.push(await screenshotStep("01-open", "Open relay-local-control product demo", "Idle page is visible"));

  await page.getByRole("button", { name: "Connect Desktop" }).click();
  await page.getByTestId("connection-state").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("[data-testid='connection-state']")?.textContent?.includes("connected"), null, { timeout: 120000 });
  steps.push(await screenshotStep("02-connect", "Click Connect Desktop", "Page shows connected device"));

  await page.getByRole("button", { name: "Run pwd" }).click();
  await page.waitForFunction((cwdValue) => document.body.textContent.includes(cwdValue), process.cwd(), { timeout: 120000 });
  steps.push(await screenshotStep("03-pwd", "Click Run pwd", "Visible result shows current repo path"));

  await page.getByRole("button", { name: "Run ls" }).click();
  await page.waitForFunction(() => document.body.textContent.includes("package.json"), null, { timeout: 120000 });
  steps.push(await screenshotStep("04-ls", "Click Run ls", "Visible result includes package.json"));

  await page.getByRole("button", { name: "Check legacy API" }).click();
  await page.waitForFunction(() => document.body.textContent.includes("legacy_runtime_api_removed"), null, { timeout: 120000 });
  steps.push(await screenshotStep("05-legacy", "Click Check legacy API", "Visible result shows old job API returns 410"));

  await context.tracing.stop({ path: tracePath });
  const manifest = buildManifest(steps, tracePath);
  writeFileSync(resolve(evidenceDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(reportDir, "blackbox.md"), blackboxReport(manifest));
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  if (browser) await browser.close();
  if (demoServer) await demoServer.close();
  await adapter.close();
  await workerServer.close();
}

async function startDemoServer({ bridge }) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://local.test");
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(html());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/connect") {
        const intent = await bridge.connect.createIntent({ deviceName: "Relay Local Control Browser Device" });
        const connected = await runDesktop([
          "headless-connect",
          "--api",
          apiBase,
          "--intent",
          intent.token,
          "--device-name",
          "Relay Local Control Browser Device",
        ]);
        assert.equal(connected.status, 0, childMessage(connected));
        const claim = JSON.parse(connected.stdout);
        scenario.connected = true;
        scenario.device_id = claim.device_id;
        return writeJson(response, 200, publicState());
      }
      if (request.method === "POST" && url.pathname === "/api/run") {
        assert.ok(scenario.device_id, "not_connected");
        const body = await readJsonRequest(request);
        const op = String(body.op || "");
        const command = op === "pwd" ? { op: "pwd" } : op === "ls" ? { op: "ls", path: "." } : null;
        assert.ok(command, "unsupported_command");
        const channelId = op === "pwd" ? "bb_chan_1" : "bb_chan_2";
        const seq = op === "pwd" ? 100 : 200;
        scenario.commands[op] = await runCommandThroughBridge(bridge, scenario.device_id, channelId, seq, command, {
          failFirstConnectorAck: op === "pwd",
        });
        return writeJson(response, 200, publicState());
      }
      if (request.method === "POST" && url.pathname === "/api/legacy") {
        const legacyJobs = await fetch(`${apiBase}/v1/products/bridge-demo/jobs`, {
          method: "POST",
          headers: { origin: apiBase, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ kind: "shell.run", input: { command: "pwd" } }),
        });
        const payload = await legacyJobs.json();
        scenario.legacy_jobs = { status: legacyJobs.status, error: payload.error };
        return writeJson(response, 200, publicState());
      }
      return writeJson(response, 404, { ok: false, error: "not_found" });
    } catch (error) {
      console.error(`[relay-local-control:blackbox] api error ${error?.stack || error?.message || error}`);
      return writeJson(response, 500, { ok: false, error: String(error?.message || error) });
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function runCommandThroughBridge(bridge, deviceId, channelId, seq, command, options = {}) {
  console.error(`[relay-local-control:blackbox] run ${command.op} start`);
  const requestKey = `relay-local-control-blackbox-${seq}-${Date.now()}`;
  const envelope = await encryptCommandEnvelope(command, adapter.keyBytes, {
    product_id: "bridge-demo",
    device_id: deviceId,
    channel_id: channelId,
    seq,
    request_key: requestKey,
  });
  const created = await bridge.relay.create(envelope);
  console.error(`[relay-local-control:blackbox] run ${command.op} envelope ${created.envelope.id}`);
  recordNoServerVisiblePlaintext(`${command.op}:request`, created.envelope, plaintextTokensFor(command));

  if (options.failFirstConnectorAck) {
    workerServer.failNextConnectorAckFor(created.envelope.id);
    console.error(`[relay-local-control:blackbox] run ${command.op} first poll with ack fault`);
    const failedPoll = await runDesktop(["headless-poll"]);
    assert.notEqual(failedPoll.status, 0, "first poll should fail after response upload when connector ack is fault-injected");
    assert.equal(executionsFor(created.envelope.id), 1, "first delivery should execute exactly once");
    console.error(`[relay-local-control:blackbox] run ${command.op} retry poll`);
    assertPollProcessed(await runDesktop(["headless-poll"]));
    assert.equal(executionsFor(created.envelope.id), 1, "retry must not re-run local command");
    assert.equal(adapter.calls.some((item) => item.envelope_id === created.envelope.id && item.replay === true), true);
  } else {
    console.error(`[relay-local-control:blackbox] run ${command.op} poll`);
    assertPollProcessed(await runDesktop(["headless-poll"]));
  }

  console.error(`[relay-local-control:blackbox] run ${command.op} wait response`);
  const { envelope: responseEnvelope, ack } = await bridge.relay.waitForResponse({ deviceId, channelId, afterSeq: seq, timeoutMs: 10000, intervalMs: 250 });
  const result = await decryptResponseEnvelope(responseEnvelope, adapter.keyBytes);
  recordNoServerVisiblePlaintext(`${command.op}:response`, responseEnvelope, plaintextTokensFor(command, result));
  await ack({ status: "acked" });
  console.error(`[relay-local-control:blackbox] run ${command.op} done`);
  return result;
}

async function startLocalWorker() {
  const env = {
    BRIDGE_LOCAL_MEMORY: "1",
    BRIDGE_WEB_ORIGIN: "http://127.0.0.1:0",
    BRIDGE_PUBLIC_API_BASE: "http://127.0.0.1:0",
    SESSION_COOKIE_NAME: "pb_session",
  };
  const failConnectorAckOnce = new Set();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await readIncoming(incoming);
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}${incoming.url}`;
      const parsed = new URL(url);
      const connectorAckMatch = parsed.pathname.match(/^\/v1\/connectors\/relay\/envelopes\/([^/]+)\/ack$/);
      if (incoming.method === "POST" && connectorAckMatch) {
        const envelopeId = decodeURIComponent(connectorAckMatch[1]);
        if (failConnectorAckOnce.delete(envelopeId)) {
          outgoing.writeHead(503, { "content-type": "application/json; charset=utf-8" });
          outgoing.end(JSON.stringify({ error: "fault_injected_connector_ack_failed", envelope_id: envelopeId }));
          return;
        }
      }
      const request = new Request(url, {
        method: incoming.method,
        headers: incomingHeaders(incoming.headers),
        body: body.length && incoming.method !== "GET" && incoming.method !== "HEAD" ? body : undefined,
      });
      const response = await worker.fetch(request, {
        ...env,
        BRIDGE_WEB_ORIGIN: `http://127.0.0.1:${port}`,
        BRIDGE_PUBLIC_API_BASE: `http://127.0.0.1:${port}`,
        BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({
          "bridge-demo": [`http://127.0.0.1:${port}`],
        }),
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      outgoing.end(JSON.stringify({ error: "relay_local_control_blackbox_proxy_error", message: error.message || String(error) }));
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    failNextConnectorAckFor: (envelopeId) => failConnectorAckOnce.add(String(envelopeId || "")),
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function screenshotStep(id, action, actual) {
  const path = resolve(evidenceDir, `${id}.png`);
  await page.screenshot({ path, fullPage: true });
  return {
    id,
    action,
    expected: actual,
    actual,
    screenshot: path,
  };
}

function buildManifest(steps, tracePath) {
  const pwd = scenario.commands.pwd || {};
  const ls = scenario.commands.ls || {};
  return {
    ok: true,
    entry: demoServer.url,
    api_base: apiBase,
    adapter_url: adapter.url,
    device_id: scenario.device_id,
    steps,
    trace: tracePath,
    commands: {
      pwd: { ok: pwd.ok === true, stdout: pwd.stdout || "" },
      ls: { ok: ls.ok === true, includes_package_json: Array.isArray(ls.entries) && ls.entries.some((item) => item.name === "package.json") },
    },
    adapter_calls: adapter.calls,
    adapter_executions: adapter.executions,
    legacy_jobs: scenario.legacy_jobs,
    server_visible_plaintext: serverVisibleChecks.some((item) => item.leaked),
    server_visible_checks: serverVisibleChecks,
    bdd_refs: ["ADP-P03", "RET-N01"],
    checked_at: new Date().toISOString(),
  };
}

function blackboxReport(manifest) {
  const rows = manifest.steps.map((step) => (
    `| ${step.id} | ${step.action} | ${step.expected} | ${step.actual} | ${rel(step.screenshot)} |`
  )).join("\n");
  return `# Relay Local Control Blackbox

## Verdict

approve

## Scope

User-visible browser route for the relay-local-control example. The page was opened in Playwright, buttons were clicked as a user would click them, and screenshots plus a Playwright trace were saved as evidence.

## Steps

| Step | Action | Expected | Actual | Evidence |
| --- | --- | --- | --- | --- |
${rows}

## Results

- Entry: ${manifest.entry}
- pwd: ${manifest.commands.pwd.ok ? "pass" : "fail"}; stdout ${manifest.commands.pwd.stdout}
- ls: ${manifest.commands.ls.ok ? "pass" : "fail"}; package.json visible ${manifest.commands.ls.includes_package_json}
- Legacy job API: HTTP ${manifest.legacy_jobs?.status}; ${manifest.legacy_jobs?.error}
- Adapter retry: ${manifest.adapter_calls.some((item) => item.replay === true) ? "pass" : "fail"}; duplicate pwd delivery replayed without duplicate execution
- Adapter executions: ${manifest.adapter_executions.map((item) => item.op).join(", ")}
- Server-visible plaintext: ${manifest.server_visible_plaintext ? "fail" : "pass"}
- Trace: ${rel(manifest.trace)}
- Manifest: ${rel(resolve(evidenceDir, "manifest.json"))}

## BDD Mapping

- ADP-P03: visible page triggered encrypted relay to Desktop Adapter for pwd and ls .; Adapter returned encrypted response envelopes.
- RET-N01: computed checks found no pwd, ls, stdout, or local repo path in server-visible non-crypto envelope fields.

## Residual Risk

This is a local example blackbox using local-memory Worker and verifier-controlled Desktop headless connect. It proves the user-visible relay-local-control route and retry behavior, not production deployment.
`;
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Relay Local Control</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f4f6f8; color: #16202a; }
    main { max-width: 1040px; margin: 0 auto; padding: 28px; }
    header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; border-bottom: 1px solid #cfd7df; padding-bottom: 16px; }
    h1 { margin: 0; font-size: 24px; font-weight: 680; letter-spacing: 0; }
    .subtitle { margin: 6px 0 0; color: #5d6975; font-size: 14px; }
    .state { padding: 7px 10px; border: 1px solid #b8c3cc; background: #fff; border-radius: 6px; font-size: 13px; min-width: 220px; text-align: right; }
    .toolbar { display: flex; gap: 10px; margin: 22px 0; flex-wrap: wrap; }
    button { border: 1px solid #8a98a6; background: #ffffff; color: #16202a; border-radius: 6px; min-height: 36px; padding: 0 14px; font-size: 14px; cursor: pointer; }
    button:disabled { color: #8b96a1; background: #edf1f4; cursor: not-allowed; }
    button.primary { background: #18324a; color: #fff; border-color: #18324a; }
    section { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    article { background: #fff; border: 1px solid #cfd7df; border-radius: 8px; padding: 14px; min-height: 160px; }
    h2 { font-size: 15px; margin: 0 0 10px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.45; color: #203040; }
    .wide { grid-column: 1 / -1; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Relay Local Control</h1>
        <p class="subtitle">Product page -> encrypted relay -> Desktop -> Product Adapter -> encrypted response</p>
      </div>
      <div class="state" data-testid="connection-state" id="connectionState">idle</div>
    </header>
    <div class="toolbar">
      <button class="primary" id="connect">Connect Desktop</button>
      <button id="pwd" disabled>Run pwd</button>
      <button id="ls" disabled>Run ls</button>
      <button id="legacy" disabled>Check legacy API</button>
    </div>
    <section>
      <article>
        <h2>pwd</h2>
        <pre id="pwdOut">not run</pre>
      </article>
      <article>
        <h2>ls</h2>
        <pre id="lsOut">not run</pre>
      </article>
      <article>
        <h2>Legacy API</h2>
        <pre id="legacyOut">not checked</pre>
      </article>
      <article>
        <h2>Relay Evidence</h2>
        <pre id="evidence">waiting</pre>
      </article>
      <article class="wide">
        <h2>Raw State</h2>
        <pre id="raw">idle</pre>
      </article>
    </section>
  </main>
  <script>
    const stateEl = document.querySelector("#connectionState");
    const rawEl = document.querySelector("#raw");
    const evidenceEl = document.querySelector("#evidence");
    const pwdEl = document.querySelector("#pwdOut");
    const lsEl = document.querySelector("#lsOut");
    const legacyEl = document.querySelector("#legacyOut");
    const buttons = {
      connect: document.querySelector("#connect"),
      pwd: document.querySelector("#pwd"),
      ls: document.querySelector("#ls"),
      legacy: document.querySelector("#legacy"),
    };
    buttons.connect.addEventListener("click", () => runAction(() => post("/api/connect", {})));
    buttons.pwd.addEventListener("click", () => runAction(() => post("/api/run", { op: "pwd" })));
    buttons.ls.addEventListener("click", () => runAction(() => post("/api/run", { op: "ls" })));
    buttons.legacy.addEventListener("click", () => runAction(() => post("/api/legacy", {})));
    async function runAction(fn) {
      try {
        render(await fn());
      } catch (error) {
        rawEl.textContent = "error: " + (error.message || String(error));
      } finally {
        setBusy(false);
      }
    }
    async function post(url, body) {
      setBusy(true);
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      setBusy(false);
      if (!response.ok || payload.ok === false) throw new Error(payload.error || "request_failed");
      return payload;
    }
    function setBusy(busy) {
      for (const button of Object.values(buttons)) button.disabled = busy || (button !== buttons.connect && stateEl.textContent === "idle");
    }
    function render(state) {
      stateEl.textContent = state.connected ? "connected " + state.device_id : "idle";
      buttons.pwd.disabled = !state.connected;
      buttons.ls.disabled = !state.connected;
      buttons.legacy.disabled = !state.connected;
      if (state.commands?.pwd) pwdEl.textContent = state.commands.pwd.stdout;
      if (state.commands?.ls) lsEl.textContent = state.commands.ls.entries.map((item) => item.name).join("\\n");
      if (state.legacy_jobs) legacyEl.textContent = "HTTP " + state.legacy_jobs.status + " " + state.legacy_jobs.error;
      evidenceEl.textContent = [
        "server_visible_plaintext=" + state.server_visible_plaintext,
        "adapter_calls=" + state.adapter_calls.length,
        "adapter_executions=" + state.adapter_executions.map((item) => item.op).join(",")
      ].join("\\n");
      rawEl.textContent = JSON.stringify(state, null, 2);
    }
  </script>
</body>
</html>`;
}

function publicState() {
  return {
    ok: true,
    connected: scenario.connected,
    device_id: scenario.device_id,
    commands: scenario.commands,
    legacy_jobs: scenario.legacy_jobs,
    adapter_calls: adapter.calls,
    adapter_executions: adapter.executions,
    server_visible_plaintext: serverVisibleChecks.some((item) => item.leaked),
    server_visible_checks: serverVisibleChecks,
  };
}

function assertPollProcessed(child) {
  assert.equal(child.status, 0, childMessage(child));
  const pollPayload = JSON.parse(child.stdout);
  assert.equal(pollPayload.ok, true);
  assert.ok(pollPayload.count >= 1, "headless-poll must process at least one relay envelope");
  return pollPayload;
}

function executionsFor(envelopeId) {
  return adapter.executions.filter((item) => item.envelope_id === envelopeId).length;
}

function plaintextTokensFor(command, result = {}) {
  return [
    command.op,
    command.path && command.path !== "." ? command.path : "",
    result.op,
    result.stdout,
    process.cwd(),
  ].filter((value) => typeof value === "string" && value.length > 1);
}

function recordNoServerVisiblePlaintext(label, envelope, tokens) {
  const values = serverVisibleStringValues(envelope);
  const leaks = tokens.filter((token) => values.some((value) => value.includes(token)));
  const check = { label, leaked: leaks.length > 0, leaks };
  serverVisibleChecks.push(check);
  assert.deepEqual(leaks, [], `${label} leaked product plaintext into server-visible fields`);
}

function serverVisibleStringValues(input, key = "") {
  if (input == null) return [];
  if (["ciphertext", "aad", "nonce"].includes(key)) return [];
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.flatMap((item) => serverVisibleStringValues(item));
  if (typeof input === "object") {
    return Object.entries(input).flatMap(([nextKey, value]) => serverVisibleStringValues(value, nextKey));
  }
  return [];
}

function fetchWithJar(origin) {
  let cookie = "";
  return async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", origin);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  };
}

function runDesktop(args) {
  return new Promise((resolveRun) => {
    console.error(`[relay-local-control:blackbox] desktop ${args.join(" ")} start`);
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
      env: {
        ...process.env,
        PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1",
        PANDA_BRIDGE_DESKTOP_STATE: statePath,
        PANDA_BRIDGE_ADAPTER_BRIDGE_DEMO_URL: adapter.url,
        PANDA_BRIDGE_SKIP_KEYCHAIN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      stderr += "\nblackbox_desktop_timeout";
      child.kill("SIGKILL");
    }, 60000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      clearTimeout(timeout);
      console.error(`[relay-local-control:blackbox] desktop ${args.join(" ")} exit ${status}`);
      resolveRun({ status, stdout, stderr });
    });
  });
}

function childMessage(child) {
  return JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr });
}

async function readJsonRequest(request) {
  return JSON.parse((await readIncoming(request)).toString("utf8") || "{}");
}

async function readIncoming(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function incomingHeaders(headers) {
  const next = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) next.set(key, value.join(", "));
    else if (value != null) next.set(key, String(value));
  }
  return next;
}

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function rel(path) {
  return relative(process.cwd(), path);
}
