#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.error("[desktop:icon:mac] macOS only");
  process.exit(1);
}

const source = resolve("apps/desktop/assets/panda-bridge-icon.svg");
const iconset = resolve("apps/desktop/assets/PandaBridge.iconset");
const output = resolve("apps/desktop/assets/PandaBridge.icns");
const sizes = [16, 32, 128, 256, 512];

if (!existsSync(source)) {
  console.error(`[desktop:icon:mac] missing ${source}`);
  process.exit(1);
}

rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

for (const size of sizes) {
  renderPng(size, resolve(iconset, `icon_${size}x${size}.png`));
  renderPng(size * 2, resolve(iconset, `icon_${size}x${size}@2x.png`));
}

run("iconutil", ["-c", "icns", iconset, "-o", output]);
console.log(JSON.stringify({ ok: true, icon: output }, null, 2));

function renderPng(size, outputPath) {
  run("magick", [
    "-background",
    "none",
    source,
    "-resize",
    `${size}x${size}`,
    outputPath,
  ]);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
