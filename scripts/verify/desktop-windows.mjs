#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const evidenceDir = resolve("spec/L3/evidence/desktop-windows");
const summaryPath = resolve(evidenceDir, "summary.json");
const args = new Set(process.argv.slice(2));
const xwinEnabled = args.has("--xwin") || process.env.PANDA_BRIDGE_WINDOWS_XWIN === "1";
mkdirSync(evidenceDir, { recursive: true });

const checks = [];
const startedAt = new Date().toISOString();

checks.push(runCheck("rust target x86_64-pc-windows-msvc installed", "rustup", ["target", "list", "--installed"], {
  expectStdout: "x86_64-pc-windows-msvc",
}));
checks.push(runCheck("desktop cargo check for Windows target", "cargo", [
  "check",
  "--manifest-path",
  "apps/desktop/Cargo.toml",
  "--target",
  "x86_64-pc-windows-msvc",
]));
checks.push(runCheck("Windows package script static contract", "node", [
  "scripts/desktop/package-windows.mjs",
  "--check",
]));
checks.push(staticSourceCheck());
if (process.platform === "win32") {
  checks.push(runCheck("desktop release build on Windows runner", "cargo", [
    "build",
    "--release",
    "--manifest-path",
    "apps/desktop/Cargo.toml",
  ]));
  checks.push(runCheck("desktop release binary starts in headless mode", releaseBinaryPath(), [
    "headless-status",
  ], {
    env: {
      ...process.env,
      PANDA_BRIDGE_SKIP_KEYCHAIN: "1",
    },
    expectStdout: "\"version\"",
  }));
  checks.push(runCheck("Windows portable package build", "node", [
    "scripts/desktop/package-windows.mjs",
    "--skip-build",
  ]));
  checks.push(windowsPackageArtifactCheck());
  checks.push(runCheck("Windows installer writes current-user registry", "powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installScriptPath(),
    "-NoLaunch",
  ]));
  checks.push(runCheck("Windows URL protocol registry query", "reg.exe", [
    "query",
    "HKCU\\Software\\Classes\\panda-bridge\\shell\\open\\command",
  ], {
    expectStdout: "PandaBridge.exe",
  }));
  checks.push(runCheck("Windows startup registry query", "reg.exe", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "/v",
    "Panda Bridge",
  ], {
    expectStdout: "PandaBridge.exe",
  }));
  checks.push(runCheck("Windows uninstaller removes current-user registration", "powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    uninstallScriptPath(),
  ]));
  checks.push(runCheck("Windows URL protocol removed after uninstall", "reg.exe", [
    "query",
    "HKCU\\Software\\Classes\\panda-bridge",
  ], {
    expectFailure: true,
  }));
} else if (xwinEnabled) {
  checks.push(runCheck("cargo-xwin installed", "cargo", [
    "xwin",
    "--version",
  ], {
    expectStdout: "cargo-xwin",
  }));
  checks.push(runCheck("desktop release build with cargo-xwin", "cargo", [
    "xwin",
    "build",
    "--release",
    "--manifest-path",
    "apps/desktop/Cargo.toml",
    "--target",
    "x86_64-pc-windows-msvc",
  ]));
  checks.push(runCheck("Windows portable package build from cargo-xwin artifact", "node", [
    "scripts/desktop/package-windows.mjs",
    "--xwin",
    "--skip-build",
  ]));
  checks.push(windowsPackageArtifactCheck());
}

const ok = checks.every((check) => check.ok);
const summary = {
  ok,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  platform: process.platform,
  xwin_enabled: xwinEnabled,
  limitation: process.platform === "win32"
    ? "Windows runner available; this verifier proves Windows compilation, release headless startup, portable packaging, Install.ps1 HKCU registry writes, and uninstall cleanup, but not full visible WebView2 UI interaction."
    : xwinEnabled
      ? "No Windows runtime is available in this environment; this verifier proves cross-target cargo check, MSVC-linked Windows release build through cargo-xwin, portable zip packaging, and Windows install/package contracts, not live WebView2 rendering."
    : "No Windows runtime is available in this environment; this verifier proves cross-target compilation and Windows install/package contracts, not live WebView2 rendering.",
  checks,
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ok, summary: summaryPath }, null, 2));
if (!ok) process.exit(1);

