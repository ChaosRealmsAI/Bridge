#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

const PRODUCT_ID = "panda-syllo";
const SYLLO_CAPABILITIES = ["syllo.sessions", "syllo.issue", "syllo.highlight", "syllo.doc"];
const hostHome = process.env.HOME || "";
assert.ok(hostHome, "HOME is required so Syllo can read real local sessions");

const evidenceDir = resolve("spec/verification/evidence/syllo-bridge-dogfood");
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-syllo-dogfood-"));
const home = resolve(temp, "home");
const statePath = resolve(temp, "desktop-state.json");
mkdirSync(home, { recursive: true });
const project = mkdtempSync(resolve(home, "project-"));
const docRelPath = "docs/bridge.md";
const docPath = resolve(project, docRelPath);
const startedAt = new Date();

mkdirSync(evidenceDir, { recursive: true });
mkdirSync(resolve(project, "docs"), { recursive: true });
writeFileSync(docPath, `# Syllo Bridge Dogfood\n\n${startedAt.toISOString()}\n`);

const baseEnv = {
  BRIDGE_LOCAL_MEMORY: "1",
  SESSION_COOKIE_NAME: "pb_session",
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const bodyBuffer = await readIncoming(incoming);
    const apiBase = localApiBase();
    const request = new Request(`${apiBase}${incoming.url}`, {
      method: incoming.method,
      headers: incomingHeaders(incoming.headers),
      body: bodyBuffer.length && incoming.method !== "GET" && incoming.method !== "HEAD" ? bodyBuffer : undefined,
    });
    const response = await worker.fetch(request, workerEnv(apiBase));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ error: "syllo_bridge_proxy_error", message: error.message || String(error) }));
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const apiBase = localApiBase();

