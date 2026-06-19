#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { dispatchPandaBurnCommand } from "../../adapters/panda-burn/src/adapter-server.mjs";
import {
  availabilityQuotaSummary,
  emptyAvailabilityQuota,
  withQuotaWindowFields,
} from "../../adapters/panda-burn/local-tools/backend/burn-agent-account-shape.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const temp = join(tmpdir(), `panda-burn-local-runtime-${process.pid}-${Date.now()}`);
const adapterCli = resolve(root, "adapters/panda-burn/local-tools/backend/burn");
const previous = {
  HOME: process.env.HOME,
  BURN_APP_HOME: process.env.BURN_APP_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  PATH: process.env.PATH,
};

try {
  const home = join(temp, "home");
  const burnHome = join(temp, "burn-home");
  const project = join(temp, "project");
  const bin = join(temp, "bin");
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".codex/sessions/2026/06/19"), { recursive: true });
  mkdirSync(join(home, ".claude/projects/-tmp-project"), { recursive: true });
  writeFileSync(join(home, ".codex/auth.json"), JSON.stringify({ email: "codex-local@example.com" }));
  writeFileSync(join(home, ".claude/.credentials.json"), JSON.stringify({ token: "redacted" }));
  writeFileSync(join(home, ".codex/sessions/2026/06/19/codex.jsonl"), JSON.stringify({
    timestamp: "2026-06-19T00:00:00.000Z",
    type: "session_meta",
    payload: { id: "codex-local", cwd: project },
  }) + "\n");
  writeExecutable(join(bin, "codex"), `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  echo "codex fixture 0.0.0"
  exit 0
fi
echo "codex fixture"
`);
  writeExecutable(join(bin, "claude"), `#!/usr/bin/env sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","apiProvider":"anthropic","email":"claude-local@example.com","orgName":"Fixture Org","orgId":"org-fixture"}'
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "claude fixture 0.0.0"
  exit 0
fi
echo "claude fixture"
`);

  process.env.HOME = home;
  process.env.BURN_APP_HOME = burnHome;
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.PATH = `${bin}:${previous.PATH || ""}`;

  const context = {
    root: realpathSync(project),
    cli: adapterCli,
    burnCli: adapterCli,
    burnAppHome: burnHome,
    cliExecutions: [],
    syncExecutions: [],
    chatMemoryErrors: [],
  };

  const health = await call("burn.relay.health", {}, context);
  assert.equal(health.ok, true, "relay health ok");
  assert.equal(health.data.product_id, "panda-burn", "relay health product");

  const store = await call("burn.store.status", {}, context);
  assert.equal(store.ok, true, "store status ok");
  assert.equal(store.data.product, "burn", "store product");

  const profiles = await call("burn.agent.profiles.discover", { quick: true }, context);
  assert.equal(profiles.ok, true, "profile discovery ok");
  assert.ok(profiles.data.counts.codex >= 1, "codex profile discovered");
  assert.ok(profiles.data.counts.claude >= 1, "claude profile discovered");

  const capabilities = await call("burn.agent.capabilities.get", {}, context);
  assert.equal(capabilities.ok, true, "capabilities ok");
  assert.equal(capabilities.data.providers.codex.profile_inventory, true, "codex capabilities");
  assert.equal(capabilities.data.providers.claude.profile_inventory, true, "claude capabilities");
  assert.equal(capabilities.data.api.cli["burn agent account list"], true, "CLI account list capability missing");
  assert.equal(capabilities.data.api.desktop_actions["agent.accounts.list"], true, "desktop account list action capability missing");
  assert.equal(capabilities.data.api.bridge_commands["burn.agent.accounts.list"], true, "bridge account list command capability missing");

  const accounts = await call("burn.agent.accounts.list", { live: false }, context);
  assert.equal(accounts.ok, true, "accounts list ok");
  assert.equal(accounts.data.schema, "burn.agent.accounts.v1", "accounts list schema");
  assert.ok(accounts.data.accounts.length >= 2, "account list should include Codex and Claude fixtures");
  assertAccountAvailability(accounts.data.accounts.find((item) => item.profile.id === "codex:default"), "codex:default");
  assertAccountAvailability(accounts.data.accounts.find((item) => item.profile.id === "claude:default"), "claude:default");
  assert.equal(accounts.data.accounts.find((item) => item.profile.id === "codex:default").account.email_display, "c***@example.com", "Codex email must be masked");
  assert.equal(accounts.data.accounts.find((item) => item.profile.id === "claude:default").account.email_display, "c***@example.com", "Claude email must be masked");
  assertNoSecretLeak(accounts.data, ["codex-local@example.com", "claude-local@example.com", "redacted"]);

  const accountGet = await call("burn.agent.accounts.get", { profile_id: "codex:default", live: false }, context);
  assert.equal(accountGet.ok, true, "account get ok");
  assert.equal(accountGet.data.schema, "burn.agent.account.get.v1", "account get schema");
  assertAccountAvailability(accountGet.data.account, "codex:default");

  const active = await call("burn.agent.accounts.active", { source: "claude", live: false }, context);
  assert.equal(active.ok, true, "active account ok");
  assert.equal(active.data.schema, "burn.agent.accounts.active.v1", "active account schema");
  assert.equal(active.data.active.profile.id, "claude:default", "active Claude profile");
  assert.equal(active.data.active.active_reason, "CLAUDE_CONFIG_DIR", "active reason");
  assert.deepEqual(active.data.active.env_keys, ["CLAUDE_CONFIG_DIR"], "active env keys");
  assertAccountAvailability(active.data.active, "claude:default");

  const diagnostics = await call("burn.agent.login.diagnostics", { live: false }, context);
  assert.equal(diagnostics.ok, true, "login diagnostics ok");
  assert.equal(diagnostics.data.schema, "burn.agent.login-diagnostics.v1", "login diagnostics schema");
  assert.ok(diagnostics.data.diagnostics.some((item) => item.profile_id === "codex:default"), "Codex diagnostic missing");
  assert.ok(diagnostics.data.diagnostics.some((item) => item.profile_id === "claude:default"), "Claude diagnostic missing");
  assertNoSecretLeak(diagnostics.data, ["codex-local@example.com", "claude-local@example.com", "redacted"]);

  const actions = await call("burn.action.list", { target: "desktop" }, context);
  assert.equal(actions.ok, true, "action list ok");
  assert.ok(actions.data.actions.some((item) => item.id === "agent.profile.discover"), "desktop action registry migrated");
  assert.ok(actions.data.actions.some((item) => item.id === "agent.accounts.list"), "desktop account list action migrated");

  assertQuotaWindowShape();

  console.log(JSON.stringify({
    ok: true,
    check: "panda-burn-local-runtime",
    commands: [
      health.type,
      store.type,
      profiles.type,
      capabilities.type,
      accounts.type,
      accountGet.type,
      active.type,
      diagnostics.type,
      actions.type,
    ],
    cli_executions: context.cliExecutions.length,
  }, null, 2));
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
}

