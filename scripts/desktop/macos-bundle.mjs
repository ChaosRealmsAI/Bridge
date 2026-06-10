import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const appName = "Panda Bridge";
export const bundleIdentifier = "cc.otherline.panda-bridge";
export const binaryName = "panda-bridge-desktop";
export const iconFileName = "PandaBridge.icns";
export const releaseBinary = resolve("apps/desktop/target/release", binaryName);
export const iconPath = resolve("apps/desktop/assets", iconFileName);

export function assertMacos(commandName) {
  if (process.platform !== "darwin") {
    console.error(`[${commandName}] macOS only`);
    process.exit(1);
  }
}

export function createMacAppBundle(appPath, options = {}) {
  const build = options.build !== false;
  if (build) run("cargo", ["build", "--release", "--manifest-path", "apps/desktop/Cargo.toml"]);
  if (!existsSync(iconPath)) run("node", ["scripts/desktop/build-icon.mjs"]);

  const contents = resolve(appPath, "Contents");
  const macos = resolve(contents, "MacOS");
  const resources = resolve(contents, "Resources");

  rmSync(appPath, { recursive: true, force: true });
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  copyFileSync(releaseBinary, resolve(macos, appName));
  copyFileSync(iconPath, resolve(resources, iconFileName));
  writeFileSync(resolve(contents, "PkgInfo"), "APPLPBRG\n");
  writeFileSync(resolve(contents, "Info.plist"), plist());
  run("chmod", ["755", resolve(macos, appName)]);
  return {
    appPath,
    executable: resolve(macos, appName),
    icon: resolve(resources, iconFileName),
  };
}

export function signAppBundle(appPath) {
  const identity = process.env.PANDA_BRIDGE_CODESIGN_IDENTITY ?? "-";
  const result = spawnSync("codesign", ["--force", "--deep", "--sign", identity, appPath], {
    stdio: "inherit",
  });
  return { identity, ok: result.status === 0 };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.stdio ?? "inherit" });
  if (result.status !== 0 && !options.optional) process.exit(result.status || 1);
  return result;
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>${appName}</string>
  <key>CFBundleIconFile</key>
  <string>${iconFileName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
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
