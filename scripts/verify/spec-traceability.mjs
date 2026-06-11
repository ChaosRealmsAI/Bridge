#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(".");
const currentVersionData = (await import(pathToFileURL(resolve(root, "spec/js/版本简档.js")).href)).default;
const evidenceVersion = process.env.PANDA_BRIDGE_SPEC_VERSION || currentVersionData.currentVersion?.id || "v14-security-permission-control";
const evidencePath = resolve(root, "spec/verification/evidence", evidenceVersion, "spec-traceability-summary.json");

const requiredFiles = [
  "README.md",
  "docs/product-integration.md",
  "docs/desktop-user-guide.md",
  "docs/desktop-ai-cli.md",
  "安全评审报告.md",
  "spec/README.md",
  "spec/bdd/_schema.json",
  "spec/bdd/_index.json",
  "spec/js/用户纠错.js",
  "spec/js/需求池.js",
  "spec/js/缺陷池.js",
  "spec/js/产品能力.js",
  "spec/js/版本简档.js",
  "spec/js/路线图.js",
  "spec/js/技术文档.js",
  "spec/js/资源清单.js",
  "spec/js/质量标准.js",
  "spec/js/验证环境.js",
  "spec/js/过程日志.js",
  "spec/js/变更记录.js",
  "spec/js/版本简档烟雾测试.js",
];

const auditToBddMap = {
  "BUG-AUDIT-P1-2": ["OH-001"],
  "BUG-AUDIT-P1-3": ["PC-002", "PC-003"],
  "BUG-AUDIT-P1-4": ["DA-004"],
  "BUG-AUDIT-P2-1": ["RR-002", "RR-003"],
  "BUG-AUDIT-P2-2": ["PC-004"],
  "BUG-AUDIT-P2-3": ["PC-001"],
  "BUG-AUDIT-P2-4": ["OH-002"],
  "BUG-AUDIT-P2-5": ["OH-006"],
  "BUG-AUDIT-P2-6": ["DA-001", "DA-005", "OH-003"],
  "BUG-AUDIT-P2-7": ["OH-003"],
  "BUG-AUDIT-P2-8": ["OH-004"],
  "BUG-AUDIT-P2-9": ["OH-005"],
  "BUG-AUDIT-P2-NONCE": ["DA-002"],
};

const specifiedOnlyBddModules = new Set(["bridge-state-machine"]);

const explicitOriginExceptions = {
  "apps/cloud-worker/wrangler.test.toml": [
    "https://bridge.otherline.cc",
    "https://panda.otherline.cc",
    "https://pandart.cc",
    "https://www.pandart.cc",
    "https://dev.otherline.cc",
    "https://spec.otherline.cc",
    "https://otherline.cc",
  ],
};

const legacyFactSources = [
  "spec/_index.json",
  "spec/gate",
  "spec/goal",
  "spec/implementation",
  "spec/architecture",
  "spec/quality",
  "spec/design",
  "spec/devlog.md",
  "spec/changelog.md",
  "spec/principles.md",
];

const exists = (file) => existsSync(resolve(root, file));
const readJson = (file) => JSON.parse(readFileSync(resolve(root, file), "utf8"));
const importJs = async (file) => (await import(pathToFileURL(resolve(root, file)).href)).default;

for (const file of requiredFiles) {
  assert.ok(exists(file), `missing required spec file: ${file}`);
}

for (const file of legacyFactSources) {
  assert.equal(exists(file), false, `legacy spec fact source must stay deleted: ${file}`);
}

for (const dir of ["apps", "packages", "scripts", "supabase/migrations"]) {
  assert.ok(exists(dir), `product source path must remain: ${dir}`);
}

const bddIndex = readJson("spec/bdd/_index.json");
assert.ok(Array.isArray(bddIndex.modules) && bddIndex.modules.length >= 4, "BDD index must list security modules");

const bddFiles = readdirSync(resolve(root, "spec/bdd"))
  .filter((file) => file.endsWith(".json") && !file.startsWith("_"))
  .map((file) => `spec/bdd/${file}`)
  .sort();

