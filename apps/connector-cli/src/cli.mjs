#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
    authorized_products: [],
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
    policy: fullAccessAuthorizationPolicy(),
  });
  const state = {
    api_base: api,
    device_id: payload.device.id,
    device_token: payload.device_token,
    authorized_products: payload.product ? [productGrant(payload.product, payload.authorization)] : [],
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
  const job = {
    id: "fixture",
    product_id: "panda-chat",
    kind: "codex.chat",
    workspace_ref: args["workspace-ref"] || "default",
    input: { prompt: args.prompt || "hello" },
    policy: {
      timeout_ms: Number(args["timeout-ms"] || 60000),
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.sandbox ? { sandbox: args.sandbox } : {}),
      ...(args["approval-policy"] ? { approvalPolicy: args["approval-policy"] } : {}),
      ...(args["developer-instructions"] ? { developerInstructions: args["developer-instructions"] } : {}),
    },
  };
  const result = await executeJob({
    api_base: "",
    device_token: "",
    authorized_products: [productGrant(
      { id: "panda-chat", name: "Panda Chat", capabilities: ["codex.chat"] },
      fixtureGrantAuthorization(),
    )],
  }, job);
  console.log(JSON.stringify(result, null, 2));
}

function fixtureGrantAuthorization() {
  if (args["empty-grant"]) return emptyFixtureAuthorization();
  if (args["narrow-grant"]) return narrowFixtureAuthorization();
  return fixtureAuthorization();
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
  let policy;
  try {
    policy = localJobPolicyForState(state, job);
  } catch (error) {
    const denial = error instanceof Error ? error.message : String(error);
    const result = localPolicyDenialResult(job, denial);
    await postEvent(state, job.id, "policy_denied", localPolicyDenialEvent(job, denial));
    return result;
  }
  await postEvent(state, job.id, "effective_policy", effectivePolicyEvent(job, policy));
  await postEvent(state, job.id, "started", { kind: job.kind, workspace_ref: job.workspace_ref });
  if (job.kind === "codex.chat" || job.kind === "codex.run") {
    return runCodexOrFixture({ job, policy, apiBase: state.api_base, token: state.device_token });
  }
  if (job.kind === "codex.rpc") {
    return {
      ok: false,
      error: "codex.rpc is reserved in protocol v0.1; enable after method-level local authorization is implemented",
    };
  }
  return { ok: false, error: `unsupported job kind: ${job.kind}` };
}

async function runCodexOrFixture({ job, policy = effectiveJobPolicy(job), apiBase, token }) {
  if (fakeCodexEnabled()) {
    const prompt = String(job.input?.prompt || "").trim();
    const reply = `Panda Bridge fixture reply: ${prompt || "ok"}`;
    if (apiBase) await postEvent({ api_base: apiBase, device_token: token }, job.id, "text_delta", { delta: reply });
    return { ok: true, reply, fixture: true, cloud_openai_credentials: false };
  }
  return runCodexAppServer({
    job,
    policy,
    apiBase,
    token,
    codexBin: codexBin(),
    timeoutMs: Number(job.policy?.timeout_ms || 240000),
  });
}

