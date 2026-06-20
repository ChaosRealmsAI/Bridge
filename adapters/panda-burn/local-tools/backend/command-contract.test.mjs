import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const contract = JSON.parse(readFileSync(resolve(adapterRoot, "command-contract.json"), "utf8"));

const flutterCriticalCommands = [
  "burn.agent.sessions.list",
  "burn.agent.session.show",
  "burn.agent.session.watch",
  "burn.agent.session.create",
  "burn.agent.session.continue",
  "burn.agent.turn.interrupt",
  "burn.agent.usage.summary",
  "burn.agent.usage.refresh",
  "burn.agent.usage.status",
  "burn.agent.usage.snapshot",
  "burn.agent.usage.totals",
  "burn.agent.usage.activity",
  "burn.agent.usage.heatmap",
  "burn.agent.usage.filters",
  "burn.agent.usage.diagnostics",
  "burn.agent.usage.pricing",
  "burn.agent.usage.dimensions",
  "burn.agent.usage.dimension",
  "burn.agent.usage.compact",
  "burn.project.list",
  "burn.project.create",
  "burn.project.preference.set",
  "burn.session.preference.set",
  "burn.monitor.sessions",
  "burn.business.sync.list",
  "burn.business.sync.ack",
];

test("Flutter-critical session and usage commands have detailed contracts", () => {
  assert.equal(contract.schema, "panda-burn.command-contract.v1");
  const commands = new Set(contract.commands);
  for (const command of flutterCriticalCommands) {
    assert.equal(commands.has(command), true, `${command} missing from command list`);
    assertDetailedContract(command, contract.contracts?.[command]);
  }
});

test("relay store status distinguishes public response schema from backend store schema", () => {
  const status = contract.contracts?.["burn.store.status"];
  assertDetailedContract("burn.store.status", status);
  assert.equal(status.output.schema, "burn.store.status.v1");
  assert.match(JSON.stringify(status), /store_schema/);
});

function assertDetailedContract(command, detail) {
  assert.ok(detail && typeof detail === "object", `${command} missing contract detail`);
  assert.ok(detail.input && typeof detail.input === "object", `${command} missing input contract`);
  assert.ok(detail.output && typeof detail.output === "object", `${command} missing output contract`);
  assert.ok(detail.errors && typeof detail.errors === "object", `${command} missing error contract`);
  assert.ok(detail.emptySemantics && typeof detail.emptySemantics === "string", `${command} missing empty semantics`);
  assert.ok(detail.pagination || detail.output.pagination, `${command} missing pagination semantics`);
  assert.ok(detail.output.requiredFields || detail.output.sessionRequiredFields || detail.output.activityRowRequiredFields, `${command} missing required output fields`);
}