assert.deepEqual(
  bddIndex.modules.map((item) => `spec/bdd/${item.file}`).sort(),
  bddFiles,
  "BDD index must exactly match module files",
);

const bddDocs = bddFiles.map((file) => ({ file, doc: readJson(file) }));
const scenarioIds = [];
const scenariosById = new Map();
const capRefs = new Set();
for (const { file, doc } of bddDocs) {
  const specifiedOnly = specifiedOnlyBddModules.has(doc.module);
  for (const key of ["id", "module", "userStory", "scenarios", "implementationStatus", "verificationStatus", "guardStatus"]) {
    assert.ok(doc[key] !== undefined, `${file} missing ${key}`);
  }
  if (specifiedOnly) {
    assert.ok(["todo", "in_progress", "done"].includes(doc.implementationStatus), `${file} implementationStatus must be schema-valid`);
    assert.ok(["todo", "partial", "verified"].includes(doc.verificationStatus), `${file} verificationStatus must be schema-valid`);
  } else {
    assert.equal(doc.implementationStatus, "done", `${file} implementationStatus must be done`);
    assert.equal(doc.verificationStatus, "verified", `${file} verificationStatus must be verified`);
  }
  assert.equal(doc.guardStatus, "guarded", `${file} guardStatus must be guarded`);
  assert.ok(Array.isArray(doc.scenarios) && doc.scenarios.length > 0, `${file} must include scenarios`);
  for (const capRef of doc.capabilityRefs || []) capRefs.add(capRef);
  for (const scenario of doc.scenarios) {
    for (const key of ["id", "kind", "title", "given", "when", "then", "status"]) {
      assert.ok(scenario[key] !== undefined, `${file} scenario missing ${key}`);
    }
    assert.ok(Array.isArray(scenario.guards) && scenario.guards.length > 0, `${scenario.id} must include concrete guards`);
    if (specifiedOnly) {
      assert.ok(["todo", "implemented", "verified"].includes(scenario.status), `${scenario.id} status must be schema-valid`);
    } else {
      assert.equal(scenario.status, "verified", `${scenario.id} status must be verified`);
    }
    scenarioIds.push(scenario.id);
    scenariosById.set(scenario.id, scenario);
  }
}
assert.equal(new Set(scenarioIds).size, scenarioIds.length, "BDD scenario ids must be unique");

const capabilities = await importJs("spec/js/产品能力.js");
const capIds = new Set(capabilities.modules.flatMap((module) => module.capabilities.map((cap) => cap.id)));
for (const cap of capabilities.modules.flatMap((module) => module.capabilities)) {
  if (cap.versions?.includes(evidenceVersion)) assert.equal(cap.status, "done", `${cap.id} status must be done`);
}
for (const capRef of capRefs) {
  assert.ok(capIds.has(capRef), `BDD references unknown capability: ${capRef}`);
}

const bugPool = await importJs("spec/js/缺陷池.js");
const bugIds = bugPool.bugs.map((bug) => bug.id);
assert.ok(bugIds.includes("BUG-AUDIT-P1-3"), "audit P1-3 must remain tracked");
assert.ok(bugIds.includes("BUG-AUDIT-P2-NONCE"), "nonce residual must remain tracked");
assert.equal(new Set(bugIds).size, bugIds.length, "bug ids must be unique");
const bugsById = new Map(bugPool.bugs.map((bug) => [bug.id, bug]));
for (const bug of bugPool.bugs) {
  assert.ok(Array.isArray(bug.bddRefs) && bug.bddRefs.length, `${bug.id} missing bddRefs`);
  assert.equal(bug.status, "closed", `${bug.id} status must be closed`);
  for (const ref of bug.bddRefs) assert.ok(scenarioIds.includes(ref), `${bug.id} references unknown BDD scenario ${ref}`);
}
for (const [bugId, expectedRefs] of Object.entries(auditToBddMap)) {
  const bug = bugsById.get(bugId);
  assert.ok(bug, `explicit audit map missing bug ${bugId}`);
  assert.deepEqual([...bug.bddRefs].sort(), [...expectedRefs].sort(), `${bugId} must map to exact BDD refs`);
  for (const ref of expectedRefs) {
    assert.ok(scenariosById.get(ref)?.guards?.length > 0, `${bugId} scenario ${ref} missing guard`);
  }
}

