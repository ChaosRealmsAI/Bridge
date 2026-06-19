import { ACTION_VERSION } from "./constants.mjs";
import { publicDescriptor } from "./builders.mjs";
import { getActionDescriptor, listActions } from "./registry.mjs";
import { runAction } from "./runner.mjs";
import { codedError } from "./validation.mjs";

export async function main() {
  const [command, maybeId, ...tail] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help" || (command === "help" && !maybeId)) {
    process.stdout.write(helpText());
    return;
  }
  if (command === "list") {
    const { options } = parseCliArgs([maybeId, ...tail].filter(Boolean));
    const actions = listActions({ target: options.target });
    if (options.json) return jsonOut({ ok: true, version: ACTION_VERSION, actions });
    process.stdout.write(`${actions.map((item) => `${item.id.padEnd(28)} ${item.target.padEnd(7)} ${item.risk.padEnd(11)} ${item.title}`).join("\n")}\n`);
    return;
  }
  if (command === "help") {
    const { options } = parseCliArgs(tail);
    const descriptor = getActionDescriptor(maybeId || "");
    if (!descriptor) throw codedError("unknown_action", `unknown action: ${maybeId || ""}`);
    if (options.json) return jsonOut({ ok: true, version: ACTION_VERSION, action: publicDescriptor(descriptor) });
    process.stdout.write(actionHelp(publicDescriptor(descriptor)));
    return;
  }
  if (command === "run") {
    const { options, rest } = parseCliArgs(tail);
    if (rest.length) throw codedError("unknown_action_argument", `unknown action argument: ${rest.join(" ")}`);
    const result = await runAction(maybeId || "", options);
    if (options.json) return jsonOut(result);
    process.stdout.write(`${result.ok ? "ok" : "failed"} ${result.action_id}\n`);
    return;
  }
  throw codedError("unknown_action_command", `unknown action command: ${command}`);
}

function parseCliArgs(args) {
  const options = { input: {}, json: false, params: [] };
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--target") options.target = args[++index] || "";
    else if (arg === "--project") options.project = args[++index] || "";
    else if (arg === "--input-json") options.input = JSON.parse(args[++index] || "{}");
    else if (arg === "--param") options.params.push(args[++index] || "");
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--phone-url") options.phoneUrl = args[++index] || "";
    else if (arg === "--phone-token") options.phoneToken = args[++index] || "";
    else if (arg === "--wait-ms") options.waitMs = Number(args[++index] || 0);
    else rest.push(arg);
  }
  for (const item of options.params) {
    const at = item.indexOf("=");
    if (at <= 0) throw codedError("invalid_param", `invalid --param ${item}`);
    options.input[item.slice(0, at)] = coerce(item.slice(at + 1));
  }
  return { options, rest };
}

function helpText() {
  return `Burn action surface

Usage:
  burn action list [--target desktop|phone] [--json]
  burn action help <id> [--json]
  burn action run <id> [--project P] [--input-json JSON] [--param key=value] [--dry-run] [--json]

Phone action transport:
  burn action run ui.nav.tab --input-json '{"tab":"monitor"}' --phone-url http://127.0.0.1:8798 --phone-token TOKEN --json

Safety:
  Only registry allowlist actions run. No shell, arbitrary file access, delete, deploy, or permission escalation action exists.
`;
}

function actionHelp(item) {
  return `${item.id}
  title: ${item.title}
  target: ${item.target}
  risk: ${item.risk}
  description: ${item.description}
  required: ${(item.input_schema.required || []).join(", ") || "(none)"}
  side effects: ${item.side_effects}
  example input: ${JSON.stringify(item.examples?.[0] || {}, null, 2)}
`;
}

function jsonOut(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function coerce(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
