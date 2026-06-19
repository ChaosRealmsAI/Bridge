import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  bridgeRelayEnvelopeAadText,
  bridgeRelayKeyBootstrapAadText,
} from "../../packages/sdk/src/index.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const android = read("packages/native/android/src/main/java/cc/pandabridge/sdk/BridgeRelaySdk.kt");
const ios = read("packages/native/ios/Sources/PandaBridgeKit/BridgeRelay.swift");
const platformChecks = [];

const envelopeAad = bridgeRelayEnvelopeAadText({
  productId: "panda-burn",
  deviceId: "dev_1",
  channelId: "chan_1",
  direction: "product_to_device",
  seq: 1,
  authorizationId: "auth_1",
  authorizationEpoch: 3,
  relayKeyId: "rk_1",
});
assert.equal(
  envelopeAad,
  "product:panda-burn|device:dev_1|channel:chan_1|direction:product_to_device|seq:1|authorization:auth_1|epoch:3|relay_key:rk_1",
);

const bootstrapAad = bridgeRelayKeyBootstrapAadText({
  productId: "panda-burn",
  deviceId: "dev_1",
  authorizationId: "auth_1",
  authorizationEpoch: 3,
  relayKeyId: "rk_1",
});
assert.equal(bootstrapAad, "bridge-relay-key-bootstrap-v1|panda-burn|dev_1|auth_1|3|rk_1");

for (const [name, text] of [["Android", android], ["iOS", ios]]) {
  for (const marker of [
    "direction:",
    "authorization:",
    "epoch:",
    "relay_key:",
    "bridge-relay-key-bootstrap-v1",
    "product_to_device",
    "device_to_product",
    "after_seq",
    "wait_ms",
  ]) {
    assert.ok(text.includes(marker), `${name} native SDK missing relay parity marker ${marker}`);
  }
  const hasAckPath = text.includes("/ack") || text.includes("appendPathComponent(\"ack\")");
  assert.ok(hasAckPath, `${name} native SDK missing relay parity marker ack path`);
  for (const productMarker of [/\bburn\b/i, /\bcodex\b/i, /\bclaude\b/i]) {
    assert.equal(productMarker.test(text), false, `${name} native SDK must stay product-neutral: ${productMarker}`);
  }
}

platformChecks.push(runFlutterTests());
platformChecks.push(runSwiftBuild());
platformChecks.push(runAndroidCompile());

const failed = platformChecks.filter((check) => check.status === "failed");
const output = {
  ok: failed.length === 0,
  check: "native-sdk-parity",
  parity_markers: {
    android: "passed",
    ios: "passed",
    js_aad_reference: "passed",
  },
  platform_checks: platformChecks,
};
console.log(JSON.stringify(output, null, 2));
assert.deepEqual(failed, [], `native SDK platform checks failed:\n${failed.map((check) => `${check.id}: ${check.command}\n${check.stderr || check.stdout}`).join("\n")}`);

function read(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

function runFlutterTests() {
  const cwd = resolve(root, "packages/native/flutter");
  const available = commandAvailable("flutter", ["--version"]);
  if (!available.ok) return skipped("flutter_test", "flutter command unavailable", "flutter --version");
  return runRequired("flutter_test", "flutter", ["test"], { cwd });
}

function runSwiftBuild() {
  const packagePath = resolve(root, "packages/native/ios");
  const available = commandAvailable("swift", ["--version"]);
  if (!available.ok) return skipped("swift_build", "swift command unavailable", "swift --version");
  return runRequired("swift_build", "swift", ["build", "--package-path", packagePath], { cwd: root });
}

function runAndroidCompile() {
  const androidSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
  if (!androidSdk || !existsSync(androidSdk)) {
    return skipped("android_gradle_compile", "android sdk unavailable", "ANDROID_HOME or ANDROID_SDK_ROOT");
  }
  const gradle = gradleCommand();
  if (!gradle) return skipped("android_gradle_compile", "gradle command unavailable", "gradle --version");
  const [command, ...prefixArgs] = gradle;
  return runRequired("android_gradle_compile", command, [...prefixArgs, "-p", resolve(root, "packages/native/android"), "assembleDebug"], { cwd: root });
}

function gradleCommand() {
  const wrapper = resolve(root, "gradlew");
  if (existsSync(wrapper)) return [wrapper];
  const available = commandAvailable("gradle", ["--version"]);
  return available.ok ? ["gradle"] : null;
}

function commandAvailable(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") return { ok: false, reason: `${command} not found` };
  if (result.error) return { ok: false, reason: result.error.message };
  return { ok: result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runRequired(id, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    id,
    status: result.status === 0 ? "passed" : "failed",
    command: [command, ...args].join(" "),
    cwd: options.cwd || root,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr || result.error?.message || ""),
  };
}

function skipped(id, reason, evidence) {
  return {
    id,
    status: "skipped_unavailable",
    reason,
    evidence,
  };
}

function tail(text, max = 4000) {
  const value = String(text || "");
  return value.length > max ? value.slice(-max) : value;
}
