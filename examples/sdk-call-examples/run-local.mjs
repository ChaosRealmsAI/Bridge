#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

const VERSION = "v6-sdk-call-examples-account-stability";
const evidenceDir = resolve(process.env.PANDA_BRIDGE_SDK_EXAMPLES_EVIDENCE_DIR || `spec/verification/evidence/${VERSION}`);
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-sdk-examples-"));
const startedAt = new Date();
const runId = `${Date.now()}`;
const expectedHelpers = [
  "diagnostics",
  "preflight",
  "queue.summary",
  "auth.session",
  "auth.password",
  "auth.guest",
  "auth.share",
  "auth.join",
  "auth.logout",
  "devices.list",
  "devices.createPairingCode",
  "devices.revoke",
  "connect.createIntent",
  "connect.intent",
  "connect.claim",
  "products.list",
  "products.requestAuthorization",
  "products.authorization",
  "products.revokeAuthorization",
  "codex.chat",
  "codex.run",
  "codex.rpc",
  "jobs.create",
  "jobs.get",
  "jobs.events",
  "jobs.wait",
  "jobs.stream",
  "jobs.cancel",
];

mkdirSync(evidenceDir, { recursive: true });

const env = {
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_WEB_ORIGIN: "http://127.0.0.1:0",
  SESSION_COOKIE_NAME: "pb_session",
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const body = await readIncoming(incoming);
    const url = `http://127.0.0.1:${server.address().port}${incoming.url}`;
    const request = new Request(url, {
      method: incoming.method,
      headers: incomingHeaders(incoming.headers),
      body: shouldSendBody(incoming.method, body) ? body : undefined,
    });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ error: "sdk_examples_proxy_error", message: error.message || String(error) }));
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const apiBase = `http://127.0.0.1:${server.address().port}`;
const coverage = [];
const connectorCalls = [];

