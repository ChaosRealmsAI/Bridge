#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  decryptBridgeRelayEnvelope,
  encryptBridgeRelayEnvelope,
} from "../../packages/adapter-sdk/src/index.js";
import { startPandaBurnAdapter } from "../../adapters/panda-burn/src/adapter-server.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const temp = mkdtempSync(join(tmpdir(), "panda-burn-usage-ledger-"));
const previousHome = process.env.HOME;
let burnHome = "";

function runCli(args, env) {
  return execFileSync("node", [join(root, "adapters/panda-burn/bin/panda-burn.mjs"), ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

try {
  const home = join(temp, "home");
  burnHome = join(temp, "burn-home");
  const project = join(temp, "project");
  mkdirSync(project, { recursive: true });
  const projectReal = realpathSync(project);
  seedFixtures(home, project);

  const env = {
    ...process.env,
    HOME: home,
    BURN_APP_HOME: burnHome,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
  };

  const cliRaw = runCli(["agent", "usage", "summary", "--project", project, "--timezone", "Asia/Shanghai", "--json"], env);
  const result = JSON.parse(cliRaw);
  assertLedger(result, projectReal, { rawPaths: true });

  const ledgerDir = join(burnHome, "data/agent-usage");
  const latest = JSON.parse(readFileSync(join(ledgerDir, "latest.json"), "utf8"));
  assert.equal(latest.run_id, result.run_id, "latest.json must match CLI run");
  assert.equal(JSON.parse(readFileSync(result.output.run_path, "utf8")).run_id, result.run_id, "run file must exist");
  assert.equal(result.output.directory, ledgerDir, "ledger must be stored in user-level Burn home");
  assert.equal(result.storage.engine, "sqlite_with_json_views", "fresh scan should materialize sqlite plus JSON views");
  assert.equal(result.storage.sqlite.enabled, true, "sqlite materialization should be enabled on the bundled Node runtime");
  assert.equal(result.storage.sqlite.sqlite_path, join(ledgerDir, "usage.sqlite"), "sqlite path");
  assert.ok(existsSync(join(ledgerDir, "usage.sqlite")), "usage.sqlite must be generated");
  assert.throws(() => readFileSync(join(projectReal, ".burn/agent-usage-ledger/latest.json"), "utf8"), /ENOENT/, "usage ledger must not write project .burn");
  assert.equal(result.diagnostics.cache.files_hit, 0, "first run should not hit cache");
  assert.ok(result.diagnostics.cache.files_read >= 3, "first run should read fixture JSONL files");

  const cachedRaw = runCli(["agent", "usage", "summary", "--project", project, "--timezone", "Asia/Shanghai", "--json"], env);
  const cachedResult = JSON.parse(cachedRaw);
  assertLedger(cachedResult, projectReal, { rawPaths: true });
  assert.equal(cachedResult.served_from_cache, true, "second run should hit result cache");
  assert.equal(cachedResult.diagnostics.result_cache_hit, true, "second run diagnostics should report result cache");
  assert.equal(cachedResult.run_id, result.run_id, "result cache should reuse the previous immutable run");

  const forcedRaw = runCli(["agent", "usage", "summary", "--project", project, "--timezone", "Asia/Shanghai", "--force", "--json"], env);
  const forcedResult = JSON.parse(forcedRaw);
  assertLedger(forcedResult, projectReal, { rawPaths: true });
  assert.ok(forcedResult.diagnostics.cache.files_hit >= 3, "forced second scan should reuse parsed JSONL cache");
  assert.ok(forcedResult.diagnostics.cache.file_aggregate_hits >= 3, "forced second scan should reuse per-file aggregate cache");
  assert.equal(forcedResult.diagnostics.cache.files_read, 0, "forced second scan should not reread unchanged JSONL files");
  assert.equal(forcedResult.output.run_path === result.output.run_path, false, "forced same-second runs must not overwrite run files");
  assert.equal(JSON.parse(readFileSync(join(ledgerDir, "views/totals.json"), "utf8")).view, "totals", "totals view file missing");
  assert.equal(JSON.parse(readFileSync(join(ledgerDir, "views/activity.json"), "utf8")).view, "activity", "activity view file missing");
  assert.ok(JSON.parse(readFileSync(join(ledgerDir, "views/dimensions/by_account_day.json"), "utf8")).rows.length >= 3, "dimension view file missing");

  const filteredRaw = runCli(["agent", "usage", "summary", "--project", project, "--profile-ids", "codex:default", "--timezone", "Asia/Shanghai", "--json"], env);
  const filtered = JSON.parse(filteredRaw);
  assert.equal(filtered.profiles.length, 1, "profile include filter should scan one profile");
  assert.equal(filtered.profiles[0].id, "codex:default", "profile include filter id");
  assert.deepEqual(filtered.scan_scope.profile_ids, ["codex:default"], "profile include scope");
  assert.equal(filtered.totals.tokens.total_tokens, 278, "profile include total tokens");

  const excludedRaw = runCli(["agent", "usage", "summary", "--project", project, "--exclude-profile-ids", "codex:default", "--timezone", "Asia/Shanghai", "--json"], env);
  const excluded = JSON.parse(excludedRaw);
  assert.equal(excluded.profiles.some((profile) => profile.id === "codex:default"), false, "profile exclude filter should skip profile");
  assert.equal(excluded.totals.tokens.total_tokens, 53, "profile exclude total tokens");

  const activity = JSON.parse(runCli(["agent", "usage", "activity", "--project", project, "--timezone", "Asia/Shanghai", "--json"], env));
  assert.equal(activity.view, "activity", "activity CLI view");
  assert.ok(activity.activity.daily_heatmap.length >= 1, "daily heatmap missing");
  assert.ok(activity.activity.weekday_hour_heatmap.length >= 1, "weekday/hour heatmap missing");

  const accountDimension = JSON.parse(runCli(["agent", "usage", "dimension", "--project", project, "--dimension", "by_account_day", "--limit", "2", "--timezone", "Asia/Shanghai", "--json"], env));
  assert.equal(accountDimension.view, "dimension", "dimension CLI view");
  assert.equal(accountDimension.dimension, "by_account_day", "dimension name");
  assert.equal(accountDimension.rows.length, 2, "dimension limit should be honored");

  const snapshotActivity = JSON.parse(runCli(["agent", "usage", "snapshot", "--project", project, "--view", "activity", "--json"], env));
  assert.equal(snapshotActivity.cache_hit_kind, "snapshot", "snapshot activity should read local structured view");
  assert.equal(snapshotActivity.snapshot.active_scan, false, "snapshot should not scan JSONL");
  assert.equal(snapshotActivity.activity.active_days, activity.activity.active_days, "snapshot activity should match latest generated view");

  const snapshotDimension = JSON.parse(runCli(["agent", "usage", "snapshot", "--project", project, "--dimension", "by_account_day", "--limit", "1", "--json"], env));
  assert.equal(snapshotDimension.cache_hit_kind, "snapshot", "snapshot dimension should read local structured view");
  assert.equal(snapshotDimension.rows.length, 1, "snapshot dimension limit");

  const compact = JSON.parse(runCli(["agent", "usage", "compact", "--project", project, "--json"], env));
  assert.equal(compact.ok, true, "cache compact command");
  assert.equal(compact.schema, "panda-burn.agent-usage-ledger-cache-maintenance.v1", "cache compact schema");
  assert.ok(compact.compacted_files >= 1, "cache compact should touch derived cache files");

  const leaked = JSON.stringify(result);
  for (const secret of [
    "codex-user@example.com",
    "codex-work@example.com",
    "claude-user@example.com",
    "raw-codex-account",
    "redacted-codex-secret",
    "prompt secret should not leak",
  ]) {
    assert.equal(leaked.includes(secret), false, `ledger leaked secret/content: ${secret}`);
  }

  process.env.HOME = home;
  process.env.BURN_APP_HOME = burnHome;
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  const keyBytes = randomBytes(32);
  const runtime = await startPandaBurnAdapter({ keyB64: keyBytes.toString("base64") });
  try {
    const envelope = await encryptBridgeRelayEnvelope({
      type: "burn.agent.usage.summary",
      input: { project: projectReal, timezone: "Asia/Shanghai" },
    }, keyBytes, {
      product_id: "panda-burn",
      device_id: "dev_1",
      channel_id: "usage-ledger",
      seq: 1,
      request_key: "usage-ledger-request-1",
      sender_key_id: "test-product",
      recipient_key_id: "test-adapter",
    });
    const response = await fetch(runtime.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    assert.equal(response.status, 200, "adapter relay request should succeed");
    const payload = await response.json();
    assert.equal(payload.ok, true, "adapter should return response envelope");
    const decrypted = await decryptBridgeRelayEnvelope(payload.response_envelope, keyBytes);
    assertLedger(decrypted, projectReal, { rawPaths: false });
    assertRelayRedaction(decrypted, projectReal);

    const replay = await fetch(runtime.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const replayPayload = await replay.json();
    assert.equal(replayPayload.replay, true, "duplicate relay envelope should replay cached response");
    assert.equal(runtime.executions.length, 1, "duplicate relay envelope must not rescan");

    const snapshotEnvelope = await encryptBridgeRelayEnvelope({
      type: "burn.agent.usage.snapshot",
      input: { project: projectReal, view: "activity" },
    }, keyBytes, {
      product_id: "panda-burn",
      device_id: "dev_1",
      channel_id: "usage-ledger",
      seq: 2,
      request_key: "usage-ledger-snapshot-1",
      sender_key_id: "test-product",
      recipient_key_id: "test-adapter",
    });
    const snapshotResponse = await fetch(runtime.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshotEnvelope),
    });
    assert.equal(snapshotResponse.status, 200, "adapter snapshot alias should succeed");
    const snapshotPayload = await snapshotResponse.json();
    const snapshotDecrypted = await decryptBridgeRelayEnvelope(snapshotPayload.response_envelope, keyBytes);
    assert.equal(snapshotDecrypted.cache_hit_kind, "snapshot", "relay snapshot alias should read local structured view");
    assert.equal(snapshotDecrypted.snapshot.active_scan, false, "relay snapshot should not scan JSONL");
    assertRelayRedaction(snapshotDecrypted, projectReal);

    const badEnvelope = await encryptBridgeRelayEnvelope({
      type: "burn.agent.usage.summary",
      input: { project: "relative-project" },
    }, keyBytes, {
      product_id: "panda-burn",
      device_id: "dev_1",
      channel_id: "usage-ledger",
      seq: 3,
      request_key: "usage-ledger-bad-project",
      sender_key_id: "test-product",
      recipient_key_id: "test-adapter",
    });
    const badResponse = await fetch(runtime.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(badEnvelope),
    });
    assert.equal(badResponse.status, 200, "business validation errors should stay inside encrypted response payload");
    const badPayload = await badResponse.json();
    const badDecrypted = await decryptBridgeRelayEnvelope(badPayload.response_envelope, keyBytes);
    assert.equal(badDecrypted.ok, false, "bad project should return encrypted business error");
    assert.equal(badDecrypted.code, "project_path_must_be_absolute", "bad project error code");
    assert.equal(JSON.stringify(badPayload).includes("relative-project"), false, "plaintext adapter response must not leak invalid project");
  } finally {
    await runtime.close();
  }

  console.log(JSON.stringify({
    ok: true,
    check: "panda-burn-usage-ledger",
    usage_events: result.diagnostics.usage_events,
    profiles: result.profiles.length,
    latest: result.output.latest_path_display,
  }, null, 2));
} finally {
  if (previousHome) process.env.HOME = previousHome;
  rmSync(temp, { recursive: true, force: true });
}

function seedFixtures(home, project) {
  mkdirSync(join(home, ".codex/sessions/2026/06/18"), { recursive: true });
  mkdirSync(join(home, ".codex-work/sessions/2026/06/18"), { recursive: true });
  mkdirSync(join(home, ".claude/projects/-tmp-project"), { recursive: true });

  writeFileSync(join(home, ".codex/auth.json"), JSON.stringify({
    email: "codex-user@example.com",
    account_id: "raw-codex-account",
    tokens: { id_token: "redacted-codex-secret" },
  }));
  writeFileSync(join(home, ".codex-work/auth.json"), JSON.stringify({
    email: "codex-work@example.com",
  }));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    email: "claude-user@example.com",
    token: "redacted-claude-secret",
  }));
  writeFileSync(join(home, ".claude/.credentials.json"), JSON.stringify({ token: "redacted-profile-token" }));

  writeFileSync(join(home, ".codex/sessions/2026/06/18/codex.jsonl"), [
    JSON.stringify({ timestamp: "2026-06-17T17:00:00.000Z", type: "session_meta", payload: { model: "gpt-5.5", cwd: project, id: "codex-session-1" } }),
    JSON.stringify({ timestamp: "2026-06-17T17:01:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 150 } } } }),
    "{bad json line",
    JSON.stringify({ timestamp: "2026-06-17T17:02:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 160, cached_input_tokens: 30, output_tokens: 70, reasoning_output_tokens: 7, total_tokens: 230 } } } }),
    JSON.stringify({ timestamp: "2026-06-17T17:03:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 40, cached_input_tokens: 4, output_tokens: 8, reasoning_output_tokens: 2, total_tokens: 48 }, total_token_usage: { input_tokens: 200, cached_input_tokens: 34, output_tokens: 78, reasoning_output_tokens: 9, total_tokens: 278 } } } }),
  ].join("\n"));

  writeFileSync(join(home, ".codex-work/sessions/2026/06/18/codex-work.jsonl"), [
    JSON.stringify({ timestamp: "2026-06-17T17:10:00.000Z", type: "session_meta", payload: { model: "mystery-model", cwd: project, id: "codex-session-2" } }),
    JSON.stringify({ timestamp: "2026-06-17T17:11:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } }),
  ].join("\n"));

  writeFileSync(join(home, ".claude/projects/-tmp-project/claude.jsonl"), [
    JSON.stringify({
      timestamp: "2026-06-17T18:00:00.000Z",
      type: "assistant",
      request_id: "req_1",
      session_id: "claude-session-1",
      cwd: project,
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-6",
        role: "assistant",
        content: [{ type: "text", text: "prompt secret should not leak" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 11,
          cache_creation: { ephemeral_1h_input_tokens: 7, ephemeral_5m_input_tokens: 0 },
        },
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-17T18:00:01.000Z",
      type: "assistant",
      request_id: "req_1",
      session_id: "claude-session-1",
      cwd: project,
      uuid: "different-line-same-request",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-6",
        role: "assistant",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 },
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-17T18:05:00.000Z",
      type: "result",
      session_id: "claude-session-1",
      usage: { input_tokens: 999, output_tokens: 999, cache_creation_input_tokens: 999, cache_read_input_tokens: 999 },
    }),
    JSON.stringify({
      timestamp: "2026-06-17T18:06:00.000Z",
      type: "result",
      session_id: "claude-session-2",
      model: "claude-sonnet-4-6",
      cwd: project,
      usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 6 },
    }),
  ].join("\n"));
}

function assertLedger(result, project, options = {}) {
  assert.equal(result.ok, true, "ledger ok");
  assert.equal(result.schema, "panda-burn.agent-usage-ledger.v1", "schema mismatch");
  assert.equal(result.source_policy.only_jsonl, true, "must be JSONL-only");
  assert.equal(result.source_policy.active_scan, true, "must be active scan");
  assert.equal(result.scan_scope.timezone, "Asia/Shanghai", "timezone scope");
  if (options.rawPaths) {
    assert.equal(result.scan_scope.user_level_storage, true, "ledger must use user-level storage");
    assert.equal(result.storage?.scope, "user", "storage scope");
    assert.equal(result.output.latest_path, join(burnHome, "data/agent-usage/latest.json"));
    assert.equal(result.output.run_path.startsWith(join(burnHome, "data/agent-usage/runs/")), true, "run path should be under user-level Burn home");
  } else {
    assert.equal(Object.hasOwn(result, "project"), false, "relay summary must omit raw project path");
    assert.equal(Object.hasOwn(result.output, "latest_path"), false, "relay summary must omit raw latest path");
    assert.equal(Object.hasOwn(result.output, "run_path"), false, "relay summary must omit raw run path");
  }

  assert.equal(result.diagnostics.usage_events, 6, "usage event count should include codex deltas, codex last, unknown model, collapsed claude assistant, and result fallback");
  assert.equal(result.diagnostics.skipped_lines, 1, "bad JSONL line should be skipped");
  assert.equal(result.diagnostics.duplicate_events, 0, "same-file Claude request duplicates should be collapsed before aggregation");
  assert.ok(result.diagnostics.unknown_model_pricing.includes("codex:mystery-model"), "unknown model warning missing");

  assert.equal(result.totals.tokens.input_tokens, 180, "input tokens");
  assert.equal(result.totals.tokens.cached_input_tokens, 0, "cached input tokens");
  assert.equal(result.totals.tokens.cache_creation_input_tokens, 12, "cache creation tokens");
  assert.equal(result.totals.tokens.cache_creation_1h_input_tokens, 7, "1h cache creation tokens");
  assert.equal(result.totals.tokens.cache_read_input_tokens, 51, "cache read tokens");
  assert.equal(result.totals.tokens.output_tokens, 88, "output tokens");
  assert.equal(result.totals.tokens.reasoning_output_tokens, 9, "reasoning tokens");
  assert.equal(result.totals.tokens.total_tokens, 331, "total tokens");
  assert.ok(result.totals.cost.total_usd > 0, "known models should estimate non-zero cost");

  assert.equal(result.dimensions.by_provider.length, 2, "provider dimension");
  assert.equal(result.dimensions.by_account.length, 3, "account dimension should be account-level across profiles");
  assert.ok(result.dimensions.by_model.some((row) => row.model === "gpt-5.5"), "gpt model dimension missing");
  assert.ok(result.dimensions.by_model.some((row) => row.model === "claude-sonnet-4-6"), "claude model dimension missing");
  assert.ok(result.dimensions.by_day.some((row) => row.day === "2026-06-18"), "day dimension missing");
  assert.ok(result.dimensions.by_week.some((row) => row.week === "2026-06-15"), "week dimension missing");
  assert.ok(result.dimensions.by_month.some((row) => row.month === "2026-06"), "month dimension missing");
  assert.ok(result.dimensions.by_hour.some((row) => row.hour === "01"), "hour dimension missing");
  assert.ok(result.dimensions.by_weekday_hour.some((row) => row.weekday === "3" && row.hour === "01"), "weekday/hour heatmap dimension missing");
  assert.ok(result.dimensions.by_account_day.length >= 3, "account day dimension missing");
  assert.ok(result.dimensions.by_account_week.length >= 3, "account week dimension missing");
  assert.ok(result.dimensions.by_account_hour.length >= 3, "account hour dimension missing");
  assert.ok(result.dimensions.by_account_project.length >= 3, "account project dimension missing");
  assert.ok(result.dimensions.by_project_month.length >= 1, "project month dimension missing");
  assert.ok(result.dimensions.by_project_week.length >= 1, "project week dimension missing");
  assert.ok(result.dimensions.by_model_day.length >= 2, "model day dimension missing");
  assert.ok(result.dimensions.by_session.length >= 3, "session dimension missing");
  assert.ok(result.activity.daily_heatmap.length >= 1, "daily heatmap missing");
  assert.ok(result.activity.peak_hours.length >= 1, "peak hours missing");
  assert.ok(result.totals.metrics.cache_hit_ratio > 0, "cache hit ratio missing");
  assert.equal(result.available_filters?.timezone, "Asia/Shanghai", "product-facing timezone filter missing");
  assert.ok(Array.isArray(result.available_filters?.profiles), "product-facing profile filters missing");
}

function assertRelayRedaction(result, project) {
  const serialized = JSON.stringify(result);
  for (const raw of [
    project,
    join(project, ".burn"),
    join(project, ".burn/agent-usage-ledger/latest.json"),
    burnHome,
    join(burnHome, "data/agent-usage/latest.json"),
    join(burnHome, "data/agent-usage/usage.sqlite"),
  ]) {
    assert.equal(serialized.includes(raw), false, `relay summary leaked raw path: ${raw}`);
  }
  assert.equal(result.redaction?.raw_paths, "omitted_from_relay_response", "relay redaction marker missing");
}
