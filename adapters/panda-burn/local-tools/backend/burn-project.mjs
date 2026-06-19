#!/usr/bin/env node
import { helpText, parseArgs, usageError } from "./project/cli.mjs";
import { listProjects } from "./project/commands.mjs";
import { writeJson } from "./project/format.mjs";

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(helpText());
    return;
  }
  const options = parseArgs(args);
  if (command === "list") return writeJson(await listProjects(options));
  throw usageError(`unknown project command: ${command}`);
}

main().catch((error) => {
  const code = error.burnCode || String(error.message || "").split(":")[0] || "burn_project_failed";
  process.stderr.write(`${JSON.stringify({ ok: false, error: code, code, message: error.message })}\n`);
  process.exit(2);
});
