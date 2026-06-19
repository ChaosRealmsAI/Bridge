#!/usr/bin/env node
export { ACTIONS, getActionDescriptor, isPhoneActionAllowed, listActions } from "./actions/registry.mjs";
export { runAction } from "./actions/runner.mjs";
export { validateActionInput } from "./actions/validation.mjs";

import { main } from "./actions/cli.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error), code: error?.code || "burn_action_error" })}\n`);
    process.exit(1);
  });
}
