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

console.log("[connector.test] pass");
