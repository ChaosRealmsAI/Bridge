#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const versionId = process.env.BRIDGE_SPEC_VERSION || "agent-usage-ledger";

if (!existsSync(resolve(root, "spec/check-template.sh"))) {
  console.log(JSON.stringify({
    ok: true,
    check: "bridge-spec-traceability",
    skipped: "private_spec_missing",
  }, null, 2));
  process.exit(0);
}

const check = spawnSync("bash", ["spec/check-template.sh", "--no-smoke"], {
  cwd: root,
  stdio: "inherit",
});
assert.equal(check.status, 0, "spec/check-template.sh --no-smoke failed");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(resolve(root, "spec"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => relative(root, file));

const required = [
  "spec/L1/产品能力.md",
  "spec/L2/ManagedAdapter.md",
  "spec/L3/versions/agent-usage-ledger/版本合同.md",
];
for (const file of required) {
  assert.ok(files.includes(file), `missing trace file: ${file}`);
}

const contract = readFileSync(resolve(root, "spec/L3/versions/agent-usage-ledger/版本合同.md"), "utf8");
assert.match(contract, /Codex 和 Claude Code JSONL 是唯一数据来源/);
assert.match(contract, /data\/agent-usage/);

const evidenceDir = resolve(root, "spec/L3/evidence", versionId);
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(resolve(evidenceDir, "spec-traceability-summary.json"), `${JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  version_id: versionId,
  files,
  command: "bash spec/check-template.sh --no-smoke",
}, null, 2)}\n`);

console.log("[spec-traceability] pass");
