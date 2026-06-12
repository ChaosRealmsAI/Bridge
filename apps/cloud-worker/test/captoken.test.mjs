import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { BridgeTestStore } from "../src/index.js";
import {
  computeBoundaryFingerprint,
  issueCapToken,
  parseCompactJws,
  verifyCapTokenClaims,
  verifyCapTokenEnvelope,
  verifyCapTokenJws,
} from "../src/captoken.js";

const vectors = JSON.parse(readFileSync(new URL("../../../spec/captoken/vectors.json", import.meta.url), "utf8"));

function merge(base, patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = merge(result[key], value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

for (const testCase of vectors.claim_cases) {
  const claims = merge(vectors.base_claims, testCase.claims_patch);
  const context = merge(vectors.base_context, testCase.context_patch);
  const actual = await verifyCapTokenClaims(claims, context);
  assert.deepEqual(actual, testCase.expect, `claim vector ${testCase.name}`);
}

for (const testCase of vectors.envelope_cases) {
  const actual = await verifyCapTokenEnvelope(testCase.header, vectors.base_claims, vectors.base_context);
  assert.deepEqual(actual, testCase.expect, `envelope vector ${testCase.name}`);
}

for (const testCase of vectors.signature_cases) {
  const actual = await verifyCapTokenJws(testCase.token, vectors.base_context);
  assert.deepEqual(actual, testCase.expect, `signature vector ${testCase.name}`);
}

for (const testCase of vectors.boundary_cases) {
  const bnd = await computeBoundaryFingerprint(testCase.policy, testCase.job);
  assert.equal(bnd, testCase.expect.bnd, `boundary vector ${testCase.name}`);
}

const issued = await issueCapToken({
  BRIDGE_LOCAL_MEMORY: "1",
}, {
  authorization: { policy: vectors.base_context.authorization_policy, epoch: vectors.base_context.epoch },
  job: vectors.base_context.job,
  product: { id: vectors.base_context.job.product_id },
  userId: vectors.base_context.user_id,
  device: { id: vectors.base_context.device_id },
  nowSeconds: vectors.base_claims.nbf,
});
const parsed = parseCompactJws(issued.token);
assert.equal(parsed.header.alg, "EdDSA");
assert.equal(parsed.header.typ, "pbcap+jws");
assert.equal(parsed.header.kid, "pb-cap-test-2026q2");
assert.equal(parsed.claims.exp - parsed.claims.nbf, 300);
assert.equal(parsed.claims.eph, 7);
assert.equal(parsed.claims.rkh, vectors.base_claims.rkh);
assert.equal(parsed.claims.bnd, vectors.base_claims.bnd);
assert.deepEqual(await verifyCapTokenJws(issued.token, {
  ...vectors.base_context,
  now: vectors.base_claims.nbf + 1,
}), { verdict: "allow" });

const issuedCritical = await issueCapToken({
  BRIDGE_LOCAL_MEMORY: "1",
}, {
  authorization: {
    policy: {
      version: "AUTH-SCOPE-v2",
      product_id: "panda-dev",
      capabilities: ["shell.run"],
      boundaries: {
        shell: {
          cwd_root_id: "root-a",
          net: "deny",
          allow_exec_subtree: false,
          max_output_bytes: 1048576,
          deadline_ms: 30000,
        },
      },
    },
    epoch: 1,
  },
  job: {
    id: "job_shell_ttl",
    product_id: "panda-dev",
    kind: "shell.run",
    workspace_ref: null,
    request_key: "rk_shell_ttl",
    policy: {},
    input: { argv: ["/bin/echo", "hi"] },
  },
  product: { id: "panda-dev" },
  userId: vectors.base_context.user_id,
  device: { id: vectors.base_context.device_id },
  nowSeconds: vectors.base_claims.nbf,
});
const parsedCritical = parseCompactJws(issuedCritical.token);
assert.equal(parsedCritical.claims.exp - parsedCritical.claims.nbf, 30);
assert.equal(issuedCritical.danger, "critical");

function makeWorkerHarness(overrides = {}) {
  const state = {
    values: new Map(),
    storage: {
      async get(key) {
        return state.values.get(key);
      },
      async put(key, value) {
        state.values.set(key, value);
      },
    },
  };
  const durable = new BridgeTestStore(state, {});
  const tokenInstallIds = new Map();
  const jar = {};
  const env = {
    BRIDGE_LOCAL_MEMORY: "1",
    BRIDGE_STORAGE_BACKEND: "durable",
    BRIDGE_WEB_ORIGIN: "http://local.test",
    BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({
      "panda-chat": ["http://local.test"],
    }),
    BRIDGE_TEST_STORE: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (input, init) => durable.fetch(new Request(input, init)),
      }),
    },
    ...overrides,
  };

  async function storageOp(payload) {
    const response = await env.BRIDGE_TEST_STORE.get("bridge-test-store").fetch("https://bridge-test-store.local/storage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = JSON.parse(await response.text());
    assert.ok(response.ok, `storage op failed: ${JSON.stringify(body)}`);
    return body;
  }

  async function apiRaw(method, path, body = null, token = "", extraHeaders = {}, options = {}) {
    const headers = new Headers({ accept: "application/json" });
    if (body) headers.set("content-type", "application/json");
    if (jar.cookie) headers.set("cookie", jar.cookie);
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (token && tokenInstallIds.has(token) && !Object.hasOwn(extraHeaders, "x-panda-bridge-install-id")) {
      headers.set("x-panda-bridge-install-id", tokenInstallIds.get(token));
    }
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
    if (!options.skipOrigin && !["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("origin")) {
      headers.set("origin", env.BRIDGE_WEB_ORIGIN);
    }
    const response = await worker.fetch(new Request(`http://local.test${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }), env);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) jar.cookie = setCookie.split(";")[0];
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (payload?.device_token) {
      const installId = body?.install_id || extraHeaders["x-panda-bridge-install-id"] || tokenInstallIds.get(token);
      if (installId) tokenInstallIds.set(payload.device_token, installId);
    }
    return { response, payload };
  }

  async function api(method, path, body = null, token = "", extraHeaders = {}) {
    const { response, payload } = await apiRaw(method, path, body, token, extraHeaders);
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
    return payload;
  }

  async function nativeApi(method, path, body = null, token = "", extraHeaders = {}) {
    const { response, payload } = await apiRaw(method, path, body, token, extraHeaders, { skipOrigin: true });
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
    return payload;
  }

  return { env, api, apiRaw, nativeApi, storageOp };
}

async function createAuthorizedDevice(harness, label) {
  await harness.api("POST", "/v1/sessions/guest", { display_name: `L1 ${label}` });
  const intent = await harness.api("POST", "/v1/connect-intents", {
    product_id: "panda-chat",
    device_name: `L1 ${label}`,
    install_id: `install-l1-${label}`,
  });
  return harness.nativeApi("POST", `/v1/connect-intents/${encodeURIComponent(intent.token)}/claim`, {
    device_name: `L1 ${label}`,
    install_id: `install-l1-${label}`,
    capabilities: { codex: ["codex.chat"] },
  }, "", {
    "x-panda-bridge-local-client": "desktop",
    "x-panda-bridge-install-id": `install-l1-${label}`,
  });
}

async function createChatJob(harness, deviceId, requestKey) {
  return harness.api("POST", "/v1/products/panda-chat/jobs", {
    kind: "codex.chat",
    device_id: deviceId,
    product_id: "panda-chat",
    workspace_ref: "default",
    input: { prompt: requestKey },
    request_key: requestKey,
    policy: { token_budget: 1000, timeout_ms: 60000 },
  });
}

async function bumpAuthorizationEpochOnly(harness, claim) {
  const rows = (await harness.storageOp({
    op: "select",
    table: "bridge_authorizations",
    filters: {
      user_id: claim.account.id,
      device_id: claim.device.id,
      product_id: "panda-chat",
    },
  })).rows;
  assert.equal(rows.length, 1);
  await harness.storageOp({
    op: "update",
    table: "bridge_authorizations",
    id: rows[0].id,
    patch: { epoch: Number(rows[0].epoch || 1) + 1, updated_at: new Date().toISOString() },
  });
}

async function auditRowsForJob(harness, jobId, action) {
  return (await harness.storageOp({
    op: "select",
    table: "bridge_audit_log",
    filters: { target_id: jobId, action },
  })).rows;
}

function installFixedJtiSequence(jti, jobIds) {
  const original = globalThis.crypto.randomUUID;
  const ids = [
    jobIds[0],
    jti,
    "00000000-0000-4000-8000-00000000a101",
    "00000000-0000-4000-8000-00000000a102",
    "00000000-0000-4000-8000-00000000a103",
    jobIds[1],
    jti,
    "00000000-0000-4000-8000-00000000b101",
    "00000000-0000-4000-8000-00000000b102",
    "00000000-0000-4000-8000-00000000b103",
  ];
  globalThis.crypto.randomUUID = () => ids.shift() || original.call(globalThis.crypto);
  return () => {
    globalThis.crypto.randomUUID = original;
  };
}

{
  const harness = makeWorkerHarness({ PANDA_BRIDGE_CAPTOKEN_MODE: "enforce" });
  const claim = await createAuthorizedDevice(harness, "epoch-enforce");
  const created = await createChatJob(harness, claim.device.id, "l1-epoch-enforce");
  await bumpAuthorizationEpochOnly(harness, claim);
  const accepted = await harness.apiRaw("POST", `/v1/connectors/jobs/${created.job.id}/accept`, { transport: "websocket" }, claim.device_token);
  assert.equal(accepted.response.status, 403);
  assert.equal(accepted.payload.error, "cap_token_epoch_stale");
  assert.equal(accepted.payload.accepted, false);
  const jobs = (await harness.storageOp({ op: "select", table: "bridge_jobs", filters: { id: created.job.id } })).rows;
  assert.equal(jobs[0].status, "queued");
  const denied = await auditRowsForJob(harness, created.job.id, "cap_token.l1_denied");
  assert.equal(denied.at(-1).payload.reason, "cap_token_epoch_stale");
  assert.equal(denied.at(-1).payload.mode, "enforce");
}

{
  const harness = makeWorkerHarness();
  const claim = await createAuthorizedDevice(harness, "epoch-shadow");
  const created = await createChatJob(harness, claim.device.id, "l1-epoch-shadow");
  await bumpAuthorizationEpochOnly(harness, claim);
  const accepted = await harness.apiRaw("POST", `/v1/connectors/jobs/${created.job.id}/accept`, { transport: "websocket" }, claim.device_token);
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.payload.accepted, true);
  assert.equal(accepted.payload.job.status, "running");
  const denied = await auditRowsForJob(harness, created.job.id, "cap_token.l1_denied");
  assert.equal(denied.at(-1).payload.reason, "cap_token_epoch_stale");
  assert.equal(denied.at(-1).payload.mode, "shadow");
}

{
  const harness = makeWorkerHarness({ PANDA_BRIDGE_CAPTOKEN_MODE: "enforce" });
  const claim = await createAuthorizedDevice(harness, "replay-enforce");
  const fixedJti = "00000000-0000-4000-8000-00000000cafe";
  const restoreUuid = installFixedJtiSequence(fixedJti, [
    "00000000-0000-4000-8000-000000000201",
    "00000000-0000-4000-8000-000000000202",
  ]);
  let first;
  let second;
  try {
    first = await createChatJob(harness, claim.device.id, "l1-replay-enforce-a");
    second = await createChatJob(harness, claim.device.id, "l1-replay-enforce-b");
  } finally {
    restoreUuid();
  }
  assert.equal(parseCompactJws(first.job.cap_token).claims.jti, fixedJti);
  assert.equal(parseCompactJws(second.job.cap_token).claims.jti, fixedJti);
  const firstAccepted = await harness.api("POST", `/v1/connectors/jobs/${first.job.id}/accept`, { transport: "websocket" }, claim.device_token);
  assert.equal(firstAccepted.accepted, true);
  await harness.api("POST", `/v1/connectors/jobs/${first.job.id}/ack`, { status: "succeeded", result: { ok: true } }, claim.device_token);
  const replay = await harness.apiRaw("POST", `/v1/connectors/jobs/${second.job.id}/accept`, { transport: "websocket" }, claim.device_token);
  assert.equal(replay.response.status, 403);
  assert.equal(replay.payload.error, "cap_token_replay");
  assert.equal(replay.payload.accepted, false);
  const denied = await auditRowsForJob(harness, second.job.id, "cap_token.l1_denied");
  assert.equal(denied.at(-1).payload.reason, "cap_token_replay");
  assert.equal(denied.at(-1).payload.jti, fixedJti);
  assert.equal(denied.at(-1).payload.mode, "enforce");
}

{
  const harness = makeWorkerHarness();
  const claim = await createAuthorizedDevice(harness, "replay-shadow");
  const fixedJti = "00000000-0000-4000-8000-00000000feed";
  const restoreUuid = installFixedJtiSequence(fixedJti, [
    "00000000-0000-4000-8000-000000000301",
    "00000000-0000-4000-8000-000000000302",
  ]);
  let first;
  let second;
  try {
    first = await createChatJob(harness, claim.device.id, "l1-replay-shadow-a");
    second = await createChatJob(harness, claim.device.id, "l1-replay-shadow-b");
  } finally {
    restoreUuid();
  }
  const firstAccepted = await harness.api("POST", `/v1/connectors/jobs/${first.job.id}/accept`, { transport: "websocket" }, claim.device_token);
  assert.equal(firstAccepted.accepted, true);
  await harness.api("POST", `/v1/connectors/jobs/${first.job.id}/ack`, { status: "succeeded", result: { ok: true } }, claim.device_token);
  const replay = await harness.apiRaw("POST", `/v1/connectors/jobs/${second.job.id}/accept`, { transport: "websocket" }, claim.device_token);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.accepted, true);
  assert.equal(replay.payload.job.status, "running");
  const denied = await auditRowsForJob(harness, second.job.id, "cap_token.l1_denied");
  assert.equal(denied.at(-1).payload.reason, "cap_token_replay");
  assert.equal(denied.at(-1).payload.jti, fixedJti);
  assert.equal(denied.at(-1).payload.mode, "shadow");
}

console.log(`captoken js vectors: claims=${vectors.claim_cases.length} envelope=${vectors.envelope_cases.length} signatures=${vectors.signature_cases.length} bnd=${vectors.boundary_cases.length} l1=4`);
