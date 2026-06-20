import { actionCliArgs } from "./cli-args.mjs";
import { runCli } from "./cli.mjs";
import { authorizedProjectRoots, resolveAuthorizedProject } from "./path-policy.mjs";
import { cleanText, parseJsonOrNull } from "./utils.mjs";

export async function runBurnActionCommand(command, context) {
  const input = command.input || {};
  try {
    const project = command.type === "burn.action.run"
      ? await resolveAuthorizedProject(input.project_path || input.project || input.cwd || context.root, context.root, authorizedProjectRoots(context))
      : context.root;
    const args = actionCliArgs(command.type, input, project);
    const stdout = await runCli(context, args, { cwd: context.root, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, version: "burn-relay-v1", type: command.type, request_id: command.request_id || null, generated_at: new Date().toISOString(), data: stdout.trim() ? JSON.parse(stdout) : null };
  } catch (error) {
    return actionError(command, "burn_action_command_failed", error);
  }
}

function actionError(command, code, error) {
  const causeCode = actionCauseCode(error);
  const response = {
    ok: false,
    version: "burn-relay-v1",
    type: command.type,
    request_id: command.request_id || null,
    error: code,
    message: cleanText(error?.message || error).slice(0, 800),
  };
  if (causeCode) response.cause_code = causeCode;
  return response;
}

function actionCauseCode(error) {
  const raw = String(error?.message || error || "").trim();
  const parsed = parseJsonOrNull(raw) || parseJsonOrNull(raw.match(/\{[\s\S]*\}/)?.[0] || "");
  if (typeof parsed?.code === "string") return parsed.code;
  if (!parsed && /^[A-Za-z0-9_.-]+$/.test(raw)) return raw;
  return error?.code ? cleanText(error.code) : "";
}

export function isActionCommand(type) {
  return /^burn\.action\.(list|help|run)$/.test(String(type || ""));
}
