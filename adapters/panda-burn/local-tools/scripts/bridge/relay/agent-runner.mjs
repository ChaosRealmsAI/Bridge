import { env } from "node:process";
import { appendChatMemoryEvent } from "../../../backend/burn-chat-memory-lib.mjs";
import { agentAccountArgs } from "./agent-account-args.mjs";
import { runUsageLedgerCommand } from "./agent-usage-ledger.mjs";
import { parseCliError, runCli, runCliJsonStream } from "./cli.mjs";
import { authorizedProjectRoots, resolveAuthorizedProject } from "./path-policy.mjs";
import { cleanText, positiveNumber } from "./utils.mjs";

const AGENT_COMMANDS = new Set([
  "burn.agent.profiles.discover",
  "burn.agent.profile.status",
  "burn.agent.profile.resolve",
  "burn.agent.accounts.list",
  "burn.agent.accounts.get",
  "burn.agent.accounts.active",
  "burn.agent.login.diagnostics",
  "burn.agent.capabilities.get",
  "burn.agent.usage.summary",
  "burn.agent.usage.refresh",
  "burn.agent.usage.status",
  "burn.agent.usage.snapshot",
  "burn.agent.usage.totals",
  "burn.agent.usage.activity",
  "burn.agent.usage.heatmap",
  "burn.agent.usage.filters",
  "burn.agent.usage.diagnostics",
  "burn.agent.usage.pricing",
  "burn.agent.usage.dimension",
  "burn.agent.usage.dimensions",
  "burn.agent.usage.compact",
  "burn.agent.claude.quota.cache",
  "burn.agent.claude.quota.refresh",
  "burn.agent.quota.list",
  "burn.agent.quota.probe",
  "burn.agent.health.scan",
  "burn.agent.sources.list",
  "burn.agent.source.status",
  "burn.agent.sessions.list",
  "burn.agent.session.show",
  "burn.agent.session.create",
  "burn.agent.session.continue",
  "burn.agent.turn.interrupt",
]);

export function isAgentCommand(type) {
  return AGENT_COMMANDS.has(type);
}

export async function runBurnAgentCommand(command, context) {
  const input = command.input || {};
  if (command.type.startsWith("burn.agent.usage.")) {
    return runUsageLedgerCommand(command, context);
  }
  const project = projectInput(input);
  const cwd = project
    ? await resolveAuthorizedProject(project, context.root, authorizedProjectRoots(context))
    : context.root;
  await recordAgentMemory(context, command, input, cwd, {
    event_type: "user_prompt",
    role: "user",
    status: "pending",
    text: cleanText(input.prompt),
    meta: { command_type: command.type, mode: cleanText(input.mode), model: cleanText(input.model) },
  });
  try {
    const args = await agentArgs(command.type, input, context);
    if (wantsStream(command.type, input)) {
      const data = await runCliJsonStream(context, args, {
        cwd,
        timeout: positiveNumber(context.agentTimeoutMs, 60000),
        env: agentEnv(context),
      }, (event) => emitAgentProgress(command, input, cwd, event, context));
      await recordAgentMemory(context, command, input, cwd, {
        event_type: "assistant_final",
        role: "assistant",
        status: "final",
        session_id: finalSessionId(data),
        text: finalText(data),
        payload: data,
      });
      return {
        ok: true,
        version: "burn-relay-v1",
        type: command.type,
        request_id: command.request_id || null,
        data,
      };
    }
    const stdout = await runCli(context, args, {
      cwd,
      timeout: positiveNumber(context.agentTimeoutMs, 60000),
      maxBuffer: 16 * 1024 * 1024,
      env: agentEnv(context),
    });
    const data = JSON.parse(stdout);
    await recordAgentMemory(context, command, input, cwd, {
      event_type: "assistant_final",
      role: "assistant",
      status: "final",
      session_id: finalSessionId(data),
      text: finalText(data),
      payload: data,
    });
    return {
      ok: true,
      version: "burn-relay-v1",
      type: command.type,
      request_id: command.request_id || null,
      data,
    };
  } catch (error) {
    const parsed = parseCliError(error, "burn_agent_failed");
    await recordAgentMemory(context, command, input, cwd, {
      event_type: "agent_failed",
      role: "system",
      status: "failed",
      text: parsed.message,
      payload: { ok: false, error: parsed.code, code: parsed.code, message: parsed.message, cause_code: parsed.causeCode },
    });
    return {
      ok: false,
      version: "burn-relay-v1",
      type: command.type,
      request_id: command.request_id || null,
      error: parsed.code,
      code: parsed.code,
      message: parsed.message,
      cause_code: parsed.causeCode,
    };
  }
}

