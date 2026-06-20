#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  copyBridgeManagedAdapterNodeModules,
  managedAdapterSources,
  prepareManagedAdapterSources,
} from "./managed-adapters.mjs";
import {
  copyVersionedArtifact,
  desktopReleaseContract,
  desktopReleaseDownloadUrl,
  desktopReleaseTarget,
  desktopReleaseVersion,
} from "./release-contract.mjs";

const releaseContract = desktopReleaseContract();
const releaseTarget = desktopReleaseTarget("windows-x64");
const appName = releaseContract.appName;
const exeName = "Bridge.exe";
const binaryName = "bridge-desktop.exe";
const args = new Set(process.argv.slice(2));
const nativeReleaseBinary = resolve("apps/desktop/target/release", binaryName);
const xwinReleaseBinary = resolve("apps/desktop/target/x86_64-pc-windows-msvc/release", binaryName);
const xwinMode = args.has("--xwin");
const skipBuild = args.has("--skip-build");
const releaseBinary = xwinMode ? xwinReleaseBinary : nativeReleaseBinary;
const outDir = resolve("dist/desktop/windows");
const appDir = resolve(outDir, appName);
const zipPath = resolve(outDir, releaseTarget.fileName);
const checkOnly = args.has("--check");

if (checkOnly) {
  assertTemplateContracts();
  console.log(JSON.stringify({
    ok: true,
    mode: "check",
    package: "windows-portable-zip",
    version: desktopReleaseVersion(),
    app_name: appName,
    artifact: releaseTarget.fileName,
    versioned_artifact: releaseTarget.versionedFileName,
    exe_name: exeName,
    registry: {
      url_scheme: "HKCU:\\Software\\Classes\\bridge",
      startup: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    },
  }, null, 2));
  process.exit(0);
}

