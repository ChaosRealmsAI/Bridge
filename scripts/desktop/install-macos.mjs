#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";
import { appName, assertMacos, createMacAppBundle, run, signAppBundle } from "./macos-bundle.mjs";

assertMacos("desktop:install:mac");

const appPath = resolve(homedir(), "Applications", `${appName}.app`);
const bundle = createMacAppBundle(appPath);
const signature = signAppBundle(appPath);

run("xattr", ["-dr", "com.apple.quarantine", appPath], { optional: true });
run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", appPath], { optional: true });

console.log(JSON.stringify({
  ok: true,
  app_path: bundle.appPath,
  executable: bundle.executable,
  icon: bundle.icon,
  codesign: signature,
}, null, 2));
