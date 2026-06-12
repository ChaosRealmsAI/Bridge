#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import worker, { __bridgeTestMemorySnapshot } from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";
import { bridgeNotesPermissions, NOTES_ROOT_ID } from "../../examples/bridge-notes/src/permissions.mjs";

const PRODUCT_ID = "panda-notes";
const evidenceDir = resolve("spec/verification/evidence/bridge-notes-dogfood");
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-notes-dogfood-"));
const hostHome = process.env.HOME || "";
const home = resolve(temp, "home");
const statePath = resolve(temp, "desktop-state.json");
const workspace = resolve(temp, "workspace");
const importRoot = resolve(temp, "notes-import");
const outsideRoot = resolve(home, ".ssh");
const seedPath = resolve(importRoot, "seed.txt");
const outsidePath = resolve(outsideRoot, "id_rsa");
const body = `主权正文-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const seedText = `notes import seed ${Date.now()}`;
const startedAt = new Date();

mkdirSync(evidenceDir, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(importRoot, { recursive: true });
mkdirSync(outsideRoot, { recursive: true });
writeFileSync(seedPath, seedText);
writeFileSync(outsidePath, "outside should be denied");

const baseEnv = {
  BRIDGE_LOCAL_MEMORY: "1",
  SESSION_COOKIE_NAME: "pb_session",
  BRIDGE_PANDA_NOTES_DELEGATION_SECRET: "bridge-notes-local-secret",
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const bodyBuffer = await readIncoming(incoming);
    const apiBase = localApiBase();
    const url = `${apiBase}${incoming.url}`;
    const request = new Request(url, {
      method: incoming.method,
      headers: incomingHeaders(incoming.headers),
      body: bodyBuffer.length && incoming.method !== "GET" && incoming.method !== "HEAD" ? bodyBuffer : undefined,
    });
    const response = await worker.fetch(request, workerEnv(apiBase));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ error: "bridge_notes_proxy_error", message: error.message || String(error) }));
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const apiBase = localApiBase();

try {
  const jar = cookieJar(apiBase);
  const bridge = createBridgeClient({ apiBase, productId: PRODUCT_ID, fetch: jar.fetch });
  const session = await bridge.auth.guest("Bridge Notes Dogfood");
  assert.equal(session.authenticated, true);

  const intent = await bridge.connect.createIntent({
    deviceName: "Bridge Notes Dogfood Desktop",
    permissions: bridgeNotesPermissions(),
  });
  assert.match(intent.token, /^pbi_/);

  const connected = await runDesktop([
    "headless-connect",
    "--api",
    apiBase,
    "--intent",
    intent.token,
    "--device-name",
    "Bridge Notes Dogfood Desktop",
  ]);
  assert.equal(connected.status, 0, childMessage(connected));
  const claim = parseJson(connected.stdout);
  const deviceId = claim.device_id;
  assert.ok(deviceId, "headless-connect did not return device_id");

  const ready = await bridge.ensureReady({ wait: true, timeoutMs: 10000, intervalMs: 250 });
  assert.equal(ready.ready, true);

  const codex = await codexLeg(bridge, deviceId);
  const data = await dataLeg(bridge, deviceId);
  const fs = await fsLeg(bridge, deviceId);

  const summary = {
    ok: true,
    product_id: PRODUCT_ID,
    api_base: apiBase,
    temp_home: home,
    desktop_state_path: statePath,
    evidence_dir: evidenceDir,
    device_id: deviceId,
    session_user_id: session.user.id,
    codex,
    data,
    fs,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
  };
  writeEvidence("summary.json", summary);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function codexLeg(bridge, deviceId) {
  const prompt = "Reply exactly: notes-codex-ok";
  const created = await bridge.codex.chat({
    deviceId,
    prompt,
    requestKey: `bridge-notes-codex-${Date.now()}`,
  });
  await pollDesktop();
  const final = await bridge.jobs.wait(created.job.id, { timeoutMs: 180000, intervalMs: 500 });
  if (final.status !== "succeeded") {
    const scrubTokens = (o) => JSON.parse(JSON.stringify(o).replace(/("cap_token"\s*:\s*)"[^"]*"/g, '$1"[redacted]"'));
    writeEvidence("codex-failure.json", scrubTokens({ final, events: await bridge.jobs.events(created.job.id) }));
  }
  assert.equal(final.status, "succeeded");
  assert.equal(String(final.result.reply || "").trim(), "notes-codex-ok");
  const events = await bridge.jobs.events(created.job.id);
  return {
    ok: true,
    job_id: created.job.id,
    reply: String(final.result.reply || "").trim(),
    event_count: events.items.length,
  };
}

async function dataLeg(bridge, deviceId) {
  const key = "note/n1";
  const note = { id: "n1", title: "Sovereignty", body, updated_at: new Date().toISOString() };
  const put = await bridge.data.put({
    deviceId,
    key,
    value: note,
    requestKey: `bridge-notes-put-${Date.now()}`,
  });
  await pollDesktop();
  const putFinal = await bridge.jobs.wait(put.job.id, { timeoutMs: 30000, intervalMs: 250 });
  assert.equal(putFinal.status, "succeeded");
  assert.equal(JSON.stringify(putFinal.result).includes(body), false, "data.put result leaked note body");
  assert.equal(JSON.stringify(putFinal.input).includes(body), false, "terminal data.put input was not scrubbed");
  const memoryAfterPut = JSON.stringify(__bridgeTestMemorySnapshot());
  assert.equal(memoryAfterPut.includes(body), false, "worker memory retained data.put body after ack");

  const sqlitePath = productSqlitePath();
  const storedJson = sqlite(sqlitePath, "SELECT value_json FROM kv WHERE namespace='product:panda-notes' AND key='note/n1';");
  assert.ok(storedJson.includes(body), "sqlite3 did not find note body");
  // Money-shot: persist the actual local row so the note can be seen sitting on
  // the machine (the harness deletes it at the end of the leg).
  writeEvidence("local-note-row.json", { sqlite_path: sqlitePath, key: "note/n1", value_json: storedJson.trim() });

  const query = await bridge.data.query({
    deviceId,
    prefix: "note/",
    limit: 10,
    requestKey: `bridge-notes-query-${Date.now()}`,
  });
  await pollDesktop();
  const queryFinal = await bridge.jobs.wait(query.job.id, { timeoutMs: 30000, intervalMs: 250 });
  assert.equal(queryFinal.status, "succeeded");
  const queried = queryFinal.result.items?.find((item) => item.key === key)?.value;
  assert.equal(queried?.body, body);

  const del = await bridge.data.delete({
    deviceId,
    key,
    requestKey: `bridge-notes-delete-${Date.now()}`,
  });
  await pollDesktop();
  const deleteFinal = await bridge.jobs.wait(del.job.id, { timeoutMs: 30000, intervalMs: 250 });
  assert.equal(deleteFinal.status, "succeeded");
  assert.equal(deleteFinal.result.deleted, true);
  const remaining = sqlite(sqlitePath, "SELECT count(*) FROM kv WHERE namespace='product:panda-notes' AND key='note/n1';").trim();
  assert.equal(remaining, "0");

  // P1 sovereignty lock (negative leg): a data.put cancelled BEFORE ack must not
  // leave plaintext in the cloud job record — sovereignty must hold on the
  // cancel/revoke path, not just the happy ack path.
  const cancelBody = `cancel-probe-secret-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probe = await bridge.data.put({
    deviceId,
    key: "note/cancel-probe",
    value: { id: "cancel-probe", body: cancelBody },
    requestKey: `bridge-notes-cancel-probe-${Date.now()}`,
  });
  // Intentionally do NOT poll desktop: leave the job queued, then cancel it.
  await bridge.jobs.cancel(probe.job.id);
  const cancelledJob = await bridge.jobs.get(probe.job.id);
  const cancelledInput = JSON.stringify(cancelledJob.input ?? cancelledJob.job?.input ?? {});
  assert.equal(cancelledInput.includes(cancelBody), false, "cancelled data.put input leaked note body (sovereignty hole)");
  const memoryAfterCancel = JSON.stringify(__bridgeTestMemorySnapshot());
  assert.equal(memoryAfterCancel.includes(cancelBody), false, "worker memory retained cancelled data.put body");

  return {
    cancel_redaction_ok: !cancelledInput.includes(cancelBody) && !memoryAfterCancel.includes(cancelBody),
    ok: true,
    put_job_id: put.job.id,
    query_job_id: query.job.id,
    delete_job_id: del.job.id,
    sqlite_path: sqlitePath,
    sqlite_contains_body: storedJson.includes(body),
    put_result_contains_body: JSON.stringify(putFinal.result).includes(body),
    put_worker_memory_contains_body_after_ack: memoryAfterPut.includes(body),
    query_read_back: queried?.body === body,
    delete_sqlite_remaining_rows: Number(remaining),
  };
}

