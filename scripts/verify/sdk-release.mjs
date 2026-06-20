#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("../..", import.meta.url).pathname);
const packages = [
  {
    dir: "packages/protocol",
    name: "@bridge/protocol",
    required: ["package.json", "src/index.js"],
    forbidden: ["test/", "node_modules/"],
  },
  {
    dir: "packages/sdk",
    name: "@bridge/sdk",
    required: ["package.json", "README.md", "src/index.js", "src/index.d.ts", "src/server.js", "src/server.d.ts"],
    forbidden: ["test/", "node_modules/"],
  },
  {
    dir: "packages/adapter-sdk",
    name: "@bridge/adapter-sdk",
    required: ["package.json", "src/index.js", "src/index.d.ts"],
    forbidden: ["test/", "node_modules/"],
  },
];

const results = [];
for (const pkg of packages) {
  const manifestPath = resolve(root, pkg.dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.name, pkg.name, `${pkg.dir} package name drifted`);
  assert.equal(manifest.type, "module", `${pkg.dir} must stay ESM`);
  assert.ok(Array.isArray(manifest.files) && manifest.files.includes("src"), `${pkg.dir} must publish an explicit src whitelist`);
  assertExportsExist(pkg.dir, manifest);

  const dry = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: resolve(root, pkg.dir),
    encoding: "utf8",
  });
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  const parsed = JSON.parse(dry.stdout);
  const files = (parsed[0]?.files || []).map((item) => item.path).sort();
  for (const required of pkg.required) {
    assert.ok(files.includes(required), `${pkg.name} dry-run missing ${required}`);
  }
  for (const forbidden of pkg.forbidden) {
    assert.equal(files.some((file) => file.startsWith(forbidden)), false, `${pkg.name} dry-run includes ${forbidden}`);
  }
  results.push({ package: pkg.name, files });
}

console.log(JSON.stringify({
  ok: true,
  check: "sdk-release",
  packages: results,
}, null, 2));

function assertExportsExist(dir, manifest) {
  const entries = manifest.exports && typeof manifest.exports === "object"
    ? Object.values(manifest.exports)
    : [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      assertFile(dir, entry);
    } else if (entry && typeof entry === "object") {
      for (const target of Object.values(entry)) assertFile(dir, target);
    }
  }
}

function assertFile(dir, target) {
  const clean = String(target).replace(/^\.\//, "");
  assert.ok(existsSync(resolve(root, dir, clean)), `${dir} export target missing: ${target}`);
}