async function agentArgs(type, input, context) {
  if (type === "burn.agent.profiles.discover") {
    const args = ["agent", "profile", "discover"];
    if (input.quick !== false) args.push("--quick");
    args.push("--json");
    return args;
  }
  if (type === "burn.agent.profile.status") {
    const args = ["agent", "profile", "status", "--profile-id", required(input.profile_id || input.profileId, "profile_id")];
    if (input.deep === true) args.push("--deep");
    args.push("--json");
    return args;
  }
  if (type === "burn.agent.profile.resolve") {
    const args = [
      "agent",
      "profile",
      "resolve",
      "--source",
      required(input.source, "source"),
      "--project",
      await resolvedProject(input, context),
    ];
    const operation = cleanText(input.operation || input.op);
    if (operation) args.push("--operation", operation);
    const sessionId = cleanText(input.session_id || input.sessionId || input.id);
    if (sessionId) args.push("--session-id", sessionId);
    const preferred = cleanText(input.preferred_profile_id || input.preferredProfileId || input.profile_id || input.profileId);
    if (preferred) args.push("--preferred-profile-id", preferred);
    args.push("--json");
    return args;
  }
  const accountArgs = agentAccountArgs(type, input);
  if (accountArgs) return accountArgs;
  if (type === "burn.agent.sources.list") return ["sources", "list", "--json"];
  const source = required(input.source, "source");
  if (type === "burn.agent.source.status") {
    return withProfile(["source", "status", "--source", source, "--project", await resolvedProject(input, context), "--json"], input);
  }
  if (type === "burn.agent.sessions.list") {
    return withProfile([
      "source",
      "sessions",
      "list",
      "--source",
      source,
      "--project",
      await resolvedProject(input, context),
      "--limit",
      String(limit(input, 50)),
      "--json",
    ], input);
  }
  if (type === "burn.agent.session.show") {
    const args = [
      "source",
      "session",
      "show",
      "--source",
      source,
      "--project",
      await resolvedProject(input, context),
      "--session-id",
      required(input.session_id || input.id, "session_id"),
      "--cursor",
      String(cursor(input)),
      "--limit",
      String(limit(input, 50)),
      "--json",
    ];
    if (input.latest === true || cleanText(input.order) === "latest") {
      args.splice(args.length - 1, 0, "--latest");
    }
    return withProfile(args, input);
  }
  if (type === "burn.agent.session.create") {
    return turnArgs("create", source, input, context);
  }
  if (type === "burn.agent.session.continue") {
    return turnArgs("continue", source, input, context);
  }
  if (type === "burn.agent.turn.interrupt") {
    const args = [
      "source",
      "turn",
      "interrupt",
      "--source",
      source,
      "--project",
      await resolvedProject(input, context),
      "--session-id",
      required(input.session_id || input.id, "session_id"),
      "--json",
    ];
    const turnId = cleanText(input.turn_id || input.turnId);
    if (turnId) args.splice(args.length - 1, 0, "--turn-id", turnId);
    return withProfile(args, input);
  }
  throw new Error("agent_command_not_allowed");
}

