#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const contractPath = resolve(root, "release/desktop.json");
const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export function desktopReleaseContract() {
  const contract = readJson(contractPath);
  assertDesktopReleaseShape(contract);
  return contract;
}

export function desktopReleaseVersion() {
  return desktopReleaseContract().version;
}

export function desktopReleaseTarget(id) {
  const contract = desktopReleaseContract();
  const target = contract.targets[id];
  if (!target) throw new Error(`unknown_desktop_release_target:${id}`);
  return target;
}

export function desktopReleaseDownloadUrl(target, options = {}) {
  const contract = desktopReleaseContract();
  const channel = options.channel || "production";
  const base = String(contract.assetBaseUrls[channel] || contract.assetBaseUrls.production || "").replace(/\/$/, "");
  return `${base}${options.versioned ? target.versionedDownloadPath : target.downloadPath}`;
}

export function desktopReleaseArtifactPath(target, options = {}) {
  return resolve(root, target.distDir, options.versioned ? target.versionedFileName : target.fileName);
}

export function desktopReleaseManifestPath(options = {}) {
  const contract = desktopReleaseContract();
  const fileName = options.versioned
    ? `panda-bridge-desktop-v${contract.version}.json`
    : "panda-bridge-desktop-latest.json";
  return resolve(root, "dist/desktop/release", fileName);
}

export async function assertDesktopReleaseContract(options = {}) {
  const contract = desktopReleaseContract();
  assertVersionFiles(contract);
  await assertRuntimeInstallConstants(contract);
  assertPackageScripts();
  assertCommitGate();
  if (options.artifacts) assertReleaseArtifacts(contract);
  return contract;
}

export function copyVersionedArtifact(target) {
  const stablePath = desktopReleaseArtifactPath(target);
  const versionedPath = desktopReleaseArtifactPath(target, { versioned: true });
  if (!existsSync(stablePath)) throw new Error(`release artifact not found: ${stablePath}`);
  copyFileSync(stablePath, versionedPath);
  return versionedPath;
}

