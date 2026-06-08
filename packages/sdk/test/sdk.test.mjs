import assert from "node:assert/strict";
import { createBridgeClient } from "../src/index.js";

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

await client.connect.createIntent({ deviceName: "Mac" });
assert.equal(calls[1].url, "https://api.example.test/v1/connect-intents");
assert.equal(JSON.parse(calls[1].init.body).product_id, "panda-chat");

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

await devClient.connect.createIntent({ deviceName: "Dev Mac" });
assert.equal(devCalls[0].url, "https://api.example.test/v1/connect-intents");
assert.equal(JSON.parse(devCalls[0].init.body).product_id, "panda-dev");

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

console.log("[sdk.test] pass");