try {
  const jar = cookieJar(apiBase);
  const bridge = createBridgeClient({ apiBase, productId: PRODUCT_ID, fetch: jar.fetch });
  const session = await bridge.auth.guest("Syllo Bridge Dogfood");
  assert.equal(session.authenticated, true);

  const intent = await bridge.connect.createIntent({
    deviceName: "Syllo Bridge Dogfood Desktop",
    permissions: sylloPermissions(apiBase),
  });
  assert.match(intent.token, /^pbi_/);

  const connected = await runDesktop([
    "headless-connect",
    "--api",
    apiBase,
    "--intent",
    intent.token,
    "--device-name",
    "Syllo Bridge Dogfood Desktop",
  ]);
  assert.equal(connected.status, 0, childMessage(connected));
  const claim = parseJson(connected.stdout);
  const deviceId = claim.device_id;
  assert.ok(deviceId, "headless-connect did not return device_id");

  const ready = await bridge.ensureReady({ wait: true, timeoutMs: 10000, intervalMs: 250 });
  assert.equal(ready.ready, true);

  const sessions = await sylloJob(bridge, deviceId, "syllo.sessions", { action: "list" }, "sessions-list");
  assert.equal(typeof sessions.running_total, "number");
  assert.ok(Array.isArray(sessions.by_project), "sessions.by_project must be an array");

  const issue = await sylloJob(bridge, deviceId, "syllo.issue", {
    action: "create",
    project,
    title: `Bridge dogfood issue ${Date.now()}`,
    body: "Created through Panda Bridge -> desktop -> syllo CLI",
    labels: ["bridge", "dogfood"],
    agent: "codex",
  }, "issue-create");
  assert.equal(typeof issue.number, "number");
  assert.ok(existsSync(resolve(project, ".syllo", "issues", `${issue.id}.json`)), "issue JSON was not written");

  const issues = await sylloJob(bridge, deviceId, "syllo.issue", {
    action: "list",
    project,
  }, "issue-list");
  assert.ok(Array.isArray(issues));
  assert.ok(issues.some((item) => item.number === issue.number), "created issue not found in list");

  const linkedDoc = await sylloJob(bridge, deviceId, "syllo.doc", {
    action: "link",
    project,
    path: docRelPath,
  }, "doc-link");
  assert.ok(linkedDoc.id, "doc link did not return id");

  const docs = await sylloJob(bridge, deviceId, "syllo.doc", {
    action: "list",
    project,
  }, "doc-list");
  assert.ok(Array.isArray(docs.links));
  assert.ok(docs.links.some((item) => item.id === linkedDoc.id && item.exists === true), "linked doc not found");

  const highlight = await sylloJob(bridge, deviceId, "syllo.highlight", {
    action: "add",
    project,
    kind: "note",
    title: `Bridge dogfood highlight ${Date.now()}`,
    body: "Created through Panda Bridge",
    options: [{ key: "a", label: "Keep Syllo bridge", recommended: true }],
    agent: "codex",
  }, "highlight-add");
  assert.ok(highlight.id, "highlight add did not return id");

  const highlights = await sylloJob(bridge, deviceId, "syllo.highlight", {
    action: "list",
    project,
  }, "highlight-list");
  assert.ok(Array.isArray(highlights));
  assert.ok(highlights.some((item) => item.id === highlight.id), "created highlight not found in list");

  const summary = {
    ok: true,
    product_id: PRODUCT_ID,
    api_base: apiBase,
    project,
    device_id: deviceId,
    session_user_id: session.user.id,
    sessions: {
      running_total: sessions.running_total,
      project_count: sessions.by_project.length,
    },
    issue: {
      id: issue.id,
      number: issue.number,
      local_json_exists: existsSync(resolve(project, ".syllo", "issues", `${issue.id}.json`)),
      list_count: issues.length,
    },
    doc: {
      linked_id: linkedDoc.id,
      links: docs.links,
    },
    highlight: {
      id: highlight.id,
      list_count: highlights.length,
      items: highlights,
    },
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
  };
  writeEvidence("summary.json", summary);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function sylloJob(bridge, deviceId, kind, input, label) {
  const created = await bridge.jobs.create({
    kind,
    deviceId,
    input,
    requestKey: `syllo-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  try {
    await pollDesktop();
  } catch (error) {
    writeEvidence(`${label}-poll-failure.json`, {
      error: error.message || String(error),
      job: await bridge.jobs.get(created.job.id),
      events: await bridge.jobs.events(created.job.id),
    });
    throw error;
  }
  const final = await bridge.jobs.wait(created.job.id, { timeoutMs: 60000, intervalMs: 250 });
  if (final.status !== "succeeded") {
    writeEvidence(`${label}-failure.json`, { final, events: await bridge.jobs.events(created.job.id) });
  }
  assert.equal(final.status, "succeeded");
  assert.equal(final.result?.ok, true, JSON.stringify(final.result));
  return final.result.data;
}

async function pollDesktop() {
  const polled = await runDesktop(["headless-poll"]);
  if (polled.status !== 0) {
    const probe = await connectorProbe().catch((error) => ({ error: error.message || String(error) }));
    assert.equal(polled.status, 0, `${childMessage(polled)}\nprobe=${JSON.stringify(probe, null, 2)}`);
  }
  return parseJson(polled.stdout);
}

async function connectorProbe() {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const response = await fetch(`${apiBase}/v1/connectors/jobs`, {
    headers: {
      authorization: `Bearer ${state.device_token}`,
      "x-panda-bridge-install-id": state.install_id || "",
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    payload: text ? JSON.parse(text) : {},
  };
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
        PANDA_BRIDGE_DESKTOP_STATE: statePath,
        PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1",
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

function sylloPermissions(sourceOrigin) {
  return {
    version: "AUTH-SCOPE-v2",
    preset: "syllo-dogfood",
    request_source: "syllo_bridge_dogfood",
    product_id: PRODUCT_ID,
    source_origin: sourceOrigin,
    capabilities: SYLLO_CAPABILITIES,
    workspace_roots: [{ id: "default", path_display: "[local]/default" }],
    sandbox_floor: "workspace-write",
    approval_policy_floor: "on-request",
    allow_approval_never: false,
    allow_developer_instructions: false,
  };
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
      "panda-syllo": [currentApiBase],
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
