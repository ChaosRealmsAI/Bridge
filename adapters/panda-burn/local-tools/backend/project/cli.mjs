export function helpText() {
  return `Burn project

Usage:
  burn project list [--root R] [--cursor N] [--limit N] [--max-depth N] [--json]
`;
}

export function parseArgs(args) {
  const options = {
    root: "",
    project: "",
    cursor: 0,
    limit: 80,
    maxDepth: 2,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--root") options.root = requiredValue(args, ++index, arg);
    else if (arg === "--project") options.project = requiredValue(args, ++index, arg);
    else if (arg === "--cursor") options.cursor = positiveInt(requiredValue(args, ++index, arg), 0, "cursor");
    else if (arg === "--limit") options.limit = Math.min(200, positiveInt(requiredValue(args, ++index, arg), 80, "limit"));
    else if (arg === "--max-depth") options.maxDepth = Math.min(6, positiveInt(requiredValue(args, ++index, arg), 2, "max-depth"));
    else throw usageError(`unknown project argument: ${arg}`);
  }
  return options;
}

function requiredValue(args, index, label) {
  const value = args[index] || "";
  if (!value) throw usageError(`missing ${label} value`);
  return value;
}

function positiveInt(value, fallback, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    if (value === undefined || value === "") return fallback;
    throw usageError(`invalid ${label}`);
  }
  return Math.floor(parsed);
}

export function usageError(message) {
  const error = new Error(message);
  error.burnCode = message === "local_policy_denied" ? "local_policy_denied" : "burn_project_usage";
  return error;
}