async function fsLeg(bridge, deviceId) {
  const bound = await runDesktop([
    "headless-bind-local-root",
    "--product-id",
    PRODUCT_ID,
    "--root-id",
    NOTES_ROOT_ID,
    "--domain",
    "fs_read",
    "--path",
    importRoot,
  ]);
  assert.equal(bound.status, 0, childMessage(bound));
  const boundPayload = parseJson(bound.stdout);
  assert.equal(boundPayload.root_id, NOTES_ROOT_ID);
  assert.equal(JSON.stringify(boundPayload).includes(importRoot), false);

  const read = await bridge.jobs.create({
    kind: "fs.read",
    deviceId,
    input: { path: seedPath },
    requestKey: `bridge-notes-fs-read-${Date.now()}`,
  });
  await pollDesktop();
  const readFinal = await bridge.jobs.wait(read.job.id, { timeoutMs: 30000, intervalMs: 250 });
  assert.equal(readFinal.status, "succeeded");
  const readEvents = await bridge.jobs.events(read.job.id);
  const content = chunksText(readEvents.items);
  assert.equal(content, seedText);

  const denied = await bridge.jobs.create({
    kind: "fs.read",
    deviceId,
    input: { path: outsidePath },
    requestKey: `bridge-notes-fs-denied-${Date.now()}`,
  });
  await pollDesktop();
  const deniedFinal = await bridge.jobs.wait(denied.job.id, { timeoutMs: 30000, intervalMs: 250 });
  assert.equal(deniedFinal.status, "failed");
  assert.equal(deniedFinal.result.error, "local_policy_denied");
  assert.match(deniedFinal.result.reason || "", /path_outside_allowlist|path_denied_by_sandbox/);

  return {
    ok: true,
    bind_root_id: boundPayload.root_id,
    bind_redacted_real_path: boundPayload.redacted_real_path,
    read_job_id: read.job.id,
    read_content: content,
    denied_job_id: denied.job.id,
    denied_error: deniedFinal.result.error,
    denied_reason: deniedFinal.result.reason,
  };
}