function writeExecutable(file, content) {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

async function call(type, input, context) {
  const response = await dispatchPandaBurnCommand({
    version: "burn-relay-v1",
    type,
    request_id: `verify-${type}`,
    input,
  }, context);
  assert.notEqual(response?.ok, false, `${type} failed: ${JSON.stringify(response)}`);
  return response;
}

function assertAccountAvailability(row, profileId) {
  assert.ok(row, `${profileId} account row missing`);
  assert.equal(row.schema, "burn.agent.account-availability.v1", `${profileId} availability schema`);
  assert.equal(row.profile.id, profileId, `${profileId} profile id`);
  assert.equal(typeof row.profile.command_available, "boolean", `${profileId} command_available`);
  assert.equal(typeof row.profile.auth_hint_present, "boolean", `${profileId} auth_hint_present`);
  assert.equal(typeof row.account.identity_known, "boolean", `${profileId} identity_known`);
  assert.equal(typeof row.account.account_hash, "string", `${profileId} account_hash`);
  assert.equal(typeof row.availability.auth_status, "string", `${profileId} auth_status`);
  assert.equal(typeof row.availability.can_start_new_turn, "boolean", `${profileId} can_start_new_turn`);
  assert.equal(typeof row.availability.needs_login, "boolean", `${profileId} needs_login`);
  assert.equal(row.availability.quota.windows instanceof Array, true, `${profileId} quota windows`);
  assert.equal(typeof row.health.status, "string", `${profileId} health status`);
  assert.equal(typeof row.frontend.display_status, "string", `${profileId} frontend status`);
}

function assertQuotaWindowShape() {
  const quota = withQuotaWindowFields({
    source_kind: "fixture",
    authoritative: true,
    live_status: "live",
    allowed: true,
    plan_type: "pro",
    remaining_display: "40%",
    windows: [
      {
        limit_id: "five_hour",
        kind: "primary",
        used_percent: 60,
        remaining_percent: 40,
        window_minutes: 300,
        resets_at: "2026-06-20T05:00:00.000Z",
      },
      {
        limit_id: "seven_day",
        kind: "secondary",
        used_percent: 25,
        remaining_percent: 75,
        window_minutes: 10080,
        resets_at: "2026-06-27T00:00:00.000Z",
      },
    ],
  });
  assert.equal(quota.five_hour_remaining_display, "40%", "5h display must use remaining_percent");
  assert.notEqual(quota.five_hour_remaining_display, "60%", "5h display must not use used_percent");
  assert.equal(quota.five_hour_resets_at, "2026-06-20T05:00:00.000Z", "5h reset");
  assert.equal(quota.weekly_remaining_display, "75%", "weekly display must use remaining_percent");
  assert.notEqual(quota.weekly_remaining_display, "25%", "weekly display must not use used_percent");
  assert.equal(quota.weekly_resets_at, "2026-06-27T00:00:00.000Z", "weekly reset");
  assert.equal(quota.windows[0].used_percent, 60, "5h used_percent preserved");
  assert.equal(quota.windows[0].remaining_percent, 40, "5h remaining_percent preserved");
  assert.equal(quota.windows[1].used_percent, 25, "weekly used_percent preserved");
  assert.equal(quota.windows[1].remaining_percent, 75, "weekly remaining_percent preserved");

  const duplicateSummary = availabilityQuotaSummary({
    windows: [
      { limit_id: "five_hour_a", remaining_percent: 90, window_minutes: 300 },
      { limit_id: "five_hour_b", remaining_percent: 35, window_minutes: 300 },
      { limit_id: "weekly_a", remaining_percent: 70, window_minutes: 10080 },
      { limit_id: "weekly_b", remaining_percent: 20, window_minutes: 10080 },
    ],
  });
  assert.equal(duplicateSummary.five_hour_remaining_display, "35%", "5h duplicate windows choose tightest remaining_percent");
  assert.equal(duplicateSummary.weekly_remaining_display, "20%", "weekly duplicate windows choose tightest remaining_percent");

  const unknownQuota = emptyAvailabilityQuota({
    source_kind: "claude_local_auth_status",
    live_status: "subscription_status_only",
    allowed: true,
  });
  assert.equal(unknownQuota.five_hour_remaining_display, "", "unknown 5h quota display stays empty");
  assert.equal(unknownQuota.weekly_remaining_display, "", "unknown weekly quota display stays empty");
  assert.deepEqual(unknownQuota.windows, [], "unknown quota keeps an empty windows array");
}

function assertNoSecretLeak(payload, secrets) {
  const text = JSON.stringify(payload);
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `payload leaked secret: ${secret}`);
  }
}
