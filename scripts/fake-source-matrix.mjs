#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createBridgeClient } from "../packages/sdk/src/index.js";

const VERSION = "v13-fake-source-matrix-console";
const evidenceDir = resolve("spec/verification/evidence", VERSION);
mkdirSync(evidenceDir, { recursive: true });

const DEFAULT_MATRIX = Object.freeze({
  sources: [
    fakeSource("forge-chat", "Forge Chat", "panda-forge-chat", "http://forge.fake.test", ["Ada Forge", "Ben Forge"]),
    fakeSource("atlas-dev", "Atlas Dev", "panda-atlas-dev", "http://atlas.fake.test", ["Cora Atlas", "Dax Atlas"]),
    fakeSource("nova-lab", "Nova Lab", "panda-nova-lab", "http://nova.fake.test", ["Eve Nova", "Finn Nova"]),
  ],
});

let matrixConfig = clone(DEFAULT_MATRIX);
let lastRun = null;

const port = Number(argValue("--port") || process.env.PANDA_BRIDGE_FAKE_MATRIX_PORT || 8794);
const host = "127.0.0.1";
const server = createServer(handleRequest);

server.listen(port, host, () => {
  const address = server.address();
  const url = `http://${host}:${address.port}`;
  console.log(JSON.stringify({ ready: true, url, version: VERSION }));
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/") {
      return writeHtml(response, pageHtml());
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      return writeJson(response, 200, { ok: true, config: publicConfig(matrixConfig), last_run: lastRun });
    }
    if (request.method === "GET" && url.pathname === "/api/last-run") {
      return writeJson(response, 200, { ok: true, last_run: lastRun });
    }
    if (request.method === "POST" && url.pathname === "/api/config") {
      const body = await readJsonBody(request);
      matrixConfig = normalizeMatrix(body.config || body);
      return writeJson(response, 200, { ok: true, config: publicConfig(matrixConfig) });
    }
    if (request.method === "POST" && url.pathname === "/api/reset") {
      matrixConfig = clone(DEFAULT_MATRIX);
      lastRun = null;
      return writeJson(response, 200, { ok: true, config: publicConfig(matrixConfig), last_run: lastRun });
    }
    if (request.method === "POST" && url.pathname === "/api/run") {
      const body = await readJsonBody(request);
      matrixConfig = normalizeMatrix(body.config || matrixConfig);
      lastRun = await runMatrix(matrixConfig);
      return writeJson(response, 200, { ok: true, run: lastRun, config: publicConfig(matrixConfig) });
    }
    return writeJson(response, 404, { error: "not_found", path: url.pathname });
  } catch (error) {
    return writeJson(response, 500, { error: "fake_matrix_error", message: error.message || String(error) });
  }
}

