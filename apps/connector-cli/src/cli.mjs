#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import readline from "node:readline";

const VERSION = "panda-bridge-connector-v0.1";
const DEFAULT_API = (process.env.PANDA_BRIDGE_API_BASE || "https://api.bridge.otherline.cc").replace(/\/$/, "");
const DEFAULT_STATE = resolve(homedir(), ".panda-bridge", "connector.json");
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "help";

try {
  let oneShot = true;
  if (command === "help" || args.help) printHelp();
  else if (command === "connect") await connect();
  else if (command === "claim") await claim();
  else if (command === "heartbeat") await heartbeat();
  else if (command === "poll") await poll();
  else if (command === "watch") {
    oneShot = false;
    await watch();
  }
  else if (command === "doctor") await doctor();
  else if (command === "run-fixture") await runFixture();
  else throw new Error(`unknown command: ${command}`);
  if (oneShot) process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function claim() {
  const api = apiBase();
  const payload = await postJson(`${api}/v1/connectors/claim`, {
    code: required("code"),
    device_name: args["device-name"] || deviceName(),
    app_version: VERSION,
    capabilities: capabilities(),
    local_state: localState(),
  });
  const state = {
    api_base: api,
    device_id: payload.device.id,
    device_token: payload.device_token,
    claimed_at: new Date().toISOString(),
  };
  writeJson(statePath(), state);
  console.log(JSON.stringify(redactState(state), null, 2));
}

async function connect() {
  const api = apiBase();
  const intent = required("intent");
  if (!args.yes && !args.assume_yes) {
    const preview = await getJson(`${api}/v1/connect-intents/${encodeURIComponent(intent)}`);
    console.error(`Connecting this machine to ${preview.connect_intent?.product_id || "Panda Bridge"} as ${args["device-name"] || deviceName()}.`);
  }
  const payload = await postJson(`${api}/v1/connect-intents/${encodeURIComponent(intent)}/claim`, {
    device_name: args["device-name"] || deviceName(),
    app_version: VERSION,
    capabilities: capabilities(),
    local_state: localState(),
    policy: {},
  });
  const state = {
    api_base: api,
    device_id: payload.device.id,
    device_token: payload.device_token,
    claimed_at: new Date().toISOString(),
  };
  writeJson(statePath(), state);
  console.log(JSON.stringify({
    ...redactState(state),
    device: payload.device,
    authorization: payload.authorization,
  }, null, 2));
}

async function heartbeat() {
  const state = loadState();
  const payload = await postJson(`${state.api_base}/v1/connectors/heartbeat`, {
    app_version: VERSION,
    capabilities: capabilities(),
    local_state: localState(),
  }, state.device_token);
  console.log(JSON.stringify(payload, null, 2));
}

async function poll() {
  const state = loadState();
  const payload = await getJson(`${state.api_base}/v1/connectors/jobs`, state.device_token);
  const results = [];
  for (const job of payload.items || []) {
    const result = await executeJob(state, job).catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    const status = result.ok === false ? "failed" : "succeeded";
    await postJson(`${state.api_base}/v1/connectors/jobs/${encodeURIComponent(job.id)}/ack`, {
      status,
      result,
    }, state.device_token);
    results.push({ job_id: job.id, kind: job.kind, status, result });
  }
  console.log(JSON.stringify({ count: results.length, results }, null, 2));
}

async function watch() {
  const intervalMs = Number(args["interval-ms"] || 1800);
  for (;;) {
    await heartbeat().catch((error) => console.error(`[heartbeat] ${error.message}`));
    await poll().catch((error) => console.error(`[poll] ${error.message}`));
    if (args.once) break;
    await sleep(intervalMs);
  }
}

async function runFixture() {
  const result = await runCodexOrFixture({
    job: {
      id: "fixture",
      kind: "codex.chat",
      workspace_ref: "default",
      input: { prompt: args.prompt || "hello" },
      policy: { timeout_ms: Number(args["timeout-ms"] || 60000) },
    },
    apiBase: "",
    token: "",
  });
  console.log(JSON.stringify(result, null, 2));
}

async function doctor() {
  const path = statePath();
  const stateRead = readConnectorState(path);
  const api = String(stateRead.state?.api_base || apiBase()).replace(/\/$/, "");
  const health = await tryGetJson(`${api}/v1/health`);
  const diagnostics = await tryGetJson(`${api}/v1/diagnostics`);
  const local = localState();
  const fixtureMode = fakeCodexEnabled();
  const codexReady = fixtureMode || Boolean(local.commands?.codex);
  const ready = Boolean(
    health.ok
    && diagnostics.ok
    && stateRead.exists
    && stateRead.state?.device_id
    && stateRead.state?.device_token
    && codexReady
  );
  const output = {
    ok: ready,
    version: VERSION,
    api_base: api,
    state: {
      path: redactLocalPath(path),
      exists: stateRead.exists,
      readable: Boolean(stateRead.state),
      error: stateRead.error,
      device_id: stateRead.state?.device_id || null,
      claimed_at: stateRead.state?.claimed_at || null,
      token_present: Boolean(stateRead.state?.device_token),
    },
    cloud: {
      health_ok: Boolean(health.ok),
      diagnostics_ok: Boolean(diagnostics.ok),
      protocol: diagnostics.payload?.protocol || health.payload?.protocol || null,
      storage: diagnostics.payload?.storage || health.payload?.storage || null,
      products_count: Array.isArray(diagnostics.payload?.products) ? diagnostics.payload.products.length : 0,
      realtime_enabled: Boolean(diagnostics.payload?.realtime?.enabled),
      supported_kinds: diagnostics.payload?.jobs?.supported_kinds || [],
      queue_limits: diagnostics.payload?.jobs?.queue_limits || null,
      error: health.error || diagnostics.error || null,
    },
    local: {
      platform: local.platform,
      commands: local.commands,
      fixture_mode: fixtureMode,
      codex_ready: codexReady,
      workspace_configured: Boolean(local.workspaces?.default),
    },
  };
  console.log(JSON.stringify(output, null, 2));
}

async function executeJob(state, job) {
  await postEvent(state, job.id, "started", { kind: job.kind, workspace_ref: job.workspace_ref });
  if (job.kind === "codex.chat" || job.kind === "codex.run") {
    return runCodexOrFixture({ job, apiBase: state.api_base, token: state.device_token });
  }
  if (job.kind === "codex.rpc") {
    return {
      ok: false,
      error: "codex.rpc is reserved in protocol v0.1; enable after method-level local authorization is implemented",
    };
  }
  return { ok: false, error: `unsupported job kind: ${job.kind}` };
}

async function runCodexOrFixture({ job, apiBase, token }) {
  if (fakeCodexEnabled()) {
    const prompt = String(job.input?.prompt || "").trim();
    const reply = `Panda Bridge fixture reply: ${prompt || "ok"}`;
    if (apiBase) await postEvent({ api_base: apiBase, device_token: token }, job.id, "text_delta", { delta: reply });
    return { ok: true, reply, fixture: true, cloud_openai_credentials: false };
  }
  return runCodexAppServer({
    job,
    apiBase,
    token,
    codexBin: codexBin(),
    cwd: workspacePath(job.workspace_ref),
    timeoutMs: Number(job.policy?.timeout_ms || 240000),
  });
}

async function runCodexAppServer({ job, apiBase, token, codexBin, cwd, timeoutMs }) {
  const prompt = String(job.input?.prompt || "").trim();
  if (!prompt) return { ok: false, error: "missing prompt" };
  const proc = spawn(codexBin, ["app-server", "--stdio"], {
    cwd,
    env: codexSpawnEnv(codexBin),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let processError = null;
  const rl = readline.createInterface({ input: proc.stdout });
  const stderr = [];
  proc.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  proc.stdin.on("error", (error) => {
    processError = error;
  });

  let nextId = 0;
  const pending = new Map();
  let finalText = "";
  let completedTurn = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    rl.close();
    proc.kill("SIGTERM");
  };

  const send = (method, params) => {
    if (processError) {
      return Promise.reject(new Error(`failed to start codex app-server at ${codexBin}: ${processError.message}`));
    }
    const id = ++nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex app-server timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve: resolvePromise, reject, timer });
      proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        processError = error;
        reject(new Error(`failed to write to codex app-server at ${codexBin}: ${error.message}`));
      });
    });
  };
  const notify = (method, params) => {
    if (!processError) proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  };

  rl.on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === "item/agentMessage/delta") {
      const delta = msg.params?.delta || "";
      finalText += delta;
      if (apiBase && delta) await postEvent({ api_base: apiBase, device_token: token }, job.id, "text_delta", { delta });
    } else if (msg.method && apiBase) {
      await postEvent({ api_base: apiBase, device_token: token }, job.id, "app_server_event", {
        method: msg.method,
        params: redactAppServerParams(msg.params),
      });
    }
    if (msg.method === "turn/completed") completedTurn = msg.params?.turn || { status: "completed" };
    if (msg.id && pending.has(msg.id)) {
      const item = pending.get(msg.id);
      clearTimeout(item.timer);
      pending.delete(msg.id);
      if (msg.error) item.reject(new Error(JSON.stringify(msg.error)));
      else item.resolve(msg.result ?? {});
    }
  });
  proc.on("exit", () => {
    closed = true;
  });
  proc.on("error", (error) => {
    processError = error;
    closed = true;
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      pending.delete(id);
      item.reject(new Error(`failed to start codex app-server at ${codexBin}: ${error.message}`));
    }
  });

  try {
    await send("initialize", {
      clientInfo: { name: "panda_bridge_connector", title: "Panda Bridge Connector", version: VERSION },
      capabilities: {},
    });
    notify("initialized", {});
    const accountResult = await send("account/read", { refreshToken: false });
    const account = summarizeCodexAccount(accountResult);
    if (!account.authenticated) throw new Error("local Codex is not signed in; run `codex` or `codex login` on this machine");
    const rateLimits = await send("account/rateLimits/read").catch(() => null);

    const thread = await send("thread/start", {
      cwd,
      sandbox: sandboxFor(job),
      approvalPolicy: approvalPolicyFor(job),
      ephemeral: job.input?.ephemeral !== false,
      developerInstructions: developerInstructionsFor(job),
    });
    const threadId = thread?.thread?.id;
    if (!threadId) throw new Error("codex app-server did not return a thread id");
    await send("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      approvalPolicy: approvalPolicyFor(job),
    });
    const turn = await waitForTurn({ timeoutMs, isClosed: () => closed, getTurn: () => completedTurn });
    const reply = finalText.trim() || extractAgentText(turn).trim();
    if (!reply) throw new Error("codex app-server completed without an assistant message");
    return {
      ok: true,
      reply,
      codex_thread_id: threadId,
      codex_turn_status: turn.status || "completed",
      codex_account: account,
      codex_rate_limits: summarizeRateLimits(rateLimits),
      cloud_openai_credentials: false,
    };
  } catch (error) {
    return {
      ok: false,
      error: `${error instanceof Error ? error.message : String(error)}; codex_bin=${codexBin}; ${stderr.join("").slice(-800)}`,
      cloud_openai_credentials: false,
    };
  } finally {
    cleanup();
  }
}

