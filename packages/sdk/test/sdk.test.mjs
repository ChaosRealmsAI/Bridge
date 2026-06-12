import assert from "node:assert/strict";
import {
  BRIDGE_ERROR_MESSAGES,
  BridgeError,
  BridgeErrorCodes,
  bridgeDelegatedAccountStatusModel,
  bridgeDelegatedConnectIntentStatusModel,
  bridgeDesktopInstallDefaults,
  bridgeDesktopInstallTarget,
  bridgeDesktopStatusModel,
  bridgeSnapshotStatusForDevice,
  bridgeStateModel,
  createBridgeClient,
} from "../src/index.js";

const calls = [];
const client = createBridgeClient({
  apiBase: "https://api.example.test",
  productId: "panda-chat",
  fetch: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ job: { id: "job_1", status: "queued" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  },
});

const job = await client.codex.run({ deviceId: "dev_1", prompt: "hello" });
assert.equal(job.job.id, "job_1");
assert.equal(calls[0].url, "https://api.example.test/v1/products/panda-chat/jobs");
assert.equal(JSON.parse(calls[0].init.body).kind, "codex.run");
assert.deepEqual(JSON.parse(calls[0].init.body).policy, {});

assert.equal(bridgeDesktopInstallDefaults.macos.fileName, "panda-bridge-macos.dmg");
assert.equal(
  bridgeDesktopInstallTarget({ channel: "test" }).downloadUrl,
  "https://assets-bridge.test.example/downloads/panda-bridge-macos.dmg",
);
assert.equal(
  bridgeDesktopInstallTarget({ assetBaseUrl: "https://cdn.example.test/" }).downloadUrl,
  "https://cdn.example.test/downloads/panda-bridge-macos.dmg",
);
assert.equal(
  bridgeDesktopInstallTarget({ downloadUrl: "https://download.example.test/PandaBridge.dmg" }).downloadUrl,
  "https://download.example.test/PandaBridge.dmg",
);
assert.equal(bridgeDesktopInstallTarget().openUrl, "panda-bridge://open");
assert.equal(bridgeDesktopInstallTarget().sha256.length, 64);
assert.throws(() => bridgeDesktopInstallTarget({ platform: "windows" }), /unsupported_bridge_desktop_platform/);

const installTarget = bridgeDesktopInstallTarget({ channel: "test" });
const readyState = bridgeStateFixture("active", true);
const readyModel = bridgeDesktopStatusModel(readyState, installTarget);
assert.equal(readyModel.ready, true);
assert.equal(readyModel.authorization.status, "active");
assert.equal(readyModel.connection.state, "connected");
assert.equal(readyModel.nextAction, "ready");
assert.equal(readyModel.download.downloadUrl, installTarget.downloadUrl);

const offlineModel = bridgeDesktopStatusModel(bridgeStateFixture("active", false), installTarget);
assert.equal(offlineModel.ready, false);
assert.equal(offlineModel.authorization.status, "active");
assert.equal(offlineModel.connection.state, "reconnecting");
assert.equal(offlineModel.nextAction, "wait_for_device");

const pausedModel = bridgeDesktopStatusModel(bridgeStateFixture("paused", true), installTarget);
assert.equal(pausedModel.ready, false);
assert.equal(pausedModel.authorization.status, "paused");
assert.equal(pausedModel.connection.connected, false);
assert.equal(pausedModel.nextAction, "resume_authorization");

const directState = bridgeStateModel({
  product: { id: "panda-chat" },
  install: stateInstall(),
  accounts: [{
    account: { id: "acct_1", email: "panda@example.test" },
    authorization: { id: "auth_1", status: "active", policy: { capabilities: ["codex.chat"] } },
    connected: true,
    current_device: { id: "dev_1", device_name: "Mac Studio", status: "online" },
  }],
});
assert.equal(directState.product_id, "panda-chat");
assert.equal(directState.ready, true);
assert.equal(directState.accounts[0].authorization.status, "active");
assert.equal(directState.accounts[0].authorization.policy, undefined);
assert.equal(directState.accounts[0].connected, true);
assert.equal(directState.accounts[0].current_device.id, "dev_1");
assert.equal(directState.bridge_state, undefined);

