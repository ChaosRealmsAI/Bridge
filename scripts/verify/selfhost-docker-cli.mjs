#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const PRODUCT_ID = "acme-demo";
const PRODUCT_NAME = "Acme Demo";
const ADMIN_TOKEN = `selfhost-admin-${Date.now()}`;
const DOCUMENTED_DOCKER_PAIR_COMMAND = "docker compose exec bridge-server node scripts/selfhost/bridge-server.mjs pair";
const LOCAL_PAIR_COMMAND = "node scripts/selfhost/bridge-server.mjs pair";
const evidenceDir = resolve("spec/L3/evidence/personal-selfhost-docker-cli");
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-selfhost-docker-cli-"));
const realHome = process.env.HOME || process.env.USERPROFILE || "";
const serverEnv = {
  ...process.env,
  BRIDGE_SELFHOST_ADMIN_TOKEN: ADMIN_TOKEN,
  BRIDGE_SERVER_STARTUP_PAIR: "1",
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_ENV: "local",
  BRIDGE_PRODUCT_REGISTRY_MODE: "replace",
  BRIDGE_PRODUCT_REGISTRY_JSON: JSON.stringify({
    products: [{
      id: PRODUCT_ID,
      name: PRODUCT_NAME,
      official_origin: "http://127.0.0.1:0",
      web_url: "http://127.0.0.1:0/acme",
    }],
  }),
};

rmSync(evidenceDir, { recursive: true, force: true });
mkdirSync(evidenceDir, { recursive: true });

const docker = await dockerAvailability();
const server = await startBridgeServer();

