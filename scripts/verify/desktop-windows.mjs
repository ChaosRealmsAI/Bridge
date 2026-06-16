#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const evidenceDir = resolve("spec/verification/evidence/desktop-windows");
const summaryPath = resolve(evidenceDir, "summary.json");
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

const ok = checks.every((check) => check.ok);
const summary = {
  ok,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  platform: process.platform,
  limitation: "No Windows runtime is available in this environment; this verifier proves cross-target compilation and Windows install/package contracts, not live WebView2 rendering.",
  checks,
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ok, summary: summaryPath }, null, 2));
if (!ok) process.exit(1);

function runCheck(name, command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const ok = result.status === 0 && (!options.expectStdout || stdout.includes(options.expectStdout));
  return {
    name,
    command: [command, ...args].join(" "),
    ok,
    status: result.status,
    stdout_tail: tail(stdout),
    stderr_tail: tail(stderr),
  };
}

function staticSourceCheck() {
  const main = readFileSync("apps/desktop/src/main.rs", "utf8");
  const packageScript = readFileSync("scripts/desktop/package-windows.mjs", "utf8");
  const required = [
    { file: "apps/desktop/src/main.rs", marker: "Software\\Classes\\panda-bridge" },
    { file: "apps/desktop/src/main.rs", marker: "Software\\Microsoft\\Windows\\CurrentVersion\\Run" },
    { file: "apps/desktop/src/main.rs", marker: "apply_windows_launch_at_login" },
    { file: "scripts/desktop/package-windows.mjs", marker: "PandaBridge.exe" },
    { file: "scripts/desktop/package-windows.mjs", marker: "Install.ps1" },
    { file: "scripts/desktop/package-windows.mjs", marker: "WebView2 Evergreen Runtime" },
    { file: "scripts/desktop/package-windows.mjs", marker: "F3017226-FE2A-4295-8BDF-00C3A9A7E4C5" },
  ];
  const missing = required.filter((item) => {
    const text = item.file.endsWith("main.rs") ? main : packageScript;
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
