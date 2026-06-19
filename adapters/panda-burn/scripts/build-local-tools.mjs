#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendRoot = resolve(adapterRoot, "local-tools", "backend");
const chatRoot = resolve(backendRoot, "burn-chat");
const binDir = resolve(backendRoot, "bin");

run("cargo", ["build", "--release", "--manifest-path", resolve(backendRoot, "Cargo.toml")]);
mkdirSync(binDir, { recursive: true });
for (const name of ["burn-chat", "burn-monitor"]) {
  const binary = process.platform === "win32" ? `${name}.exe` : name;
  const source = resolve(backendRoot, "target", "release", binary);
  if (!existsSync(source)) throw new Error(`missing built local tool: ${source}`);
  copyFileSync(source, resolve(binDir, binary));
}

if (!existsSync(resolve(chatRoot, "node_modules"))) {
  run("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: chatRoot });
}

console.log(JSON.stringify({
  ok: true,
  adapter: "panda-burn",
  backend: backendRoot,
  bin_dir: binDir,
}));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || adapterRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