async function turnArgs(kind, source, input, context) {
  const args = [
    "source",
    "session",
    kind,
    "--source",
    source,
    "--project",
    await resolvedProject(input, context),
  ];
  if (kind === "continue") args.push("--session-id", required(input.session_id || input.id, "session_id"));
  args.push("--prompt", required(input.prompt, "prompt"));
  const model = cleanText(input.model);
  if (model) args.push("--model", model);
  const mode = cleanText(input.mode);
  if (mode) args.push("--mode", mode);
  addOptions(args, input);
  if (wantsStream(`burn.agent.session.${kind}`, input)) args.push("--json-stream");
  args.push("--json");
  return withProfile(args, input);
}

function withProfile(args, input) {
  const profileId = cleanText(input.profile_id || input.profileId);
  if (!profileId) return args;
  return ["agent", ...args, "--profile-id", profileId];
}

async function resolvedProject(input, context) {
  return resolveAuthorizedProject(projectInput(input) || context.root, context.root, authorizedProjectRoots(context));
}

function projectInput(input) {
  return cleanText(input.project || input.project_path || input.cwd);
}

function addOptions(args, input) {
  const options = input.options || input.options_json || input.sdk_options || input.sdkOptions;
  if (!options) return;
  if (typeof options !== "object" || Array.isArray(options)) throw new Error("agent options must be a JSON object");
  args.push("--options-json", JSON.stringify(options));
}

function limit(input, fallback) { return Math.max(1, Math.min(positiveNumber(input.limit, fallback), 200)); }

function cursor(input) { return Math.max(0, positiveNumber(input.cursor, 0)); }

function required(value, name) {
  const text = cleanText(value);
  if (!text) throw new Error(`missing_${name}`);
  return text;
}

function agentEnv(context) {
  return {
    ...env,
    PATH: pathWithCommonCliDirs(env.PATH),
  };
}

function pathWithCommonCliDirs(pathValue) {
  const parts = String(pathValue || "").split(":").filter(Boolean);
  for (const dir of ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"]) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(":");
}

function wantsStream(type, input) {
  if (!["burn.agent.session.create", "burn.agent.session.continue"].includes(type)) return false;
  return input.stream === true || input.json_stream === true || input.jsonStream === true;
}

async function emitAgentProgress(command, input, project, event, context) {
  const commandId = cleanText(input.command_id || input.commandId || command.request_id);
  const source = cleanText(input.source);
  const progress = {
    schema: "burn.agent.turn.event.v1",
    command_id: commandId,
    source,
    project,
    seq: positiveNumber(event.seq, 0),
    status: cleanText(event.status) || "streaming",
    block: event.block || null,
    raw_json: event.raw_json || null,
  };
  await recordAgentMemory(context, command, input, project, {
    event_type: "agent_progress",
    role: "assistant",
    status: progress.status,
    seq: progress.seq,
    text: cleanText(progress.block?.text || progress.block?.summary),
    block: progress.block,
    raw_json: progress.raw_json,
  });
  if (typeof context.emitProgress !== "function") return;
  await context.emitProgress({
    ok: true,
    version: "burn-relay-v1",
    type: command.type,
    request_id: command.request_id || null,
    schema: "burn.agent.turn.event.v1",
    progress: true,
    data: progress,
  });
}

async function recordAgentMemory(context, command, input, project, event) {
  if (!isAgentTurnCommand(command.type)) return;
  try {
    const commandId = cleanText(input.command_id || input.commandId || command.request_id);
    await appendChatMemoryEvent({
      home: context.burnAppHome,
      project,
      source: cleanText(input.source),
      session_key: cleanText(input.session_id || input.id) || commandId,
      session_id: cleanText(event.session_id || input.session_id || input.id),
      command_id: commandId,
      ...event,
    });
  } catch (error) {
    context.chatMemoryErrors?.push?.({
      at: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 400),
    });
  }
}

function isAgentTurnCommand(type) {
  return type === "burn.agent.session.create" || type === "burn.agent.session.continue";
}

function finalSessionId(data) {
  return cleanText(data?.session_id || data?.summary?.id || data?.turn?.common?.session_id || data?.data?.session_id);
}

function finalText(data) {
  return cleanText(data?.reply || data?.data?.reply || data?.turn?.chat?.reply || data?.result);
}
