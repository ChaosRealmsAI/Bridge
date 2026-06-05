import assert from "node:assert/strict";
import { validateBridgeJob } from "../src/index.js";

const valid = validateBridgeJob({
  kind: "saas.custom.run",
  productId: "panda-chat",
  deviceId: "dev_1",
  input: { prompt: "hello" },
  policy: {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    cwd: "/tmp/x",
    developerInstructions: "hi",
    token_budget: 9999999,
    timeout_ms: 3600000,
    extra: { passthrough: true },
  },
});
assert.equal(valid.ok, true);
assert.equal(valid.job.kind, "saas.custom.run");
assert.equal(valid.job.workspace_ref, null);
assert.deepEqual(valid.job.policy, {
  sandbox: "danger-full-access",
  approvalPolicy: "never",
  cwd: "/tmp/x",
  developerInstructions: "hi",
  token_budget: 9999999,
  timeout_ms: 3600000,
  extra: { passthrough: true },
});

const rpc = validateBridgeJob({
  kind: "codex.rpc",
  productId: "panda-chat",
  deviceId: "dev_1",
  input: { calls: [{ method: "shell/run" }] },
});
assert.equal(rpc.ok, true);

const invalid = validateBridgeJob({
  kind: "",
  productId: "panda-chat",
  deviceId: "dev_1",
});
assert.equal(invalid.ok, false);
assert.ok(invalid.errors.includes("missing_kind"));

console.log("[protocol.test] pass");
