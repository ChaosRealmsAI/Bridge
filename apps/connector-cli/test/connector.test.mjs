import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
const source = readFileSync(resolve(root, "apps/connector-cli/src/cli.mjs"), "utf8");

for (const stale of [
  "/v1/connectors/jobs",
  "run-fixture",
  "fake-codex",
  "codex.",
  "local_policy_denied",
]) {
  assert.equal(source.includes(stale), false, `connector CLI must not contain stale runtime marker: ${stale}`);
}

const help = spawnSync("node", ["apps/connector-cli/src/cli.mjs", "help"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /poll-relay/);
assert.match(help.stdout, /relay-only/);

const stateDir = mkdtempSync(resolve(tmpdir(), "panda-bridge-connector-test-"));
const doctor = spawnSync("node", [
  "apps/connector-cli/src/cli.mjs",
  "doctor",
  "--api",
  "http://127.0.0.1:9",
  "--state",
  resolve(stateDir, "missing.json"),
], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(doctor.status, 0, doctor.stderr);
const payload = JSON.parse(doctor.stdout);
assert.equal(payload.ok, false);
assert.equal(payload.relay_only, true);
assert.equal(payload.local.relay.envelopes, true);
assert.deepEqual(payload.local.adapter_router.products, {});

console.log("[connector.test] pass");
