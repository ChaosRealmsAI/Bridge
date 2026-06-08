#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(".");
const evidenceVersion = process.env.PANDA_BRIDGE_SPEC_VERSION || "current";
const evidencePath = resolve(root, "spec/verification/evidence", evidenceVersion, "spec-traceability-summary.json");

const coreFiles = [
  "README.md",
  "spec/README.md",
  "spec/_index.json",
  "spec/principles.md",
  "spec/changelog.md",
  "spec/devlog.md",
  "spec/gate/capability-map.html",
  "spec/gate/bdd/_index.json",
  "spec/architecture/architecture.md",
  "spec/design/ux.md",
  "spec/quality/gates.md",
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
  "spec/performance-optimization-plan.md",
];

const read = (path) => readFileSync(resolve(root, path), "utf8");
const exists = (path) => existsSync(resolve(root, path));

for (const file of coreFiles) {
  assert.ok(exists(file), `missing required spec file: ${file}`);
}

for (const path of forbiddenPaths) {
  assert.equal(exists(path), false, `legacy documentation path should be absent: ${path}`);
}

for (const path of ["apps", "packages", "scripts", "supabase/migrations", "package-lock.json"]) {
  assert.ok(exists(path), `product source path must remain: ${path}`);
}

for (const dir of ["spec/gate", "spec/architecture", "spec/design", "spec/implementation", "spec/quality", "spec/verification", "spec/goal"]) {
  assert.ok(exists(dir), `new spec directory missing: ${dir}`);
}

const readme = read("README.md");
for (const link of ["spec/README.md", "spec/gate/capability-map.html", "spec/architecture/architecture.md", "spec/quality/gates.md"]) {
  assert.ok(readme.includes(link), `README missing spec link: ${link}`);
}

const index = JSON.parse(read("spec/_index.json"));
const versions = Array.isArray(index.versions) ? index.versions : [];
assert.ok(versions.length > 0, "spec index must list at least one version");

const indexedFiles = new Set();
for (const version of versions) {
  if (version.goal_file) indexedFiles.add(version.goal_file);
  if (version.roadmap) indexedFiles.add(version.roadmap);
  if (version.verification) indexedFiles.add(version.verification);
  for (const file of version.bdd_files || []) indexedFiles.add(file);
}

for (const file of indexedFiles) {
  assert.ok(exists(file), `indexed spec file missing: ${file}`);
}

const routeFiles = readdirSync(resolve(root, "spec/gate/routes"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => `spec/gate/routes/${file}`)
  .sort();
assert.ok(routeFiles.length > 0, "expected at least one route file");
const routeText = routeFiles.map((file) => read(file)).join("\n\n");
const routeIds = [...routeText.matchAll(/^## (ROUTE-[A-Z0-9-]+)：/gm)].map((match) => match[1]);
const uniqueRouteIds = new Set(routeIds);
assert.equal(uniqueRouteIds.size, routeIds.length, "route ids must be unique");

const capHtml = read("spec/gate/capability-map.html");
const capIds = [...capHtml.matchAll(/<code>(CAP-[A-Z0-9-]+)<\/code>/g)].map((match) => match[1]);
assert.ok(capIds.length >= 10, "expected at least ten capability rows");
const uniqueCapIds = new Set(capIds);
assert.equal(uniqueCapIds.size, capIds.length, "capability ids must be unique");

const bddFiles = readdirSync(resolve(root, "spec/gate/bdd"))
  .filter((file) => file.endsWith(".json") && file !== "_index.json")
  .map((file) => `spec/gate/bdd/${file}`)
  .sort();
const bddItems = bddFiles.flatMap((file) => JSON.parse(read(file)).items.map((item) => ({ ...item, file })));
const uniqueBddIds = new Set(bddItems.map((item) => item.id));
assert.equal(uniqueBddIds.size, bddItems.length, "BDD ids must be unique");

for (const version of versions) {
  assert.ok(version.version, "index version missing version slug");
  assert.ok(Array.isArray(version.routes) && version.routes.length, `${version.version} missing routes`);
  for (const routeId of version.routes) {
    assert.ok(uniqueRouteIds.has(routeId), `${version.version} references unknown route ${routeId}`);
  }
  for (const capId of version.capability_ids || []) {
    assert.ok(uniqueCapIds.has(capId), `${version.version} references unknown capability ${capId}`);
  }
}

for (const item of bddItems) {
  assert.ok(item.id, `BDD item in ${item.file} missing id`);
  assert.ok(Array.isArray(item.route_ids) && item.route_ids.length, `${item.id} missing route_ids`);
  assert.ok(Array.isArray(item.capability_ids) && item.capability_ids.length, `${item.id} missing capability_ids`);
  for (const routeId of item.route_ids) {
    assert.ok(uniqueRouteIds.has(routeId), `${item.id} references unknown route ${routeId}`);
  }
  for (const capId of item.capability_ids) {
    assert.ok(uniqueCapIds.has(capId), `${item.id} references unknown capability ${capId}`);
  }
}

for (const capId of capIds) {
  assert.ok(routeText.includes(capId) || bddItems.some((item) => item.capability_ids.includes(capId)), `capability lacks route/BDD trace: ${capId}`);
}

const bddIndex = JSON.parse(read("spec/gate/bdd/_index.json"));
for (const module of bddIndex.modules || []) {
  const file = `spec/gate/bdd/${module.file}`;
  assert.ok(bddFiles.includes(file), `BDD index references unknown file: ${file}`);
  const count = JSON.parse(read(file)).items.length;
  assert.equal(count, module.count, `BDD index count mismatch for ${file}`);
}

mkdirSync(dirname(evidencePath), { recursive: true });
const summary = {
  ok: true,
  evidence_version: evidenceVersion,
  checked_at: new Date().toISOString(),
  indexed_versions: versions.map((item) => item.version),
  indexed_files: indexedFiles.size,
  forbidden_paths_absent: forbiddenPaths.length,
  capability_count: capIds.length,
  route_count: routeIds.length,
  route_ids: routeIds,
  bdd_files: bddFiles,
  bdd_count: bddItems.length,
  spec_dirs: readdirSync(resolve(root, "spec")).sort(),
};
writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