try {
  const owner = sdkContext("owner");
  const joined = sdkContext("joined");
  const other = sdkContext("other");
  const guest = sdkContext("guest");
  const invalid = sdkContext("invalid");

  const unauthenticatedPreflight = await owner.call("preflight", (client) => client.preflight());
  assert.equal(unauthenticatedPreflight.ready, false);
  assert.equal(unauthenticatedPreflight.issues.some((item) => item.code === "not_authenticated"), true);

  const diagnostics = await owner.call("diagnostics", (client) => client.diagnostics());
  assert.equal(diagnostics.ok, true);

  const products = await owner.call("products.list", (client) => client.products.list());
  assert.ok((products.items || []).some((item) => item.id === "panda-chat"));

  const ownerEmail = `sdk-examples-owner-${runId}@example.local`;
  const ownerSession = await owner.call("auth.password", (client) => client.auth.password(ownerEmail, `Owner-${runId}-Password!`, "SDK Examples Owner"));
  assert.equal(ownerSession.authenticated, true);
  const ownerCurrentSession = await owner.call("auth.session", (client) => client.auth.session());
  assert.equal(ownerCurrentSession.user.id, ownerSession.user.id);

  await expectSdkError(
    () => invalid.call("auth.password", (client) => client.auth.password(ownerEmail, "wrong-password", "Invalid")),
    401,
    "invalid_credentials",
  );

  const guestSession = await guest.call("auth.guest", (client) => client.auth.guest("SDK Examples Guest"));
  assert.equal(guestSession.authenticated, true);
  await guest.call("auth.logout", (client) => client.auth.logout());

  const share = await owner.call("auth.share", (client) => client.auth.share());
  assert.ok(share.token);
  const joinedSession = await joined.call("auth.join", (client) => client.auth.join(share.token));
  assert.equal(joinedSession.user.id, ownerSession.user.id);

  const intent = await owner.call("connect.createIntent", (client) => client.connect.createIntent({ deviceName: "SDK Examples Fixture Device" }));
  const intentPreview = await owner.call("connect.intent", (client) => client.connect.intent(intent.token));
  assert.equal(intentPreview.connect_intent.product_id, "panda-chat");
  const claim = await owner.call("connect.claim", (client) => client.connect.claim(intent.token, {
    deviceName: "SDK Examples Fixture Device",
    appVersion: "sdk-examples-v0.1",
    capabilities: { runtime: "fixture", examples: true },
    localState: { platform: "local-fixture", temp_dir_present: Boolean(temp) },
  }));
  let deviceId = claim.device.id;
  let deviceToken = claim.device_token;
  assert.ok(deviceId);
  assert.ok(deviceToken);

  const devices = await owner.call("devices.list", (client) => client.devices.list());
  assert.equal(devices.items.some((item) => item.id === deviceId), true);
  const joinedDevices = await joined.call("devices.list", (client) => client.devices.list());
  assert.equal(joinedDevices.items.some((item) => item.id === deviceId), true);

  const pairingCode = await owner.call("devices.createPairingCode", (client) => client.devices.createPairingCode("SDK Examples Pairing Code"));
  assert.ok(pairingCode.pairing_code?.code || pairingCode.code);

  const initialAuthorization = await owner.call("products.authorization", (client) => client.products.authorization(deviceId));
  assert.equal(initialAuthorization.authorization.status, "active");
  const confirmedAuthorization = await owner.call("products.requestAuthorization", (client) => client.products.requestAuthorization(deviceId, { source: "sdk-examples" }));
  assert.equal(confirmedAuthorization.authorization.status, "active");

  await owner.call("products.revokeAuthorization", (client) => client.products.revokeAuthorization(deviceId));
  const revokedPreflight = await owner.call("preflight", (client) => client.preflight({ deviceId }));
  assert.equal(revokedPreflight.ready, false);
  assert.equal(revokedPreflight.issues.some((item) => item.code === "product_not_authorized"), true);
  await expectSdkError(
    () => owner.call("codex.run", (client) => client.codex.run({ deviceId, prompt: "should fail after revoke", requestKey: `v6-revoked-${runId}` })),
    403,
    "product_not_authorized",
  );
  const revokedDeviceId = deviceId;
  const restoreIntent = await owner.call("connect.createIntent", (client) => client.connect.createIntent({ deviceName: "SDK Examples Restored Fixture Device" }));
  const restoreClaim = await owner.call("connect.claim", (client) => client.connect.claim(restoreIntent.token, {
    deviceName: "SDK Examples Restored Fixture Device",
    appVersion: "sdk-examples-v0.1",
    capabilities: { runtime: "fixture", examples: true },
    localState: { platform: "local-fixture", restored_after_revoke: true },
  }));
  deviceId = restoreClaim.device.id;
  deviceToken = restoreClaim.device_token;
  const restoredAuthorization = await owner.call("products.authorization", (client) => client.products.authorization(deviceId));
  assert.equal(restoredAuthorization.authorization.status, "active");
  const readyPreflight = await owner.call("preflight", (client) => client.preflight({ deviceId }));
  assert.equal(readyPreflight.ready, true);
  assert.equal(readyPreflight.selected_device.id, deviceId);
  const joinedDevicesAfterRestore = await joined.call("devices.list", (client) => client.devices.list());
  assert.equal(joinedDevicesAfterRestore.items.some((item) => item.id === deviceId), true);

  const chatJob = await owner.call("codex.chat", (client) => client.codex.chat({ deviceId, prompt: "sdk examples chat", requestKey: `v6-chat-${runId}` }));
  await completeConnectorJobs(deviceToken, "chat");
  const chatFinal = await owner.call("jobs.wait", (client) => client.jobs.wait(chatJob.job.id, { timeoutMs: 5000, intervalMs: 25 }));
  assert.equal(chatFinal.status, "succeeded");
  const chatEvents = await owner.call("jobs.events", (client) => client.jobs.events(chatJob.job.id));
  assertJobEvents(chatEvents.items);
  const streamEvents = [];
  await owner.stream("jobs.stream", (client) => client.jobs.stream(chatJob.job.id, { timeoutMs: 5000, intervalMs: 25 }), (event) => {
    streamEvents.push(event);
  });
  assert.ok(streamEvents.some((event) => event.type === "completed"));

  const runJob = await owner.call("codex.run", (client) => client.codex.run({ deviceId, prompt: "sdk examples run", requestKey: `v6-run-${runId}` }));
  await completeConnectorJobs(deviceToken, "run");
  const runFinal = await owner.call("jobs.get", (client) => client.jobs.get(runJob.job.id));
  assert.equal(runFinal.job.status, "succeeded");

  const rpcJob = await owner.call("codex.rpc", (client) => client.codex.rpc({ deviceId, calls: [{ method: "initialize", params: {} }], requestKey: `v6-rpc-${runId}` }));
  await completeConnectorJobs(deviceToken, "rpc");
  const rpcFinal = await owner.call("jobs.get", (client) => client.jobs.get(rpcJob.job.id));
  assert.equal(rpcFinal.job.status, "succeeded");

  const customJob = await owner.call("jobs.create", (client) => client.jobs.create({
    kind: "saas.custom.run",
    deviceId,
    input: { task: "sdk examples custom" },
    requestKey: `v6-custom-${runId}`,
    policy: { timeout_ms: 60000 },
  }));
  await completeConnectorJobs(deviceToken, "custom");
  const customFinal = await owner.call("jobs.get", (client) => client.jobs.get(customJob.job.id));
  assert.equal(customFinal.job.status, "succeeded");

  const cancelJob = await owner.call("jobs.create", (client) => client.jobs.create({
    kind: "codex.run",
    deviceId,
    input: { prompt: "sdk examples cancel" },
    requestKey: `v6-cancel-${runId}`,
  }));
  const cancelled = await owner.call("jobs.cancel", (client) => client.jobs.cancel(cancelJob.job.id));
  assert.equal(cancelled.job.status, "cancelled");

  const queueSummary = await owner.call("queue.summary", (client) => client.queue.summary());
  assert.equal(queueSummary.counts.succeeded, 4);
  assert.equal(queueSummary.counts.cancelled, 1);

  const otherEmail = `sdk-examples-other-${runId}@example.local`;
  const otherSession = await other.call("auth.password", (client) => client.auth.password(otherEmail, `Other-${runId}-Password!`, "SDK Examples Other"));
  assert.notEqual(otherSession.user.id, ownerSession.user.id);
  const otherDevices = await other.call("devices.list", (client) => client.devices.list());
  assert.equal(otherDevices.items.some((item) => item.id === deviceId), false);
  assert.equal(otherDevices.items.some((item) => item.id === revokedDeviceId), false);
  const otherQueue = await other.call("queue.summary", (client) => client.queue.summary());
  assert.equal(otherQueue.counts.total, 0);
  await expectSdkError(() => other.call("jobs.get", (client) => client.jobs.get(chatJob.job.id)), 404, "job_not_found");
  const otherProductAuth = await other.call("products.authorization", (client) => client.products.authorization(deviceId));
  assert.equal(otherProductAuth.authorization, null);

  await joined.call("auth.logout", (client) => client.auth.logout());
  await expectSdkError(() => joined.call("auth.session", (client) => client.auth.session()), 401, null);
  await expectSdkError(() => joined.call("devices.list", (client) => client.devices.list()), 401, "unauthorized");

  const revokedDevice = await owner.call("devices.revoke", (client) => client.devices.revoke(deviceId));
  assert.equal(revokedDevice.device.status, "revoked");

  const helperSet = new Set(coverage.map((item) => item.helper));
  const missingHelpers = expectedHelpers.filter((helper) => !helperSet.has(helper));
  assert.deepEqual(missingHelpers, []);

  const sdkCallCoverage = {
    ok: true,
    checked_at: new Date().toISOString(),
    api_base: apiBase,
    expected_helpers: expectedHelpers,
    covered_helpers: [...helperSet].sort(),
    missing_helpers: missingHelpers,
    sdk_calls: coverage,
    connector_calls: connectorCalls,
    source_access: "SDK-as-user product calls plus public connector API fixture executor",
  };

  const accountStability = {
    ok: true,
    checked_at: new Date().toISOString(),
    owner_user_id: ownerSession.user.id,
    joined_user_id: joinedSession.user.id,
    joined_same_account: joinedSession.user.id === ownerSession.user.id,
    other_user_id: otherSession.user.id,
    other_account_isolated: true,
    owner_device_id: deviceId,
    revoked_device_id: revokedDeviceId,
    owner_device_visible_to_joined: joinedDevicesAfterRestore.items.some((item) => item.id === deviceId),
    owner_device_hidden_from_other: !otherDevices.items.some((item) => item.id === deviceId),
    owner_product_auth_hidden_from_other: otherProductAuth.authorization === null,
    product_auth_initial_active: initialAuthorization.authorization.status === "active",
    product_auth_confirmed_active: confirmedAuthorization.authorization.status === "active",
    product_auth_revoked_issue: revokedPreflight.issues.some((item) => item.code === "product_not_authorized"),
    product_auth_restored_active: restoredAuthorization.authorization.status === "active",
    logout_blocks_session: true,
    logout_blocks_devices: true,
    other_queue_total: otherQueue.counts.total,
  };

  const jobs = [
    jobSummary("codex.chat", chatJob.job, chatFinal, chatEvents.items, streamEvents),
    jobSummary("codex.run", runJob.job, runFinal.job, (await owner.call("jobs.events", (client) => client.jobs.events(runJob.job.id))).items, []),
    jobSummary("codex.rpc", rpcJob.job, rpcFinal.job, (await owner.call("jobs.events", (client) => client.jobs.events(rpcJob.job.id))).items, []),
    jobSummary("jobs.create", customJob.job, customFinal.job, (await owner.call("jobs.events", (client) => client.jobs.events(customJob.job.id))).items, []),
    jobSummary("jobs.cancel", cancelJob.job, cancelled.job, (await owner.call("jobs.events", (client) => client.jobs.events(cancelJob.job.id))).items, []),
  ];

  const summary = {
    ok: true,
    version: VERSION,
    api_base: apiBase,
    started_at: startedAt.toISOString(),
    checked_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt.getTime(),
    temp_dir: redactLocalPath(temp),
    owner_user_id: ownerSession.user.id,
    joined_same_account: accountStability.joined_same_account,
    other_account_isolated: accountStability.other_account_isolated,
    device_id: deviceId,
    ready_preflight: {
      ready: readyPreflight.ready,
      selected_device_id: readyPreflight.selected_device?.id || null,
      issues_count: readyPreflight.issues.length,
    },
    queue_counts: queueSummary.counts,
    jobs,
    helper_coverage: {
      expected_count: expectedHelpers.length,
      covered_count: helperSet.size,
      missing_helpers: missingHelpers,
    },
    evidence_files: [
      `spec/verification/evidence/${VERSION}/summary.json`,
      `spec/verification/evidence/${VERSION}/sdk-call-coverage.json`,
      `spec/verification/evidence/${VERSION}/account-stability.json`,
    ],
    redaction_ok: true,
  };

  writeRedactedJson("sdk-call-coverage.json", sdkCallCoverage);
  writeRedactedJson("account-stability.json", accountStability);
  writeRedactedJson("summary.json", summary);

  console.log(JSON.stringify({
    ok: true,
    version: VERSION,
    api_base: apiBase,
    covered_helpers: helperSet.size,
    jobs: jobs.map((job) => ({ helper: job.helper, status: job.final_status })),
    evidence_dir: `spec/verification/evidence/${VERSION}`,
  }, null, 2));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

function sdkContext(label) {
  let cookie = "";
  let activeHelper = "untracked";
  const fetchJar = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const parsed = new URL(url);
    coverage.push({
      client: label,
      helper: activeHelper,
      method: init.method || "GET",
      path: redactPath(`${parsed.pathname}${parsed.search}`),
      status: response.status,
    });
    return response;
  };
  const client = createBridgeClient({ apiBase, productId: "panda-chat", fetch: fetchJar });
  return {
    client,
    async call(helper, operation) {
      activeHelper = helper;
      try {
        return await operation(client);
      } finally {
        activeHelper = "untracked";
      }
    },
    async stream(helper, operation, onEvent) {
      activeHelper = helper;
      try {
        for await (const event of operation(client)) onEvent(event);
      } finally {
        activeHelper = "untracked";
      }
    },
  };
}