if (process.platform !== "win32" && !xwinMode) {
  console.error("[desktop:package:windows] Windows only. Use --check for static validation or --xwin for cross packaging on this OS.");
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

if (!skipBuild) {
  if (xwinMode) {
    run("cargo", ["xwin", "build", "--release", "--manifest-path", "apps/desktop/Cargo.toml", "--target", "x86_64-pc-windows-msvc"]);
  } else {
    run("cargo", ["build", "--release", "--manifest-path", "apps/desktop/Cargo.toml"]);
  }
}
if (!existsSync(releaseBinary)) {
  console.error(`[desktop:package:windows] release binary not found: ${releaseBinary}`);
  process.exit(1);
}
copyFileSync(releaseBinary, resolve(appDir, exeName));
const managedAdapters = copyManagedAdapters(appDir);
const managedAdapterNodeModules = managedAdapters.length > 0 ? copyBridgeManagedAdapterNodeModules(appDir) : [];
const nodeRuntime = copyNodeRuntime(appDir);
writeFileSync(resolve(appDir, "Install.ps1"), installScript());
writeFileSync(resolve(appDir, "Uninstall.ps1"), uninstallScript());
writeFileSync(resolve(appDir, "README.txt"), readmeText());
writeFileSync(resolve(appDir, "manifest.json"), JSON.stringify(manifest(managedAdapters, nodeRuntime), null, 2));

if (process.platform === "win32" && !xwinMode) {
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Compress-Archive -Path ${psQuote(resolve(appDir, "*"))} -DestinationPath ${psQuote(zipPath)} -Force`,
  ]);
} else {
  run("zip", ["-qr", zipPath, "."], { cwd: appDir });
}

const bytes = statSync(zipPath).size;
const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
const versionedZipPath = copyVersionedArtifact(releaseTarget);
const summary = {
  ok: true,
  mode: xwinMode ? "xwin-cross" : "windows-native",
  version: desktopReleaseVersion(),
  app_dir: appDir,
  zip_path: zipPath,
  versioned_zip_path: versionedZipPath,
  download_url: desktopReleaseDownloadUrl(releaseTarget),
  versioned_download_url: desktopReleaseDownloadUrl(releaseTarget, { versioned: true }),
  binary_source: releaseBinary,
  bytes,
  sha256,
  install: resolve(appDir, "Install.ps1"),
  uninstall: resolve(appDir, "Uninstall.ps1"),
  managed_adapters: managedAdapters,
  managed_adapter_node_modules: managedAdapterNodeModules.map((item) => item.target),
  node_runtime: nodeRuntime,
  distributable: true,
  signing: {
    required: false,
    status: "unsigned-portable-zip",
  },
};

writeFileSync(resolve(outDir, "package-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

function manifest(copiedAdapters = [], copiedNodeRuntime = null) {
  const payload = {
    app_name: appName,
    version: desktopReleaseVersion(),
    binary: exeName,
    bundle_identifier: releaseContract.bundleIdentifier,
    protocol: releaseContract.protocol,
    startup_registry_value: appName,
    install_dir: "%LOCALAPPDATA%\\Bridge",
    webview: "Microsoft Edge WebView2 Evergreen Runtime",
    managed_adapters: {
      directory: "adapters",
      manifests: copiedAdapters.map((adapter) => adapter.manifest),
    },
  };
  if (copiedNodeRuntime) payload.node_runtime = "runtime\\node\\node.exe";
  return payload;
}

function copyManagedAdapters(targetRoot) {
  const source = process.env.BRIDGE_MANAGED_ADAPTERS_DIR;
  const copied = [];
  if (!source) return copied;
  const sourceRoot = resolve(source);
  if (!existsSync(sourceRoot)) {
    throw new Error(`BRIDGE_MANAGED_ADAPTERS_DIR not found: ${sourceRoot}`);
  }
  prepareManagedAdapterSources(sourceRoot);
  const adaptersDir = resolve(targetRoot, "adapters");
  mkdirSync(adaptersDir, { recursive: true });
  for (const adapter of managedAdapterSources(sourceRoot)) {
    const target = resolve(adaptersDir, adapter.productId);
    cpSync(adapter.sourceDir, target, { recursive: true, force: true });
    copied.push({
      product_id: adapter.productId,
      directory: target,
      manifest: `adapters\\${adapter.productId}\\adapter.manifest.json`,
    });
  }
  return copied;
}

function copyNodeRuntime(targetRoot) {
  const source = process.env.BRIDGE_NODE_RUNTIME_DIR;
  if (!source) return null;
  const resolved = resolve(source);
  if (!existsSync(resolved)) {
    throw new Error(`BRIDGE_NODE_RUNTIME_DIR not found: ${resolved}`);
  }
  const target = resolve(targetRoot, "runtime", "node");
  cpSync(resolved, target, { recursive: true, force: true });
  return target;
}

function installScript() {
  return String.raw`param(
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$AppName = "Bridge"
$InstallDir = Join-Path $env:LOCALAPPDATA "Bridge"
$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $InstallDir "Bridge.exe"

function Test-WebView2Runtime {
  $ClientId = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  $Keys = @(
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$ClientId",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$ClientId",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$ClientId"
  )
  foreach ($Key in $Keys) {
    if (Test-Path $Key) { return $true }
  }
  return $false
}

if (-not (Test-WebView2Runtime)) {
  Write-Warning "Microsoft Edge WebView2 Evergreen Runtime was not detected. Bridge uses WebView2 to render the desktop UI."
  Write-Warning "Install it from https://developer.microsoft.com/microsoft-edge/webview2/ before launching Bridge on this machine."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $SourceDir "*") -Destination $InstallDir -Recurse -Force

$SchemeKey = "HKCU:\Software\Classes\bridge"
$CommandKey = Join-Path $SchemeKey "shell\open\command"
New-Item -Path $CommandKey -Force | Out-Null
Set-Item -Path $SchemeKey -Value "URL:Bridge Protocol"
New-ItemProperty -Path $SchemeKey -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
Set-Item -Path $CommandKey -Value ('"{0}" "%1"' -f $Exe)

$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
New-ItemProperty -Path $RunKey -Name $AppName -Value ('"{0}"' -f $Exe) -PropertyType String -Force | Out-Null

Write-Host "Bridge installed to $InstallDir"
if (-not $NoLaunch) {
  Start-Process -FilePath $Exe
}
`;
}

function uninstallScript() {
  return String.raw`$ErrorActionPreference = "Stop"
$AppName = "Bridge"
$InstallDir = Join-Path $env:LOCALAPPDATA "Bridge"

Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name $AppName -ErrorAction SilentlyContinue
Remove-Item -Path "HKCU:\Software\Classes\bridge" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Bridge removed. User state under %APPDATA%\Bridge is preserved."
`;
}

function readmeText() {
  return `Bridge for Windows

Install:
1. Right-click Install.ps1 and run with PowerShell, or run:
   powershell.exe -ExecutionPolicy Bypass -File .\\Install.ps1

Requirement:
- Microsoft Edge WebView2 Evergreen Runtime. Most Windows 10/11 machines already have it; Install.ps1 prints a warning and download link if it is missing.

The installer copies Bridge to %LOCALAPPDATA%\\Bridge, registers bridge:// for the current user, and enables launch at login through HKCU Run.

Uninstall:
   powershell.exe -ExecutionPolicy Bypass -File .\\Uninstall.ps1
`;
}

function assertTemplateContracts() {
  const install = installScript();
  const uninstall = uninstallScript();
  const required = [
    "HKCU:\\Software\\Classes\\bridge",
    "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "Bridge.exe",
    "Start-Process",
    "NoLaunch",
    "URL Protocol",
    "WebView2 Evergreen Runtime",
    "F3017226-FE2A-4295-8BDF-00C3A9A7E4C5",
  ];
  for (const marker of required) {
    if (!install.includes(marker)) {
      throw new Error(`install script missing ${marker}`);
    }
  }
  if (!uninstall.includes("Remove-ItemProperty") || !uninstall.includes("bridge")) {
    throw new Error("uninstall script does not remove startup and protocol registration");
  }
  const data = manifest();
  if (data.protocol !== "bridge" || data.binary !== exeName) {
    throw new Error("manifest does not match Windows protocol/binary contract");
  }
  const legacyManifestKey = ["burn", "manifest"].join("_");
  if (!Array.isArray(data.managed_adapters?.manifests) || data.managed_adapters?.[legacyManifestKey] || Object.hasOwn(data, "node_runtime")) {
    throw new Error("manifest does not advertise managed adapter/runtime contract");
  }
  const runtimeManifest = manifest([], "runtime-present");
  if (runtimeManifest.node_runtime !== "runtime\\node\\node.exe") {
    throw new Error("manifest does not advertise copied node runtime");
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: options.cwd });
  if (result.error) {
    console.error(`[desktop:package:windows] failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