export function artifactDigest(file) {
  const bytes = readFileSync(file);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function main() {
  const command = process.argv[2] || "check";
  if (command === "check") {
    await assertDesktopReleaseContract();
    console.log(JSON.stringify({ ok: true, check: "desktop-release-contract" }, null, 2));
    return;
  }
  if (command === "verify-artifacts") {
    await assertDesktopReleaseContract({ artifacts: true });
    console.log(JSON.stringify({ ok: true, check: "desktop-release-artifacts" }, null, 2));
    return;
  }
  if (command === "prepare") {
    const manifest = await prepareReleaseManifest();
    console.log(JSON.stringify({ ok: true, check: "desktop-release-prepare", manifest }, null, 2));
    return;
  }
  if (command === "audit-public") {
    const audit = await auditPublicRelease();
    console.log(JSON.stringify({ ok: true, check: "desktop-release-public-audit", audit }, null, 2));
    return;
  }
  if (command === "stage-public") {
    const staged = await stagePublicRelease();
    console.log(JSON.stringify({ ok: true, check: "desktop-release-stage-public", staged }, null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

function assertDesktopReleaseShape(contract) {
  assert.equal(contract.schemaVersion, "2026-06-21.panda-bridge.desktop-release.v1");
  assert.equal(contract.product, "panda-bridge-desktop");
  assert.equal(contract.appName, "Panda Bridge");
  assert.equal(contract.bundleIdentifier, "cc.otherline.panda-bridge");
  assert.equal(contract.protocol, "panda-bridge");
  assert.match(contract.version, semverPattern);
  assert.equal(contract.releaseId, `panda-bridge-desktop-v${contract.version}`);
  assert.ok(contract.assetBaseUrls?.production?.startsWith("https://"), "production asset base URL is required");
  assert.ok(contract.assetBaseUrls?.test?.startsWith("https://"), "test asset base URL is required");
  assert.equal(contract.manifest.latestPath, "/downloads/panda-bridge-desktop/latest.json");
  assert.equal(contract.manifest.versionedPath, `/downloads/releases/v${contract.version}/panda-bridge-desktop-v${contract.version}.json`);
  assertTarget(contract, "macos", { platform: "macos", packageType: "dmg", suffix: ".dmg" });
  assertTarget(contract, "windows-x64", { platform: "windows", packageType: "portable-zip", suffix: ".zip" });
  assert.equal(contract.releaseGate.prepareCommand, "npm run release:desktop:prepare");
  assert.equal(contract.releaseGate.verifyCommand, "npm run release:desktop:verify");
  assert.equal(contract.releaseGate.publicAuditCommand, "npm run release:desktop:audit-public");
}

function assertTarget(contract, id, expected) {
  const target = contract.targets?.[id];
  assert.ok(target, `missing release target: ${id}`);
  assert.equal(target.platform, expected.platform, `${id} platform`);
  assert.equal(target.package, expected.packageType, `${id} package`);
  assert.ok(target.distDir.startsWith("dist/desktop/"), `${id} distDir must stay under dist/desktop`);
  assert.ok(target.fileName.startsWith("panda-bridge-"), `${id} stable file must use panda-bridge prefix`);
  assert.ok(target.fileName.endsWith(expected.suffix), `${id} stable file suffix`);
  assert.ok(target.versionedFileName.includes(`v${contract.version}`), `${id} versioned file must include release version`);
  assert.ok(target.versionedFileName.endsWith(expected.suffix), `${id} versioned file suffix`);
  assert.ok(target.downloadPath.startsWith("/downloads/"), `${id} stable download path`);
  assert.equal(target.downloadPath.endsWith(target.fileName), true, `${id} stable download path must end with fileName`);
  assert.equal(
    target.versionedDownloadPath,
    `/downloads/releases/v${contract.version}/${target.versionedFileName}`,
    `${id} versioned download path`,
  );
  assert.match(target.sha256, sha256Pattern, `${id} sha256`);
  assert.ok(Number.isInteger(target.minimumBytes) && target.minimumBytes > 0, `${id} minimumBytes`);
  assert.ok(!/html/i.test(target.contentType), `${id} contentType cannot be HTML`);
}

function assertVersionFiles(contract) {
  const rootPackage = readJson(resolve(root, "package.json"));
  const desktopPackage = readJson(resolve(root, "apps/desktop/package.json"));
  const lock = readJson(resolve(root, "package-lock.json"));
  const cargo = readFileSync(resolve(root, "apps/desktop/Cargo.toml"), "utf8");
  assert.equal(rootPackage.version, contract.version, "root package version must match desktop release");
  assert.equal(desktopPackage.version, contract.version, "desktop package version must match desktop release");
  assert.equal(lock.packages[""].version, contract.version, "package-lock root version must match desktop release");
  assert.equal(lock.packages["apps/desktop"].version, contract.version, "package-lock desktop version must match desktop release");
  assert.match(cargo, new RegExp(`\\[package\\][\\s\\S]*?\\nversion = "${escapeRegex(contract.version)}"`), "Cargo package version must match desktop release");
  assert.match(cargo, new RegExp(`\\[package\\.metadata\\.bundle\\][\\s\\S]*?\\nversion = "${escapeRegex(contract.version)}"`), "Cargo bundle version must match desktop release");
}

async function assertRuntimeInstallConstants(contract) {
  const sdk = await import(pathToFileURL(resolve(root, "packages/sdk/src/index.js")).href);
  assert.equal(sdk.BRIDGE_SDK_VERSION, contract.version, "SDK version must match desktop release");
  assertSdkTarget(sdk.bridgeDesktopInstallDefaults.macos, contract, contract.targets.macos);
  assertSdkTarget(sdk.bridgeDesktopInstallDefaults.windows, contract, contract.targets["windows-x64"]);
  assert.equal(sdk.bridgeDesktopInstallTarget({ platform: "windows" }).fileName, contract.targets["windows-x64"].fileName);

  const worker = await import(pathToFileURL(resolve(root, "apps/cloud-worker/src/core/constants.js")).href);
  assert.equal(worker.BRIDGE_DESKTOP_RELEASE.version, contract.version, "Worker release version");
  assert.equal(worker.BRIDGE_DESKTOP_INSTALL.version, contract.version, "Worker install version");
  assert.equal(worker.BRIDGE_DESKTOP_RELEASE.manifest.latest_path, contract.manifest.latestPath);
  assertWorkerTarget(worker.BRIDGE_DESKTOP_RELEASE.targets.macos, contract, contract.targets.macos);
  assertWorkerTarget(worker.BRIDGE_DESKTOP_RELEASE.targets.windows_x64, contract, contract.targets["windows-x64"]);
}

function assertSdkTarget(actual, contract, expected) {
  assert.ok(actual, `SDK missing ${expected.platform} install target`);
  assert.equal(actual.version, contract.version);
  assert.equal(actual.fileName, expected.fileName);
  assert.equal(actual.downloadPath, expected.downloadPath);
  assert.equal(actual.versionedDownloadPath, expected.versionedDownloadPath);
  assert.equal(actual.sha256, expected.sha256);
  assert.equal(actual.downloadUrls.production, `${contract.assetBaseUrls.production}${expected.downloadPath}`);
  assert.equal(actual.downloadUrls.test, `${contract.assetBaseUrls.test}${expected.downloadPath}`);
}

function assertWorkerTarget(actual, contract, expected) {
  assert.ok(actual, `Worker missing ${expected.platform} install target`);
  assert.equal(actual.version, contract.version);
  assert.equal(actual.file_name, expected.fileName);
  assert.equal(actual.versioned_file_name, expected.versionedFileName);
  assert.equal(actual.download_path, expected.downloadPath);
  assert.equal(actual.versioned_download_path, expected.versionedDownloadPath);
  assert.equal(actual.sha256, expected.sha256);
}

function assertPackageScripts() {
  const pkg = readJson(resolve(root, "package.json"));
  assert.ok(pkg.scripts["check:release-contract"], "package.json must expose check:release-contract");
  assert.ok(pkg.scripts.check.includes("check:release-contract"), "npm run check must include release contract gate");
  assert.equal(pkg.scripts["release:desktop:prepare"], "node scripts/desktop/package-macos.mjs --release && npm run desktop:package:windows:xwin && node scripts/desktop/release-contract.mjs prepare");
  assert.equal(pkg.scripts["release:desktop:verify"], "node scripts/desktop/release-contract.mjs verify-artifacts");
  assert.equal(pkg.scripts["release:desktop:stage-public"], "node scripts/desktop/release-contract.mjs stage-public");
  assert.equal(pkg.scripts["release:desktop:deploy-public"], "npm run release:desktop:stage-public && npm run cloud:deploy && npm run release:desktop:audit-public");
  assert.equal(pkg.scripts["release:desktop:audit-public"], "node scripts/desktop/release-contract.mjs audit-public");
}

function assertCommitGate() {
  const script = resolve(root, "scripts/check-commit.sh");
  assert.ok(existsSync(script), "scripts/check-commit.sh must exist for global pre-commit hook");
  const text = readFileSync(script, "utf8");
  assert.match(text, /check:release-contract/, "commit gate must run release contract check");
}

function assertReleaseArtifacts(contract, options = {}) {
  const checkHash = options.checkHash !== false;
  for (const [id, target] of Object.entries(contract.targets)) {
    const stablePath = desktopReleaseArtifactPath(target);
    const versionedPath = desktopReleaseArtifactPath(target, { versioned: true });
    const summaryPath = resolve(root, target.distDir, "package-summary.json");
    assert.ok(existsSync(stablePath), `${id} stable artifact missing: ${stablePath}`);
    assert.ok(existsSync(versionedPath), `${id} versioned artifact missing: ${versionedPath}`);
    assert.ok(existsSync(summaryPath), `${id} package summary missing: ${summaryPath}`);
    const summary = readJson(summaryPath);
    assert.equal(summary.version, contract.version, `${id} package summary version`);
    if (id === "macos") {
      assert.equal(summary.distributable, true, "macOS public release requires Developer ID signing and notarization");
    }
    for (const file of [stablePath, versionedPath]) {
      const digest = artifactDigest(file);
      assert.ok(digest.bytes >= target.minimumBytes, `${id} artifact too small: ${file}`);
      if (checkHash) assert.equal(digest.sha256, target.sha256, `${id} artifact sha256 mismatch: ${file}`);
    }
  }
}

async function prepareReleaseManifest() {
  const contract = await assertDesktopReleaseContract();
  assertReleaseArtifacts(contract, { checkHash: false });
  const generatedAt = new Date().toISOString();
  const targets = Object.fromEntries(Object.entries(contract.targets).map(([id, target]) => {
    const stablePath = desktopReleaseArtifactPath(target);
    const versionedPath = desktopReleaseArtifactPath(target, { versioned: true });
    const digest = artifactDigest(stablePath);
    return [id, {
      platform: target.platform,
      ...(target.arch ? { arch: target.arch } : {}),
      package: target.package,
      fileName: target.fileName,
      versionedFileName: target.versionedFileName,
      downloadUrl: desktopReleaseDownloadUrl(target),
      versionedDownloadUrl: desktopReleaseDownloadUrl(target, { versioned: true }),
      sha256: digest.sha256,
      bytes: digest.bytes,
      localArtifacts: {
        stable: relative(stablePath),
        versioned: relative(versionedPath),
        packageSummary: relative(resolve(root, target.distDir, "package-summary.json")),
      },
    }];
  }));
  const manifest = {
    schemaVersion: "2026-06-21.panda-bridge.desktop-release-manifest.v1",
    releaseId: contract.releaseId,
    product: contract.product,
    version: contract.version,
    channel: contract.channel,
    generatedAt,
    manifestUrls: {
      latest: `${contract.assetBaseUrls.production}${contract.manifest.latestPath}`,
      versioned: `${contract.assetBaseUrls.production}${contract.manifest.versionedPath}`,
    },
    targets,
  };
  const latestPath = desktopReleaseManifestPath();
  const versionedPath = desktopReleaseManifestPath({ versioned: true });
  mkdirSync(dirname(latestPath), { recursive: true });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(latestPath, text);
  writeFileSync(versionedPath, text);
  return {
    latest: relative(latestPath),
    versioned: relative(versionedPath),
  };
}

async function stagePublicRelease() {
  const contract = await assertDesktopReleaseContract({ artifacts: true });
  const manifest = await prepareReleaseManifest();
  const staged = [];
  for (const [id, target] of Object.entries(contract.targets)) {
    for (const versioned of [false, true]) {
      const source = desktopReleaseArtifactPath(target, { versioned });
      const destination = publicAssetPath(versioned ? target.versionedDownloadPath : target.downloadPath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      const digest = artifactDigest(destination);
      staged.push({ id, versioned, path: relative(destination), bytes: digest.bytes, sha256: digest.sha256 });
    }
  }
  for (const versioned of [false, true]) {
    const source = desktopReleaseManifestPath({ versioned });
    const destination = publicAssetPath(versioned ? contract.manifest.versionedPath : contract.manifest.latestPath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    staged.push({ id: "manifest", versioned, path: relative(destination), bytes: artifactDigest(destination).bytes });
  }
  return { manifest, assets: staged };
}

async function auditPublicRelease() {
  const contract = await assertDesktopReleaseContract();
  const results = [];
  for (const [id, target] of Object.entries(contract.targets)) {
    for (const versioned of [false, true]) {
      const url = desktopReleaseDownloadUrl(target, { versioned });
      const result = await fetchAndDigest(url);
      assert.equal(result.status, 200, `${id} ${versioned ? "versioned" : "stable"} public URL returned ${result.status}: ${url}`);
      assert.ok(!/text\/html/i.test(result.contentType), `${id} public URL returned HTML instead of ${target.package}: ${url}`);
      assert.ok(result.bytes >= target.minimumBytes, `${id} public artifact too small at ${url}: ${result.bytes}`);
      assert.equal(result.sha256, target.sha256, `${id} public sha256 mismatch at ${url}`);
      results.push({ id, versioned, url, bytes: result.bytes, sha256: result.sha256, contentType: result.contentType });
    }
  }
  return results;
}

async function fetchAndDigest(url) {
  const response = await fetch(url, { redirect: "follow" });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function relative(file) {
  return file.replace(`${root}/`, "");
}

function publicAssetPath(publicPath) {
  return resolve(root, "apps/web-chat/public", String(publicPath).replace(/^\/+/, ""));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