try {
  const startup = parsePairOutput(server.stdout, "startup");
  assert.match(startup.token, /^[A-Z0-9]{4}-[A-Z0-9]{4,6}$/);
  assert.equal(containsLongLivedCredential(server.stdout), false, "startup output must not contain a long-lived device credential");
  const health = await fetchJson(`${server.url}/v1/health`);
  assert.equal(health.ok, true);

  const pairCommand = await runCommand(process.execPath, [
    "scripts/selfhost/bridge-server.mjs",
    "pair",
    "--url",
    server.url,
    "--admin-token",
    ADMIN_TOKEN,
    "--device-name",
    "Panda Bridge Desktop CLI Verification",
  ], { env: serverEnv });
  assert.equal(pairCommand.status, 0, commandMessage(pairCommand));
  assert.equal(containsLongLivedCredential(pairCommand.stdout), false, "pair command output must not contain a long-lived device credential");
  const cliPair = parsePairOutput(pairCommand.stdout, "pair-command");
  assert.match(cliPair.token, /^[A-Z0-9]{4}-[A-Z0-9]{4,6}$/);
  assert.notEqual(cliPair.token, startup.token, "pair command should generate a fresh token");

const paired = await runDesktop([
    "headless-pair-selfhost-profile",
    "--api",
    server.url,
    "--token",
    cliPair.token,
    "--name",
    "My Server",
    "--device-name",
    "Panda Bridge Desktop CLI Verification",
  ], "paired");
  assert.equal(paired.status, 0, commandMessage(paired));
  const settings = JSON.parse(paired.stdout);
  const profile = settings.cloud_profiles.find((item) => item.api_base === server.url);
  assert.ok(profile, "Desktop must save the My Server profile");
  assert.equal(profile.source, "selfhost");
  assert.ok((profile.products || []).some((item) => item.id === "panda-burn"), "server Profile must keep fixed Burn product");
  assert.equal((profile.products || []).some((item) => item.id === PRODUCT_ID), false, "server diagnostics product must not replace the fixed catalog");
  assert.equal(JSON.stringify(settings).includes(cliPair.token), false, "Desktop settings must not contain the original Pairing Token");

  const reused = await runDesktop([
    "headless-pair-selfhost-profile",
    "--api",
    server.url,
    "--token",
    cliPair.token,
    "--name",
    "My Server",
  ], "reused");
  assert.notEqual(reused.status, 0, "reused Pairing Token must fail");

  const evidence = {
    ok: true,
    docker,
    local_equivalent_used: true,
    documented_docker_pair_command: DOCUMENTED_DOCKER_PAIR_COMMAND,
    docker_pair_command_verified_in_this_environment: false,
    local_pair_command_verified: LOCAL_PAIR_COMMAND,
    server_url: server.url,
    startup_output: redactPairOutput(server.stdout),
    pair_command_output: redactPairOutput(pairCommand.stdout),
    pair_command_expires: cliPair.expires,
    pair_token_shape: tokenShape(cliPair.token),
    no_long_lived_credential_printed_by_pair_command: !containsLongLivedCredential(pairCommand.stdout),
    desktop_pairing: {
      paired_profile_source: profile.source,
      profile_products: (profile.products || []).map((item) => item.id),
      desktop_settings_contains_original_pairing_token: JSON.stringify(settings).includes(cliPair.token),
      reused_token_rejected: reused.status !== 0,
    },
    checks: [
      "Server URL emitted by bridge-server serve startup.",
      "Pairing Token and Expires emitted by bridge-server pair.",
      `Documented Docker exec command is ${DOCUMENTED_DOCKER_PAIR_COMMAND}; this verifier executed the same Node entrypoint locally because Compose state is not mutated here.`,
      "Pairing Token from bridge-server pair was consumed by Desktop headless pairing.",
      "Consumed Pairing Token could not be reused by a fresh Desktop state.",
      "Pair command output did not include pbd_ device credentials or device_token fields.",
    ],
    checked_at: new Date().toISOString(),
  };
  writeFileSync(resolve(evidenceDir, "summary.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, "pair-command-redacted.txt"), redactPairOutput(pairCommand.stdout));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  server.stop();
  rmSync(temp, { recursive: true, force: true });
}

async function startBridgeServer() {
  const child = spawn(process.execPath, [
    "scripts/selfhost/bridge-server.mjs",
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
  ], {
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const started = await waitFor(() => {
    const parsed = tryParsePairOutput(stdout);
    return parsed?.serverUrl ? parsed : null;
  }, {
    timeoutMs: 10000,
    onTimeout: () => {
      child.kill("SIGTERM");
      throw new Error(`bridge-server serve did not emit startup pair output. stdout=${stdout} stderr=${stderr}`);
    },
  });
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    url: started.serverUrl,
    stop() {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

function runDesktop(args, label) {
  const statePath = resolve(temp, `${label}-desktop-state.json`);
  const homePath = resolve(temp, `${label}-home`);
  mkdirSync(homePath, { recursive: true });
  return runCommand("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
    env: {
      ...process.env,
      HOME: homePath,
      USERPROFILE: homePath,
      CARGO_HOME: process.env.CARGO_HOME || (realHome ? resolve(realHome, ".cargo") : undefined),
      RUSTUP_HOME: process.env.RUSTUP_HOME || (realHome ? resolve(realHome, ".rustup") : undefined),
      PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT: "1",
      PANDA_BRIDGE_DESKTOP_STATE: statePath,
      PANDA_BRIDGE_SKIP_KEYCHAIN: "1",
    },
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand) => {
    let resolved = false;
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (resolved) return;
      resolved = true;
      resolveCommand({ command, args, status: null, signal: null, stdout, stderr, error: error.message || String(error) });
    });
    child.on("close", (status, signal) => {
      if (resolved) return;
      resolved = true;
      resolveCommand({ command, args, status, signal, stdout, stderr });
    });
  });
}

async function dockerAvailability() {
  const dockerVersion = await runCommand("docker", ["--version"]);
  const composePlugin = dockerVersion.status === 0 ? await runCommand("docker", ["compose", "version"]) : null;
  const composeStandalone = dockerVersion.status === 0 && composePlugin?.status !== 0
    ? await runCommand("docker-compose", ["--version"])
    : null;
  return {
    docker_cli_available: dockerVersion.status === 0,
    docker_version: dockerVersion.status === 0 ? dockerVersion.stdout.trim() : null,
    compose_available: Boolean(composePlugin?.status === 0 || composeStandalone?.status === 0),
    compose_version: composePlugin?.status === 0 ? composePlugin.stdout.trim() : composeStandalone?.status === 0 ? composeStandalone.stdout.trim() : null,
    docker_compose_run: false,
    docker_compose_run_reason: composePlugin?.status === 0 || composeStandalone?.status === 0
      ? `Verifier did not mutate an existing Compose service; it checked the same Node entrypoint as ${DOCUMENTED_DOCKER_PAIR_COMMAND}.`
      : `Docker Compose is not available in this environment; verifier checked the same Node entrypoint as ${DOCUMENTED_DOCKER_PAIR_COMMAND}.`,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const payload = await response.json();
  assert.ok(response.ok, JSON.stringify(payload));
  return payload;
}

function tryParsePairOutput(output) {
  try {
    return parsePairOutput(output, "output");
  } catch {
    return null;
  }
}

function parsePairOutput(output, label) {
  const serverUrl = matchLine(output, "Server URL");
  const token = matchLine(output, "Pairing Token");
  const expires = matchLine(output, "Expires");
  assert.ok(serverUrl, `${label} missing Server URL`);
  assert.ok(token, `${label} missing Pairing Token`);
  assert.ok(expires, `${label} missing Expires`);
  assert.equal(token.includes("run bridge-server pair"), false, `${label} did not generate a Pairing Token`);
  return { serverUrl, token, expires };
}

function matchLine(output, label) {
  const match = String(output).match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() || "";
}

function redactPairOutput(output) {
  return String(output)
    .replace(/^Pairing Token:\s*.+$/m, "Pairing Token: [redacted-pairing-token]")
    .replace(/pbd_[A-Za-z0-9._-]+/g, "[redacted-device-token]");
}

function tokenShape(token) {
  return token.replace(/[A-Z0-9]/g, "X");
}

function containsLongLivedCredential(output) {
  return /pbd_[A-Za-z0-9._-]+/.test(output) || /device_token/i.test(output);
}

async function waitFor(probe, { timeoutMs, onTimeout }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return onTimeout();
}

function commandMessage(child) {
  return JSON.stringify({
    command: child.command,
    args: child.args,
    status: child.status,
    signal: child.signal,
    error: child.error,
    stdout: child.stdout,
    stderr: child.stderr,
  });
}