const version = await importJs("spec/js/版本简档.js");
assert.equal(version.currentVersion?.status, "done", "current version status must be done");
const roadmap = await importJs("spec/js/路线图.js");
const currentMilestone = roadmap.milestones?.find((item) => item.id === evidenceVersion);
assert.ok(currentMilestone, `roadmap missing milestone ${evidenceVersion}`);
assert.equal(currentMilestone.status, "done", `roadmap milestone ${evidenceVersion} status must be done`);
const plan = version.currentVersion?.implementationPlan;
assert.equal(plan?.planSkill, "codex-plan-mode-prompt", "implementationPlan.planSkill mismatch");
assert.ok(Array.isArray(plan.tasks) && plan.tasks.length >= 10, "implementationPlan.tasks must be populated");
for (const task of plan.tasks) {
  for (const key of ["id", "title", "checked", "status", "executor", "goalMd", "evidenceMd"]) {
    assert.ok(task[key] !== undefined, `task ${task.id || "unknown"} missing ${key}`);
  }
  assert.ok(["主 agent", "codexctl"].includes(task.executor), `task ${task.id} invalid executor`);
  if (task.executor === "codexctl") assert.ok(task.executorCommand, `task ${task.id} missing executorCommand`);
  assert.equal(task.checked, true, `task ${task.id} must be checked`);
  assert.equal(task.status, "done", `task ${task.id} status must be done`);
}
assert.equal(version.currentVersion?.evidenceReport?.status, "complete", "evidenceReport.status must be complete");
assert.ok(
  Array.isArray(version.currentVersion?.evidenceReport?.artifacts) && version.currentVersion.evidenceReport.artifacts.length >= 8,
  "evidenceReport.artifacts must list concrete evidence",
);
assert.ok(exists(`spec/verification/evidence/${evidenceVersion}/summary.json`), `${evidenceVersion} evidence summary missing`);

assert.equal(version.currentVersion?.foundationSwitches?.capDirection, 1, "CAP switch must be 1");
assert.equal(version.currentVersion?.foundationSwitches?.trueRunSee, 1, "true-run-see switch must be 1");
assert.equal(version.currentVersion?.foundationSwitches?.adversarialPosture, 1, "adversarial switch must be 1");

const auditText = readFileSync(resolve(root, "安全评审报告.md"), "utf8");
for (const marker of ["P1-2", "P1-3", "P1-4", "P2-1", "P2-2", "P2-3", "P2-4", "P2-5", "P2-6", "P2-7", "P2-8", "P2-9"]) {
  assert.ok(auditText.includes(marker), `audit report missing marker ${marker}`);
}

const sdkSource = readFileSync(resolve(root, "packages/sdk/src/index.js"), "utf8");
const sdkPublicCopy = readFileSync(resolve(root, "apps/web-chat/public/sdk/index.js"), "utf8");
assert.equal(sdkPublicCopy, sdkSource, "public web SDK copy drifted from packages/sdk/src/index.js");

