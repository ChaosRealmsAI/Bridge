import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync("node", ["apps/connector-cli/src/cli.mjs", "run-fixture", "--fake-codex", "--prompt", "hello"], {
  cwd: new URL("../../..", import.meta.url).pathname,
  encoding: "utf8",
});

assert.equal(result.status, 0, result.stderr);
const payload = JSON.parse(result.stdout);
assert.equal(payload.ok, true);
assert.match(payload.reply, /hello/);

const fullAccess = spawnSync("node", [
  "apps/connector-cli/src/cli.mjs",
  "run-fixture",
  "--fake-codex",
  "--prompt",
  "hello",
  "--sandbox",
  "danger-full-access",
  "--approval-policy",
  "never",
], {
  cwd: new URL("../../..", import.meta.url).pathname,
  encoding: "utf8",
});

assert.equal(fullAccess.status, 0, fullAccess.stderr);
const fullAccessPayload = JSON.parse(fullAccess.stdout);
assert.equal(fullAccessPayload.ok, true);
assert.match(fullAccessPayload.reply, /hello/);

const denied = spawnSync("node", [
  "apps/connector-cli/src/cli.mjs",
  "run-fixture",
  "--fake-codex",
  "--prompt",
  "hello",
  "--sandbox",
  "danger-full-access",
  "--narrow-grant",
], {
  cwd: new URL("../../..", import.meta.url).pathname,
  encoding: "utf8",
});

assert.equal(denied.status, 0, denied.stderr);
const deniedPayload = JSON.parse(denied.stdout);
assert.equal(deniedPayload.ok, false);
assert.equal(deniedPayload.error, "local_policy_denied");
assert.equal(deniedPayload.denied, "sandbox");
assert.equal(deniedPayload.reason, "sandbox_not_allowed_locally");

const grantDenied = spawnSync("node", [
  "apps/connector-cli/src/cli.mjs",
  "run-fixture",
  "--fake-codex",
  "--prompt",
  "hello",
  "--approval-policy",
  "never",
  "--narrow-grant",
], {
  cwd: new URL("../../..", import.meta.url).pathname,
  encoding: "utf8",
  env: { ...process.env, PANDA_BRIDGE_ALLOW_APPROVAL_NEVER: "1" },
});

assert.equal(grantDenied.status, 0, grantDenied.stderr);
const grantDeniedPayload = JSON.parse(grantDenied.stdout);
assert.equal(grantDeniedPayload.ok, false);
assert.equal(grantDeniedPayload.error, "local_policy_denied");
assert.equal(grantDeniedPayload.denied, "approvalPolicy");
assert.equal(grantDeniedPayload.reason, "approval_policy_not_allowed_locally");

const emptyGrantDenied = spawnSync("node", [
  "apps/connector-cli/src/cli.mjs",
  "run-fixture",
  "--fake-codex",
  "--prompt",
  "hello",
  "--empty-grant",
], {
  cwd: new URL("../../..", import.meta.url).pathname,
  encoding: "utf8",
});

assert.equal(emptyGrantDenied.status, 0, emptyGrantDenied.stderr);
const emptyGrantDeniedPayload = JSON.parse(emptyGrantDenied.stdout);
assert.equal(emptyGrantDeniedPayload.ok, false);
assert.equal(emptyGrantDeniedPayload.error, "local_policy_denied");
assert.equal(emptyGrantDeniedPayload.denied, "capability");
assert.equal(emptyGrantDeniedPayload.reason, "capability_not_authorized_locally");

console.log("[connector.test] pass");
