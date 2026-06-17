import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const appName = "Panda Bridge";
export const bundleIdentifier = "cc.otherline.panda-bridge";
export const binaryName = "panda-bridge-desktop";
export const iconFileName = "PandaBridge.icns";
export const releaseBinary = resolve("apps/desktop/target/release", binaryName);
export const iconPath = resolve("apps/desktop/assets", iconFileName);
export const entitlementsPath = resolve("dist/desktop/macos/panda-bridge.entitlements.plist");

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
  const managedAdapters = copyManagedAdapters(resources);
  const nodeRuntime = copyNodeRuntime(resources);
  writeFileSync(resolve(contents, "PkgInfo"), "APPLPBRG\n");
  writeFileSync(resolve(contents, "Info.plist"), plist());
  run("chmod", ["755", resolve(macos, appName)]);
  return {
    appPath,
    executable: resolve(macos, appName),
    icon: resolve(resources, iconFileName),
    managedAdapters,
    nodeRuntime,
  };
}

// Sign the bundle. With a real Developer ID identity (PANDA_BRIDGE_CODESIGN_IDENTITY,
// e.g. "Developer ID Application: ACME (TEAMID)") the binary and bundle are signed
// with hardened runtime + entitlements + a secure timestamp, which is the only thing
// that lets the shipped app pass Gatekeeper and notarize — and is also what makes the
// macOS keychain "Always Allow" stick (a stable signature == no per-launch password
// prompt). Without it we fall back to ad-hoc ("-"), which is DEV-ONLY: ad-hoc builds
// cannot be notarized, get blocked / translocated on other Macs, and re-prompt the
// keychain on every launch.
export function signAppBundle(appPath, options = {}) {
  const identity = options.identity ?? process.env.PANDA_BRIDGE_CODESIGN_IDENTITY ?? "-";
  const adhoc = identity === "-";
  const executable = resolve(appPath, "Contents", "MacOS", appName);

  if (adhoc) {
    console.warn(
      "[codesign] ad-hoc signing (DEV ONLY). This build will NOT pass Gatekeeper, " +
        "cannot be notarized, and re-prompts the keychain every launch on other Macs. " +
        "Set PANDA_BRIDGE_CODESIGN_IDENTITY to a Developer ID Application identity to ship.",
    );
    const result = spawnSync("codesign", ["--force", "--sign", "-", appPath], { stdio: "inherit" });
    return { identity, adhoc: true, hardened_runtime: false, ok: result.status === 0 };
  }

  writeEntitlements();
  const common = [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--entitlements",
    entitlementsPath,
    "--sign",
    identity,
  ];
  // Sign inner-most first (the executable), then the bundle. (--deep is deprecated.)
  const inner = spawnSync("codesign", [...common, executable], { stdio: "inherit" });
  const outer = spawnSync("codesign", [...common, appPath], { stdio: "inherit" });
  const verify = spawnSync("codesign", ["--verify", "--strict", "--verbose=2", appPath], { stdio: "inherit" });
  return {
    identity,
    adhoc: false,
    hardened_runtime: true,
    ok: inner.status === 0 && outer.status === 0 && verify.status === 0,
  };
}

// Submit to Apple's notary service and staple the ticket. Gated on credentials:
// either PANDA_BRIDGE_NOTARY_PROFILE (a `xcrun notarytool store-credentials` profile)
// or PANDA_BRIDGE_NOTARY_APPLE_ID + _TEAM_ID + _PASSWORD (an app-specific password).
// Without credentials it skips cleanly (returns notarized:false, skipped:true) so the
// dev/ad-hoc path keeps working.
export function notarizeApp({ appPath, dmgPath }) {
  const target = dmgPath ?? appPath;
  if (!target) return { notarized: false, skipped: true, reason: "no target to notarize" };

  const profile = process.env.PANDA_BRIDGE_NOTARY_PROFILE;
  const appleId = process.env.PANDA_BRIDGE_NOTARY_APPLE_ID;
  const teamId = process.env.PANDA_BRIDGE_NOTARY_TEAM_ID;
  const password = process.env.PANDA_BRIDGE_NOTARY_PASSWORD;
  const credArgs = profile
    ? ["--keychain-profile", profile]
    : appleId && teamId && password
      ? ["--apple-id", appleId, "--team-id", teamId, "--password", password]
      : null;
  if (!credArgs) {
    console.warn(
      "[notarize] skipped: set PANDA_BRIDGE_NOTARY_PROFILE (from `xcrun notarytool store-credentials`) " +
        "or PANDA_BRIDGE_NOTARY_APPLE_ID/_TEAM_ID/_PASSWORD to notarize for distribution.",
    );
    return { notarized: false, skipped: true, reason: "no notary credentials" };
  }

  const submit = spawnSync("xcrun", ["notarytool", "submit", target, ...credArgs, "--wait"], { stdio: "inherit" });
  if (submit.status !== 0) return { notarized: false, ok: false, reason: "notarytool submit failed" };

  // Staple the ticket so Gatekeeper validates offline.
  const stapleTargets = [dmgPath, appPath].filter(Boolean);
  for (const item of stapleTargets) {
    spawnSync("xcrun", ["stapler", "staple", item], { stdio: "inherit" });
  }
  return { notarized: true, ok: true, stapled: stapleTargets };
}

function writeEntitlements() {
  mkdirSync(resolve("dist/desktop/macos"), { recursive: true });
  // Minimal hardened-runtime entitlements for a Developer-ID (non-sandboxed) wry app:
  // WKWebView needs JIT + unsigned executable memory. Network and login-keychain access
  // need no entitlement for a non-sandboxed app.
  writeFileSync(
    entitlementsPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
`,
  );
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.stdio ?? "inherit" });
  if (result.status !== 0 && !options.optional) process.exit(result.status || 1);
  return result;
}

function copyManagedAdapters(resources) {
  const source = process.env.PANDA_BRIDGE_MANAGED_ADAPTERS_DIR;
  const copied = [];
  if (!source) return copied;
  const sourceRoot = resolve(source);
  if (!existsSync(sourceRoot)) {
    throw new Error(`PANDA_BRIDGE_MANAGED_ADAPTERS_DIR not found: ${sourceRoot}`);
  }
  const adaptersDir = resolve(resources, "adapters");
  mkdirSync(adaptersDir, { recursive: true });
  for (const adapter of managedAdapterSources(sourceRoot)) {
    const target = resolve(adaptersDir, adapter.productId);
    cpSync(adapter.sourceDir, target, { recursive: true, force: true });
    copied.push(target);
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
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const productId = String(manifest.product_id || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(productId)) {
    throw new Error(`managed adapter manifest has invalid product_id: ${manifestPath}`);
  }
  return { sourceDir, productId };
}

function copyNodeRuntime(resources) {
  const source = process.env.PANDA_BRIDGE_NODE_RUNTIME_DIR;
  if (!source) return null;
  const resolved = resolve(source);
  if (!existsSync(resolved)) {
    throw new Error(`PANDA_BRIDGE_NODE_RUNTIME_DIR not found: ${resolved}`);
  }
  const target = resolve(resources, "runtime", "node");
  cpSync(resolved, target, { recursive: true, force: true });
  return target;
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