async function completeConnectorJobs(deviceToken, label) {
  const payload = await connectorRequest(deviceToken, "GET", "/v1/connectors/jobs");
  assert.ok(payload.items.length > 0, `expected at least one connector job for ${label}`);
  for (const job of payload.items) {
    const reply = `Panda Bridge SDK example reply: ${label} ${job.kind}`;
    await connectorRequest(deviceToken, "POST", `/v1/connectors/jobs/${encodeURIComponent(job.id)}/events`, {
      type: "started",
      payload: { kind: job.kind, example_label: label },
    });
    await connectorRequest(deviceToken, "POST", `/v1/connectors/jobs/${encodeURIComponent(job.id)}/events`, {
      type: "text_delta",
      payload: { delta: reply },
    });
    await connectorRequest(deviceToken, "POST", `/v1/connectors/jobs/${encodeURIComponent(job.id)}/ack`, {
      status: "succeeded",
      result: { ok: true, reply, fixture: true, example_label: label },
    });
  }
  return payload.items;
}

async function connectorRequest(deviceToken, method, path, body = null) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${deviceToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  connectorCalls.push({ method, path: redactPath(path), status: response.status });
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function expectSdkError(operation, status, code = null) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.status, status);
    if (code) assert.equal(error.payload?.error, code);
    return error;
  }
  throw new Error(`expected SDK error status ${status}`);
}

