#!/usr/bin/env node
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.error("[desktop:install:mac] macOS only");
  process.exit(1);
}

const appName = "Panda Bridge";
const binaryName = "panda-bridge-desktop";
const appPath = resolve(homedir(), "Applications", `${appName}.app`);
const contents = resolve(appPath, "Contents");
const macos = resolve(contents, "MacOS");
const resources = resolve(contents, "Resources");
const sourceBinary = resolve("apps/desktop/target/release", binaryName);

run("cargo", ["build", "--release", "--manifest-path", "apps/desktop/Cargo.toml"]);
rmSync(appPath, { recursive: true, force: true });
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });
copyFileSync(sourceBinary, resolve(macos, appName));
writeFileSync(resolve(contents, "PkgInfo"), "APPLPBRG\n");
writeFileSync(resolve(contents, "Info.plist"), plist());
run("chmod", ["755", resolve(macos, appName)]);
run("xattr", ["-dr", "com.apple.quarantine", appPath], { optional: true });
run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", appPath], { optional: true });

console.log(JSON.stringify({
  ok: true,
  app_path: appPath,
  executable: resolve(macos, appName),
}, null, 2));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0 && !options.optional) process.exit(result.status || 1);
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>Panda Bridge</string>
  <key>CFBundleExecutable</key>
  <string>Panda Bridge</string>
  <key>CFBundleIdentifier</key>
  <string>cc.otherline.panda-bridge</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Panda Bridge</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>Panda Bridge Connect</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>panda-bridge</string>
      </array>
    </dict>
  </array>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}
