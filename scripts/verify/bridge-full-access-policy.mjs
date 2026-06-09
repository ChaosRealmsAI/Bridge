#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

const VERSION = "v16-caller-defined-full-access-bridge";
const evidenceDir = resolve("spec/verification/evidence", VERSION);
mkdirSync(evidenceDir, { recursive: true });
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-v16-full-access-"));
const desktopStatePath = resolve(temp, "desktop-state.json");

const env = {
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_WEB_ORIGIN: "http://chat.local.test",
  BRIDGE_ALLOWED_ORIGINS: "http://chat.local.test http://spec.local.test http://127.0.0.1",
  BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({
    "panda-chat": ["http://chat.local.test"],
    "panda-spec": ["http://spec.local.test"],
  }),
  SESSION_COOKIE_NAME: "pb_session",
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const body = await readIncoming(incoming);
    const port = server.address().port;
    const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
      method: incoming.method,
      headers: incomingHeaders(incoming.headers),
      body: body.length && incoming.method !== "GET" && incoming.method !== "HEAD" ? body : undefined,
    });
    const response = await worker.fetch(request, {
      ...env,
      BRIDGE_PUBLIC_API_BASE: `http://127.0.0.1:${port}`,
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ error: "bridge_full_access_proxy_error", message: error.message || String(error) }));
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const apiBase = `http://127.0.0.1:${server.address().port}`;

