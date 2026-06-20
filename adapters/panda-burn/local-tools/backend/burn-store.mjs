#!/usr/bin/env node
import { doctorBurnStore, initBurnStore, statusBurnStore } from "./burn-store-lib.mjs";

function usage() {
  return `Burn store

Usage:
  burn store init [--home PATH] [--account-id ID] [--device-id ID] [--json]
  burn store status [--home PATH] [--json]
  burn store doctor [--home PATH] [--json]
`;
}

function parse(argv) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--home") options.home = argv[++i];
    else if (arg === "--account-id") options.accountId = argv[++i];
    else if (arg === "--device-id") options.deviceId = argv[++i];
    else rest.push(arg);
  }
  return { command: rest[0], options };
}

async function print(value, json) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${JSON.stringify(value)}\n`);
}

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (!command || command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(usage());
    return;
  }
  if (command === "init") return print(await initBurnStore(options), options.json);
  if (command === "status") return print(await statusBurnStore(options), options.json);
  if (command === "doctor") return print(await doctorBurnStore(options), options.json);
  throw coded("burn_store_usage", `unknown store command: ${command}`);
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code || "burn_store_error" })}\n`);
  process.exit(1);
});
