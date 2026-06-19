import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env, execPath } from "node:process";
import { execCommand, parseCliError } from "./cli.mjs";
import { authorizedProjectRoots, resolveAuthorizedProject } from "./path-policy.mjs";
import { cleanText, positiveNumber } from "./utils.mjs";

export async function runUsageLedgerCommand(command, context) {
  const input = command.input || {};
  const project = await resolvedProject(input, context);
  const args = usageLedgerArgs(command.type, input, project);
  try {
    const stdout = await execCommand(execPath, [burnCli(context), ...args], {
      cwd: project,
      timeout: positiveNumber(context.usageLedgerTimeoutMs || env.BURN_RELAY_USAGE_TIMEOUT_MS, 300000),
      maxBuffer: 64 * 1024 * 1024,
      env: { ...env, ...(context.burnAppHome ? { BURN_APP_HOME: context.burnAppHome } : {}) },
    });
    const data = JSON.parse(stdout);
    if (data?.ok === false) {
      return {
        ok: false,
        version: "burn-relay-v1",
        type: command.type,
        request_id: command.request_id || null,
        error: cleanText(data.error || data.code || "usage_ledger_failed"),
        code: cleanText(data.code || data.error || "usage_ledger_failed"),
        message: cleanText(data.message || data.error || "usage ledger failed"),
        data,
      };
    }
    return { ok: true, version: "burn-relay-v1", type: command.type, request_id: command.request_id || null, data };
  } catch (error) {
    const parsed = parseCliError(error, "usage_ledger_failed");
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

function usageLedgerArgs(type, input, project) {
  const command = usageCommand(type);
  const args = ["agent", "usage", command, "--project", project];
  const source = cleanText(input.source);
  const profileId = cleanText(input.profile_id || input.profileId);
  const from = cleanText(input.from);
  const to = cleanText(input.to);
  const timezone = cleanText(input.timezone || input.time_zone || input.timeZone);
  const maxFiles = cleanText(input.max_files || input.maxFiles);
  const maxDepth = cleanText(input.max_depth || input.maxDepth);
  const view = cleanText(input.view || input.select || input.output_view || input.outputView);
  const dimension = cleanText(input.dimension || input.name);
  const limit = cleanText(input.limit);
  const profileIds = listOption(input.profile_ids || input.profileIds);
  const excludeProfileIds = listOption(input.exclude_profile_ids || input.excludeProfileIds);
  if (source) args.push("--source", source);
  if (profileId) args.push("--profile-id", profileId);
  if (profileIds) args.push("--profile-ids", profileIds);
  if (excludeProfileIds) args.push("--exclude-profile-ids", excludeProfileIds);
  if (from) args.push("--from", from);
  if (to) args.push("--to", to);
  if (timezone) args.push("--timezone", timezone);
  if (maxFiles) args.push("--max-files", maxFiles);
  if (maxDepth) args.push("--max-depth", maxDepth);
  if (view) args.push("--view", view);
  if (dimension) args.push("--dimension", dimension);
  if (limit) args.push("--limit", limit);
  if (input.force === true && command !== "refresh") args.push("--force");
  args.push("--json");
  return args;
}

function usageCommand(type) {
  const suffix = cleanText(type).replace(/^burn\.agent\.usage\./, "");
  if (["totals", "activity", "heatmap", "filters", "diagnostics", "pricing", "dimension", "dimensions", "compact"].includes(suffix)) {
    return suffix;
  }
  if (suffix === "refresh") return "refresh";
  if (suffix === "status") return "status";
  if (suffix === "snapshot") return "snapshot";
  return "summary";
}

function listOption(value) {
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean).join(",");
  return cleanText(value);
}

async function resolvedProject(input, context) {
  return resolveAuthorizedProject(projectInput(input) || context.root, context.root, authorizedProjectRoots(context));
}

function projectInput(input) {
  return cleanText(input.project || input.project_path || input.cwd);
}

function burnCli(context) {
  const candidates = [
    cleanText(env.BURN_CLI),
    cleanText(env.PANDA_BURN_CLI),
    cleanText(context.burnCli),
    cleanText(context.cli),
    resolve(context.root, "backend/burn"),
    resolve(context.root, "adapters/panda-burn/bin/panda-burn.mjs"),
    resolve(context.root, "backend/bin/panda-burn.mjs"),
    resolve(context.root, "backend/bin/panda-burn"),
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (found) return found;
  const error = new Error(`Burn CLI not found; set BURN_CLI or PANDA_BURN_CLI. tried=${candidates.join(", ")}`);
  error.code = "panda_burn_cli_missing";
  throw error;
}
