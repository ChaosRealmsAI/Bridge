#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

const VERSION = "v12-multi-account-realtime-fanout";
const evidenceDir = resolve("spec/verification/evidence", VERSION);
mkdirSync(evidenceDir, { recursive: true });

const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-realtime-fanout-"));
const statePath = resolve(temp, "desktop-state.json");
const controlState = resolve(temp, "verify-control.json");
const deviceName = `V12 Fanout Desktop ${Date.now()}`;
const installId = `install-v12-${Date.now()}`;
const accountA = {
  id: `acct-v12-a-${Date.now()}`,
  email: `v12-a-${Date.now()}@pandart.cc`,
  display: "V12 Account A",
  device_id: `dev-v12-a-${Date.now()}`,
  token: `token-v12-a-${Date.now()}`,
};
const accountB = {
  id: `acct-v12-b-${Date.now()}`,
  email: `v12-b-${Date.now()}@pandart.cc`,
  display: "V12 Account B",
  device_id: `dev-v12-b-${Date.now()}`,
  token: `token-v12-b-${Date.now()}`,
};

const fakeApi = makeFakeRealtimeBridge([accountA, accountB]);
await fakeApi.listen();
const apiBase = fakeApi.apiBase;
writeFileSync(statePath, JSON.stringify(credentialsFixture(apiBase), null, 2) + "\n");

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
  const started = await control("POST", "/v1/actions", { action: "start_worker" });
  assert.equal(started.ok, true);
  assert.ok(
    [0, 2].includes(started.spawned_realtime_connections),
    `unexpected spawned realtime count: ${started.spawned_realtime_connections}`,
  );
  await waitFor(async () => (await control("GET", "/v1/status")).worker_running === true, "desktop worker did not start");
  await waitForRealtimeDevices(control, [accountA.device_id, accountB.device_id], 30000);

  const clientA = createBridgeClient({
    apiBase,
    productId: "panda-chat",
    fetch: fetchWithOrigin("http://chat.local.test", accountA.id),
  });
  const clientB = createBridgeClient({
    apiBase,
    productId: "panda-chat",
    fetch: fetchWithOrigin("http://chat.local.test", accountB.id),
  });
  const createStartedAt = Date.now();
  const [createdA, createdB] = await Promise.all([
    clientA.codex.chat({
      deviceId: accountA.device_id,
      prompt: "v12 account A realtime fanout",
      requestKey: `v12-a-${Date.now()}`,
      tokenBudget: 1000,
      timeoutMs: 60000,
    }),
    clientB.codex.chat({
      deviceId: accountB.device_id,
      prompt: "v12 account B realtime fanout",
      requestKey: `v12-b-${Date.now()}`,
      tokenBudget: 1000,
      timeoutMs: 60000,
    }),
  ]);
  const createDurationMs = Date.now() - createStartedAt;
  assert.equal(createdA.job.status, "queued");
  assert.equal(createdB.job.status, "queued");
  assert.notEqual(createdA.job.device_id, createdB.job.device_id);

  await waitForDesktopJobs(control, [
    { job_id: createdA.job.id, device_id: accountA.device_id, account_id: accountA.id },
    { job_id: createdB.job.id, device_id: accountB.device_id, account_id: accountB.id },
  ], 30000);

  const [finalA, finalB] = await Promise.all([
    clientA.jobs.wait(createdA.job.id, { timeoutMs: 30000, intervalMs: 250 }),
    clientB.jobs.wait(createdB.job.id, { timeoutMs: 30000, intervalMs: 250 }),
  ]);
  assert.equal(finalA.status, "succeeded");
  assert.equal(finalB.status, "succeeded");
  assert.match(finalA.result.reply, /v12 account A realtime fanout/);
  assert.match(finalB.result.reply, /v12 account B realtime fanout/);

  const [eventsA, eventsB] = await Promise.all([
    clientA.jobs.events(createdA.job.id),
    clientB.jobs.events(createdB.job.id),
  ]);
  assertClaimedOverWebsocket(eventsA.items, createdA.job.id);
  assertClaimedOverWebsocket(eventsB.items, createdB.job.id);

  const desktopEvents = await control("GET", "/v1/events");
  const summary = redact({
    ok: true,
    version: VERSION,
    api_base: apiBase,
    state_path: statePath,
    accounts: {
      a: { id: accountA.id, email: accountA.email, device_id: accountA.device_id },
      b: { id: accountB.id, email: accountB.email, device_id: accountB.device_id },
    },
    start_worker: started,
    create_duration_ms: createDurationMs,
    created_jobs: [
      { job_id: createdA.job.id, device_id: createdA.job.device_id, status: createdA.job.status },
      { job_id: createdB.job.id, device_id: createdB.job.device_id, status: createdB.job.status },
    ],
    final_jobs: [
      { job_id: finalA.id, status: finalA.status, reply: finalA.result.reply },
      { job_id: finalB.id, status: finalB.status, reply: finalB.result.reply },
    ],
    realtime_connected_devices: realtimeConnectedDevices(desktopEvents.items),
    realtime_jobs: realtimeJobs(desktopEvents.items),
    server_job_events: fakeApi.publicEvents(),
    locked_regression: "npm run verify:multi-account-realtime",
    source_access: "SDK-as-user job creation plus Desktop verify-control status/events; no Desktop source, storage internals, or hidden poll command used as the route oracle.",
    checked_at: new Date().toISOString(),
  });
  writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(resolve(evidenceDir, "desktop-events.json"), JSON.stringify(desktopEvents, null, 2) + "\n");
  writeFileSync(resolve(evidenceDir, "job-a-events.json"), JSON.stringify(eventsA, null, 2) + "\n");
  writeFileSync(resolve(evidenceDir, "job-b-events.json"), JSON.stringify(eventsB, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (control) {
    await control("POST", "/v1/actions", { action: "stop_worker" }).catch(() => null);
  }
  desktop.kill("SIGTERM");
  writeFileSync(resolve(evidenceDir, "desktop-stdout.log"), desktopStdout);
  writeFileSync(resolve(evidenceDir, "desktop-stderr.log"), desktopStderr);
  await fakeApi.close();
}

function makeFakeRealtimeBridge(accounts) {
  const accountsByToken = new Map(accounts.map((account) => [account.token, account]));
  const accountsByDevice = new Map(accounts.map((account) => [account.device_id, account]));
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
        return writeJson(response, 200, { ok: true, realtime: { enabled: true } });
      }
      if (request.method === "POST" && productJobMatch) {
        const productId = decodeURIComponent(productJobMatch[1]);
        const account = accountsByDevice.get(body.device_id);
        assert.ok(account, `unknown device ${body.device_id}`);
        const at = now();
        const job = {
          id: `job_${++seq}_${Date.now()}`,
          device_id: account.device_id,
          product_id: productId,
          source_origin: request.headers.origin || null,
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
          user_id: account.id,
        };
        jobs.set(job.id, job);
        jobEvents.set(job.id, [event(job.id, "queued", { device_id: account.device_id })]);
        apiEvents.push({ type: "job_created", job_id: job.id, device_id: account.device_id, at });
        dispatchJob(job);
        return writeJson(response, 200, { job: publicJob(job), product: { id: productId, name: "Panda Chat" } });
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
        const connector = requireConnector(request);
        const job = requiredJob(decodeURIComponent(connectorAcceptMatch[1]));
        assert.equal(job.device_id, connector.device_id);
        if (job.status !== "queued") {
          return writeJson(response, 200, { job: publicJob(job), accepted: false });
        }
        const at = now();
        Object.assign(job, {
          status: "running",
          desktop_received_at: body.desktop_received_at || at,
          accepted_at: at,
          updated_at: at,
        });
        appendJobEvent(job.id, "claimed", {
          device_id: connector.device_id,
          transport: body.transport || "websocket",
          accepted_at: at,
        }, 2);
        apiEvents.push({ type: "job_accepted", job_id: job.id, device_id: connector.device_id, at });
        return writeJson(response, 200, { job: publicJob(job), accepted: true });
      }
      if (request.method === "POST" && connectorEventsMatch) {
        const connector = requireConnector(request);
        const job = requiredJob(decodeURIComponent(connectorEventsMatch[1]));
        assert.equal(job.device_id, connector.device_id);
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
        const connector = requireConnector(request);
        const job = requiredJob(decodeURIComponent(connectorAckMatch[1]));
        assert.equal(job.device_id, connector.device_id);
        const at = now();
        Object.assign(job, {
          status: body.status === "failed" ? "failed" : "succeeded",
          result: body.result || {},
          completed_at: job.completed_at || at,
          acked_at: at,
          updated_at: at,
        });
        appendJobEvent(job.id, job.status === "failed" ? "failed" : "completed", {
          ...job.result,
          completed_at: job.completed_at,
          acked_at: at,
        });
        apiEvents.push({ type: "job_acked", job_id: job.id, device_id: connector.device_id, at });
        return writeJson(response, 200, { job: publicJob(job) });
      }
      writeJson(response, 404, { error: "not_found", path: url.pathname });
    } catch (error) {
      writeJson(response, 500, { error: "fake_bridge_error", message: error.message || String(error) });
    }
  });

  server.on("upgrade", (request, socket) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const match = url.pathname.match(/^\/v1\/realtime\/devices\/([^/]+)$/);
      if (!match) return socket.destroy();
      const account = requireConnector(request);
      const deviceId = decodeURIComponent(match[1]);
      assert.equal(account.device_id, deviceId);
      const key = request.headers["sec-websocket-key"];
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"));
      sockets.set(deviceId, socket);
      apiEvents.push({ type: "realtime_connected", device_id: deviceId, account_id: account.id, at: now() });
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
    apiEvents.push({ type: "job_pushed", job_id: job.id, device_id: job.device_id, at });
    sendWs(socket, { type: "job.assign", job: publicJob(job), sent_at: at });
  }

  function requireConnector(request) {
    const auth = request.headers.authorization || "";
    const token = auth.match(/^Bearer (.+)$/)?.[1];
    const account = accountsByToken.get(token);
    if (!account) throw new Error("unauthorized connector");
    return account;
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
    return {
      id: `evt_${jobId}_${forcedSeq || items.length + 1}`,
      job_id: jobId,
      seq: forcedSeq || items.length + 1,
      type,
      payload,
      created_at: now(),
    };
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

function credentialsFixture(apiBase) {
  const connections = [accountA, accountB].map((account) => connectionFixture(apiBase, account));
  return {
    ...connections[0],
    connections,
  };
}

function connectionFixture(apiBase, account) {
  const at = now();
  return {
    api_base: apiBase,
    device_id: account.device_id,
    device_name: deviceName,
    device_token: account.token,
    install_id: installId,
    account_id: account.id,
    account_display: account.email,
    product_id: "panda-chat",
    product_name: "Panda Chat",
    cloud_origin: "http://chat.local.test",
    authorized_products: [
      {
        id: "panda-chat",
        name: "Panda Chat",
        origin: "http://chat.local.test",
        capabilities: ["codex.chat", "codex.run"],
        accounts: [
          {
            id: account.id,
            email: account.email,
            display_name: account.display,
            device_id: account.device_id,
            origin: "http://chat.local.test",
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
    return expected.every((job) => items.some((item) => (
      item.job_id === job.job_id &&
      item.device_id === job.device_id &&
      item.account_id === job.account_id
    )));
  }, "desktop did not receive every account job over realtime", timeout);
}

function assertClaimedOverWebsocket(items, jobId) {
  const claimed = (items || []).find((item) => item.type === "claimed");
  assert.ok(claimed, `job ${jobId} was not claimed`);
  assert.equal(claimed.payload?.transport, "websocket", `job ${jobId} was not claimed over websocket`);
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
  return (events || [])
    .filter((item) => item.type === "realtime_connected")
    .map((item) => item.payload?.device_id)
    .filter(Boolean);
}

function realtimeJobs(events) {
  return (events || [])
    .filter((item) => item.type === "realtime_job")
    .map((item) => ({
      job_id: item.payload?.job_id,
      device_id: item.payload?.device_id,
      account_id: item.payload?.account_id,
      product_id: item.payload?.product_id,
      transport: item.payload?.transport,
    }));
}

function now() {
  return new Date().toISOString();
}

function redact(value) {
  const text = JSON.stringify(value, (key, item) => (/token|cookie|session/i.test(key) ? "[redacted]" : item));
  return JSON.parse(text);
}
