#!/usr/bin/env node
import { runPandaBurnCli } from "../src/cli.mjs";

runPandaBurnCli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: String(error?.message || error),
    code: error?.code || "panda_burn_error",
  })}\n`);
  process.exit(1);
});
