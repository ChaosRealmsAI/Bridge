#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const appName = "Panda Bridge";
const exeName = "PandaBridge.exe";
const binaryName = "panda-bridge-desktop.exe";
const args = new Set(process.argv.slice(2));
const nativeReleaseBinary = resolve("apps/desktop/target/release", binaryName);
const xwinReleaseBinary = resolve("apps/desktop/target/x86_64-pc-windows-msvc/release", binaryName);
const xwinMode = args.has("--xwin");
const skipBuild = args.has("--skip-build");
const releaseBinary = xwinMode ? xwinReleaseBinary : nativeReleaseBinary;
const outDir = resolve("dist/desktop/windows");
const appDir = resolve(outDir, appName);
const zipPath = resolve(outDir, "panda-bridge-windows-x64.zip");
const checkOnly = args.has("--check");

if (checkOnly) {
  assertTemplateContracts();
  console.log(JSON.stringify({
    ok: true,
    mode: "check",
    package: "windows-portable-zip",
    app_name: appName,
    exe_name: exeName,
    registry: {
      url_scheme: "HKCU:\\Software\\Classes\\panda-bridge",
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
const nodeRuntime = copyNodeRuntime(appDir);
writeFileSync(resolve(appDir, "Install.ps1"), installScript());
writeFileSync(resolve(appDir, "Uninstall.ps1"), uninstallScript());
writeFileSync(resolve(appDir, "README.txt"), readmeText());
writeFileSync(resolve(appDir, "manifest.json"), JSON.stringify(manifest(managedAdapters), null, 2));

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
console.log(JSON.stringify({
  ok: true,
  mode: xwinMode ? "xwin-cross" : "windows-native",
  app_dir: appDir,
  zip_path: zipPath,
  binary_source: releaseBinary,
  bytes,
  sha256,
  install: resolve(appDir, "Install.ps1"),
  uninstall: resolve(appDir, "Uninstall.ps1"),
  managed_adapters: managedAdapters,
  node_runtime: nodeRuntime,
}, null, 2));

function manifest(copiedAdapters = []) {
  return {
    app_name: appName,
    binary: exeName,
    bundle_identifier: "cc.otherline.panda-bridge",
    protocol: "panda-bridge",
    startup_registry_value: appName,
    install_dir: "%LOCALAPPDATA%\\Panda Bridge",
    webview: "Microsoft Edge WebView2 Evergreen Runtime",
    managed_adapters: {
      directory: "adapters",
      manifests: copiedAdapters.map((adapter) => adapter.manifest),
    },
    node_runtime: "runtime\\node\\node.exe",
  };
}

function copyManagedAdapters(targetRoot) {
  const source = process.env.PANDA_BRIDGE_MANAGED_ADAPTERS_DIR;
  const copied = [];
  if (!source) return copied;
  const sourceRoot = resolve(source);
  if (!existsSync(sourceRoot)) {
    throw new Error(`PANDA_BRIDGE_MANAGED_ADAPTERS_DIR not found: ${sourceRoot}`);
  }
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

function managedAdapterSources(sourceRoot) {
  if (existsSync(resolve(sourceRoot, "adapter.manifest.json"))) {
    return [managedAdapterSource(sourceRoot)];
  }
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(sourceRoot, entry.name))
    .filter((sourceDir) => existsSync(resolve(sourceDir, "adapter.manifest.json")))
    .map(managedAdapterSource);
}

function managedAdapterSource(sourceDir) {
  const manifestPath = resolve(sourceDir, "adapter.manifest.json");
  const manifestData = JSON.parse(readFileSync(manifestPath, "utf8"));
  const productId = String(manifestData.product_id || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(productId)) {
    throw new Error(`managed adapter manifest has invalid product_id: ${manifestPath}`);
  }
  return { sourceDir, productId };
}

function copyNodeRuntime(targetRoot) {
  const source = process.env.PANDA_BRIDGE_NODE_RUNTIME_DIR;
  if (!source) return null;
  const resolved = resolve(source);
  if (!existsSync(resolved)) {
    throw new Error(`PANDA_BRIDGE_NODE_RUNTIME_DIR not found: ${resolved}`);
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
$AppName = "Panda Bridge"
$InstallDir = Join-Path $env:LOCALAPPDATA "Panda Bridge"
$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $InstallDir "PandaBridge.exe"

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
  Write-Warning "Microsoft Edge WebView2 Evergreen Runtime was not detected. Panda Bridge uses WebView2 to render the desktop UI."
  Write-Warning "Install it from https://developer.microsoft.com/microsoft-edge/webview2/ before launching Panda Bridge on this machine."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $SourceDir "*") -Destination $InstallDir -Recurse -Force

$SchemeKey = "HKCU:\Software\Classes\panda-bridge"
$CommandKey = Join-Path $SchemeKey "shell\open\command"
New-Item -Path $CommandKey -Force | Out-Null
Set-Item -Path $SchemeKey -Value "URL:Panda Bridge Protocol"
New-ItemProperty -Path $SchemeKey -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
Set-Item -Path $CommandKey -Value ('"{0}" "%1"' -f $Exe)

$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
New-ItemProperty -Path $RunKey -Name $AppName -Value ('"{0}"' -f $Exe) -PropertyType String -Force | Out-Null

Write-Host "Panda Bridge installed to $InstallDir"
if (-not $NoLaunch) {
  Start-Process -FilePath $Exe
}
`;
}

function uninstallScript() {
  return String.raw`$ErrorActionPreference = "Stop"
$AppName = "Panda Bridge"
$InstallDir = Join-Path $env:LOCALAPPDATA "Panda Bridge"

Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name $AppName -ErrorAction SilentlyContinue
Remove-Item -Path "HKCU:\Software\Classes\panda-bridge" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Panda Bridge removed. User state under %USERPROFILE%\.panda-bridge is preserved."
`;
}

function readmeText() {
  return `Panda Bridge for Windows

Install:
1. Right-click Install.ps1 and run with PowerShell, or run:
   powershell.exe -ExecutionPolicy Bypass -File .\\Install.ps1

Requirement:
- Microsoft Edge WebView2 Evergreen Runtime. Most Windows 10/11 machines already have it; Install.ps1 prints a warning and download link if it is missing.

The installer copies Panda Bridge to %LOCALAPPDATA%\\Panda Bridge, registers panda-bridge:// for the current user, and enables launch at login through HKCU Run.

Uninstall:
   powershell.exe -ExecutionPolicy Bypass -File .\\Uninstall.ps1
`;
}

function assertTemplateContracts() {
  const install = installScript();
  const uninstall = uninstallScript();
  const required = [
    "HKCU:\\Software\\Classes\\panda-bridge",
    "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "PandaBridge.exe",
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
  if (!uninstall.includes("Remove-ItemProperty") || !uninstall.includes("panda-bridge")) {
    throw new Error("uninstall script does not remove startup and protocol registration");
  }
  const data = manifest();
  if (data.protocol !== "panda-bridge" || data.binary !== exeName) {
    throw new Error("manifest does not match Windows protocol/binary contract");
  }
  const legacyManifestKey = ["burn", "manifest"].join("_");
  if (!Array.isArray(data.managed_adapters?.manifests) || data.managed_adapters?.[legacyManifestKey] || data.node_runtime !== "runtime\\node\\node.exe") {
    throw new Error("manifest does not advertise managed adapter/runtime contract");
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
