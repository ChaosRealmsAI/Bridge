#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { appName, assertMacos, createMacAppBundle, run, signAppBundle } from "./macos-bundle.mjs";

assertMacos("desktop:package:mac");

const outDir = resolve("dist/desktop/macos");
const appPath = resolve(outDir, `${appName}.app`);
const dmgRoot = resolve(outDir, "dmg-root");
const dmgPath = resolve(outDir, "panda-bridge-macos.dmg");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const bundle = createMacAppBundle(appPath);
const signature = signAppBundle(appPath);

rmSync(dmgRoot, { recursive: true, force: true });
mkdirSync(dmgRoot, { recursive: true });
copyAppBundle(appPath, resolve(dmgRoot, `${appName}.app`));
symlinkSync("/Applications", resolve(dmgRoot, "Applications"));
run("hdiutil", ["create", "-volname", appName, "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmgPath]);
rmSync(dmgRoot, { recursive: true, force: true });

const bytes = statSync(dmgPath).size;
const sha256 = createHash("sha256").update(readFileSync(dmgPath)).digest("hex");

console.log(JSON.stringify({
  ok: true,
  app_path: bundle.appPath,
  dmg_path: dmgPath,
  bytes,
  sha256,
  codesign: signature,
  notarized: false,
}, null, 2));

function copyAppBundle(source, destination) {
  run("ditto", [source, destination]);
  copyFileSync(resolve(source, "Contents", "PkgInfo"), resolve(destination, "Contents", "PkgInfo"));
}