function assertJobEvents(items) {
  const types = new Set((items || []).map((item) => item.type));
  for (const type of ["queued", "claimed", "started", "text_delta", "completed"]) {
    assert.equal(types.has(type), true, `missing job event type: ${type}`);
  }
}

function jobSummary(helper, createdJob, finalJob, events, streamEvents) {
  return {
    helper,
    kind: createdJob.kind,
    job_id: createdJob.id,
    final_status: finalJob.status,
    event_types: [...new Set((events || []).map((item) => item.type))],
    event_count: (events || []).length,
    stream_event_count: (streamEvents || []).length,
  };
}

function writeRedactedJson(name, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assertRedacted(text, name);
  writeFileSync(resolve(evidenceDir, name), text);
}

function assertRedacted(text, name) {
  const forbidden = [
    /pbs_[a-zA-Z0-9_-]+/,
    /pbd_[a-zA-Z0-9_-]+/,
    /pbl_[a-zA-Z0-9_-]+/,
    /pb_session/i,
    /"device_token"\s*:/i,
    /"cookie"\s*:/i,
    /"password"\s*:/i,
    /"authorization_header"\s*:/i,
    /SERVICE_ROLE/i,
    /SUPABASE/i,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(text), false, `${name} leaked ${pattern}`);
  }
}

function redactPath(path) {
  return String(path)
    .replace(/\/v1\/connect-intents\/[^/?]+/g, "/v1/connect-intents/<intent-token>")
    .replace(/join=[^&]+/g, "join=<session-link>");
}

function redactLocalPath(path) {
  return String(path).replace(/^\/Users\/[^/]+/, "/Users/<user>");
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

function shouldSendBody(method, body) {
  return body.length > 0 && method !== "GET" && method !== "HEAD";
}
