#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);

const requiredFiles = [
  "apps/cloud-worker/src/router.js",
  "apps/cloud-worker/src/legacy-runtime.js",
  "apps/connector-cli/src/cli.mjs",
  "apps/web-chat/public/main.js",
  "examples/sdk-call-examples/run-local.mjs",
  "examples/minimal-caller/run-local.mjs",
];
for (const file of requiredFiles) assertFile(file);

const workerIndex = read("apps/cloud-worker/src/index.js");
assert.ok(workerIndex.includes("./router.js"), "Worker index must use router module");
assert.ok(workerIndex.includes("./legacy-runtime.js"), "Worker index must use legacy runtime module");
assert.ok(workerIndex.includes("isLegacyRuntimeRoute(request.method, path)"), "Worker index must delegate legacy route matching");
assert.ok(workerIndex.includes("legacyRuntimeApiRemovedPayload()"), "Worker index must delegate legacy response payload");
for (const inline of [
  'path === "/v1/queue/summary"',
  'path === "/v1/connectors/jobs"',
  "delegatedProductJobMatch",
  "connectorEventMatch",
  "acceptMatch",
  "ackMatch",
]) {
  assert.equal(workerIndex.includes(inline), false, `Worker index must not keep inline legacy route matcher: ${inline}`);
}
assert.ok(lineCount("apps/cloud-worker/src/index.js") <= 4300, "Worker index must not grow beyond the v0-8 module boundary budget");
assertNoCoreProductPolicyDrift("apps/cloud-worker/src/index.js", workerIndex);

const legacyRuntime = read("apps/cloud-worker/src/legacy-runtime.js");
assert.ok(legacyRuntime.includes("isLegacyRuntimeRoute"), "legacy-runtime module must expose route predicate");
assert.ok(legacyRuntime.includes("legacy_runtime_api_removed"), "legacy-runtime module must own legacy 410 payload");

assertAllowedExampleDirs();

const packageJson = JSON.parse(read("package.json"));
assertNoPackageScriptDrift(packageJson.scripts || {});

const activeFiles = [
  "apps/connector-cli/src/cli.mjs",
  "apps/web-chat/public/main.js",
  "apps/web-chat/public/index.html",
  ...walk("examples").filter((file) => !file.includes("/relay-local-control/")),
  ...activePackageScriptTargets().filter((file) => !file.includes("/relay-local-control/")),
];
for (const file of activeFiles) assertNoActiveLegacySurface(file, read(file));
for (const file of [
  "packages/sdk/src/index.js",
  "packages/sdk/src/index.d.ts",
  "apps/web-chat/public/sdk/index.js",
  "apps/desktop/src/main.rs",
  "apps/desktop/ui/index.html",
  "apps/cloud-worker/src/products.js",
]) {
  assertNoCoreProductPolicyDrift(file, read(file));
}
for (const file of walk("examples/relay-local-control")) assertRelayLocalControlOnlyUsesLegacyAsNegativeProbe(file, read(file));
for (const file of activeDocFiles()) assertNoDocRuntimeDrift(file, read(file));

assert.equal(exists("examples/bridge-notes"), false, "legacy bridge-notes example must not remain under active examples/");
assert.ok(packageJson.scripts["check:sdk-types"], "package.json missing check:sdk-types");
assert.ok(packageJson.scripts["check:sdk-release"], "package.json missing check:sdk-release");
assert.ok(packageJson.scripts["check:bridge-architecture"], "package.json missing check:bridge-architecture");
assert.equal(Boolean(packageJson.scripts["verify:bridge-notes"]), false, "legacy bridge-notes verify script must not remain active");

console.log(JSON.stringify({
  ok: true,
  check: "bridge-architecture",
  active_files: activeFiles,
  worker_index_lines: lineCount("apps/cloud-worker/src/index.js"),
}));

function assertNoActiveLegacySurface(file, text) {
  const staleMarkers = [
    "/v1/connectors/jobs",
    "run-fixture",
    "fake-codex",
    "codex.",
    "claude.",
    "syllo.run",
    "syllo.chat",
    "bridge.jobs",
    "client.jobs",
    ".jobs.",
    "jobs.create",
    "jobs.wait",
    "jobs.stream",
    "queue.summary",
    "data.put",
    "data.get",
    "data.query",
    "fs.read",
    "fs.write",
    "shell.run",
    "local Codex",
    "PANDA_BRIDGE_FAKE_CODEX",
    "本机 Codex",
    "Panda Bridge fixture reply",
    "jobs: {}",
    "codex: {}",
    "verify:browser",
    "verify:mobile-browser",
    "pandart:local",
    "PANDART_DOMAIN",
    "pandart.cc",
    "scripts/pandart-local-chat.mjs",
  ];
  for (const marker of staleMarkers) {
    assert.equal(text.includes(marker), false, `${file} contains active legacy marker: ${marker}`);
  }
  if (text.includes("headless-poll")) {
    for (const marker of ["PANDA_BRIDGE_FAKE_CODEX", "本机 Codex", "Panda Bridge fixture reply", "jobs: {}", "codex: {}"]) {
      assert.equal(text.includes(marker), false, `${file} combines headless-poll with old runtime marker: ${marker}`);
    }
  }
}

