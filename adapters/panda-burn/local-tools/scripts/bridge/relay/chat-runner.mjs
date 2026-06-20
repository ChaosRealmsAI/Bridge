import { env } from "node:process";
import { resolve } from "node:path";
import { parseCliError, runCli } from "./cli.mjs";
import { authorizedProjectRoots, resolveAuthorizedProject, safeRealpath } from "./path-policy.mjs";
import { cleanText, positiveNumber } from "./utils.mjs";

// Keep this in sync with backend/burn-chat/src/lib.rs Agent::NAMES.
// scripts/check/chat-driver-registry.mjs enforces the cross-layer list.
export const SUPPORTED_CHAT_AGENTS = ["codex", "claude"];

export async function runBurnSessionsShow(command, context) {
  const input = command.input || {};
  const sessionId = cleanText(input.session_id || input.id || "");
  if (!sessionId) throw new Error("missing_session_id");
  const agent = cleanText(input.agent || input.source);
  const transcriptPath = expandHomePath(cleanText(input.transcript_path || input.transcriptPath));
  if (transcriptPath) {
    const args = showArgsWithPaging(
      ["sessions", "show", "--id", sessionId, "--transcript-path", transcriptPath, ...(agent ? ["--agent", agent] : []), "--json"],
      input,
    );
    if (input.latest === true || cleanText(input.order) === "latest") args.push("--latest");
    try {
      return sessionsShowSuccess(command, await runShowCli(context, args, context.root));
    } catch (error) {
      return sessionsShowFailure(command, error);
    }
  }
  const projectInput = cleanText(input.project_path || input.project || input.cwd || "");
  if (!projectInput) throw new Error("missing_project");
  const project = await resolveReadableHistoryProject(projectInput, context);
  const cwd = await safeRealpath(project) || await safeRealpath(context.root) || context.root;
  const profileId = cleanText(input.profile_id || input.profileId);
  const profileAware = Boolean(profileId && agent);
  const legacyArgs = showArgsWithPaging(
    ["sessions", "show", "--id", sessionId, "--project", project, "--json"],
    input,
  );
  const profileArgs = profileAware
    ? ["agent", "source", "session", "show", "--source", agent, "--project", project, "--session-id", sessionId, "--profile-id", profileId, "--json"]
    : legacyArgs;
  if (profileAware) {
    showArgsWithPaging(profileArgs, input);
    if (input.latest === true || cleanText(input.order) === "latest") profileArgs.push("--latest");
  }
  let primaryError = null;
  try {
    const data = await runShowCli(context, profileArgs, cwd);
    if (!profileAware || historyMessageCount(data) > 0) {
      return sessionsShowSuccess(command, data);
    }
    const fallback = await tryLegacyShow(context, legacyArgs, cwd);
    return sessionsShowSuccess(command, fallback && historyMessageCount(fallback) > 0 ? fallback : data);
  } catch (error) {
    primaryError = error;
  }
  if (profileAware) {
    try {
      return sessionsShowSuccess(command, await runShowCli(context, legacyArgs, cwd));
    } catch {
      // Return the profile-aware error below: it is the most specific failure.
    }
  }
  return sessionsShowFailure(command, primaryError);
}

function expandHomePath(path) {
  if (!path) return "";
  if (path === "~") return env.HOME || path;
  if (path.startsWith("~/")) return resolve(env.HOME || "", path.slice(2));
  return path;
}

function showArgsWithPaging(args, input) {
  const cursor = Number(input.cursor || 0);
  const limit = Number(input.limit || 80);
  if (Number.isFinite(cursor) && cursor > 0) args.push("--cursor", String(Math.floor(cursor)));
  if (Number.isFinite(limit) && limit > 0) args.push("--limit", String(Math.floor(limit)));
  return args;
}