if (evidenceVersion === "v15-productized-onboarding") {
  const packageJson = readJson("package.json");
  assert.equal(packageJson.scripts?.["verify:productized-onboarding"], "node scripts/verify/productized-onboarding.mjs", "missing productized onboarding script");
  assert.equal(packageJson.scripts?.["verify:desktop-ai-cli"], "node scripts/verify/desktop-ai-cli-control.mjs", "missing Desktop AI CLI script");
  const productDoc = readFileSync(resolve(root, "docs/product-integration.md"), "utf8");
  const userDoc = readFileSync(resolve(root, "docs/desktop-user-guide.md"), "utf8");
  const cliDoc = readFileSync(resolve(root, "docs/desktop-ai-cli.md"), "utf8");
  const sdkReadme = readFileSync(resolve(root, "packages/sdk/README.md"), "utf8");
  for (const marker of ["connect.createIntent", "preflight", "product_not_authorized", "desktop_claim_required"]) {
    assert.ok(productDoc.includes(marker), `product integration doc missing ${marker}`);
  }
  for (const marker of ["headless-status", "headless-connect", "headless-poll", "headless-revoke-authorization"]) {
    assert.ok(cliDoc.includes(marker), `Desktop AI CLI doc missing ${marker}`);
  }
  for (const marker of ["PANDA_BRIDGE_VERIFY", "open_deep_link", "click_allow_intent", "click_revoke_authorization", "GET /v1/screenshot"]) {
    assert.ok(cliDoc.includes(marker), `Desktop AI CLI doc missing installed-app control marker ${marker}`);
  }
  for (const marker of ["builtin_app_png", "desktop_builtin_renderer", "npm run verify:desktop-ai-cli"]) {
    assert.ok(cliDoc.includes(marker), `Desktop AI CLI doc missing built-in screenshot marker ${marker}`);
  }
  assert.ok(cliDoc.includes("PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT=1"), "CLI doc must mention explicit headless connect flag");
  assert.ok(userDoc.includes("Local Authorization Record"), "Desktop user guide must explain local authorization record");
  assert.ok(sdkReadme.includes("scope_insufficient"), "SDK README must document capability enforcement");
  assert.ok(sdkReadme.includes("desktop_claim_required"), "SDK README must document browser claim rejection");
  assert.ok(exists("spec/verification/evidence/v15-productized-onboarding/productized-onboarding.json"), "v15 productized onboarding evidence missing");
  assert.ok(exists("scripts/verify/desktop-ai-cli-control.mjs"), "Desktop AI CLI verification script missing");
}

const migrationTexts = readdirSync(resolve(root, "supabase/migrations"))
  .filter((file) => file.endsWith(".sql"))
  .map((file) => readFileSync(resolve(root, "supabase/migrations", file), "utf8").toLowerCase())
  .join("\n");
const createTableMatches = [...migrationTexts.matchAll(/create\s+table\s+if\s+not\s+exists\s+public\.(bridge_[a-z0-9_]+)/g)];
const rlsMatches = [...migrationTexts.matchAll(/alter\s+table\s+if\s+exists\s+public\.(bridge_[a-z0-9_]+)\s+enable\s+row\s+level\s+security/g)];
const createdTables = [...new Set(createTableMatches.map((match) => match[1]))].sort();
const rlsTables = new Set(rlsMatches.map((match) => match[1]));
assert.ok(createdTables.length >= 10, "RLS check did not find bridge table migrations");
for (const table of createdTables) {
  assert.ok(rlsTables.has(table), `missing enable row level security for public.${table}`);
}

const { officialProductOrigins } = await import(pathToFileURL(resolve(root, "apps/cloud-worker/src/products.js")).href);
const officialOrigins = officialProductOrigins().sort();
for (const wranglerFile of ["apps/cloud-worker/wrangler.toml", "apps/cloud-worker/wrangler.test.toml"]) {
  const text = readFileSync(resolve(root, wranglerFile), "utf8");
  const match = text.match(/BRIDGE_ALLOWED_ORIGINS\s*=\s*"([^"]*)"/);
  assert.ok(match, `${wranglerFile} missing BRIDGE_ALLOWED_ORIGINS`);
  const allowed = new Set(match[1].split(/\s+/).filter(Boolean));
  const exceptions = new Set(explicitOriginExceptions[wranglerFile] || []);
  for (const origin of officialOrigins) {
    assert.ok(allowed.has(origin) || exceptions.has(origin), `${wranglerFile} missing official origin ${origin}`);
  }
}

mkdirSync(dirname(evidencePath), { recursive: true });
const summary = {
  ok: true,
  evidence_version: evidenceVersion,
  checked_at: new Date().toISOString(),
  bdd_files: bddFiles,
  bdd_scenarios: scenarioIds.length,
  capabilities: capIds.size,
  audit_bugs: bugIds.length,
  explicit_audit_map: Object.keys(auditToBddMap).length,
  tasks: plan.tasks.length,
  legacy_fact_sources_absent: legacyFactSources.length,
  rls_tables: createdTables.length,
  official_origins: officialOrigins.length,
  sdk_copy_drift: false,
  productized_docs: evidenceVersion === "v15-productized-onboarding",
};
writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
