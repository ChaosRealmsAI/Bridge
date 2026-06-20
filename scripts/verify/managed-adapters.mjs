#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  decryptBridgeRelayEnvelope,
  encryptBridgeRelayEnvelope,
} from "@bridge/adapter-sdk";

import {
  bridgeManagedAdapterNodePackages,
  copyBridgeManagedAdapterNodeModules,
  managedAdapterSources,
} from "../desktop/managed-adapters.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const adaptersRoot = resolve(root, "adapters");
const temp = mkdtempSync(join(tmpdir(), "bridge-managed-adapters-"));

try {
  assert.ok(existsSync(adaptersRoot), "adapters directory is required");
  const adapters = managedAdapterSources(adaptersRoot);
  assert.ok(adapters.length > 0, "at least one managed adapter manifest is required");

  for (const adapter of adapters) validateManifest(adapter);

  const installRoot = join(temp, "installed-app");
  const installAdaptersRoot = join(installRoot, "adapters");
  mkdirSync(installAdaptersRoot, { recursive: true });
  for (const adapter of adapters) {
    cpSync(adapter.sourceDir, join(installAdaptersRoot, adapter.productId), {
      recursive: true,
      force: true,
    });
  }
  const copiedPackages = copyBridgeManagedAdapterNodeModules(installRoot, { packageRoot: root });
  for (const item of bridgeManagedAdapterNodePackages) {
    assert.ok(copiedPackages.some((copied) => copied.name === item.name), `managed adapter bridge package missing: ${item.name}`);
  }
  for (const dependencyName of adapterRuntimeDependencies(adapters)) {
    assert.ok(copiedPackages.some((item) => item.name === dependencyName), `managed adapter runtime package missing: ${dependencyName}`);
  }

  const started = [];
  for (const adapter of managedAdapterSources(installAdaptersRoot)) {
    started.push(await assertNodeAdapterStarts(adapter));
  }

  console.log(JSON.stringify({
    ok: true,
    check: "managed-adapters",
    adapters: started,
    node_packages: copiedPackages.map((item) => item.name),
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function validateManifest(adapter) {
  const manifest = adapter.manifest;
  assert.equal(manifest.schema, "panda.bridge.managed-adapter.v1", `${adapter.manifestPath} schema`);
  assert.equal(manifest.product_id, adapter.productId, `${adapter.manifestPath} product_id mismatch`);
  assert.equal(typeof manifest.product_name, "string", `${adapter.manifestPath} product_name required`);
  assert.equal(manifest.runtime?.type, "node", `${adapter.manifestPath} runtime.type must be node`);
  assert.equal(typeof manifest.runtime.entry, "string", `${adapter.manifestPath} runtime.entry required`);
  assert.ok(manifest.runtime.entry.length > 0, `${adapter.manifestPath} runtime.entry empty`);
  assert.ok(Array.isArray(manifest.runtime.args), `${adapter.manifestPath} runtime.args must be an array`);
  assert.ok(existsSync(resolve(adapter.sourceDir, manifest.runtime.entry)), `${adapter.manifestPath} runtime entry missing`);
  assert.equal(manifest.health?.path, "/v1/health", `${adapter.manifestPath} health path`);
  assert.ok(Array.isArray(manifest.capabilities), `${adapter.manifestPath} capabilities must be an array`);
  assert.ok(manifest.capabilities.includes("relay.envelope"), `${adapter.manifestPath} missing relay.envelope`);
  const expectedCommands = commandContract(adapter);
  if (expectedCommands) {
    assert.ok(Array.isArray(manifest.commands), `${adapter.manifestPath} commands must be an array`);
    assert.deepEqual(
      [...manifest.commands].sort(),
      [...expectedCommands].sort(),
      `${adapter.manifestPath} command contract drifted`,
    );
  }
  if (adapter.productId === "panda-burn") validatePandaBurnManifestDiagnostics(adapter, manifest);
}

function validatePandaBurnManifestDiagnostics(adapter, manifest) {
  for (const command of [
    "burn.relay.health",
    "burn.agent.capabilities.get",
    "burn.agent.login.diagnostics",
    "burn.agent.health.scan",
  ]) {
    assert.ok(
      manifest.commands.includes(command),
      `${adapter.manifestPath} missing diagnostic command: ${command}`,
    );
  }
}

function commandContract(adapter) {
  const contractPath = resolve(adapter.sourceDir, "command-contract.json");
  if (!existsSync(contractPath)) return null;
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.equal(typeof contract.schema, "string", `${contractPath} schema required`);
  assert.ok(Array.isArray(contract.commands), `${contractPath} commands must be an array`);
  return contract.commands;
}

function adapterRuntimeDependencies(adapters) {
  const dependencies = new Set();
  for (const adapter of adapters) {
    const packagePath = resolve(adapter.sourceDir, "package.json");
    if (!existsSync(packagePath)) continue;
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    for (const dependencyName of Object.keys(packageJson.dependencies || {})) {
      if (dependencyName.startsWith("@bridge/")) continue;
      dependencies.add(dependencyName);
    }
  }
  return dependencies;
}

async function assertNodeAdapterStarts(adapter) {
  const manifest = JSON.parse(readFileSync(adapter.manifestPath, "utf8"));
  const cwd = resolve(adapter.sourceDir, manifest.runtime.cwd || ".");
  const entry = resolve(adapter.sourceDir, manifest.runtime.entry);
  const keyBytes = randomBytes(32);
  const keyB64 = keyBytes.toString("base64");
  const child = spawn("node", [entry, ...(manifest.runtime.args || [])], {
    cwd,
    env: {
      ...process.env,
      BRIDGE_RELAY_KEY_B64: keyB64,
      HOME: join(temp, "home"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  try {
    const line = await readFirstStdoutLine(child, stderr);
    const ready = JSON.parse(line);
    assert.equal(ready.ok, true, `${adapter.productId} ready.ok`);
    assert.equal(ready.product_id, adapter.productId, `${adapter.productId} ready product_id`);
    assert.equal(typeof ready.url, "string", `${adapter.productId} ready url`);
    const relayUrl = new URL(ready.url);
    assert.equal(relayUrl.pathname, "/v1/relay-envelope", `${adapter.productId} relay path`);
    const healthUrl = new URL("/v1/health", relayUrl.origin);
    const response = await fetch(healthUrl);
    const health = await response.json();
    assert.equal(response.status, 200, `${adapter.productId} health status`);
    assert.equal(health.ok, true, `${adapter.productId} health ok`);
    assert.equal(health.product_id, adapter.productId, `${adapter.productId} health product_id`);
    const diagnostics = adapter.productId === "panda-burn"
      ? await assertPandaBurnCapabilityDiagnostics(adapter, relayUrl, keyBytes)
      : null;
    return {
      product_id: adapter.productId,
      entry: manifest.runtime.entry,
      manifest_commands: Array.isArray(manifest.commands) ? manifest.commands.length : 0,
      manifest_capabilities: manifest.capabilities || [],
      ready_url: ready.url,
      health: health.status,
      diagnostics,
    };
  } finally {
    await stopChild(child);
  }
}

async function assertPandaBurnCapabilityDiagnostics(adapter, relayUrl, keyBytes) {
  const command = {
    version: "burn-relay-v1",
    type: "burn.agent.capabilities.get",
    request_id: "verify-managed-adapter-capabilities",
    input: {},
  };
  const request = await encryptBridgeRelayEnvelope(command, keyBytes, {
    product_id: adapter.productId,
    device_id: "verify-managed-adapters",
    channel_id: "verify-managed-adapters",
    seq: 1,
    request_key: "verify-managed-adapter-capabilities",
    adapter_id: adapter.productId,
    schema_id: "burn-relay-v1",
  });
  const response = await fetch(relayUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `${adapter.productId} capability relay status`);
  assert.equal(payload.ok, true, `${adapter.productId} capability relay ok`);
  const decoded = await decryptBridgeRelayEnvelope(payload.response_envelope, keyBytes);
  assert.equal(decoded.ok, true, `${adapter.productId} capability command ok`);
  assert.equal(decoded.type, "burn.agent.capabilities.get", `${adapter.productId} capability command type`);
  assert.equal(decoded.data?.schema, "burn.agent.capabilities.v1", `${adapter.productId} capability schema`);
  assert.equal(decoded.data?.providers?.codex?.profile_inventory, true, `${adapter.productId} codex capability inventory`);
  assert.equal(decoded.data?.providers?.claude?.profile_inventory, true, `${adapter.productId} claude capability inventory`);
  return {
    command: decoded.type,
    schema: decoded.data.schema,
    providers: Object.keys(decoded.data.providers || {}),
  };
}

async function readFirstStdoutLine(child, stderr) {
  let buffer = "";
  return await new Promise((resolveLine, rejectLine) => {
    const timeout = setTimeout(() => {
      rejectLine(new Error(`adapter_ready_timeout: ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`));
    }, 8000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      clearTimeout(timeout);
      resolveLine(buffer.slice(0, index).trim());
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      rejectLine(new Error(`adapter_exited_before_ready:${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectLine(error);
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timer);
  }
}