async function runMatrix(config) {
  const normalized = normalizeMatrix(config);
  const entries = activeEntries(normalized);
  assert.equal(normalized.sources.length, 3, "matrix must contain exactly three fake sources");
  for (const source of normalized.sources) {
    assert.ok(source.accounts.filter((account) => account.enabled).length >= 2, `${source.label} must have at least two enabled accounts`);
  }

  const fakeApi = makeFakeRealtimeBridge(entries);
  await fakeApi.listen();
  const apiBase = fakeApi.apiBase;
  const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-fake-matrix-"));
  const statePath = resolve(temp, "desktop-state.json");
  const controlState = resolve(temp, "verify-control.json");
  writeFileSync(statePath, JSON.stringify(credentialsFixture(apiBase, entries), null, 2) + "\n");

  const desktop = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", "--verify-control"], {
    env: {
      ...process.env,
      PANDA_BRIDGE_VERIFY: "1",
      PANDA_BRIDGE_FAKE_CODEX: "1",
      PANDA_BRIDGE_DESKTOP_STATE: statePath,
      PANDA_BRIDGE_VERIFY_CONTROL_STATE: controlState,
      PANDA_BRIDGE_TOKEN_ROTATION_INTERVAL_SECONDS: "86400",
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

  let control = null;
  try {
    const controlInfo = await waitForControl(controlState);
    control = makeControlClient(controlInfo);
    const startWorker = await control("POST", "/v1/actions", { action: "start_worker" });
    await waitFor(async () => (await control("GET", "/v1/status")).worker_running === true, "desktop worker did not start", 30000);
    await waitForRealtimeDevices(control, entries.map((entry) => entry.device_id), 45000);

    const startedAt = Date.now();
    const created = await Promise.all(entries.map((entry) => {
      const client = createBridgeClient({
        apiBase,
        productId: entry.product_id,
        fetch: fetchWithOrigin(entry.origin, entry.account_id),
      });
      return client.codex.chat({
        deviceId: entry.device_id,
        prompt: `${entry.prompt} / ${entry.source_label} / ${entry.account_email}`,
        requestKey: `${VERSION}-${entry.source_id}-${entry.account_id}-${Date.now()}`,
        tokenBudget: 1000,
        timeoutMs: 60000,
      }).then((payload) => ({ entry, payload, client }));
    }));
    await waitForDesktopJobs(control, created.map((item) => ({
      job_id: item.payload.job.id,
      device_id: item.entry.device_id,
      account_id: item.entry.account_id,
      product_id: item.entry.product_id,
    })), 45000);

    const finals = await Promise.all(created.map(async (item) => {
      const final = await item.client.jobs.wait(item.payload.job.id, { timeoutMs: 45000, intervalMs: 250 });
      const events = await item.client.jobs.events(item.payload.job.id);
      const claimed = (events.items || []).find((event) => event.type === "claimed");
      assert.equal(final.status, "succeeded");
      assert.equal(claimed?.payload?.transport, "websocket");
      return {
        source_id: item.entry.source_id,
        source_label: item.entry.source_label,
        account_id: item.entry.account_id,
        account_email: item.entry.account_email,
        product_id: item.entry.product_id,
        origin: item.entry.origin,
        device_id: item.entry.device_id,
        job_id: final.id,
        status: final.status,
        reply: final.result?.reply || "",
        transport: claimed.payload.transport,
      };
    }));
    const desktopEvents = await control("GET", "/v1/events");
    const summary = redact({
      ok: true,
      version: VERSION,
      api_base: apiBase,
      source_count: normalized.sources.length,
      accounts_per_source: normalized.sources.map((source) => ({
        source_id: source.id,
        enabled_accounts: source.accounts.filter((account) => account.enabled).length,
      })),
      route_count: finals.length,
      start_worker: startWorker,
      run_duration_ms: Date.now() - startedAt,
      sources: normalized.sources,
      realtime_connected_devices: realtimeConnectedDevices(desktopEvents.items),
      realtime_jobs: realtimeJobs(desktopEvents.items),
      final_jobs: finals,
      server_job_events: fakeApi.publicEvents(),
      evidence_files: {
        summary: `spec/verification/evidence/${VERSION}/matrix-run-summary.json`,
        desktop_events: `spec/verification/evidence/${VERSION}/matrix-desktop-events.json`,
      },
      checked_at: new Date().toISOString(),
    });
    writeFileSync(resolve(evidenceDir, "matrix-run-summary.json"), JSON.stringify(summary, null, 2) + "\n");
    writeFileSync(resolve(evidenceDir, "matrix-desktop-events.json"), JSON.stringify(desktopEvents, null, 2) + "\n");
    writeFileSync(resolve(evidenceDir, "matrix-config.json"), JSON.stringify(publicConfig(normalized), null, 2) + "\n");
    return summary;
  } finally {
    if (control) {
      await control("POST", "/v1/actions", { action: "stop_worker" }).catch(() => null);
    }
    desktop.kill("SIGTERM");
    writeFileSync(resolve(evidenceDir, "matrix-desktop-stdout.log"), desktopStdout);
    writeFileSync(resolve(evidenceDir, "matrix-desktop-stderr.log"), desktopStderr);
    await fakeApi.close();
  }
}

function fakeSource(id, label, productId, origin, accountNames) {
  return {
    id,
    label,
    product_id: productId,
    origin,
    prompt: `v13 configured ${label}`,
    accounts: accountNames.map((name, index) => ({
      id: `${id}-acct-${index + 1}`,
      enabled: true,
      email: `${id}-acct-${index + 1}@fake.pandart.cc`,
      display_name: name,
    })),
  };
}

function normalizeMatrix(config) {
  const rawSources = Array.isArray(config?.sources) ? config.sources : DEFAULT_MATRIX.sources;
  const sources = rawSources.slice(0, 3).map((source, sourceIndex) => {
    const id = cleanId(source.id || `source-${sourceIndex + 1}`);
    const accounts = Array.isArray(source.accounts) && source.accounts.length
      ? source.accounts
      : DEFAULT_MATRIX.sources[sourceIndex]?.accounts || [];
    return {
      id,
      label: cleanText(source.label || `Fake Source ${sourceIndex + 1}`, 80),
      product_id: cleanId(source.product_id || `panda-fake-${sourceIndex + 1}`),
      origin: cleanOrigin(source.origin || `http://${id}.fake.test`),
      prompt: cleanText(source.prompt || `v13 configured ${id}`, 180),
      accounts: accounts.slice(0, 4).map((account, accountIndex) => ({
        id: cleanId(account.id || `${id}-acct-${accountIndex + 1}`),
        enabled: account.enabled !== false,
        email: cleanEmail(account.email || `${id}-acct-${accountIndex + 1}@fake.pandart.cc`),
        display_name: cleanText(account.display_name || `Fake ${accountIndex + 1}`, 80),
      })),
    };
  });
  while (sources.length < 3) {
    sources.push(clone(DEFAULT_MATRIX.sources[sources.length]));
  }
  return { sources };
}

function activeEntries(config) {
  const stamp = Date.now();
  return config.sources.flatMap((source, sourceIndex) => source.accounts
    .filter((account) => account.enabled)
    .map((account, accountIndex) => ({
      source_id: source.id,
      source_label: source.label,
      product_id: source.product_id,
      origin: source.origin,
      prompt: source.prompt,
      account_id: `${source.id}-${account.id}-${stamp}`,
      account_email: account.email,
      account_display: account.display_name,
      device_id: `dev-${source.id}-${account.id}-${stamp}`,
      token: `token-${sourceIndex + 1}-${accountIndex + 1}-${stamp}`,
    })));
}

function credentialsFixture(apiBase, entries) {
  const connections = entries.map((entry) => connectionFixture(apiBase, entry));
  return { ...connections[0], connections };
}

function connectionFixture(apiBase, entry) {
  const at = now();
  return {
    api_base: apiBase,
    device_id: entry.device_id,
    device_name: `Fake Matrix ${entry.source_label}`,
    device_token: entry.token,
    install_id: `install-${VERSION}`,
    account_id: entry.account_id,
    account_display: entry.account_email,
    product_id: entry.product_id,
    product_name: entry.source_label,
    cloud_origin: entry.origin,
    authorized_products: [
      {
        id: entry.product_id,
        name: entry.source_label,
        origin: entry.origin,
        capabilities: ["codex.chat", "codex.run"],
        accounts: [
          {
            id: entry.account_id,
            email: entry.account_email,
            display_name: entry.account_display,
            device_id: entry.device_id,
            origin: entry.origin,
            authorized_at: at,
          },
        ],
        authorized_at: at,
      },
    ],
    device_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
    device_token_rotated_at_unix: Math.floor(Date.now() / 1000),
    install_identity_bound: true,
    connections: [],
    claimed_at: at,
  };
}

function makeFakeRealtimeBridge(entries) {
  const entriesByToken = new Map(entries.map((entry) => [entry.token, entry]));
  const entriesByDevice = new Map(entries.map((entry) => [entry.device_id, entry]));
  const sockets = new Map();
  const jobs = new Map();
  const jobEvents = new Map();
  const apiEvents = [];
  let seq = 0;
  let port = 0;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const body = await readJsonBody(request);
      const productJobMatch = url.pathname.match(/^\/v1\/products\/([^/]+)\/jobs$/);
      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      const jobEventsMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/events$/);
      const connectorAcceptMatch = url.pathname.match(/^\/v1\/connectors\/jobs\/([^/]+)\/accept$/);
      const connectorEventsMatch = url.pathname.match(/^\/v1\/connectors\/jobs\/([^/]+)\/events$/);
      const connectorAckMatch = url.pathname.match(/^\/v1\/connectors\/jobs\/([^/]+)\/ack$/);

      if (request.method === "GET" && url.pathname === "/v1/diagnostics") {
        return writeJson(response, 200, { ok: true, realtime: { enabled: true }, fake_matrix: true });
      }
      if (request.method === "POST" && productJobMatch) {
        const productId = decodeURIComponent(productJobMatch[1]);
        const entry = entriesByDevice.get(body.device_id);
        assert.ok(entry, `unknown device ${body.device_id}`);
        assert.equal(productId, entry.product_id, `product mismatch for ${entry.device_id}`);
        const at = now();
        const job = {
          id: `job_${++seq}_${Date.now()}`,
          device_id: entry.device_id,
          product_id: productId,
          source_origin: request.headers.origin || entry.origin,
          kind: body.kind || "codex.chat",
          runtime: "codex",
          workspace_ref: body.workspace_ref || "default",
          input: body.input || {},
          policy: body.policy || {},
          request_key: body.request_key || null,
          status: "queued",
          result: null,
          created_at: at,
          updated_at: at,
          queued_at: at,
          user_id: entry.account_id,
        };
        jobs.set(job.id, job);
        jobEvents.set(job.id, [event(job.id, "queued", { device_id: entry.device_id })]);
        apiEvents.push({ type: "job_created", job_id: job.id, device_id: entry.device_id, product_id: productId, at });
        dispatchJob(job);
        return writeJson(response, 200, { job: publicJob(job), product: { id: productId, name: entry.source_label } });
      }
      if (request.method === "GET" && jobMatch) {
        const job = requiredJob(decodeURIComponent(jobMatch[1]));
        return writeJson(response, 200, { job: publicJob(job) });
      }
      if (request.method === "GET" && jobEventsMatch) {
        const job = requiredJob(decodeURIComponent(jobEventsMatch[1]));
        const after = Number(url.searchParams.get("after") || 0);
        return writeJson(response, 200, {
          job: publicJob(job),
          items: (jobEvents.get(job.id) || []).filter((item) => Number(item.seq || 0) > after),
        });
      }
      if (request.method === "POST" && connectorAcceptMatch) {
        const entry = requireConnector(request);
        const job = requiredJob(decodeURIComponent(connectorAcceptMatch[1]));
        assert.equal(job.device_id, entry.device_id);
        if (job.status !== "queued") return writeJson(response, 200, { job: publicJob(job), accepted: false });
        const at = now();
        Object.assign(job, {
          status: "running",
          desktop_received_at: body.desktop_received_at || at,
          accepted_at: at,
          updated_at: at,
        });
        appendJobEvent(job.id, "claimed", { device_id: entry.device_id, transport: body.transport || "websocket", accepted_at: at }, 2);
        apiEvents.push({ type: "job_accepted", job_id: job.id, device_id: entry.device_id, product_id: job.product_id, at });
        return writeJson(response, 200, { job: publicJob(job), accepted: true });
      }
      if (request.method === "POST" && connectorEventsMatch) {
        const entry = requireConnector(request);
        const job = requiredJob(decodeURIComponent(connectorEventsMatch[1]));
        assert.equal(job.device_id, entry.device_id);
        const incoming = Array.isArray(body.events) ? body.events : [body];
        const items = incoming.map((item) => {
          const type = item.type || "status";
          if (type === "started" && !job.started_at) job.started_at = now();
          if (type === "text_delta" && !job.first_delta_at) job.first_delta_at = now();
          job.updated_at = now();
          return appendJobEvent(job.id, type, item.payload || item);
        });
        return writeJson(response, 201, { items });
      }
      if (request.method === "POST" && connectorAckMatch) {
        const entry = requireConnector(request);
        const job = requiredJob(decodeURIComponent(connectorAckMatch[1]));
        assert.equal(job.device_id, entry.device_id);
        const at = now();
        Object.assign(job, {
          status: body.status === "failed" ? "failed" : "succeeded",
          result: body.result || {},
          completed_at: job.completed_at || at,
          acked_at: at,
          updated_at: at,
        });
        appendJobEvent(job.id, job.status === "failed" ? "failed" : "completed", { ...job.result, completed_at: job.completed_at, acked_at: at });
        apiEvents.push({ type: "job_acked", job_id: job.id, device_id: entry.device_id, product_id: job.product_id, at });
        return writeJson(response, 200, { job: publicJob(job) });
      }
      return writeJson(response, 404, { error: "not_found", path: url.pathname });
    } catch (error) {
      return writeJson(response, 500, { error: "fake_bridge_error", message: error.message || String(error) });
    }
  });

  server.on("upgrade", (request, socket) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const match = url.pathname.match(/^\/v1\/realtime\/devices\/([^/]+)$/);
      if (!match) return socket.destroy();
      const entry = requireConnector(request);
      const deviceId = decodeURIComponent(match[1]);
      assert.equal(entry.device_id, deviceId);
      const key = request.headers["sec-websocket-key"];
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"));
      sockets.set(deviceId, socket);
      apiEvents.push({ type: "realtime_connected", device_id: deviceId, account_id: entry.account_id, product_id: entry.product_id, at: now() });
      sendWs(socket, { type: "realtime.ready", role: "desktop", device_id: deviceId, connected_at: now() });
      socket.on("close", () => sockets.delete(deviceId));
      socket.on("error", () => sockets.delete(deviceId));
      socket.on("data", () => {});
    } catch {
      socket.destroy();
    }
  });

  function dispatchJob(job) {
    const socket = sockets.get(job.device_id);
    if (!socket || socket.destroyed) return;
    const at = now();
    job.pushed_at = at;
    job.updated_at = at;
    apiEvents.push({ type: "job_pushed", job_id: job.id, device_id: job.device_id, product_id: job.product_id, at });
    sendWs(socket, { type: "job.assign", job: publicJob(job), sent_at: at });
  }

  function requireConnector(request) {
    const auth = request.headers.authorization || "";
    const token = auth.match(/^Bearer (.+)$/)?.[1];
    const entry = entriesByToken.get(token);
    if (!entry) throw new Error("unauthorized connector");
    return entry;
  }

  function requiredJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);
    return job;
  }

  function appendJobEvent(jobId, type, payload, forcedSeq = null) {
    const item = event(jobId, type, payload, forcedSeq);
    const items = jobEvents.get(jobId) || [];
    items.push(item);
    jobEvents.set(jobId, items);
    return item;
  }

  function event(jobId, type, payload, forcedSeq = null) {
    const items = jobEvents.get(jobId) || [];
    return { id: `evt_${jobId}_${forcedSeq || items.length + 1}`, job_id: jobId, seq: forcedSeq || items.length + 1, type, payload, created_at: now() };
  }

  return {
    get apiBase() {
      return `http://127.0.0.1:${port}`;
    },
    listen: () => new Promise((resolveListen) => {
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolveListen();
      });
    }),
    close: async () => {
      for (const socket of sockets.values()) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
    publicEvents: () => apiEvents.slice(),
  };
}

