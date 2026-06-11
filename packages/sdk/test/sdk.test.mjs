import assert from "node:assert/strict";
import {
  BridgeError,
  BridgeErrorCodes,
  bridgeDelegatedAccountStatusModel,
  bridgeDelegatedConnectIntentStatusModel,
  bridgeDesktopInstallDefaults,
  bridgeDesktopInstallTarget,
  bridgeDesktopStatusModel,
  bridgeSnapshotStatusForDevice,
  bridgeFullAccessPolicy,
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
const readyModel = bridgeDesktopStatusModel({
  status: "connected",
  device: { id: "dev_1", online: true, installed: true },
}, installTarget);
assert.equal(readyModel.ready, true);
assert.equal(readyModel.authorization.state, "authorized");
assert.equal(readyModel.connection.state, "connected");
assert.equal(readyModel.nextAction, "ready");
assert.equal(readyModel.download.downloadUrl, installTarget.downloadUrl);

const authorizedOfflineModel = bridgeDesktopStatusModel({
  status: "device_offline",
  device: { id: "dev_1", online: false, installed: true },
}, installTarget);
assert.equal(authorizedOfflineModel.ready, false);
assert.equal(authorizedOfflineModel.authorization.state, "authorized");
assert.equal(authorizedOfflineModel.connection.state, "disconnected");
assert.equal(authorizedOfflineModel.nextAction, "open_bridge");

const pendingModel = bridgeDesktopStatusModel({
  status: "authorization_pending",
  device: { id: "dev_1", online: true, installed: true },
}, installTarget);
assert.equal(pendingModel.ready, false);
assert.equal(pendingModel.authorization.state, "pending");
assert.equal(pendingModel.connection.state, "waiting");
assert.equal(pendingModel.nextAction, "confirm_on_desktop");

const accountReady = bridgeDelegatedAccountStatusModel({
  devices: [{ id: "dev_1", device_name: "Mac Studio", status: "online" }],
  authorized_devices: [{ id: "dev_1", device_name: "Mac Studio", status: "online" }],
  authorizations: [{ id: "auth_1", device_id: "dev_1", status: "active" }],
  selected_device: { id: "dev_1", device_name: "Mac Studio", status: "online" },
  authorization: { id: "auth_1", device_id: "dev_1", status: "active" },
});
assert.equal(accountReady.status, "connected");
assert.equal(accountReady.ready, true);
assert.equal(accountReady.deviceId, "dev_1");
assert.equal(accountReady.outlet.deviceId, "dev_1");

const accountOffline = bridgeDelegatedAccountStatusModel({
  authorized_devices: [{ id: "dev_1", device_name: "Mac Studio", status: "offline" }],
  authorizations: [{ id: "auth_1", device_id: "dev_1", status: "active" }],
});
assert.equal(accountOffline.status, "device_offline");
assert.equal(accountOffline.authorized, true);
assert.equal(accountOffline.connected, false);

const accountUntrusted = bridgeDelegatedAccountStatusModel({
  devices: [{ id: "dev_1", device_name: "Mac Studio", status: "online" }],
});
assert.equal(accountUntrusted.status, "source_registered");
assert.equal(accountUntrusted.deviceId, null);
assert.equal(accountUntrusted.authorization, null);
assert.equal(bridgeSnapshotStatusForDevice({ status: "online" }), "connected");
assert.equal(bridgeSnapshotStatusForDevice({ status: "offline" }), "device_offline");

const pendingIntentModel = bridgeDelegatedConnectIntentStatusModel({
  deep_link: "panda-bridge://connect?intent=pbi_test&api=https%3A%2F%2Fapi.bridge.otherline.cc",
  connect_intent: { id: "intent_1", expires_at: "2099-01-01T00:00:00Z" },
}, "pbi_test");
assert.equal(pendingIntentModel.status, "authorization_pending");
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
assert.equal(claimedIntentModel.status, "connected");
assert.equal(claimedIntentModel.authorized, true);
assert.equal(claimedIntentModel.deviceId, "dev_1");

await client.connect.createIntent({ deviceName: "Mac" });
assert.equal(calls[1].url, "https://api.example.test/v1/connect-intents");
assert.equal(JSON.parse(calls[1].init.body).product_id, "panda-chat");
assert.equal(JSON.parse(calls[1].init.body).policy.workspace_roots[0].allow_all, true);
assert.equal(JSON.parse(calls[1].init.body).policy.sandbox_floor, "danger-full-access");
assert.equal(JSON.parse(calls[1].init.body).policy.approval_policy_floor, "never");

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

await client.products.revokeAuthorization("dev_1");
assert.equal(calls[6].url, "https://api.example.test/v1/products/panda-chat/authorization?device_id=dev_1");
assert.equal(calls[6].init.method, "DELETE");

await client.diagnostics();
assert.equal(calls[7].url, "https://api.example.test/v1/diagnostics");
assert.equal(calls[7].init.method, "GET");

await client.queue.summary();
assert.equal(calls[8].url, "https://api.example.test/v1/queue/summary");
assert.equal(calls[8].init.method, "GET");

const devCalls = [];
const devClient = createBridgeClient({
  apiBase: "https://api.example.test",
  productId: "panda-dev",
  fetch: async (url, init) => {
    devCalls.push({ url, init });
    return new Response(JSON.stringify({ job: { id: "job_dev_1", status: "queued" }, items: [] }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  },
});

await devClient.connect.createIntent({
  deviceName: "Dev Mac",
  permissions: bridgeFullAccessPolicy({
    display: { workspace: "Custom caller scope" },
  }),
});
assert.equal(devCalls[0].url, "https://api.example.test/v1/connect-intents");
assert.equal(JSON.parse(devCalls[0].init.body).product_id, "panda-dev");
assert.equal(JSON.parse(devCalls[0].init.body).policy.display.workspace, "All local files");

await devClient.products.authorization("dev_2");
assert.equal(devCalls[1].url, "https://api.example.test/v1/products/panda-dev/authorization?device_id=dev_2");

await devClient.codex.rpc({ deviceId: "dev_2", calls: [{ method: "initialize" }] });
assert.equal(devCalls[2].url, "https://api.example.test/v1/products/panda-dev/jobs");
assert.equal(JSON.parse(devCalls[2].init.body).kind, "codex.rpc");
assert.equal(JSON.parse(devCalls[2].init.body).product_id, "panda-dev");

await devClient.jobs.events("job_dev_1", 4);
assert.equal(devCalls[3].url, "https://api.example.test/v1/jobs/job_dev_1/events?after=4");

await devClient.jobs.cancel("job_dev_1");
assert.equal(devCalls[4].url, "https://api.example.test/v1/jobs/job_dev_1/cancel");
assert.equal(devCalls[4].init.method, "POST");

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
assert.equal(readyPreflightResult.queue.counts.total, 1);
assert.deepEqual(readyPreflightResult.issues, []);
assert.deepEqual(readyPreflight.calls.map((call) => call.path), [
  "/v1/diagnostics",
  "/v1/session",
  "/v1/devices",
  "/v1/products/panda-chat/authorization?device_id=dev_1",
  "/v1/queue/summary",
]);

const missingAuthorizationPreflight = mockClient([
  { body: { ok: true } },
  { body: { authenticated: true, user: { id: "user_1" } } },
  { body: { items: [{ id: "dev_1", status: "online" }] } },
  { body: { authorization: null } },
  { body: { counts: { total: 0 }, devices: [] } },
]);
const missingAuthorizationResult = await missingAuthorizationPreflight.client.preflight();
assert.equal(missingAuthorizationResult.ready, false);
assert.equal(missingAuthorizationResult.issues.some((item) => item.code === "product_not_authorized"), true);
assert.equal(missingAuthorizationResult.actions.some((item) => item.code === "authorize_product"), true);

const targetMismatchPreflight = mockClient([
  { body: { ok: true } },
  { body: { authenticated: true, user: { id: "user_1" } } },
  { body: { items: [{ id: "dev_1", status: "online" }] } },
  { body: { counts: { total: 0 }, devices: [] } },
]);
const targetMismatchResult = await targetMismatchPreflight.client.preflight({ deviceId: "missing_dev" });
assert.equal(targetMismatchResult.ready, false);
assert.equal(targetMismatchResult.issues.some((item) => item.code === "device_not_found"), true);
assert.equal(targetMismatchPreflight.calls.some((call) => call.path.includes("/authorization")), false);

const bridgeStates = ["no_session", "no_device", "authorization_pending", "authorized_offline", "not_authorized", "ready"];
for (const bridge_state of bridgeStates) {
  const stateClient = mockClient([{ body: bridgeStateFixture(bridge_state) }]);
  const state = await stateClient.client.state();
  assert.equal(state.bridge_state, bridge_state);
  assert.equal(stateClient.calls[0].path, "/v1/bridge/state?product_id=panda-chat");
}

const install = client.install();
assert.equal(install.version, "0.1.0");
assert.equal(install.openUrl, "panda-bridge://open");
assert.equal(install.sha256.length, 64);

const readyEnsure = mockClient([{ body: bridgeStateFixture("ready") }]);
const readyResult = await readyEnsure.client.ensureReady({ intervalMs: 1, timeoutMs: 10 });
assert.equal(readyResult.ready, true);
assert.equal(readyEnsure.calls.length, 1);

const offlineEnsure = mockClient([{ body: bridgeStateFixture("authorized_offline") }]);
const offlineResult = await offlineEnsure.client.ensureReady({ intervalMs: 1, timeoutMs: 10 });
assert.equal(offlineResult.ready, false);
assert.equal(offlineResult.action.kind, "open_desktop");
assert.equal(offlineEnsure.calls.some((call) => call.path === "/v1/connect-intents"), false);

let openedDeepLink = "";
const authorizeEnsure = mockClient([
  { body: bridgeStateFixture("not_authorized") },
  { status: 201, body: { token: "pbi_test", deep_link: "panda-bridge://connect?intent=pbi_test", connect_intent: { expires_at: "2099-01-01T00:00:00Z" } } },
  { body: bridgeStateFixture("ready") },
]);
const authorizeResult = await authorizeEnsure.client.ensureReady({
  intervalMs: 1,
  timeoutMs: 200,
  openDeepLink: (deepLink) => {
    openedDeepLink = deepLink;
  },
});
assert.equal(authorizeResult.ready, true);
assert.equal(openedDeepLink, "panda-bridge://connect?intent=pbi_test");
assert.deepEqual(authorizeEnsure.calls.map((call) => call.path), [
  "/v1/bridge/state?product_id=panda-chat",
  "/v1/connect-intents",
  "/v1/bridge/state?product_id=panda-chat",
]);

const alreadyAuthorizedEnsure = mockClient([
  { body: bridgeStateFixture("not_authorized") },
  { body: { already_authorized: true, state: "ready", authorization: { status: "active" }, device: { id: "dev_1", status: "online" } } },
]);
const alreadyAuthorizedResult = await alreadyAuthorizedEnsure.client.ensureReady({ intervalMs: 1, timeoutMs: 20 });
assert.equal(alreadyAuthorizedResult.ready, true);
assert.equal(alreadyAuthorizedResult.state.bridge_state, "ready");
assert.equal(alreadyAuthorizedEnsure.calls.length, 2);

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
    { body: bridgeStateFixture("authorization_pending") },
    { body: bridgeStateFixture("ready") },
  ]);
  const generator = watched.client.watchState({ intervalMs: 5, timeoutMs: 100 });
  const first = await generator.next();
  assert.equal(first.value.bridge_state, "authorization_pending");
  assert.equal(FakeWebSocket.instances[0].url, "wss://api.example.test/v1/realtime/devices/dev_1?role=web");
  FakeWebSocket.instances[0].emit("message", { type: "bridge.state" });
  const second = await generator.next();
  assert.equal(second.value.bridge_state, "ready");
  await generator.return();
} finally {
  globalThis.WebSocket = originalWebSocket;
}