function runCheck(name, command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env: options.env ?? process.env });
  const stdout = result.stdout || "";
  const stderr = result.stderr || result.error?.message || "";
  const exited = typeof result.status === "number";
  const statusOk = options.expectFailure ? exited && result.status !== 0 : result.status === 0;
  const ok = statusOk && (!options.expectStdout || stdout.includes(options.expectStdout));
  return {
    name,
    command: [command, ...args].join(" "),
    ok,
    status: result.status,
    stdout_tail: tail(stdout),
    stderr_tail: tail(stderr),
  };
}

function windowsPackageArtifactCheck() {
  const target = JSON.parse(readFileSync("release/desktop.json", "utf8")).targets["windows-x64"];
  const zip = resolve("dist/desktop/windows", target.fileName);
  const versionedZip = resolve("dist/desktop/windows", target.versionedFileName);
  const manifest = resolve("dist/desktop/windows/Panda Bridge/manifest.json");
  const exe = resolve("dist/desktop/windows/Panda Bridge/PandaBridge.exe");
  const install = resolve("dist/desktop/windows/Panda Bridge/Install.ps1");
  const summary = resolve("dist/desktop/windows/package-summary.json");
  const ok = [zip, versionedZip, manifest, exe, install, summary].every((file) => existsSync(file))
    && statSync(zip).size > 0
    && statSync(versionedZip).size === statSync(zip).size
    && statSync(exe).size > 0;
  return {
    name: "Windows portable package artifact",
    command: "artifact scan dist/desktop/windows",
    ok,
    artifacts: {
      zip,
      versioned_zip: versionedZip,
      manifest,
      exe,
      install,
      package_summary: summary,
      zip_bytes: existsSync(zip) ? statSync(zip).size : 0,
      exe_bytes: existsSync(exe) ? statSync(exe).size : 0,
    },
  };
}

function staticSourceCheck() {
  const startup = readFileSync("apps/desktop/src/settings/startup.rs", "utf8");
  const windowSource = readFileSync("apps/desktop/src/window.rs", "utf8");
  const packageScript = readFileSync("scripts/desktop/package-windows.mjs", "utf8");
  const required = [
    { file: "apps/desktop/src/window.rs", marker: "Software\\Classes\\panda-bridge" },
    { file: "apps/desktop/src/window.rs", marker: "URL Protocol" },
    { file: "apps/desktop/src/settings/startup.rs", marker: "Software\\Microsoft\\Windows\\CurrentVersion\\Run" },
    { file: "apps/desktop/src/settings/startup.rs", marker: "apply_windows_launch_at_login" },
    { file: "scripts/desktop/package-windows.mjs", marker: "PandaBridge.exe" },
    { file: "scripts/desktop/package-windows.mjs", marker: "Install.ps1" },
    { file: "scripts/desktop/package-windows.mjs", marker: "WebView2 Evergreen Runtime" },
    { file: "scripts/desktop/package-windows.mjs", marker: "F3017226-FE2A-4295-8BDF-00C3A9A7E4C5" },
  ];
  const missing = required.filter((item) => {
    const text = item.file.endsWith("startup.rs")
      ? startup
      : item.file.endsWith("window.rs")
        ? windowSource
        : packageScript;
    return !text.includes(item.marker);
  });
  return {
    name: "Windows desktop source contract",
    command: "static source scan",
    ok: missing.length === 0,
    missing,
  };
}

function tail(text) {
  return text.split(/\r?\n/).filter(Boolean).slice(-30).join("\n");
}

function releaseBinaryPath() {
  return resolve("apps/desktop/target/release/panda-bridge-desktop.exe");
}

function installScriptPath() {
  return resolve("dist/desktop/windows/Panda Bridge/Install.ps1");
}

function uninstallScriptPath() {
  return resolve("dist/desktop/windows/Panda Bridge/Uninstall.ps1");
}