try {
  const accountJar = jar();
  const client = createBridgeClient({
    apiBase,
    productId: "panda-chat",
    fetch: fetchJar(accountJar, "http://chat.local.test"),
  });
  const specClient = createBridgeClient({
    apiBase,
    productId: "panda-spec",
    fetch: fetchJar(accountJar, "http://spec.local.test"),
  });

  const suffix = Date.now();
  const session = await client.auth.guest(`V16 Full Access ${suffix}`);
  assert.equal(session.authenticated, true);

  const intent = await client.connect.createIntent({ deviceName: "V16 Full Access Device" });
  assert.equal(intent.connect_intent.policy.workspace_roots[0].allow_all, true);
  assert.equal(intent.connect_intent.policy.sandbox_floor, "danger-full-access");
  assert.equal(intent.connect_intent.policy.approval_policy_floor, "never");
  assert.equal(intent.connect_intent.policy.display.workspace, "All local files");
  assert.equal(intent.connect_intent.policy.display.sandbox, "danger-full-access");
  assert.equal(intent.connect_intent.policy.display.approval, "never");

  const maliciousDisplay = await client.connect.createIntent({
    deviceName: "V16 Malicious Display Device",
    permissions: {
      workspace_roots: [{ id: "all", path_display: "All local files", allow_all: true }],
      sandbox_floor: "danger-full-access",
      approval_policy_floor: "never",
      allow_developer_instructions: true,
      display: { workspace: "Small folder", sandbox: "read-only", approval: "on-request", developer_instructions: "denied" },
    },
  });
  assert.equal(maliciousDisplay.connect_intent.policy.display.workspace, "All local files");
  assert.equal(maliciousDisplay.connect_intent.policy.display.sandbox, "danger-full-access");
  assert.equal(maliciousDisplay.connect_intent.policy.display.approval, "never");

  const invalidCapabilities = await rawJson(apiBase, "/v1/connect-intents", {
    product_id: "panda-chat",
    policy: { capabilities: ["codex.typo"] },
  }, "http://chat.local.test", accountJar.cookie);
  assert.equal(invalidCapabilities.response.status, 400);
  assert.equal(invalidCapabilities.payload.error, "invalid_authorization_policy");

  const crossOriginIntent = await rawJson(apiBase, "/v1/connect-intents", {
    product_id: "panda-spec",
    device_name: "Wrong Origin",
  }, "http://chat.local.test", accountJar.cookie);
  assert.equal(crossOriginIntent.response.status, 403);
  assert.equal(crossOriginIntent.payload.error, "product_origin_mismatch");

  const desktopPreview = await desktopJson(["headless-preview-intent", "--api", apiBase, "--intent", intent.token]);
  assert.equal(desktopPreview.local_policy.workspace_roots[0].allow_all, true);
  assert.equal(desktopPreview.local_policy.sandbox_floor, "danger-full-access");
  assert.equal(desktopPreview.local_policy.approval_policy_floor, "never");

  await expectSdkError(
    () => client.connect.claim(intent.token, { deviceName: "Browser Must Not Claim" }),
    403,
    "desktop_claim_required",
  );

  const claim = await desktopJson(["headless-connect", "--api", apiBase, "--intent", intent.token, "--device-name", "V16 Full Access Device"], {
    PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1",
  });
  const statusAfterClaim = await desktopJson(["headless-status"]);
  const chatGrant = statusAfterClaim.authorized_products.find((item) => item.id === "panda-chat");
  assert.ok(chatGrant, "desktop status must include panda-chat grant");
  assert.equal(chatGrant.policy.workspace_roots[0].allow_all, true);
  assert.equal(chatGrant.policy.sandbox_floor, "danger-full-access");
  assert.equal(chatGrant.policy.allow_approval_never, true);
  assert.equal(chatGrant.origin, "http://chat.local.test");

  const job = await client.jobs.create({
    kind: "saas.custom.run",
    deviceId: claim.device_id,
    input: { task: "caller pass-through" },
    policy: {
      cwd: process.cwd(),
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      developerInstructions: "v16 smoke developer instructions",
      caller_custom_flag: "kept",
      timeout_ms: 60000,
    },
  });
  assert.equal(job.job.status, "queued");
  assert.equal(job.job.policy.sandbox, "danger-full-access");
  assert.equal(job.job.policy.approvalPolicy, "never");
  assert.equal(job.job.policy.caller_custom_flag, "kept");
  const desktopPoll = await desktopJson(["headless-poll"], {
    PANDA_BRIDGE_FAKE_CODEX: "1",
  });
  assert.equal(desktopPoll.ok, true);
  assert.equal(desktopPoll.count, 1);
  const completedJob = await client.jobs.get(job.job.id);
  assert.equal(completedJob.job.status, "succeeded");
  assert.equal(completedJob.job.result.ok, true);

  const narrowIntent = await specClient.connect.createIntent({
    deviceName: "V16 Narrow Device",
    permissions: {
      capabilities: ["codex.chat"],
      workspace_roots: [{ id: "default", path_display: "[local]/default" }],
      sandbox_floor: "read-only",
      approval_policy_floor: "on-request",
      allow_approval_never: false,
      allow_developer_instructions: false,
    },
  });
  const emptyCapabilitiesIntent = await specClient.connect.createIntent({
    deviceName: "V16 Empty Capability Device",
    permissions: {
      capabilities: [],
      workspace_roots: [{ id: "default", path_display: "[local]/default" }],
      sandbox_floor: "read-only",
      approval_policy_floor: "on-request",
      allow_approval_never: false,
      allow_developer_instructions: false,
    },
  });
  await desktopJson(["headless-connect", "--api", apiBase, "--intent", emptyCapabilitiesIntent.token, "--device-name", "V16 Empty Capability Device"], {
    PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1",
  });
  const statusAfterEmptyCapability = await desktopJson(["headless-status"]);
  const emptySpecGrant = statusAfterEmptyCapability.authorized_products.find((item) => item.id === "panda-spec");
  assert.ok(emptySpecGrant, "desktop status must include empty panda-spec grant");
  assert.deepEqual(emptySpecGrant.capabilities, []);
  assert.deepEqual(emptySpecGrant.policy.capabilities, []);
  const cloudEmptyCapabilityDenial = await expectSdkError(
    () => specClient.codex.chat({
      deviceId: claim.device_id,
      prompt: "empty capability must deny all",
      policy: { sandbox: "read-only" },
    }),
    403,
    "authorization_scope_denied",
  );
  assert.equal(cloudEmptyCapabilityDenial.payload.denied, "capability");

  await desktopJson(["headless-connect", "--api", apiBase, "--intent", narrowIntent.token, "--device-name", "V16 Narrow Device"], {
    PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1",
  });
  const cloudNarrowDenial = await expectSdkError(
    () => specClient.codex.run({
      deviceId: claim.device_id,
      prompt: "must be denied by authorization scope",
    }),
    403,
    "authorization_scope_denied",
  );

  const connectorFull = runConnector([
    "run-fixture",
    "--fake-codex",
    "--prompt",
    "v16 full access",
    "--cwd",
    process.cwd(),
    "--sandbox",
    "danger-full-access",
    "--approval-policy",
    "never",
    "--developer-instructions",
    "v16 smoke developer instructions",
  ]);
  assert.equal(connectorFull.status, 0, connectorFull.stderr);
  const connectorFullPayload = JSON.parse(connectorFull.stdout);
  assert.equal(connectorFullPayload.ok, true);

  const connectorNarrow = runConnector([
    "run-fixture",
    "--fake-codex",
    "--prompt",
    "v16 narrow denial",
    "--sandbox",
    "danger-full-access",
    "--narrow-grant",
  ]);
  assert.equal(connectorNarrow.status, 0, connectorNarrow.stderr);
  const connectorNarrowPayload = JSON.parse(connectorNarrow.stdout);
  assert.equal(connectorNarrowPayload.error, "local_policy_denied");
  assert.equal(connectorNarrowPayload.denied, "sandbox");

  const evidence = {
    ok: true,
    version: VERSION,
    api_base: apiBase,
    account_id: session.user.id,
    desktop_preview: desktopPreview,
    device_id: claim.device_id,
    desktop_authorized_product: chatGrant,
    authorization_policy: chatGrant.policy,
    queued_job: {
      id: job.job.id,
      kind: job.job.kind,
      policy: job.job.policy,
    },
    completed_job: {
      id: completedJob.job.id,
      status: completedJob.job.status,
      result: completedJob.job.result,
    },
    browser_claim_rejected: true,
    malicious_display_normalized: maliciousDisplay.connect_intent.policy.display,
    invalid_capabilities_rejected: invalidCapabilities.payload,
    cross_origin_rejected: crossOriginIntent.payload,
    cloud_empty_capability_denial: {
      desktop_capabilities: emptySpecGrant.capabilities,
      error: cloudEmptyCapabilityDenial.payload.error,
      denied: cloudEmptyCapabilityDenial.payload.denied,
      reason: cloudEmptyCapabilityDenial.payload.reason,
    },
    cloud_narrow_denial: {
      error: cloudNarrowDenial.payload.error,
      denied: cloudNarrowDenial.payload.denied,
      reason: cloudNarrowDenial.payload.reason,
    },
    connector_full_access_ok: connectorFullPayload.ok,
    connector_narrow_denial: {
      error: connectorNarrowPayload.error,
      denied: connectorNarrowPayload.denied,
      reason: connectorNarrowPayload.reason,
    },
  };
  assertNoSecretKeys(evidence);
  writeFileSync(resolve(evidenceDir, "bridge-full-access-policy.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, "summary.json"), `${JSON.stringify({
    ok: true,
    version: VERSION,
    checked_at: new Date().toISOString(),
    artifacts: ["bridge-full-access-policy.json"],
  }, null, 2)}\n`);
  console.log(`[bridge-full-access-policy] pass ${resolve(evidenceDir, "summary.json")}`);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

function runConnector(args) {
  return spawnSync("node", ["apps/connector-cli/src/cli.mjs", ...args], {
    cwd: resolve("."),
    encoding: "utf8",
  });
}

async function rawJson(apiBase, path, body, origin, cookie = "") {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    origin,
    ...(cookie ? { cookie } : {}),
  };
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

async function desktopJson(args, extraEnv = {}) {
  return await new Promise((resolveJson, reject) => {
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
      cwd: resolve("."),
      env: {
        ...process.env,
        PANDA_BRIDGE_DESKTOP_STATE: desktopStatePath,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `desktop headless exited ${code}`));
        return;
      }
      try {
        resolveJson(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`desktop headless returned invalid JSON: ${error.message}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function expectSdkError(operation, status, code) {
  let thrown = null;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected SDK error ${code}`);
  assert.equal(thrown.status, status);
  assert.equal(thrown.payload?.error, code);
  return thrown;
}

function fetchJar(cookieJar, origin) {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", origin);
    if (cookieJar.cookie) headers.set("cookie", cookieJar.cookie);
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookieJar.cookie = setCookie.split(";")[0];
    return response;
  };
}

function jar() {
  return { cookie: "" };
}

async function readIncoming(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function incomingHeaders(headers) {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) out.set(key, value.join(", "));
    else if (value !== undefined) out.set(key, String(value));
  }
  return out;
}

function assertNoSecretKeys(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /device_token|pb_session|authorization:\s*bearer/i);
}