const errorClient = createBridgeClient({
  apiBase: "https://api.example.test",
  productId: "panda-chat",
  fetch: async () => new Response(JSON.stringify({
    error: "request_body_too_large",
    limit_bytes: 64,
  }), {
    status: 413,
    headers: { "content-type": "application/json" },
  }),
});

await assert.rejects(
  () => errorClient.diagnostics(),
  (error) => {
    assert.equal(error instanceof BridgeError, true);
    assert.equal(BridgeErrorCodes.request_body_too_large, "request_body_too_large");
    assert.equal(error.code, "request_body_too_large");
    assert.equal(error.message, "request_body_too_large");
    assert.equal(error.status, 413);
    assert.deepEqual(error.payload, { error: "request_body_too_large", limit_bytes: 64 });
    return true;
  },
);

console.log("[sdk.test] pass");

function bridgeStateFixture(bridge_state) {
  return {
    bridge_state,
    product_id: "panda-chat",
    install: {
      download_url: "https://assets.bridge.otherline.cc/downloads/panda-bridge-macos.dmg",
      version: "0.1.0",
      sha256: "e65e04f08373ffe2363616dc1426516b74f12123f52c71d7225af4bac7225962",
      platform: "macos",
      open_url: "panda-bridge://open",
    },
    devices: bridge_state === "no_session" || bridge_state === "no_device"
      ? []
      : [{ id: "dev_1", name: "Mac", online: bridge_state !== "authorized_offline", last_seen_at: "2099-01-01T00:00:00Z", current: true }],
    authorization: bridge_state === "ready" || bridge_state === "authorized_offline"
      ? { status: "active", policy: { version: "AUTH-SCOPE-v1" }, authorized_at: "2099-01-01T00:00:00Z", origin: "https://chat.example.test" }
      : null,
    intent: bridge_state === "authorization_pending"
      ? { token: "pbi_pending", expires_at: "2099-01-01T00:00:00Z", deep_link: "panda-bridge://connect?intent=pbi_pending" }
      : null,
    actions: bridgeStateActions(bridge_state),
  };
}

function bridgeStateActions(bridge_state) {
  if (bridge_state === "no_session") return [{ kind: "login" }];
  if (bridge_state === "no_device") return [{ kind: "download", url: "https://assets.bridge.otherline.cc/downloads/panda-bridge-macos.dmg" }];
  if (bridge_state === "authorization_pending") return [{ kind: "confirm_on_desktop", deep_link: "panda-bridge://connect?intent=pbi_pending" }];
  if (bridge_state === "authorized_offline") return [{ kind: "open_desktop", url: "panda-bridge://open" }];
  if (bridge_state === "not_authorized") return [{ kind: "authorize" }];
  return [];
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