async function pollDesktop() {
  const polled = await runDesktop(["headless-poll"]);
  assert.equal(polled.status, 0, childMessage(polled));
  return parseJson(polled.stdout);
}

function runDesktop(args) {
  return new Promise((resolveChild) => {
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
      env: {
        ...process.env,
        HOME: home,
        ...((process.env.RUSTUP_HOME || hostHome)
          ? { RUSTUP_HOME: process.env.RUSTUP_HOME || resolve(hostHome, ".rustup") }
          : {}),
        ...((process.env.CARGO_HOME || hostHome)
          ? { CARGO_HOME: process.env.CARGO_HOME || resolve(hostHome, ".cargo") }
          : {}),
        // HOME is a temp dir to isolate the local data SQLite (sovereignty proof),
        // but codex needs its REAL auth: point CODEX_HOME at the host ~/.codex so
        // the codex leg runs the real CLI instead of failing to initialize.
        ...((process.env.CODEX_HOME || hostHome)
          ? { CODEX_HOME: process.env.CODEX_HOME || resolve(hostHome, ".codex") }
          : {}),
        PANDA_BRIDGE_DESKTOP_STATE: statePath,
        PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1",
        PANDA_BRIDGE_CODEX_CWD: workspace,
        PANDA_BRIDGE_FAKE_CODEX: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    let error = null;
    const timer = setTimeout(() => {
      error = new Error(`desktop child timed out: ${args.join(" ")}`);
      child.kill("SIGTERM");
    }, 240000);
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

function productSqlitePath() {
  const dir = resolve(home, ".panda-bridge", "data", "products");
  assert.ok(existsSync(dir), `product sqlite dir missing: ${dir}`);
  const match = readdirSync(dir).find((name) => /^panda-notes-[0-9a-f]{16}\.sqlite3$/.test(name));
  assert.ok(match, `panda-notes sqlite file missing in ${dir}`);
  return resolve(dir, match);
}

function sqlite(dbPath, sql) {
  const result = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function chunksText(events) {
  return (events || [])
    .filter((event) => event.type === "chunk" && event.payload?.data_base64)
    .map((event) => Buffer.from(event.payload.data_base64, "base64").toString("utf8"))
    .join("");
}

function localApiBase() {
  return `http://127.0.0.1:${server.address().port}`;
}

function workerEnv(currentApiBase) {
  return {
    ...baseEnv,
    BRIDGE_WEB_ORIGIN: currentApiBase,
    BRIDGE_PUBLIC_API_BASE: currentApiBase,
    BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({
      "panda-chat": [currentApiBase],
      "panda-dev": [currentApiBase],
      "panda-spec": [currentApiBase],
      "panda-notes": [currentApiBase],
    }),
  };
}

function cookieJar(origin) {
  let cookie = "";
  return {
    fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers || {});
      headers.set("origin", origin);
      if (cookie) headers.set("cookie", cookie);
      const response = await fetch(url, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return response;
    },
  };
}

function readIncoming(incoming) {
  return new Promise((resolveRead, reject) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => resolveRead(Buffer.concat(chunks)));
    incoming.on("error", reject);
  });
}

function incomingHeaders(raw) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw || {})) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value != null) headers.set(key, String(value));
  }
  return headers;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid child JSON from ${basename(statePath)}: ${error.message}\n${text}`);
  }
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

function writeEvidence(name, payload) {
  writeFileSync(resolve(evidenceDir, name), JSON.stringify(payload, null, 2) + "\n");
}
