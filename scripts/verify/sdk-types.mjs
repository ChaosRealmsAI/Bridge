#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const files = {
  sdkJs: read("packages/sdk/src/index.js"),
  sdkTypes: read("packages/sdk/src/index.d.ts"),
  serverJs: read("packages/sdk/src/server.js"),
  serverTypes: read("packages/sdk/src/server.d.ts"),
  adapterJs: read("packages/adapter-sdk/src/index.js"),
  adapterTypes: read("packages/adapter-sdk/src/index.d.ts"),
  protocolJs: read("packages/protocol/src/index.js"),
};

for (const [name, text] of Object.entries(files)) {
  assertNoStaleSurface(name, text);
  assert.equal(/\bTODO\b|stub|placeholder/i.test(text), false, `${name} must not contain TODO/stub placeholders`);
}

for (const marker of [
  "export function createBridgeClient",
  "BridgeRelaySession",
  "waitForResponse",
  "createCall",
  "BridgeRelayEnvelope",
  "BridgeRelayWaitForResponseResult",
]) {
  assert.ok(files.sdkTypes.includes(marker), `SDK browser types missing ${marker}`);
}

for (const marker of [
  "export function createBridgeServerClient",
  "createConnectIntent",
  "bootstrapRelayKey",
  "createRelayEnvelope",
  "listRelayEnvelopes",
  "ackRelayEnvelope",
  "waitForResponse",
]) {
  assert.ok(files.serverTypes.includes(marker), `SDK server types missing ${marker}`);
}

for (const marker of [
  "export function decryptBridgeRelayEnvelope",
  "export function encryptBridgeRelayResponseEnvelope",
  "BridgeAuthorizationContext",
  "BridgeAdapterResponseCache",
  "getOrSetAsync",
]) {
  assert.ok(files.adapterTypes.includes(marker), `Adapter SDK types missing ${marker}`);
}

assert.equal(files.protocolJs.includes("validateRelayEnvelope"), true, "Protocol must expose relay envelope validation");
assert.equal(files.protocolJs.includes("validateBridgeJob"), false, "Protocol must not expose legacy job validation");

console.log(JSON.stringify({
  ok: true,
  check: "sdk-types",
  files: Object.keys(files),
}));

function read(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

function assertNoStaleSurface(name, text) {
  const stale = [
    "codex.",
    "claude.",
    "burn.",
    "shell.run",
    "fs.read",
    "fs.write",
    "data.put",
    "data.get",
    "data.query",
    "createJob",
    "jobEvents",
    "bridge.jobs",
    "client.jobs",
    "/v1/queue/summary",
  ];
  for (const marker of stale) {
    assert.equal(text.includes(marker), false, `${name} contains stale public surface marker: ${marker}`);
  }
}
