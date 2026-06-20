#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const forbiddenTrackedPrefixes = [
  ".pandacode/",
  "scripts/cloud/",
];

const forbiddenTrackedFiles = new Set([
  "apps/cloud-worker/wrangler.toml",
  "apps/cloud-worker/wrangler.test.toml",
  "docs/operations.md",
  "安全评审报告.md",
  "apple-account.png",
  "apple-dev-account.png",
  "apple-enroll.png",
  "gp-signup-step.png",
]);

const forbiddenTrackedGeneratedSegments = new Set([
  ".build",
  ".cache",
  ".dart_tool",
  ".gradle",
  ".next",
  ".parcel-cache",
  ".rollup.cache",
  ".svelte-kit",
  ".tauri",
  ".turbo",
  ".vite",
  "DerivedData",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const forbiddenTrackedReleaseBinary = /\.(?:7z|aab|apk|appimage|dmg|exe|ipa|msi|pkg|rar|tar|tgz|txz|whl|xip|zip)$/i;
const packArchiveGeneratedSegments = new Set([
  ...forbiddenTrackedGeneratedSegments,
  ".claude",
  ".codex",
  ".pandacode",
  ".burn",
  ".bridge",
  ".panda-bridge",
  ".wrangler",
  ".tmp",
  "logs",
]);
const allowedWranglerExamples = new Set([
  "wrangler.example.toml",
  "wrangler.selfhost.example.toml",
]);

const privateSupabaseRefs = [
  "jfoiiqg" + "frdosiwmkkfsf",
  "neijljzt" + "ljnntjuzavei",
];
const privateCloudflareAccountId = "ca4503ffc9541" + "fa4af1b99132462c897";

const forbiddenContent = [
  { label: "local user path", pattern: /\/Users\/Zhuanz\b/ },
  { label: "pandacode runtime", pattern: /\.pandacode\b|PandaCode session|pandacode-result/ },
  { label: "private bridge test domain", pattern: /\b(?:api-bridge-test|bridge-test|assets-bridge-test|app-test|burn-test)\.otherline\.cc\b/ },
  { label: "private supabase project ref", pattern: new RegExp(`\\b(?:${privateSupabaseRefs.join("|")})\\b`) },
  { label: "private supabase keychain handle", pattern: /\botherline\.cloud\.supabase\.[A-Za-z0-9_.-]+\b/ },
  { label: "cloudflare account id", pattern: new RegExp(`\\b${privateCloudflareAccountId}\\b`) },
];

const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
const existingTracked = tracked.filter((file) => existsSync(file));
const existingUntrackedScanned = untracked.filter((file) => existsSync(file) && shouldScanUntracked(file));
const contentScanFiles = [...existingTracked, ...existingUntrackedScanned];
const contentScanSkip = new Set([".gitignore", "scripts/verify/open-source-hygiene.mjs"]);
for (const file of existingTracked) {
  if (file.startsWith("spec/")) {
    assert.ok(
      isAllowedTrackedSpecFile(file),
      `private spec path is tracked outside public reference-doc whitelist: ${file}`,
    );
  }
  assert.equal(
    forbiddenTrackedPrefixes.some((prefix) => file.startsWith(prefix)),
    false,
    `private path is tracked: ${file}`,
  );
  assert.equal(forbiddenTrackedFiles.has(file), false, `private file is tracked: ${file}`);
  assert.equal(
    trackedGeneratedSegment(file),
    "",
    `generated/cache/build directory is tracked: ${file}`,
  );
  assert.equal(
    forbiddenTrackedReleaseBinary.test(file),
    false,
    `release archive/binary is tracked: ${file}`,
  );
}

const hits = [];
for (const file of contentScanFiles) {
  if (contentScanSkip.has(file)) continue;
  const text = readTextIfLikelyText(file);
  if (text == null) continue;
  for (const rule of forbiddenContent) {
    if (contentRuleAllowed(file, rule)) continue;
    if (rule.pattern.test(text)) hits.push({ file, rule: rule.label });
  }
}

assert.deepEqual(hits, [], `open-source hygiene failed:\n${hits.map((hit) => `${hit.file}: ${hit.rule}`).join("\n")}`);

const packageSurfaceHits = [
  ...npmPackSurfaceHits(),
  ...gitArchiveSurfaceHits(),
];
assert.deepEqual(
  packageSurfaceHits,
  [],
  `package/archive hygiene failed:\n${packageSurfaceHits.map(formatSurfaceHit).join("\n")}`,
);

console.log(JSON.stringify({
  ok: true,
  check: "open-source-hygiene",
  tracked_files: tracked.length,
  untracked_scanned_files: existingUntrackedScanned.length,
  package_archive_surface_guard: "passed",
  release_archive_binary_guard: "passed",
  generated_cache_build_dir_guard: "passed",
}, null, 2));

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function npm(args) {
  const result = spawnSync("npm", args, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function readTextIfLikelyText(file) {
  const buf = readFileSync(file);
  if (buf.includes(0)) return null;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32 && byte <= 126) continue;
    if (byte >= 0xc2) continue;
    suspicious += 1;
  }
  if (sample.length > 0 && suspicious / sample.length > 0.1) return null;
  return buf.toString("utf8");
}

function trackedGeneratedSegment(file) {
  return file.split("/").find((segment) => forbiddenTrackedGeneratedSegments.has(segment)) || "";
}

function shouldScanUntracked(file) {
  if (isAllowedTrackedSpecFile(file)) return true;
  if (file.startsWith("spec/")) return false;
  if (file.startsWith(".pandacode/")) return false;
  if (file.startsWith(".git/")) return false;
  if (trackedGeneratedSegment(file)) return false;
  if (forbiddenTrackedReleaseBinary.test(file)) return false;
  if (/^Dockerfile(?:\..*)?$/.test(file.split("/").pop() || "")) return true;
  return /\.(?:cjs|css|dart|html|js|json|jsx|md|mjs|rs|sh|sql|toml|ts|tsx|txt|yaml|yml)$/.test(file);
}

function contentRuleAllowed(file, rule) {
  return rule.label === "pandacode runtime"
    && file.startsWith("adapters/panda-burn/local-tools/backend/");
}

function isAllowedTrackedSpecFile(file) {
  return false;
}

function npmPackSurfaceHits() {
  const surfaces = [
    {
      label: "root npm pack",
      packageDir: "",
      args: ["pack", "--dry-run", "--json"],
    },
    ...workspacePackages().map((workspace) => ({
      label: `npm pack ${workspace.name}`,
      packageDir: workspace.dir,
      args: ["--workspace", workspace.name, "pack", "--dry-run", "--json"],
    })),
  ];
  return surfaces.flatMap((surface) => {
    const packages = JSON.parse(npm(surface.args));
    return packages.flatMap((pkg) => {
      return pkg.files.flatMap((entry) => {
        const packagePath = normalizePath(entry.path);
        const repoPath = surface.packageDir
          ? normalizePath(`${surface.packageDir}/${packagePath}`)
          : packagePath;
        return privateSurfaceHits(repoPath, {
          source: surface.label,
          packagePath,
        });
      });
    });
  });
}

function gitArchiveSurfaceHits() {
  const archive = spawnSync("git", ["archive", "--format=tar", "HEAD"], {
    maxBuffer: 100 * 1024 * 1024,
  });
  assert.equal(archive.status, 0, archive.stderr?.toString("utf8") || archive.stdout?.toString("utf8"));
  const listing = spawnSync("tar", ["-tf", "-"], {
    input: archive.stdout,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  assert.equal(listing.status, 0, listing.stderr || listing.stdout);
  return listing.stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((entry) => privateSurfaceHits(entry, { source: "git archive HEAD" }));
}

function privateSurfaceHits(file, context) {
  const normalized = normalizePath(file);
  const segments = normalized.split("/");
  const basename = segments.at(-1) || "";
  const hits = [];
  const generatedSegment = segments.find((segment) => packArchiveGeneratedSegments.has(segment));
  if (generatedSegment) hits.push(surfaceHit(context, normalized, `private/generated segment ${generatedSegment}`));
  if (segments[0] === "spec") hits.push(surfaceHit(context, normalized, "private spec path"));
  if (normalized.startsWith("scripts/cloud/")) hits.push(surfaceHit(context, normalized, "private scripts/cloud"));
  if (/^\.env(?:\.|$)/.test(basename)) hits.push(surfaceHit(context, normalized, "private env file"));
  if (/^wrangler(?:\.[^.]+)?\.toml$/.test(basename) && !allowedWranglerExamples.has(basename)) {
    hits.push(surfaceHit(context, normalized, "real wrangler config"));
  }
  if (basename === ".DS_Store") hits.push(surfaceHit(context, normalized, "generated desktop artifact"));
  if (basename.endsWith(".log")) hits.push(surfaceHit(context, normalized, "log file"));
  if (forbiddenTrackedReleaseBinary.test(basename)) {
    hits.push(surfaceHit(context, normalized, "release archive/binary"));
  }
  return hits;
}

function surfaceHit(context, file, rule) {
  return {
    source: context.source,
    file,
    packagePath: context.packagePath,
    rule,
  };
}

function formatSurfaceHit(hit) {
  const packagePath = hit.packagePath && hit.packagePath !== hit.file
    ? ` (${hit.packagePath})`
    : "";
  return `${hit.source}: ${hit.file}${packagePath}: ${hit.rule}`;
}

function workspacePackages() {
  const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
  const patterns = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages || [];
  return patterns.flatMap(workspacePackagesForPattern);
}

function workspacePackagesForPattern(pattern) {
  if (!pattern.endsWith("/*")) return [];
  const base = pattern.slice(0, -2);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => normalizePath(`${base}/${entry.name}`))
    .filter((dir) => existsSync(`${dir}/package.json`))
    .map((dir) => {
      const packageJson = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
      return { dir, name: packageJson.name };
    })
    .filter((workspace) => workspace.name);
}

function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}