function publicJob(job) {
  return {
    id: job.id,
    device_id: job.device_id,
    product_id: job.product_id,
    source_origin: job.source_origin || null,
    kind: job.kind,
    runtime: job.runtime,
    workspace_ref: job.workspace_ref,
    input: job.input,
    policy: job.policy,
    status: job.status,
    result: job.result,
    request_key: job.request_key,
    created_at: job.created_at,
    updated_at: job.updated_at,
    queued_at: job.queued_at || job.created_at || null,
    pushed_at: job.pushed_at || null,
    desktop_received_at: job.desktop_received_at || null,
    accepted_at: job.accepted_at || null,
    started_at: job.started_at || null,
    first_delta_at: job.first_delta_at || null,
    completed_at: job.completed_at || null,
    acked_at: job.acked_at || null,
    timing: {},
  };
}

function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Panda Fake Source Matrix</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080b0e;
      --panel: #10171d;
      --panel-2: #151f27;
      --rail: #0d1217;
      --line: #273744;
      --line-strong: #40505e;
      --text: #edf4f6;
      --muted: #8ea2b0;
      --faint: #60717d;
      --accent: #d4ad4d;
      --cyan: #4fd1c5;
      --green: #62d38f;
      --red: #f06d62;
      --ink: #05080a;
      --radius: 6px;
      --mono: "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace;
      --body: "Aptos", "IBM Plex Sans", "Helvetica Neue", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px) 0 0/56px 56px, var(--bg); color: var(--text); font-family: var(--body); line-height: 1.45; }
    button, input { font: inherit; }
    button { cursor: pointer; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 260px 1fr; }
    aside { background: var(--rail); border-right: 1px solid var(--line); padding: 18px 14px; display: grid; grid-template-rows: auto auto 1fr auto; gap: 16px; }
    .mark { display: grid; grid-template-columns: 44px 1fr; gap: 11px; align-items: center; }
    .badge { width: 44px; height: 44px; display: grid; place-items: center; background: var(--accent); color: var(--ink); font-weight: 900; border-radius: var(--radius); }
    h1 { margin: 0; font-size: 22px; line-height: 1; letter-spacing: 0; }
    .sub { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
    .metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .metric { border: 1px solid var(--line); padding: 9px; background: #0b1014; border-radius: var(--radius); }
    .metric strong { display: block; font-family: var(--mono); font-size: 18px; color: var(--cyan); }
    .metric span { color: var(--muted); font-size: 11px; text-transform: uppercase; }
    .source-list { display: grid; gap: 7px; align-content: start; }
    .source-tab { width: 100%; border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 10px; text-align: left; border-radius: var(--radius); display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .source-tab[aria-selected="true"] { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
    .source-tab small { color: var(--muted); font-family: var(--mono); }
    .runner { display: grid; gap: 8px; }
    .primary, .secondary { border: 1px solid var(--line-strong); padding: 11px 12px; border-radius: var(--radius); font-weight: 800; }
    .primary { background: var(--accent); color: var(--ink); }
    .secondary { background: transparent; color: var(--text); }
    main { padding: 18px; display: grid; grid-template-rows: auto 1fr auto; gap: 14px; min-width: 0; }
    .topbar { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: end; border-bottom: 1px solid var(--line); padding-bottom: 14px; }
    .topbar h2 { margin: 0; font-size: 28px; letter-spacing: 0; }
    .status-pill { border: 1px solid var(--line-strong); padding: 8px 10px; border-radius: var(--radius); font-family: var(--mono); font-size: 12px; color: var(--cyan); }
    .workspace { display: grid; grid-template-columns: minmax(360px, 500px) minmax(420px, 1fr); gap: 14px; min-width: 0; }
    section { border: 1px solid var(--line); background: var(--panel); border-radius: var(--radius); min-width: 0; }
    section h3 { margin: 0; padding: 11px 12px; border-bottom: 1px solid var(--line); font-size: 13px; color: #d8e3e7; text-transform: uppercase; letter-spacing: .04em; }
    .form { padding: 12px; display: grid; gap: 12px; }
    label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
    input[type="text"], input[type="url"], input[type="email"] { width: 100%; border: 1px solid var(--line); background: #091015; color: var(--text); padding: 10px; border-radius: var(--radius); outline: none; }
    input:focus { border-color: var(--cyan); box-shadow: 0 0 0 2px rgba(79,209,197,.12); }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .account-row { border: 1px solid var(--line); background: var(--panel-2); border-radius: var(--radius); padding: 10px; display: grid; gap: 8px; }
    .account-head { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; }
    .account-head button { border: 1px solid var(--line); background: #0c1318; color: var(--cyan); padding: 6px 8px; border-radius: var(--radius); font-family: var(--mono); font-size: 11px; }
    .matrix-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .matrix-table th, .matrix-table td { border-bottom: 1px solid var(--line); padding: 9px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    .matrix-table th { color: var(--muted); background: #0c1217; font-size: 11px; text-transform: uppercase; }
    .ok { color: var(--green); font-weight: 800; }
    .bad { color: var(--red); font-weight: 800; }
    .log { padding: 10px 12px; color: var(--muted); font-family: var(--mono); font-size: 11px; min-height: 36px; border-top: 1px solid var(--line); }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      aside { grid-template-rows: auto auto auto auto; }
      .workspace { grid-template-columns: 1fr; }
      .topbar { grid-template-columns: 1fr; }
      .two { grid-template-columns: 1fr; }
      .matrix-table thead { display: none; }
      .matrix-table, .matrix-table tbody, .matrix-table tr, .matrix-table td { display: block; width: 100%; }
      .matrix-table tr { border-bottom: 1px solid var(--line); padding: 8px 0; }
      .matrix-table td { border-bottom: 0; display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 10px; padding: 5px 9px; }
      .matrix-table td::before { content: attr(data-label); color: var(--muted); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="mark">
        <div class="badge">FM</div>
        <div><h1>Fake Matrix</h1><p class="sub">3 sources / 2 accounts each</p></div>
      </div>
      <div class="metric-grid">
        <div class="metric"><strong data-metric-sources>3</strong><span>sources</span></div>
        <div class="metric"><strong data-metric-routes>6</strong><span>routes</span></div>
      </div>
      <div class="source-list" data-source-list></div>
      <div class="runner">
        <button class="primary" data-action="run-all">Run 3x2 Matrix</button>
        <button class="secondary" data-action="save-config">Save Config</button>
        <button class="secondary" data-action="reset-config">Reset Fake Defaults</button>
      </div>
    </aside>
    <main>
      <div class="topbar">
        <div><h2 data-current-title>Source</h2><p class="sub">Every field below is editable; every account row is clickable.</p></div>
        <div class="status-pill" data-run-status>idle</div>
      </div>
      <div class="workspace">
        <section>
          <h3>Source configuration</h3>
          <div class="form" data-editor></div>
        </section>
        <section>
          <h3>Run evidence</h3>
          <div style="overflow:auto">
            <table class="matrix-table">
              <thead><tr><th>Source</th><th>Account</th><th>Origin</th><th>Job</th><th>Transport</th><th>Status</th></tr></thead>
              <tbody data-result-body><tr><td colspan="6">No run yet.</td></tr></tbody>
            </table>
          </div>
          <div class="log" data-log>Ready.</div>
        </section>
      </div>
    </main>
  </div>
  <script>
    let state = null;
    let selected = null;
    window.__matrixState = null;

    async function load() {
      const payload = await api("/api/config");
      state = payload.config;
      selected = state.sources[0].id;
      window.__matrixState = { config: state, lastRun: payload.last_run };
      render(payload.last_run);
    }

    async function api(path, body) {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.message || payload.error || "request failed");
      return payload;
    }

    function render(lastRun = window.__matrixState?.lastRun || null) {
      document.querySelector("[data-metric-sources]").textContent = state.sources.length;
      document.querySelector("[data-metric-routes]").textContent = state.sources.reduce((sum, source) => sum + source.accounts.filter((account) => account.enabled).length, 0);
      const source = state.sources.find((item) => item.id === selected) || state.sources[0];
      selected = source.id;
      document.querySelector("[data-current-title]").textContent = source.label;
      document.querySelector("[data-source-list]").innerHTML = state.sources.map((item) => \`
        <button class="source-tab" data-source-tab="\${item.id}" aria-selected="\${item.id === selected}">
          <span>\${escapeHtml(item.label)}</span>
          <small>\${escapeHtml(item.accounts.filter((account) => account.enabled).length)} acct</small>
        </button>\`).join("");
      document.querySelectorAll("[data-source-tab]").forEach((button) => button.addEventListener("click", () => {
        selected = button.dataset.sourceTab;
        render();
      }));
      document.querySelector("[data-editor]").innerHTML = editorHtml(source);
      bindEditor(source);
      renderResults(lastRun);
      if (lastRun?.final_jobs?.length) {
        document.querySelector("[data-run-status]").textContent = lastRun.ok ? "complete" : "failed";
        document.querySelector("[data-log]").textContent = \`Completed \${lastRun.route_count} fake routes over websocket.\`;
      }
    }

    function editorHtml(source) {
      return \`
        <div class="two">
          <label>Source label<input data-source-field="label" type="text" value="\${escapeAttr(source.label)}"></label>
          <label>Product ID<input data-source-field="product_id" type="text" value="\${escapeAttr(source.product_id)}"></label>
        </div>
        <label>Origin<input data-source-field="origin" type="url" value="\${escapeAttr(source.origin)}"></label>
        <label>Prompt seed<input data-source-field="prompt" type="text" value="\${escapeAttr(source.prompt)}"></label>
        <div data-account-list>\${source.accounts.map((account, index) => accountHtml(source, account, index)).join("")}</div>
      \`;
    }

    function accountHtml(source, account, index) {
      return \`
        <div class="account-row" data-account-row="\${account.id}">
          <div class="account-head">
            <input data-account-field="enabled" data-account-index="\${index}" type="checkbox" \${account.enabled ? "checked" : ""}>
            <strong>\${escapeHtml(account.display_name)}</strong>
            <button data-account-focus="\${source.id}:\${account.id}" type="button">focus</button>
          </div>
          <div class="two">
            <label>Email<input data-account-field="email" data-account-index="\${index}" type="email" value="\${escapeAttr(account.email)}"></label>
            <label>Display<input data-account-field="display_name" data-account-index="\${index}" type="text" value="\${escapeAttr(account.display_name)}"></label>
          </div>
        </div>
      \`;
    }

    function bindEditor(source) {
      document.querySelectorAll("[data-source-field]").forEach((input) => {
        input.addEventListener("input", () => {
          source[input.dataset.sourceField] = input.value;
          if (input.dataset.sourceField === "label") document.querySelector("[data-current-title]").textContent = input.value;
        });
      });
      document.querySelectorAll("[data-account-field]").forEach((input) => {
        input.addEventListener("input", () => updateAccount(source, input));
        input.addEventListener("change", () => updateAccount(source, input));
      });
      document.querySelectorAll("[data-account-focus]").forEach((button) => {
        button.addEventListener("click", () => {
          focusAccountRow(button.closest(".account-row"), button.dataset.accountFocus);
        });
      });
      document.querySelectorAll("[data-account-row]").forEach((row) => {
        row.addEventListener("click", (event) => {
          if (event.target.matches("input, button")) return;
          focusAccountRow(row, source.id + ":" + row.dataset.accountRow);
        });
      });
    }

    function updateAccount(source, input) {
      const account = source.accounts[Number(input.dataset.accountIndex)];
      account[input.dataset.accountField] = input.type === "checkbox" ? input.checked : input.value;
      if (input.type === "checkbox") {
        document.querySelector("[data-metric-routes]").textContent = state.sources.reduce((sum, item) => sum + item.accounts.filter((row) => row.enabled).length, 0);
        document.querySelectorAll("[data-source-tab]").forEach((tab) => {
          const item = state.sources.find((candidate) => candidate.id === tab.dataset.sourceTab);
          const small = tab.querySelector("small");
          if (item && small) small.textContent = item.accounts.filter((row) => row.enabled).length + " acct";
        });
      }
      if (input.dataset.accountField === "display_name") {
        const row = input.closest(".account-row");
        const label = row?.querySelector("strong");
        if (label) label.textContent = input.value;
      }
    }

    function focusAccountRow(row, label) {
      document.querySelectorAll(".account-row").forEach((item) => item.style.borderColor = "var(--line)");
      row.style.borderColor = "var(--cyan)";
      document.querySelector("[data-log]").textContent = "Focused " + label;
    }

    function renderResults(lastRun) {
      const body = document.querySelector("[data-result-body]");
      if (!lastRun?.final_jobs?.length) {
        body.innerHTML = '<tr><td colspan="6">No run yet.</td></tr>';
        return;
      }
      body.innerHTML = lastRun.final_jobs.map((job) => \`
        <tr data-result-row="\${job.source_id}:\${job.account_id}">
          <td data-label="Source">\${escapeHtml(job.source_label)}</td>
          <td data-label="Account">\${escapeHtml(job.account_email)}</td>
          <td data-label="Origin">\${escapeHtml(job.origin)}</td>
          <td data-label="Job"><code>\${escapeHtml(job.job_id)}</code></td>
          <td data-label="Transport">\${escapeHtml(job.transport)}</td>
          <td data-label="Status" class="\${job.status === "succeeded" ? "ok" : "bad"}">\${escapeHtml(job.status)}</td>
        </tr>\`).join("");
    }

    document.querySelector("[data-action='save-config']").addEventListener("click", async () => {
      const payload = await api("/api/config", { config: state });
      state = payload.config;
      window.__matrixState = { config: state, lastRun: window.__matrixState?.lastRun || null };
      document.querySelector("[data-log]").textContent = "Config saved.";
      render();
    });
    document.querySelector("[data-action='reset-config']").addEventListener("click", async () => {
      const payload = await api("/api/reset", {});
      state = payload.config;
      selected = state.sources[0].id;
      window.__matrixState = { config: state, lastRun: payload.last_run };
      document.querySelector("[data-run-status]").textContent = "idle";
      document.querySelector("[data-log]").textContent = "Fake defaults restored.";
      render(payload.last_run);
    });
    document.querySelector("[data-action='run-all']").addEventListener("click", async () => {
      document.querySelector("[data-run-status]").textContent = "running";
      document.querySelector("[data-log]").textContent = "Running Desktop + SDK matrix...";
      try {
        const payload = await api("/api/run", { config: state });
        state = payload.config;
        window.__matrixState = { config: state, lastRun: payload.run };
        document.querySelector("[data-run-status]").textContent = payload.run.ok ? "complete" : "failed";
        document.querySelector("[data-log]").textContent = \`Completed \${payload.run.route_count} fake routes over websocket.\`;
        render(payload.run);
      } catch (error) {
        document.querySelector("[data-run-status]").textContent = "failed";
        document.querySelector("[data-log]").textContent = error.message || String(error);
      }
    });

    function escapeHtml(value) {
      return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    }
    function escapeAttr(value) { return escapeHtml(value); }
    load().catch((error) => { document.querySelector("[data-log]").textContent = error.message || String(error); });
  </script>
</body>
</html>`;
}

async function waitForControl(path) {
  return waitFor(() => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }, "verify control file was not created", 30000);
}

function makeControlClient(info) {
  return async (method, path, body = null) => {
    const response = await fetch(`${info.base_url}${path}`, {
      method,
      headers: {
        accept: "application/json",
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

async function waitForRealtimeDevices(control, deviceIds, timeout) {
  await waitFor(async () => {
    const events = await control("GET", "/v1/events");
    const seen = new Set(realtimeConnectedDevices(events.items));
    return deviceIds.every((deviceId) => seen.has(deviceId));
  }, `desktop did not connect realtime devices ${deviceIds.join(", ")}`, timeout);
}

async function waitForDesktopJobs(control, expected, timeout) {
  await waitFor(async () => {
    const events = await control("GET", "/v1/events");
    const items = realtimeJobs(events.items);
    return expected.every((job) => items.some((item) => item.job_id === job.job_id && item.device_id === job.device_id && item.account_id === job.account_id && item.product_id === job.product_id));
  }, "desktop did not receive every matrix job over realtime", timeout);
}

async function waitFor(operation, message, timeout = 30000, interval = 250) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, interval));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message || lastError}` : ""}`);
}

function realtimeConnectedDevices(events) {
  return (events || []).filter((item) => item.type === "realtime_connected").map((item) => item.payload?.device_id).filter(Boolean);
}

function realtimeJobs(events) {
  return (events || []).filter((item) => item.type === "realtime_job").map((item) => ({
    job_id: item.payload?.job_id,
    device_id: item.payload?.device_id,
    account_id: item.payload?.account_id,
    product_id: item.payload?.product_id,
    transport: item.payload?.transport,
  }));
}

function sendWs(socket, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  socket.write(Buffer.concat([header, data]));
}

function fetchWithOrigin(origin, accountId) {
  return (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", origin);
    headers.set("cookie", `fake_session=${accountId}`);
    return fetch(url, { ...init, headers });
  };
}

function readJsonBody(request) {
  return new Promise((resolveRead, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolveRead(text ? JSON.parse(text) : {});
    });
    request.on("error", reject);
  });
}

function writeJson(response, status, payload) {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "access-control-allow-origin": "*",
  });
  response.end(text);
}

function writeHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  response.end(html);
}

function publicConfig(config) {
  return clone(config);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function redact(value) {
  const text = JSON.stringify(value, (key, item) => (/token|cookie|session/i.test(key) ? "[redacted]" : item));
  return JSON.parse(text);
}

function cleanId(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "fake";
}

function cleanText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanOrigin(value) {
  const text = String(value || "").trim().slice(0, 240);
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "http://invalid.fake.test";
  }
}

function cleanEmail(value) {
  const text = String(value || "").trim().toLowerCase().slice(0, 160);
  return text.includes("@") ? text : `${cleanId(text)}@fake.pandart.cc`;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function now() {
  return new Date().toISOString();
}
