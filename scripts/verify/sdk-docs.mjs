#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);

const sdkReadme = read("packages/sdk/README.md");
const callingGuide = read("docs/sdk-calling-guide.md");
const productIntegration = read("docs/product-integration.md");
const desktopUserGuide = read("docs/desktop-user-guide.md");
const sdkSource = read("packages/sdk/src/index.js");
const sdkTypes = read("packages/sdk/src/index.d.ts");
const serverSource = read("packages/sdk/src/server.js");
const serverTypes = read("packages/sdk/src/server.d.ts");
const adapterSource = read("packages/adapter-sdk/src/index.js");
const adapterTypes = read("packages/adapter-sdk/src/index.d.ts");
const minimalCaller = read("examples/minimal-caller/run-local.mjs");
const minimalCallerReadme = read("examples/minimal-caller/README.md");
const packageJson = JSON.parse(read("package.json"));
const sdkPackage = JSON.parse(read("packages/sdk/package.json"));
const adapterPackage = JSON.parse(read("packages/adapter-sdk/package.json"));

for (const marker of [
  "createBridgeClient",
  "bridgeRelayEnvelopeAadText",
  "bridgeRelayKeyBootstrapAadText",
  "createCall",
  "waitForResponse",
  "BridgeRelaySession",
]) {
  assert.ok(sdkSource.includes(marker) || sdkTypes.includes(marker), `browser SDK missing public marker: ${marker}`);
}

for (const marker of [
  "createBridgeServerClient",
  "createConnectIntent",
  "install_id",
  "bootstrapRelayKey",
  "createRelayEnvelope",
  "listRelayEnvelopes",
  "ackRelayEnvelope",
  "waitForResponse",
]) {
  assert.ok(serverSource.includes(marker), `server SDK source missing marker: ${marker}`);
  assert.ok(serverTypes.includes(marker), `server SDK types missing marker: ${marker}`);
}

for (const marker of [
  "bridgeAdapterAuthorizationContextDenial",
  "createBridgeAdapterResponseCache",
  "getOrSetAsync",
  "decryptBridgeRelayEnvelope",
  "encryptBridgeRelayResponseEnvelope",
]) {
  assert.ok(adapterSource.includes(marker), `adapter SDK source missing marker: ${marker}`);
  assert.ok(adapterTypes.includes(marker), `adapter SDK types missing marker: ${marker}`);
}

for (const doc of [
  ["packages/sdk/README.md", sdkReadme],
  ["docs/sdk-calling-guide.md", callingGuide],
  ["docs/product-integration.md", productIntegration],
]) {
  const [name, text] = doc;
  for (const marker of [
    "createBridgeServerClient",
    "createConnectIntent",
    "installId",
    "install_id",
    "bootstrapRelayKey",
    "createRelayEnvelope",
    "listRelayEnvelopes",
    "waitForResponse",
    "ack",
    "Product Adapter",
  ]) {
    assert.ok(text.includes(marker), `${name} missing SDK docs marker: ${marker}`);
  }
}

for (const doc of [
  ["docs/sdk-calling-guide.md", callingGuide],
  ["docs/product-integration.md", productIntegration],
]) {
  const [name, text] = doc;
  assert.ok(text.includes("未发布到 npm"), `${name} must state current npm publication status`);
  assert.ok(text.includes("file:"), `${name} must document current local/file dependency mode`);
}

for (const marker of ["coco.", "syllo.", "codex.", "claude.", "shell.run", "fs.read", "fs.write"]) {
  assert.equal(adapterSource.includes(marker), false, `adapter SDK must not contain vertical business marker: ${marker}`);
  assert.equal(adapterTypes.includes(marker), false, `adapter SDK types must not contain vertical business marker: ${marker}`);
  assert.equal(serverSource.includes(marker), false, `server SDK must not contain vertical business marker: ${marker}`);
}

for (const marker of [
  "createBridgeServerClient",
  "createConnectIntent",
  "bootstrapRelayKey",
  "createRelayEnvelope",
  "waitForResponse",
  "connectorReadAndReply",
]) {
  assert.ok(minimalCaller.includes(marker), `minimal caller run file missing current relay marker: ${marker}`);
  assert.ok(minimalCallerReadme.includes(marker), `minimal caller README missing current relay marker: ${marker}`);
}

for (const staleMarker of ["createJob", "jobEvents", "codex.chat"]) {
  assert.equal(minimalCaller.includes(staleMarker), false, `minimal caller run file contains stale job marker: ${staleMarker}`);
  assert.equal(minimalCallerReadme.includes(staleMarker), false, `minimal caller README contains stale job marker: ${staleMarker}`);
}

assert.equal(sdkPackage.exports["./server"].default, "./src/server.js");
assert.equal(adapterPackage.exports["."].default, "./src/index.js");
assert.ok(packageJson.scripts["check:sdk-docs"]?.includes("scripts/verify/sdk-docs.mjs"), "root package must expose check:sdk-docs");

for (const [name, text] of [
  ["docs/desktop-user-guide.md", desktopUserGuide],
]) {
  for (const marker of [
    "AI runtime",
    "local Agent",
    "before executing jobs",
    "allow jobs",
    "`codex.chat`",
    "`codex.run`",
    "`codex.rpc`",
    "codex login",
    "bridge_jobs",
    "bridge_job_events",
    "verify:cloud",
  ]) {
    assert.equal(text.includes(marker), false, `${name} contains stale runtime docs marker: ${marker}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  check: "bridge-sdk-docs",
  docs: ["packages/sdk/README.md", "docs/sdk-calling-guide.md", "docs/product-integration.md", "examples/minimal-caller/README.md", "docs/desktop-user-guide.md"],
  packages: [sdkPackage.name, adapterPackage.name],
}));

function read(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}
