#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const versionId = process.env.PANDA_BRIDGE_SPEC_VERSION || "v0-3";

const check = spawnSync("bash", ["spec/check-template.sh", "--no-smoke"], {
  cwd: root,
  stdio: "inherit",
});
assert.equal(check.status, 0, "spec/check-template.sh --no-smoke failed");

const bddIndex = JSON.parse(readFileSync(resolve(root, "spec/bdd/_index.json"), "utf8"));
assert.equal(bddIndex.schemaVersion, "2.0", "BDD index must be v2");
assert.ok(Array.isArray(bddIndex.moduleFiles), "BDD index must use moduleFiles");

const modules = bddIndex.moduleFiles.map((item) => ({
  moduleId: item.moduleId,
  file: item.file,
}));
const behaviors = [];
for (const item of modules) {
  const doc = JSON.parse(readFileSync(resolve(root, "spec/bdd", item.file), "utf8"));
  assert.equal(doc.schemaVersion, "2.0", `${item.file} must be v2`);
  assert.equal(doc.module?.id, item.moduleId, `${item.file} module id mismatch`);
  for (const behavior of doc.behaviors || []) {
    behaviors.push({
      id: behavior.id,
      moduleId: item.moduleId,
      scenarios: (behavior.scenarios || []).map((scenario) => scenario.id),
    });
  }
}

const evidenceDir = resolve(root, "spec/verification/evidence", versionId);
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(resolve(evidenceDir, "spec-traceability-summary.json"), `${JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  version_id: versionId,
  modules,
  behavior_count: behaviors.length,
  behaviors,
  command: "bash spec/check-template.sh --no-smoke",
}, null, 2)}\n`);

console.log("[spec-traceability] pass");