const legacyOffline = bridgeStateModel({
  bridge_state: "authorized_offline",
  product_id: "panda-chat",
  install: stateInstall(),
  devices: [{ id: "dev_1", device_name: "Mac Studio", status: "offline", current: true }],
  authorization: { id: "auth_1", status: "active", policy: { workspace_roots: [] } },
});
assert.equal(legacyOffline.accounts[0].authorization.status, "active");
assert.equal(legacyOffline.accounts[0].connected, false);
assert.equal(legacyOffline.bridge_state, undefined);

const delegatedReady = bridgeDelegatedAccountStatusModel({
  devices: [{ id: "dev_1", device_name: "Mac Studio", status: "online" }],
  authorized_devices: [{ id: "dev_1", device_name: "Mac Studio", status: "online" }],
  authorizations: [{ id: "auth_1", device_id: "dev_1", status: "active", policy: { capabilities: ["codex.chat"] } }],
  selected_device: { id: "dev_1", device_name: "Mac Studio", status: "online" },
  authorization: { id: "auth_1", device_id: "dev_1", status: "active" },
});
assert.equal(delegatedReady.ready, true);
assert.equal(delegatedReady.connected, true);
assert.equal(delegatedReady.authorization.status, "active");
assert.equal(delegatedReady.current_device.id, "dev_1");

const delegatedPaused = bridgeDelegatedAccountStatusModel({
  devices: [{ id: "dev_1", device_name: "Mac Studio", status: "online" }],
  authorization: { id: "auth_1", device_id: "dev_1", status: "paused" },
});
assert.equal(delegatedPaused.ready, false);
assert.equal(delegatedPaused.connected, false);
assert.equal(delegatedPaused.authorization.status, "paused");

const pendingIntentModel = bridgeDelegatedConnectIntentStatusModel({
  deep_link: "panda-bridge://connect?intent=pbi_test&api=https%3A%2F%2Fapi.bridge.otherline.cc",
  connect_intent: { id: "intent_1", expires_at: "2099-01-01T00:00:00Z" },
}, "pbi_test");
assert.equal(pendingIntentModel.ready, false);
assert.equal(pendingIntentModel.authorized, false);
assert.equal(pendingIntentModel.intentId, "pbi_test");
assert.equal(pendingIntentModel.expiresAt, "2099-01-01T00:00:00Z");
assert.match(pendingIntentModel.deepLink, /^panda-bridge:\/\/connect/);

const claimedIntentModel = bridgeDelegatedConnectIntentStatusModel({
  deep_link: "panda-bridge://connect?intent=pbi_test&api=https%3A%2F%2Fapi.bridge.otherline.cc",
  connect_intent: { id: "intent_1", device_id: "dev_1", expires_at: "2099-01-01T00:00:00Z" },
  device: { id: "dev_1", status: "online" },
  authorization: { id: "auth_1", status: "active" },
}, "pbi_test");
assert.equal(claimedIntentModel.ready, true);
assert.equal(claimedIntentModel.authorized, true);
assert.equal(claimedIntentModel.current_device.id, "dev_1");
assert.equal(bridgeSnapshotStatusForDevice({ status: "online" }), "connected");
assert.equal(bridgeSnapshotStatusForDevice({ status: "offline" }), "reconnecting");

await client.connect.createIntent({ deviceName: "Mac" });
assert.equal(calls[1].url, "https://api.example.test/v1/connect-intents");
assert.equal(JSON.parse(calls[1].init.body).product_id, "panda-chat");
assert.equal(JSON.parse(calls[1].init.body).policy.workspace_roots[0].allow_all, true);
assert.equal(JSON.parse(calls[1].init.body).policy.sandbox_floor, "danger-full-access");
assert.equal(JSON.parse(calls[1].init.body).policy.approval_policy_floor, "never");
assert.equal(JSON.parse(calls[1].init.body).policy.display, undefined);