function assertNoCoreProductPolicyDrift(file, text) {
  const scanText = file === "apps/desktop/src/main.rs" ? text.split("\n#[cfg(test)]")[0] : text;
  const forbidden = [
    "BRIDGE_OTHERLINE_DELEGATION_SECRET",
    'productId === "otherline"',
    'product.id === "panda-syllo"',
    'product?.id !== "panda-syllo"',
    "syllo-relay-key-bootstrap-v1",
    "bridgeFullAccessAuthorizationPolicy",
    "authorizationScopeAllows",
    "policy_with_local_root_bindings",
    "apply_local_root_bindings_to_roots",
    "bridge_cap_token_jti",
    "issueCapToken",
    "verifyCapTokenJws",
    "captoken.rs",
  ];
  for (const marker of forbidden) {
    assert.equal(scanText.includes(marker), false, `${file} contains core/product policy drift: ${marker}`);
  }
  if (!file.endsWith("apps/cloud-worker/src/index.js")) {
    for (const marker of [
      "workspace_roots",
      "sandbox_floor",
      "approval_policy_floor",
      "allow_developer_instructions",
      "allow_approval_never",
      "permission_preset",
    ]) {
      assert.equal(scanText.includes(marker), false, `${file} contains product-local authorization field: ${marker}`);
    }
  }
}

function assertRelayLocalControlOnlyUsesLegacyAsNegativeProbe(file, text) {
  const hasLegacyProbe = text.includes("/v1/products/panda-chat/jobs") || text.includes("shell.run");
  if (!hasLegacyProbe) return;
  assert.ok(
    text.includes("legacyJobs") || text.includes("legacy_jobs") || text.includes("legacy_runtime_api_removed"),
    `${file} may only mention legacy runtime as an explicit 410 regression probe`,
  );
}

function assertNoDocRuntimeDrift(file, text) {
  const forbidden = [
    "AI runtime",
    "local Agent",
    "before executing jobs",
    "allow jobs",
    "`codex.chat`",
    "`codex.run`",
    "`codex.rpc`",
    "codex login",
    "Codex is missing",
    "bridge_jobs",
    "bridge_job_events",
    "verify:cloud",
    "verify:browser",
    "verify:mobile-browser",
    "pandart:local",
    "browser-smoke",
    "mobile-browser-smoke",
    "PANDA_BRIDGE_FAKE_CODEX",
    "本机 Codex",
  ];
  for (const marker of forbidden) {
    assert.equal(text.includes(marker), false, `${file} contains active doc runtime drift: ${marker}`);
  }
}

function assertNoPackageScriptDrift(scripts) {
  for (const scriptName of ["verify:browser", "verify:mobile-browser", "pandart:local"]) {
    assert.equal(Boolean(scripts[scriptName]), false, `package.json must not expose active old/product script: ${scriptName}`);
  }
  for (const [name, script] of Object.entries(scripts)) {
    for (const marker of [
      "browser-smoke.mjs",
      "mobile-browser-smoke.mjs",
      "pandart-local-chat.mjs",
      "PANDA_BRIDGE_FAKE_CODEX",
      "pandart.cc",
      "PANDART_DOMAIN",
    ]) {
      assert.equal(String(script).includes(marker), false, `package script ${name} contains stale/product marker: ${marker}`);
    }
  }
}

function activeDocFiles() {
  return [
    "README.md",
    "docs/desktop-user-guide.md",
    "docs/sdk-calling-guide.md",
    "docs/product-integration.md",
    "packages/sdk/README.md",
    "examples/sdk-call-examples/README.md",
    "examples/minimal-caller/README.md",
  ].filter(exists);
}

function activePackageScriptTargets() {
  const scripts = Object.entries(JSON.parse(read("package.json")).scripts || {});
  const targets = new Set();
  for (const [name, script] of scripts) {
    if (name.startsWith("check:")) continue;
    if (name.startsWith("desktop:")) continue;
    if (name.startsWith("cloud:")) continue;
    if (name === "build:web" || name === "web:serve") continue;
    const match = String(script).match(/\bnode\s+([^\s&|;]+)/);
    if (!match) continue;
    const target = match[1];
    if (guardVerifierTargets().has(target)) continue;
    if (target.startsWith("scripts/") || target.startsWith("examples/") || target.startsWith("apps/")) {
      if (exists(target)) targets.add(target);
    }
  }
  return [...targets].sort();
}

function guardVerifierTargets() {
  return new Set([
    "scripts/verify/bridge-architecture.mjs",
    "scripts/verify/open-source-hygiene.mjs",
    "scripts/verify/sdk-docs.mjs",
    "scripts/verify/sdk-types.mjs",
    "scripts/verify/relay-boundary.mjs",
  ]);
}

function assertAllowedExampleDirs() {
  const allowed = new Set(["minimal-caller", "relay-local-control", "sdk-call-examples"]);
  for (const name of readdirSync(resolve(root, "examples"))) {
    const full = resolve(root, "examples", name);
    if (!statSync(full).isDirectory()) continue;
    assert.ok(allowed.has(name), `unexpected active example directory: examples/${name}`);
  }
}

function walk(relDir) {
  const base = resolve(root, relDir);
  const out = [];
  for (const name of readdirSync(base)) {
    const full = resolve(base, name);
    const rel = relative(root, full);
    if (statSync(full).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

function lineCount(file) {
  return read(file).split("\n").length;
}

function read(file) {
  return readFileSync(resolve(root, file), "utf8");
}

function exists(file) {
  try {
    statSync(resolve(root, file));
    return true;
  } catch {
    return false;
  }
}

function assertFile(file) {
  assert.ok(exists(file), `missing ${file}`);
}