async function runCodexAppServer({ job, policy, apiBase, token, codexBin, timeoutMs }) {
  const prompt = String(job.input?.prompt || "").trim();
  if (!prompt) return { ok: false, error: "missing prompt" };
  const proc = spawn(codexBin, ["app-server", "--stdio"], {
    cwd: policy.cwd,
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
      cwd: policy.cwd,
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
      ephemeral: job.input?.ephemeral !== false,
      developerInstructions: developerInstructionsFor(job, policy),
    });
    const threadId = thread?.thread?.id;
    if (!threadId) throw new Error("codex app-server did not return a thread id");
    await send("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      approvalPolicy: policy.approvalPolicy,
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

function developerInstructionsFor(job, policy = {}) {
  if (policy.developerInstructions) return policy.developerInstructions;
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

function localJobPolicyForState(state, job) {
  const grants = Array.isArray(state.authorized_products) ? state.authorized_products : [];
  const grant = grants.find((item) => item?.id === job.product_id);
  if (!grant) throw new Error(`product_not_authorized_locally: ${job.product_id || ""}`);
  if (Array.isArray(grant.capabilities) && grant.capabilities.length && !grant.capabilities.includes(job.kind)) {
    throw new Error(`capability_not_authorized_locally: ${job.product_id}:${job.kind}`);
  }
  if (grant.policy?.version !== "AUTH-SCOPE-v1") throw new Error("authorization_scope_missing_locally");
  const scopeError = validateAuthorizationScope(grant.policy, job);
  if (scopeError) throw new Error(scopeError);
  try {
    return effectiveJobPolicy(job, grant.policy);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function validateLocalJobAuthorization(state, job) {
  try {
    localJobPolicyForState(state, job);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validateAuthorizationScope(scope, job) {
  if (!Array.isArray(scope.capabilities) || !scope.capabilities.includes(job.kind)) {
    return `capability_not_authorized_locally: ${job.product_id}:${job.kind}`;
  }
  const workspaceRef = job.workspace_ref || "default";
  if (!authorizationScopeAllowsWorkspace(scope, workspaceRef)) return `workspace_not_allowed_locally: ${workspaceRef}`;
  const requestedSandbox = policyString(job.policy, "sandbox") || (job.policy?.allow_shell ? "workspace-write" : "read-only");
  const sandboxFloor = policyString(scope, "sandbox_floor") || "workspace-write";
  if (!authorizationScopeAllowsSandbox(sandboxFloor, requestedSandbox)) return `sandbox_not_allowed_locally: ${requestedSandbox}`;
  const requestedApproval = policyString(job.policy, "approvalPolicy") || (job.policy?.allow_shell ? "on-request" : "on-request");
  const approvalFloor = policyString(scope, "approval_policy_floor") || "on-request";
  if (!authorizationScopeAllowsApproval(approvalFloor, requestedApproval, scope.allow_approval_never === true)) {
    return `approval_policy_not_allowed_locally: ${requestedApproval}`;
  }
  if (policyString(job.policy, "developerInstructions") && scope.allow_developer_instructions !== true) {
    return "developer_instructions_not_allowed_locally";
  }
  return "";
}

function authorizationScopeAllowsWorkspace(scope, workspaceRef) {
  const roots = Array.isArray(scope.workspace_roots) ? scope.workspace_roots : [];
  if (!roots.length) return workspaceRef === "default";
  if (roots.some(rootAllowsAllWorkspaces)) return true;
  return roots.some((item) => item?.id === workspaceRef);
}

function authorizationScopeAllowsSandbox(floor, requested) {
  if (floor === "danger-full-access") return requested === "danger-full-access" || requested === "workspace-write" || requested === "read-only";
  if (floor === "read-only") return requested === "read-only";
  if (floor === "workspace-write") return requested === "workspace-write" || requested === "read-only";
  return false;
}

function authorizationScopeAllowsApproval(floor, requested, allowNever) {
  if (floor === "never") return requested === "never" || requested === "on-failure" || requested === "on-request" || requested === "untrusted";
  if (requested === "never") return allowNever;
  const ranks = new Map([["untrusted", 0], ["on-request", 1], ["on-failure", 2]]);
  if (!ranks.has(floor) || !ranks.has(requested)) return false;
  return ranks.get(requested) <= ranks.get(floor);
}

function effectiveJobPolicy(job, scope = null) {
  const requestedCwd = policyString(job.policy, "cwd")
    || policyString(job.policy, "workspace_path")
    || workspaceRefCwd(job.workspace_ref);
  if (!requestedCwd) throw new Error(`workspace_not_allowed_locally: ${job.workspace_ref || "default"}`);
  const cwd = allowedCwd(requestedCwd, scope);
  const sandbox = allowedSandbox(policyString(job.policy, "sandbox") || (job.policy?.allow_shell ? "workspace-write" : "read-only"), scope);
  const approvalPolicy = allowedApprovalPolicy(policyString(job.policy, "approvalPolicy") || (job.policy?.allow_shell ? "on-request" : "on-request"), scope);
  const developerInstructions = policyString(job.policy, "developerInstructions");
  if (developerInstructions && !scopeAllowsDeveloperInstructions(scope)) {
    throw new Error("developer_instructions_not_allowed_locally");
  }
  return { cwd, sandbox, approvalPolicy, developerInstructions };
}

function workspaceRefCwd(workspaceRef = "default") {
  const ref = String(workspaceRef || "default");
  if (!ref || ref === "default") return workspacePath("default");
  const key = `PANDA_BRIDGE_WORKSPACE_${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  return process.env[key] || null;
}

function allowedCwd(requested, scope = null) {
  let cwd;
  try {
    cwd = realpathSync(resolve(requested));
  } catch (error) {
    throw new Error(`cwd_not_allowed_locally: ${redactExecutionPath(requested)}`);
  }
  if (scopeAllowsAllWorkspaces(scope)) return cwd;
  const roots = allowedWorkspaceRoots();
  if (roots.some((root) => cwd === root || cwd.startsWith(`${root}/`))) return cwd;
  throw new Error(`cwd_not_allowed_locally: ${redactExecutionPath(cwd)}`);
}

function allowedWorkspaceRoots() {
  const roots = [workspacePath("default")];
  const extra = process.env.PANDA_BRIDGE_ALLOWED_WORKSPACE_ROOTS || "";
  for (const item of extra.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean)) roots.push(resolve(item));
  return [...new Set(roots.map((item) => {
    try {
      return realpathSync(resolve(item));
    } catch {
      return resolve(item);
    }
  }))];
}

function allowedSandbox(value, scope = null) {
  if (authorizationScopeAllowsSandbox(scopeSandboxFloor(scope), value)) return value;
  if (value === "workspace-write" || value === "read-only") return value;
  if (value === "danger-full-access") throw new Error("sandbox_not_allowed_locally: danger-full-access");
  throw new Error(`sandbox_not_allowed_locally: ${value}`);
}

function allowedApprovalPolicy(value, scope = null) {
  if (authorizationScopeAllowsApproval(scopeApprovalFloor(scope), value, scopeAllowsApprovalNever(scope))) return value;
  if (value === "on-request" || value === "on-failure" || value === "untrusted") return value;
  if (value === "never" && envFlag("PANDA_BRIDGE_ALLOW_APPROVAL_NEVER")) return value;
  if (value === "never") throw new Error("approval_policy_not_allowed_locally: never");
  throw new Error(`approval_policy_not_allowed_locally: ${value}`);
}

function localPolicyDenialResult(job, error) {
  const { denied, reason } = localPolicyDenial(error);
  return {
    ok: false,
    error: "local_policy_denied",
    denied,
    reason,
    product_id: job.product_id || null,
    kind: job.kind || null,
    cloud_openai_credentials: false,
  };
}

function localPolicyDenialEvent(job, error) {
  const { denied, reason } = localPolicyDenial(error);
  return {
    denied,
    reason,
    product_id: job.product_id || null,
    kind: job.kind || null,
    workspace_ref: job.workspace_ref || "default",
  };
}

function localPolicyDenial(error) {
  const text = String(error || "");
  if (text.startsWith("product_not_authorized_locally")) return { denied: "product", reason: "product_not_authorized_locally" };
  if (text.startsWith("capability_not_authorized_locally")) return { denied: "capability", reason: "capability_not_authorized_locally" };
  if (text.startsWith("authorization_scope_missing_locally")) return { denied: "authorization", reason: "authorization_scope_missing_locally" };
  if (text.startsWith("workspace_not_allowed_locally")) return { denied: "workspace_ref", reason: "workspace_not_allowed_locally" };
  if (text.startsWith("cwd_not_allowed_locally")) return { denied: "cwd", reason: "cwd_not_allowed_locally" };
  if (text.startsWith("sandbox_not_allowed_locally")) return { denied: "sandbox", reason: "sandbox_not_allowed_locally" };
  if (text.startsWith("approval_policy_not_allowed_locally")) return { denied: "approvalPolicy", reason: "approval_policy_not_allowed_locally" };
  if (text.startsWith("developer_instructions_not_allowed_locally")) return { denied: "developerInstructions", reason: "developer_instructions_not_allowed_locally" };
  return { denied: "unknown", reason: "local_policy_denied" };
}

function effectivePolicyEvent(job, policy) {
  return {
    requested_policy: job.policy || {},
    effective_policy: {
      cwd: redactExecutionPath(policy.cwd),
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
      developerInstructions: policy.developerInstructions ? "[present]" : null,
    },
    workspace_ref: job.workspace_ref || "default",
    product_id: job.product_id || null,
    kind: job.kind || null,
  };
}

function policyString(policy, key) {
  const value = policy?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function productGrant(product, authorization = {}) {
  return {
    id: product.id,
    name: product.name,
    origin: authorization?.source_origin || product.origin || product.official_origin || null,
    capabilities: Array.isArray(product.capabilities) ? product.capabilities : [],
    policy: authorization?.policy || null,
    authorized_at: authorization?.updated_at || authorization?.created_at || new Date().toISOString(),
  };
}

function fixtureAuthorization() {
  return {
    source_origin: "local-fixture",
    policy: fullAccessAuthorizationPolicy({
      product_id: "panda-chat",
      source_origin: "local-fixture",
      capabilities: ["codex.chat"],
    }),
  };
}

function narrowFixtureAuthorization() {
  return {
    source_origin: "local-fixture",
    policy: {
      version: "AUTH-SCOPE-v1",
      product_id: "panda-chat",
      source_origin: "local-fixture",
      capabilities: ["codex.chat"],
      workspace_roots: [{ id: "default", path_display: "[local]/default" }],
      sandbox_floor: "workspace-write",
      approval_policy_floor: "on-request",
      allow_approval_never: false,
      allow_developer_instructions: false,
    },
  };
}

function emptyFixtureAuthorization() {
  const authorization = narrowFixtureAuthorization();
  authorization.policy.capabilities = [];
  return authorization;
}

function fullAccessAuthorizationPolicy(overrides = {}) {
  const policy = {
    version: "AUTH-SCOPE-v1",
    preset: "full-access",
    request_source: "connector_default_full_access",
    capabilities: ["codex.chat", "codex.run", "codex.rpc", "saas.custom.run"],
    workspace_roots: [{ id: "all", path_display: "All local files", allow_all: true }],
    sandbox_floor: "danger-full-access",
    approval_policy_floor: "never",
    allow_approval_never: true,
    allow_developer_instructions: true,
    display: {
      workspace: "All local files",
      sandbox: "danger-full-access",
      approval: "never",
      developer_instructions: "allowed",
    },
    ...overrides,
  };
  policy.display = authorizationPolicyDisplay(policy);
  return policy;
}

function authorizationPolicyDisplay(policy) {
  const roots = Array.isArray(policy.workspace_roots) ? policy.workspace_roots : [];
  const workspace = roots.some(rootAllowsAllWorkspaces)
    ? "All local files"
    : roots.map((root) => policyString(root, "path_display") || policyString(root, "label") || policyString(root, "id")).filter(Boolean).join(", ");
  return {
    workspace: workspace || "All local files",
    sandbox: policyString(policy, "sandbox_floor") || "danger-full-access",
    approval: policyString(policy, "approval_policy_floor") || "never",
    developer_instructions: policy.allow_developer_instructions === false ? "denied" : "allowed",
  };
}

function rootAllowsAllWorkspaces(root) {
  return root?.allow_all === true || root?.allowAll === true || root?.id === "all" || root?.id === "*";
}

function scopeAllowsAllWorkspaces(scope) {
  return Array.isArray(scope?.workspace_roots) && scope.workspace_roots.some(rootAllowsAllWorkspaces);
}

function scopeSandboxFloor(scope) {
  return policyString(scope, "sandbox_floor") || "workspace-write";
}

function scopeApprovalFloor(scope) {
  return policyString(scope, "approval_policy_floor") || "on-request";
}

function scopeAllowsApprovalNever(scope) {
  return scope?.allow_approval_never === true || scopeApprovalFloor(scope) === "never";
}

function scopeAllowsDeveloperInstructions(scope) {
  return scope?.allow_developer_instructions === true;
}

function envFlag(name) {
  const value = process.env[name] || "";
  return value === "1" || value.toLowerCase() === "true";
}

function redactExecutionPath(path) {
  const name = String(path || "").split(/[\\/]/).filter(Boolean).pop();
  return name ? `[local]/${name}` : "[local]";
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
    headers: { ...authHeaders(token), "content-type": "application/json", "x-panda-bridge-local-client": "connector-cli" },
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
