import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";

import { compactUsageLedgerCache, generateUsageLedger } from "./usage-ledger.mjs";

const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localBackendCli = resolve(adapterRoot, "local-tools", "backend", "burn");

export async function runPandaBurnCli(argv = []) {
  const { args, options } = parseArgs(argv);
  if (!args.length || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (args[0] === "agent" && args[1] === "usage") {
    const command = args[2] || "summary";
    if (command === "compact") {
      const result = await compactUsageLedgerCache({
        project: options.project || options.cwd || cwd(),
        home: options.home || options.burnHome || options["burn-home"],
      });
      print(result);
      return;
    }
    const result = await generateUsageLedger(usageOptions(command, options));
    print(result);
    return;
  }
  await runLocalBurnCli(argv);
}

function parseArgs(argv) {
  const args = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq >= 0 ? eq : undefined);
    const camel = key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (["json", "force", "snapshot"].includes(key)) {
      options[key] = true;
      options[camel] = true;
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++index];
    if (value === undefined) throw coded("panda_burn_usage", `missing --${key} value`);
    options[key] = value;
    options[camel] = value;
  }
  return { args, options };
}

function usageOptions(command, options) {
  const dimension = options.dimension || options.dim || (command === "dimension" ? options.name : "");
  return {
    project: options.project || options.cwd || cwd(),
    home: options.home || options.burnHome || options["burn-home"],
    source: options.source,
    profileId: options.profileId || options["profile-id"] || options.profile_id,
    profileIds: options.profileIds || options["profile-ids"] || options.profile_ids,
    excludeProfileIds: options.excludeProfileIds || options["exclude-profile-ids"] || options.exclude_profile_ids,
    from: options.from,
    to: options.to,
    timezone: options.timezone || options["time-zone"] || options.time_zone,
    maxFiles: options.maxFiles || options["max-files"],
    maxDepth: options.maxDepth || options["max-depth"],
    dimensionLimit: options.dimensionLimit || options["dimension-limit"],
    view: viewForUsageCommand(command, options),
    dimension,
    limit: options.limit,
    force: options.force || command === "refresh",
    snapshot: options.snapshot || command === "snapshot" || command === "read" || command === "status",
  };
}

function viewForUsageCommand(command, options) {
  if (options.view || options.select || options.output_view) return options.view || options.select || options.output_view;
  if (command === "summary") return "summary";
  if (command === "refresh") return "summary";
  if (command === "status") return "diagnostics";
  if (command === "snapshot" || command === "read") return options.view || options.select || options.output_view || "summary";
  if (command === "dimension") return "dimension";
  if (command === "dimensions") return "dimensions";
  if (["totals", "activity", "heatmap", "filters", "diagnostics", "pricing"].includes(command)) return command;
  throw coded("panda_burn_usage", `unknown usage command: ${command}`);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runLocalBurnCli(argv) {
  if (!existsSync(localBackendCli)) throw coded("panda_burn_local_cli_missing", "panda-burn local backend CLI is missing");
  const stdout = await exec(localBackendCli, argv, {
    cwd: cwd(),
    timeout: Number(process.env.PANDA_BURN_CLI_TIMEOUT_MS || 300000),
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PANDA_BURN_CLI: localBackendCli,
    },
  });
  if (stdout) process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
}

function exec(command, args, options) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(stderr?.trim() || error.message);
        wrapped.code = error.code || "panda_burn_local_cli_failed";
        rejectExec(wrapped);
        return;
      }
      resolveExec(stdout);
    });
  });
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function usage() {
  return `panda-burn managed adapter CLI

Usage:
  panda-burn store init|status|doctor [--json]
  panda-burn project list [--root R] [--json]
  panda-burn agent profile discover|status|resolve [--json]
  panda-burn agent account list|get|active [--json]
  panda-burn source|sources ...
  panda-burn sessions list|show ...
  panda-burn chat --agent claude|codex --project P --prompt TEXT [--json]
  panda-burn action list|help|run ...
  panda-burn agent usage summary [--project P] [--source codex|claude] [--profile-id ID] [--profile-ids A,B] [--exclude-profile-ids A,B] [--from ISO] [--to ISO] [--timezone TZ] [--dimension-limit N] [--force] [--json]
  panda-burn agent usage refresh [--project P] [--source codex|claude] [--timezone TZ] [--json]
  panda-burn agent usage status [--project P] [--json]
  panda-burn agent usage snapshot [--project P] [--view summary|totals|activity|filters|diagnostics|pricing|dimensions] [--dimension NAME] [--limit N] [--json]
  panda-burn agent usage dimension [--project P] --dimension by_account_day [--limit N] [--dimension-limit N] [--json]
  panda-burn agent usage dimensions [--project P] [--limit N] [--json]
  panda-burn agent usage activity [--project P] [--json]
  panda-burn agent usage filters [--project P] [--json]
  panda-burn agent usage diagnostics [--project P] [--json]
  panda-burn agent usage pricing [--project P] [--json]
  panda-burn agent usage compact [--project P] [--json]

Storage:
  Writes to $BURN_APP_HOME/data/agent-usage, or the platform Burn user data directory when BURN_APP_HOME is unset.
`;
}
