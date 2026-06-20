import { actionIdFromInput } from "./utils.mjs";

export function actionCliArgs(type, input, project) {
  if (type === "burn.action.list") {
    const args = ["action", "list", "--json"];
    appendOptional(args, "--target", input.target);
    return args;
  }
  if (type === "burn.action.help") {
    return ["action", "help", requiredActionId(input), "--json"];
  }
  if (type === "burn.action.run") {
    const actionId = requiredActionId(input);
    if (input.input !== undefined && (typeof input.input !== "object" || input.input === null || Array.isArray(input.input))) {
      throw codedError("invalid_input_type", "action input must be an object");
    }
    const actionInput = input.input || {};
    const args = ["action", "run", actionId, "--json", "--project", project, "--input-json", JSON.stringify(actionInput)];
    if (input.dry_run || input.dryRun) args.push("--dry-run");
    appendOptional(args, "--phone-url", input.phone_url || input.phoneUrl);
    appendOptional(args, "--phone-token", input.phone_token || input.phoneToken);
    appendOptional(args, "--wait-ms", input.wait_ms || input.waitMs);
    return args;
  }
  throw new Error("command_not_allowed");
}

export function workspaceCliArgs(type, input, project) {
  throw codedError("project_workspace_disabled", "project-level Burn workspace commands are disabled");
}

function requiredActionId(input) {
  const actionId = actionIdFromInput(input);
  if (!actionId) throw codedError("missing_input_id", "missing input: id|action_id");
  return actionId;
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function appendOptional(args, flag, value) {
  if (value === undefined || value === null || String(value).trim() === "") return;
  args.push(flag, String(value));
}