async function runShowCli(context, args, cwd) {
  const stdout = await runCli(context, args, { cwd, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function tryLegacyShow(context, args, cwd) {
  try {
    return await runShowCli(context, args, cwd);
  } catch {
    return null;
  }
}

function sessionsShowSuccess(command, data) {
  return { ok: true, version: "burn-relay-v1", type: command.type, request_id: command.request_id || null, data };
}

function sessionsShowFailure(command, error) {
  const parsed = normalizeSessionsShowError(parseCliError(error, "burn_sessions_show_failed"));
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

function historyMessageCount(data) {
  if (Array.isArray(data?.messages)) return data.messages.length;
  if (Array.isArray(data?.data?.messages)) return data.data.messages.length;
  return 0;
}

async function resolveReadableHistoryProject(projectInput, context) {
  try {
    return await resolveAuthorizedProject(projectInput, context.root, authorizedProjectRoots(context));
  } catch (error) {
    if (error?.code !== "local_policy_denied") throw error;
    const raw = cleanText(projectInput);
    return resolve(raw);
  }
}

function normalizeSessionsShowError(parsed) {
  const message = `${parsed.message || ""} ${parsed.causeCode || ""}`.toLowerCase();
  if (parsed.code === "burn_sessions_show_failed" && message.includes("session not found")) {
    return { ...parsed, code: "resume_not_found", causeCode: parsed.code };
  }
  return parsed;
}

export async function runBurnChat(command, context) {
  const input = command.input || {};
  const agent = String(input.agent || "").toLowerCase();
  if (!SUPPORTED_CHAT_AGENTS.includes(agent)) throw new Error("invalid_chat_agent");
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("missing_chat_prompt");
  const project = await resolveAuthorizedProject(input.project_path || input.project || input.cwd || context.root, context.root, authorizedProjectRoots(context));
  const args = ["chat", "--agent", agent, "--project", project, "--prompt", prompt, "--json"];
  const resume = cleanText(input.resume_session_id || input.resume || "");
  if (resume) args.push("--resume", resume);
  const mode = cleanText(input.mode || "");
  if (mode && mode !== "chat") args.push("--mode", mode);
  const model = cleanText(input.model || "");
  if (model) args.push("--model", model);

  try {
    const outerChatTimeoutMs = positiveNumber(context.chatTimeoutMs, 240000);
    const cliOptions = { cwd: project, timeout: outerChatTimeoutMs, maxBuffer: 16 * 1024 * 1024 };
    if (agent === "codex") {
      const requestedTimeout = Number(env.BURN_CODEX_TIMEOUT_MS || 210000);
      const maxCodexTimeout = codexInnerTimeoutCeiling(outerChatTimeoutMs, positiveNumber(context.codexMaxTimeoutMs, 210000));
      const codexTimeoutMs = Number.isFinite(requestedTimeout)
        ? Math.min(Math.max(1, Math.floor(requestedTimeout)), maxCodexTimeout)
        : maxCodexTimeout;
      cliOptions.env = { ...env, BURN_CODEX_TIMEOUT_MS: String(codexTimeoutMs) };
    }
    const stdout = await runCli(context, args, cliOptions);
    const payload = JSON.parse(stdout);
    return {
      ok: payload.ok !== false,
      version: "burn-relay-v1",
      type: command.type,
      request_id: command.request_id || null,
      data: payload,
      reply: payload.reply || "",
      session_id: payload.session_id || null,
      transcript_path: payload.transcript_path || null,
      display: payload.display || null,
    };
  } catch (error) {
    const parsed = parseCliError(error, "burn_chat_failed");
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

function codexInnerTimeoutCeiling(outerChatTimeoutMs, configuredMaxMs) {
  const belowOuterBudget = outerChatTimeoutMs > 30000
    ? outerChatTimeoutMs - 30000
    : Math.max(1, Math.floor(outerChatTimeoutMs * 0.8));
  return Math.max(1, Math.min(configuredMaxMs, belowOuterBudget));
}
