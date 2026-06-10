import assert from "node:assert/strict";
import {
  bridgeDesktopInstallDefaults,
  bridgeDesktopInstallTarget,
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
    assert.equal(error.message, "request_body_too_large");
    assert.equal(error.status, 413);
    assert.deepEqual(error.payload, { error: "request_body_too_large", limit_bytes: 64 });
    return true;
  },
);

console.log("[sdk.test] pass");

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
