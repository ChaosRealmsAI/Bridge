#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(".");
const version = "v1-spec-rebuild-alignment";
const evidencePath = resolve(root, "spec/verification/evidence", version, "spec-traceability-summary.json");

const requiredFiles = [
  "README.md",
  "spec/README.md",
  "spec/_index.json",
  "spec/principles.md",
  "spec/changelog.md",
  "spec/devlog.md",
  "spec/gate/capability-map.html",
  "spec/gate/routes/v1-spec-rebuild-alignment.md",
  "spec/gate/bdd/_index.json",
  "spec/gate/bdd/spec.json",
  "spec/gate/bdd/docs.json",
  "spec/gate/bdd/bridge.json",
  "spec/architecture/architecture.md",
  "spec/design/ux.md",
  "spec/quality/gates.md",
  "spec/implementation/roadmap/v1-spec-rebuild-alignment.json",
  "spec/goal/20260608-140530-v1-spec-rebuild-alignment.goal.md"
];

const forbiddenPaths = [
  "knowledge",
  ".codex/goals",
  "spec/evidence",
  "spec/prototypes",
  "spec/product",
  "spec/protocol",
  "spec/security",
  "spec/integrations",
  "spec/roadmap",
  "spec/concurrency-fault-model.md",
  "spec/performance-optimization-plan.md"
];

for (const file of requiredFiles) {
  assert.ok(existsSync(resolve(root, file)), `missing required spec file: ${file}`);
}

for (const path of forbiddenPaths) {
  assert.equal(existsSync(resolve(root, path)), false, `legacy documentation path should be absent: ${path}`);
}

for (const path of ["apps", "packages", "scripts", "supabase/migrations", "package-lock.json"]) {
  assert.ok(existsSync(resolve(root, path)), `product source path must remain: ${path}`);
}

const read = (path) => readFileSync(resolve(root, path), "utf8");
const routeText = read("spec/gate/routes/v1-spec-rebuild-alignment.md");
const capHtml = read("spec/gate/capability-map.html");
const readme = read("README.md");
const index = JSON.parse(read("spec/_index.json"));
const bddFiles = ["spec/gate/bdd/spec.json", "spec/gate/bdd/docs.json", "spec/gate/bdd/bridge.json"];
const bddItems = bddFiles.flatMap((file) => JSON.parse(read(file)).items.map((item) => ({ ...item, file })));

for (const link of ["spec/README.md", "spec/gate/capability-map.html", "spec/gate/routes/v1-spec-rebuild-alignment.md", "spec/architecture/architecture.md", "spec/quality/gates.md"]) {
  assert.ok(readme.includes(link), `README missing spec link: ${link}`);
}

const capIds = [...capHtml.matchAll(/<code>(CAP-[A-Z0-9-]+)<\/code>/g)].map((match) => match[1]);
assert.ok(capIds.length >= 10, "expected at least ten capability rows");
const uniqueCapIds = new Set(capIds);
assert.equal(uniqueCapIds.size, capIds.length, "capability ids must be unique");

const routeIds = [...routeText.matchAll(/^## (ROUTE-[A-Z0-9-]+)：/gm)].map((match) => match[1]);
for (const routeId of index.versions[0].routes) {
  assert.ok(routeIds.includes(routeId), `index route missing from route file: ${routeId}`);
}

for (const item of bddItems) {
  assert.ok(item.id, `BDD item in ${item.file} missing id`);
  assert.ok(Array.isArray(item.route_ids) && item.route_ids.length, `${item.id} missing route_ids`);
  assert.ok(Array.isArray(item.capability_ids) && item.capability_ids.length, `${item.id} missing capability_ids`);
  for (const routeId of item.route_ids) {
    assert.ok(routeIds.includes(routeId), `${item.id} references unknown route ${routeId}`);
  }
  for (const capId of item.capability_ids) {
    assert.ok(uniqueCapIds.has(capId), `${item.id} references unknown capability ${capId}`);
  }
}

for (const capId of capIds) {
  assert.ok(routeText.includes(capId) || bddItems.some((item) => item.capability_ids.includes(capId)), `capability lacks route/BDD trace: ${capId}`);
}

for (const dir of ["spec/gate", "spec/architecture", "spec/design", "spec/implementation", "spec/quality", "spec/verification", "spec/goal"]) {
  assert.ok(existsSync(resolve(root, dir)), `new spec directory missing: ${dir}`);
}

mkdirSync(dirname(evidencePath), { recursive: true });
const summary = {
  ok: true,
  version,
  checked_at: new Date().toISOString(),
  required_files: requiredFiles.length,
  forbidden_paths_absent: forbiddenPaths.length,
  capability_count: capIds.length,
  route_ids: routeIds,
  bdd_count: bddItems.length,
  spec_dirs: readdirSync(resolve(root, "spec")).sort()
};
writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