function waitForTurn({ timeoutMs, isClosed, getTurn }) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const tick = () => {
      const turn = getTurn();
      if (turn) return resolvePromise(turn);
      if (Date.now() - started > timeoutMs) return reject(new Error("codex app-server turn timed out"));
      if (isClosed()) return reject(new Error("codex app-server closed before turn completed"));
      setTimeout(tick, 120);
    };
    tick();
  });
}

async function postEvent(state, jobId, type, payload) {
  if (!state.api_base || !state.device_token) return null;
  return postJson(`${state.api_base}/v1/connectors/jobs/${encodeURIComponent(jobId)}/events`, { type, payload }, state.device_token);
}

function workspacePath(workspaceRef = "default") {
  const ref = String(workspaceRef || "default");
  const explicit = args[`workspace-${ref}`] || process.env[`PANDA_BRIDGE_WORKSPACE_${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (explicit) return resolve(explicit);
  if (args.workspace) {
    const entries = Array.isArray(args.workspace) ? args.workspace : [args.workspace];
    for (const entry of entries) {
      const [key, ...rest] = String(entry).split("=");
      if (key === ref) return resolve(rest.join("="));
    }
  }
  return resolve(args["codex-cwd"] || process.env.PANDA_BRIDGE_CODEX_CWD || process.cwd());
}

function sandboxFor(job) {
  if (job.policy?.allow_shell) return "workspace-write";
  return "read-only";
}

function approvalPolicyFor(job) {
  return job.policy?.allow_shell ? "on-request" : "never";
}

function developerInstructionsFor(job) {
  if (job.kind === "codex.chat") {
    return [
      "You are running through Panda Bridge into the user's local Codex app-server.",
      "Reply directly to the user. Use Chinese by default unless the user asks otherwise.",
      "For codex.chat, do not edit files or run shell commands.",
    ].join("\n");
  }
  return [
    "You are running through Panda Bridge into the user's local Codex app-server.",
    "Honor the user's task while respecting the local sandbox and approval policy.",
    "Cloud services request work, but the local connector controls execution authority.",
  ].join("\n");
}

function capabilities() {
  return {
    runtime: ["codex.chat", "codex.run"],
    reserved_runtime: ["codex.rpc"],
    app_server: true,
    platform: platform(),
  };
}

function localState() {
  const bin = codexBin();
  return {
    platform: platform(),
    commands: { codex: commandExists(bin) },
    workspaces: { default: workspacePath("default") },
  };
}

function fakeCodexEnabled() {
  return process.env.PANDA_BRIDGE_FAKE_CODEX === "1" || Boolean(args["fake-codex"]);
}

function summarizeCodexAccount(result) {
  const account = result?.account || null;
  return { authenticated: Boolean(account), type: account?.type || null, plan_type: account?.planType || null };
}

function summarizeRateLimits(result) {
  const rateLimits = result?.rateLimits;
  if (!rateLimits) return null;
  return {
    limit_name: rateLimits.limitName || null,
    plan_type: rateLimits.planType || null,
    primary_used_percent: rateLimits.primary?.usedPercent ?? null,
    secondary_used_percent: rateLimits.secondary?.usedPercent ?? null,
    rate_limit_reached_type: rateLimits.rateLimitReachedType || null,
  };
}

function extractAgentText(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return items.filter((item) => item?.type === "agentMessage" && item.text).map((item) => item.text).join("\n").trim();
}

function redactAppServerParams(params) {
  if (!params || typeof params !== "object") return {};
  return JSON.parse(JSON.stringify(params, (key, value) => {
    if (["cwd", "path", "env", "token"].includes(key)) return "[redacted]";
    return value;
  }));
}

function apiBase() {
  return String(args.api || DEFAULT_API).replace(/\/$/, "");
}

function statePath() {
  return resolve(args.state || process.env.PANDA_BRIDGE_CONNECTOR_STATE || DEFAULT_STATE);
}

function loadState() {
  if (!existsSync(statePath())) throw new Error(`missing connector state: ${statePath()}; run claim first`);
  return JSON.parse(readFileSync(statePath(), "utf8"));
}

function readConnectorState(path) {
  if (!existsSync(path)) return { exists: false, state: null, error: null };
  try {
    return { exists: true, state: JSON.parse(readFileSync(path, "utf8")), error: null };
  } catch (error) {
    return { exists: true, state: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

async function getJson(url, token = "") {
  const response = await fetch(url, { headers: authHeaders(token) });
  return parseResponse(response);
}

async function tryGetJson(url, token = "") {
  try {
    return { ok: true, payload: await getJson(url, token), error: null };
  } catch (error) {
    return { ok: false, payload: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function postJson(url, body, token = "") {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

async function parseResponse(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function redactState(state) {
  return { ...state, device_token: state.device_token ? `${state.device_token.slice(0, 8)}...` : "" };
}

function redactLocalPath(path) {
  const value = String(path || "");
  if (!value) return "";
  const home = homedir();
  if (value === home) return "~";
  if (value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
  return "[custom-state-path]";
}

function deviceName() {
  return `Panda Bridge ${platform()}`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      out._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    const value = !next || next.startsWith("--") ? true : (index += 1, next);
    if (out[key]) out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    else out[key] = value;
  }
  return out;
}

function required(name) {
  const value = args[name];
  if (!value || value === true) throw new Error(`missing --${name}`);
  return String(value);
}

function codexBin() {
  const explicit = args["codex-bin"] || process.env.PANDA_BRIDGE_CODEX_BIN;
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  return resolveCommand("codex") || "codex";
}

function resolveCommand(command) {
  if (String(command).includes("/") || String(command).includes("\\")) {
    return executableExists(command) ? command : null;
  }
  for (const entry of String(process.env.PATH || "").split(delimiter)) {
    if (!entry) continue;
    const candidate = resolve(entry, command);
    if (executableExists(candidate)) return candidate;
  }
  for (const candidate of commonCodexPaths()) {
    if (executableExists(candidate)) return candidate;
  }
  return null;
}

function commonCodexPaths() {
  return [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    resolve(homedir(), ".local/bin/codex"),
    resolve(homedir(), ".cargo/bin/codex"),
    resolve(homedir(), ".npm-global/bin/codex"),
  ];
}

function codexSpawnEnv(bin) {
  const env = { ...process.env };
  if (String(bin).includes("/") || String(bin).includes("\\")) {
    const dir = dirname(bin);
    env.PATH = prependPath(dir, env.PATH || "");
  }
  return env;
}

function prependPath(dir, path) {
  const entries = String(path || "").split(delimiter).filter(Boolean);
  if (entries.includes(dir)) return path;
  return [dir, ...entries].join(delimiter);
}

function commandExists(command) {
  if (String(command).includes("/") || String(command).includes("\\")) {
    return executableExists(command);
  }
  return Boolean(resolveCommand(command));
}

function executableExists(path) {
  if (!existsSync(path)) return false;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (platform() === "win32") return true;
    return Boolean(stat.mode & 0o111);
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printHelp() {
  console.log(`Panda Bridge Connector ${VERSION}

Usage:
  panda-bridge connect --api https://api.bridge.otherline.cc --intent TOKEN [--device-name NAME]
  panda-bridge claim --api https://api.bridge.otherline.cc --code XXXX-XXXX [--device-name NAME]  # legacy
  panda-bridge doctor [--api https://api.bridge.otherline.cc] [--state PATH] [--fake-codex]
  panda-bridge heartbeat
  panda-bridge poll [--fake-codex] [--codex-cwd PATH]
  panda-bridge watch [--interval-ms 1800] [--workspace default=/path/to/workspace]
  panda-bridge run-fixture --prompt hello --fake-codex

Environment:
  PANDA_BRIDGE_API_BASE
  PANDA_BRIDGE_CONNECTOR_STATE
  PANDA_BRIDGE_CODEX_BIN
  PANDA_BRIDGE_CODEX_CWD
  PANDA_BRIDGE_FAKE_CODEX=1
`);
}