await client.auth.share();
assert.equal(calls[2].url, "https://api.example.test/v1/sessions/share");

await client.auth.join("pbl_test");
assert.equal(calls[3].url, "https://api.example.test/v1/sessions/join");
assert.equal(JSON.parse(calls[3].init.body).token, "pbl_test");

await client.auth.password("panda-test@example.com", "secret-password", "Panda Test");
assert.equal(calls[4].url, "https://api.example.test/v1/sessions/password");
assert.equal(JSON.parse(calls[4].init.body).email, "panda-test@example.com");

await client.products.list();
assert.equal(calls[5].url, "https://api.example.test/v1/products");

const authCalls = [];
const authClient = createBridgeClient({
  apiBase: "https://api.example.test",
  productId: "panda-chat",
  fetch: async (url, init) => {
    authCalls.push({ url, init });
    const body = init.body ? JSON.parse(init.body) : {};
    return new Response(JSON.stringify({
      authorization: { id: "auth_1", device_id: "dev_1", status: body.status || "active", policy: { capabilities: ["codex.chat"] } },
      device: { id: "dev_1", status: body.status === "paused" ? "online" : "online" },
      cancelled_jobs: init.method === "DELETE" ? 2 : 0,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
const listed = await authClient.authorization.list({ deviceId: "dev_1" });
assert.equal(listed.authorization.status, "active");
assert.equal(listed.authorization.policy, undefined);
assert.equal(authCalls[0].url, "https://api.example.test/v1/products/panda-chat/authorization?device_id=dev_1");
assert.equal(authCalls[0].init.method, "GET");

const paused = await authClient.authorization.pause({ deviceId: "dev_1" });
assert.equal(paused.authorization.status, "paused");
assert.equal(paused.connected, false);
assert.equal(authCalls[1].url, "https://api.example.test/v1/products/panda-chat/authorization?device_id=dev_1");
assert.equal(authCalls[1].init.method, "PATCH");
assert.deepEqual(JSON.parse(authCalls[1].init.body), { status: "paused" });

await authClient.authorization.resume({ deviceId: "dev_1" });
assert.equal(authCalls[2].init.method, "PATCH");
assert.deepEqual(JSON.parse(authCalls[2].init.body), { status: "active" });

const removed = await authClient.authorization.remove({ deviceId: "dev_1" });
assert.equal(removed.cancelled_jobs, 2);
assert.equal(authCalls[3].init.method, "DELETE");

await authClient.products.revokeAuthorization("dev_1");
assert.equal(authCalls[4].url, "https://api.example.test/v1/products/panda-chat/authorization?device_id=dev_1");
assert.equal(authCalls[4].init.method, "DELETE");

await client.diagnostics();
assert.equal(calls[6].url, "https://api.example.test/v1/diagnostics");
assert.equal(calls[6].init.method, "GET");

await client.queue.summary();
assert.equal(calls[7].url, "https://api.example.test/v1/queue/summary");
assert.equal(calls[7].init.method, "GET");

const customCalls = [];
const customClient = createBridgeClient({
  apiBase: "https://api.example.test",
  productId: "panda-chat",
  fetch: async (url, init) => {
    customCalls.push({ url, init });
    return new Response(JSON.stringify({ job: { id: "job_custom_1", status: "queued" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  },
});

await customClient.jobs.create({
  kind: "saas.custom.run",
  deviceId: "dev_custom_1",
  input: { task: "passthrough" },
  policy: {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    cwd: "/tmp/x",
    developerInstructions: "hi",
    token_budget: 9999999,
    timeout_ms: 3600000,
  },
});
assert.equal(customCalls[0].url, "https://api.example.test/v1/products/panda-chat/jobs");
assert.deepEqual(JSON.parse(customCalls[0].init.body), {
  kind: "saas.custom.run",
  product_id: "panda-chat",
  device_id: "dev_custom_1",
  workspace_ref: null,
  request_key: null,
  input: { task: "passthrough" },
  policy: {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    cwd: "/tmp/x",
    developerInstructions: "hi",
    token_budget: 9999999,
    timeout_ms: 3600000,
  },
});

const unauthPreflight = mockClient([
  { body: { ok: true, protocol: "panda-bridge-protocol-v0.1" } },
  { status: 401, body: { authenticated: false, error: "unauthorized" } },
]);
const unauthPreflightResult = await unauthPreflight.client.preflight();
assert.equal(unauthPreflightResult.ready, false);
assert.equal(unauthPreflightResult.authenticated, false);
assert.equal(unauthPreflightResult.issues[0].code, "not_authenticated");
assert.equal(unauthPreflightResult.actions[0].code, "login");
assert.deepEqual(unauthPreflight.calls.map((call) => call.path), ["/v1/diagnostics", "/v1/session"]);
assert.ok(unauthPreflight.calls.every((call) => call.method === "GET"));

const readyPreflight = mockClient([
  { body: { ok: true, protocol: "panda-bridge-protocol-v0.1" } },
  { body: { authenticated: true, user: { id: "user_1" } } },
  { body: { items: [{ id: "dev_1", status: "online", device_name: "Mac" }] } },
  { body: { authorization: { device_id: "dev_1", product_id: "panda-chat", status: "active" } } },
  { body: { counts: { total: 1, active: 0 }, devices: [{ device: { id: "dev_1" }, queue: { active: 0 } }] } },
]);
const readyPreflightResult = await readyPreflight.client.preflight();
assert.equal(readyPreflightResult.ready, true);
assert.equal(readyPreflightResult.selected_device.id, "dev_1");
assert.equal(readyPreflightResult.authorized_devices.length, 1);
assert.deepEqual(readyPreflightResult.issues, []);

const stateClient = mockClient([{ body: bridgeStateFixture("active", true) }]);
const state = await stateClient.client.state();
assert.equal(state.ready, true);
assert.equal(state.accounts[0].authorization.status, "active");
assert.equal(state.accounts[0].connected, true);
assert.equal(state.bridge_state, undefined);
assert.equal(stateClient.calls[0].path, "/v1/bridge/state?product_id=panda-chat");

const install = client.install();
assert.equal(install.version, "0.1.0");
assert.equal(install.openUrl, "panda-bridge://open");
assert.equal(install.sha256.length, 64);

const readyEnsure = mockClient([{ body: bridgeStateFixture("active", true) }]);
const readyResult = await readyEnsure.client.ensureReady({ intervalMs: 1, timeoutMs: 10 });
assert.equal(readyResult.ready, true);
assert.equal(readyResult.account.authorization.status, "active");
assert.equal(readyEnsure.calls.length, 1);

const offlineEnsure = mockClient([{ body: bridgeStateFixture("active", false) }]);
const offlineResult = await offlineEnsure.client.ensureReady({ intervalMs: 1, timeoutMs: 10 });
assert.equal(offlineResult.ready, false);
assert.equal(offlineResult.action.kind, "wait_for_device");
assert.equal(offlineEnsure.calls.some((call) => call.path === "/v1/connect-intents"), false);

const pausedEnsure = mockClient([{ body: bridgeStateFixture("paused", true) }]);
const pausedResult = await pausedEnsure.client.ensureReady({ intervalMs: 1, timeoutMs: 10 });
assert.equal(pausedResult.ready, false);
assert.equal(pausedResult.action.kind, "resume_authorization");

const waitedEnsure = mockClient([
  { body: bridgeStateFixture("active", false) },
  { body: bridgeStateFixture("active", true) },
]);
const waitedResult = await waitedEnsure.client.ensureReady({ intervalMs: 1, timeoutMs: 200, wait: true });
assert.equal(waitedResult.ready, true);
assert.deepEqual(waitedEnsure.calls.map((call) => call.path), [
  "/v1/bridge/state?product_id=panda-chat",
  "/v1/bridge/state?product_id=panda-chat",
]);

const originalWebSocket = globalThis.WebSocket;
class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.listeners = {};
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
  close() {
    this.readyState = 3;
  }
  emit(type, payload) {
    this.listeners[type]?.({ data: JSON.stringify(payload) });
  }
}
globalThis.WebSocket = FakeWebSocket;
try {
  const watched = mockClient([
    { body: bridgeStateFixture("active", false) },
    { body: bridgeStateFixture("active", true) },
  ]);
  const generator = watched.client.watchState({ intervalMs: 5, timeoutMs: 100 });
  const first = await generator.next();
  assert.equal(first.value.ready, false);
  assert.equal(FakeWebSocket.instances[0].url, "wss://api.example.test/v1/realtime/devices/dev_1?role=web");
  FakeWebSocket.instances[0].emit("message", { type: "bridge.state" });
  const second = await generator.next();
  assert.equal(second.value.ready, true);
  await generator.return();
} finally {
  globalThis.WebSocket = originalWebSocket;
}

const errorClient = createBridgeClient({
  apiBase: "https://api.example.test",
  productId: "panda-chat",
  fetch: async () => new Response(JSON.stringify({
    error: "authorization_paused",
    message: "authorization_paused",
  }), {
    status: 403,
    headers: { "content-type": "application/json" },
  }),
});

await assert.rejects(
  () => errorClient.diagnostics(),
  (error) => {
    assert.equal(error instanceof BridgeError, true);
    assert.equal(BridgeErrorCodes.authorization_paused, "authorization_paused");
    assert.equal(BridgeErrorCodes.device_offline, "device_offline");
    assert.equal(BridgeErrorCodes.unsupported_job_kind, "unsupported_job_kind");
    assert.equal(BridgeErrorCodes.not_found, "not_found");
    assert.equal(error.code, "authorization_paused");
    // .code stays the raw code; .message is a human-readable mapping when the
    // worker did not provide a useful message (here it just echoed the code).
    assert.notEqual(error.message, "authorization_paused");
    assert.equal(error.message, BRIDGE_ERROR_MESSAGES.authorization_paused);
    assert.equal(error.status, 403);
    assert.deepEqual(error.payload, { error: "authorization_paused", message: "authorization_paused" });
    return true;
  },
);

console.log("[sdk.test] pass");

function bridgeStateFixture(status, connected) {
  return {
    product_id: "panda-chat",
    install: stateInstall(),
    accounts: [{
      account: { id: "acct_1", email: "panda@example.test" },
      authorization: { id: "auth_1", status, policy: { capabilities: ["codex.chat"] } },
      connected,
      current_device: {
        id: "dev_1",
        name: "Mac",
        status: connected ? "online" : "offline",
        online: connected,
        last_seen_at: "2099-01-01T00:00:00Z",
        current: true,
      },
    }],
  };
}

function stateInstall() {
  return {
    download_url: "https://assets.bridge.otherline.cc/downloads/panda-bridge-macos.dmg",
    version: "0.1.0",
    sha256: "e65e04f08373ffe2363616dc1426516b74f12123f52c71d7225af4bac7225962",
    platform: "macos",
    open_url: "panda-bridge://open",
  };
}

function mockClient(responses) {
  const calls = [];
  const client = createBridgeClient({
    apiBase: "https://api.example.test",
    productId: "panda-chat",
    fetch: async (url, init) => {
      const next = responses.shift() || { body: {} };
      const parsed = new URL(url);
      calls.push({
        url,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method,
      });
      return new Response(JSON.stringify(next.body), {
        status: next.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, calls };
}
