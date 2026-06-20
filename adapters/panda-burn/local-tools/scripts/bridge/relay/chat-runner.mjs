import { env } from "node:process";
import { parseCliError, runCli } from "./cli.mjs";
import { authorizedProjectRoots, resolveAuthorizedProject } from "./path-policy.mjs";
import { cleanText, positiveNumber } from "./utils.mjs";

// Keep this in sync with backend/burn-chat/src/lib.rs Agent::NAMES.
// scripts/check/chat-driver-registry.mjs enforces the cross-layer list.
export const SUPPORTED_CHAT_AGENTS = ["codex", "claude"];

export async function runBurnSessionsShow(command, context) {
  const input = command.input || {};
  const sessionId = cleanText(input.session_id || input.id || "");
  if (!sessionId) throw new Error("missing_session_id");
  const projectInput = cleanText(input.project_path || input.project || input.cwd || "");
  if (!projectInput) throw new Error("missing_project");
  const project = await resolveAuthorizedProject(projectInput, context.root, authorizedProjectRoots(context));
  const profileId = cleanText(input.profile_id || input.profileId);
  const agent = cleanText(input.agent || input.source);
  const profileAware = Boolean(profileId && agent);
  const args = profileAware
    ? ["agent", "source", "session", "show", "--source", agent, "--project", project, "--session-id", sessionId, "--profile-id", profileId, "--json"]
    : ["sessions", "show", "--id", sessionId, "--project", project, "--json"];
  const cursor = Number(input.cursor || 0);
  const limit = Number(input.limit || 80);
  if (Number.isFinite(cursor) && cursor > 0) args.push("--cursor", String(Math.floor(cursor)));
  if (Number.isFinite(limit) && limit > 0) args.push("--limit", String(Math.floor(limit)));
  if (profileAware && (input.latest === true || cleanText(input.order) === "latest")) args.push("--latest");
  try {
    const stdout = await runCli(context, args, { cwd: project, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, version: "burn-relay-v1", type: command.type, request_id: command.request_id || null, data: JSON.parse(stdout) };
  } catch (error) {
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
