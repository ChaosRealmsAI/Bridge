#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(new URL("../..", import.meta.url).pathname);
const cli = resolve(root, "adapters/panda-burn/local-tools/backend/burn-agent.mjs");
const relayRunner = resolve(root, "adapters/panda-burn/local-tools/scripts/bridge/relay/agent-runner.mjs");
const temp = mkdtempSync(join(tmpdir(), "panda-burn-abnormal-guardian-"));
const previous = {
  HOME: process.env.HOME,
  BURN_APP_HOME: process.env.BURN_APP_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};

try {
  const home = join(temp, "home");
  const burnHome = join(temp, "burn-home");
  const project = join(temp, "private-workspace", "secret-project");
  const codexDir = join(home, ".codex", "sessions", "2026", "06", "21");
  const expiredCodexDir = join(home, ".codex-expired", "sessions", "2026", "06", "21");
  const claudeProjectDir = join(home, ".claude", "projects", "-private-workspace-secret-project");
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(expiredCodexDir, { recursive: true });
  mkdirSync(claudeProjectDir, { recursive: true });
  mkdirSync(project, { recursive: true });

  const codexSocket = join(codexDir, "rollout-socket-error.jsonl");
  const codexRecovered = join(codexDir, "rollout-recovered.jsonl");
  const codexStall = join(codexDir, "rollout-stall.jsonl");
  const codexQuotedError = join(codexDir, "rollout-quoted-error.jsonl");
  const codexTokenError = join(codexDir, "rollout-token-error.jsonl");
  const codexMediumError = join(codexDir, "rollout-medium-error.jsonl");
  const claudeClean = join(claudeProjectDir, "claude-clean.jsonl");
  const expiredHistory = join(expiredCodexDir, "history-only.jsonl");

  writeJsonl(codexSocket, [
    { timestamp: "2026-06-21T00:00:00.000Z", type: "session_meta", payload: { id: "socket-error", cwd: project } },
    { timestamp: "2026-06-21T00:00:01.000Z", type: "event_msg", payload: { type: "error", message: "API Error: The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()" } },
  ]);
  writeJsonl(codexRecovered, [
    { timestamp: "2026-06-21T00:00:00.000Z", type: "session_meta", payload: { id: "recovered", cwd: project } },
    { timestamp: "2026-06-21T00:00:01.000Z", type: "event_msg", payload: { type: "error", message: "API Error: temporary rate limit" } },
    { timestamp: "2026-06-21T00:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "Recovered final answer" } },
  ]);
  writeJsonl(codexStall, [
    { timestamp: "2026-06-21T00:00:00.000Z", type: "session_meta", payload: { id: "stall", cwd: project } },
    { timestamp: "2026-06-21T00:00:01.000Z", type: "user", message: { role: "user", content: [{ type: "text", text: "secret prompt that must not leak" }] } },
  ]);
  writeJsonl(codexQuotedError, [
    { timestamp: "2026-06-21T00:00:00.000Z", type: "session_meta", payload: { id: "quoted-error", cwd: project } },
    { timestamp: "2026-06-21T00:00:01.000Z", type: "user", message: { role: "user", content: [{ type: "text", text: "Please explain this API Error: The socket connection was closed unexpectedly." }] } },
  ]);
  writeJsonl(codexTokenError, [
    { timestamp: "2026-06-21T00:00:00.000Z", type: "session_meta", payload: { id: "token-error", cwd: project } },
    { timestamp: "2026-06-21T00:00:01.000Z", type: "event_msg", payload: { type: "error", message: "API Error: failed with token sk-proj-FAKESECRET1234567890" } },
  ]);
  writeJsonl(codexMediumError, [
    { timestamp: "2026-06-21T00:00:00.000Z", type: "session_meta", payload: { id: "medium-error", cwd: project } },
    { timestamp: "2026-06-21T00:00:01.000Z", type: "event_msg", payload: { type: "error", message: "ECONNRESET while reading stream" } },
  ]);
  writeJsonl(claudeClean, [
    { type: "user", sessionId: "claude-clean", cwd: project, message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { type: "assistant", sessionId: "claude-clean", cwd: project, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ]);
  writeJsonl(expiredHistory, [
    { timestamp: "2026-06-21T00:00:00.000Z", type: "session_meta", payload: { id: "history-only", cwd: project } },
  ]);

  process.env.HOME = home;
  process.env.BURN_APP_HOME = burnHome;
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");

  const sources = run(["observer", "sources"]);
  assert.equal(sources.schema, "burn.agent.observer.sources.v1", "source schema");
  assert.ok(sources.sources.some((item) => item.source === "codex" && item.source_kind === "codex_sessions" && item.readable), "active Codex source root monitored");
  assert.ok(sources.sources.some((item) => item.source === "codex" && item.source_root_display.includes(".codex-expired") && item.monitoring_included && !item.profile_usable), "unusable/history-only source root monitored");
  assert.ok(sources.sources.some((item) => item.source === "claude" && item.source_kind === "claude_projects" && item.readable), "Claude source root monitored");

  const firstDeltas = run(["observer", "deltas", "list"]);
  assert.equal(firstDeltas.schema, "burn.agent.observer.deltas.v1", "delta schema");
  assert.ok(firstDeltas.counts.session_added >= 8, "initial scan emits session_added for existing JSONL");
  assert.ok(firstDeltas.shared_stream_consumers.includes("normal session push/history refresh"), "normal push uses shared delta stream");
  assert.ok(firstDeltas.shared_stream_consumers.includes("abnormal-session classifier"), "abnormal classifier uses shared delta stream");

  const quietDeltas = run(["observer", "deltas", "list"]);
  assert.equal(quietDeltas.counts.deltas, 0, "unchanged second scan is quiet");

  const newJsonl = join(codexDir, "rollout-new-session.jsonl");
  writeJsonl(newJsonl, [
    { timestamp: "2026-06-21T00:01:00.000Z", type: "session_meta", payload: { id: "new-session", cwd: project } },
  ]);
  futureTouch(newJsonl, 2000);
  const newDeltas = run(["observer", "deltas", "list"]);
  assert.ok(newDeltas.deltas.some((item) => item.kind === "session_added" && item.session_id === "new-session"), "new JSONL emits session_added");
  assert.ok(newDeltas.deltas.some((item) => item.kind === "transcript_delta" && item.session_id === "new-session"), "new JSONL also emits transcript_delta");

  appendFileSync(claudeClean, `${JSON.stringify({ type: "assistant", sessionId: "claude-clean", cwd: project, message: { role: "assistant", content: [{ type: "text", text: "changed" }] } })}\n`);
  futureTouch(claudeClean, 4000);
  const changedDeltas = run(["observer", "deltas", "list"]);
  assert.ok(changedDeltas.deltas.some((item) => item.kind === "transcript_delta" && item.source === "claude"), "changed JSONL emits transcript_delta");

  const abnormal = run(["abnormal", "scan", "--stability-ms", "0", "--no-response-ms", "0", "--include-suppressed"]);
  assert.equal(abnormal.schema, "burn.agent.abnormal.list.v1", "abnormal schema");
  assert.equal(abnormal.committed, true, "abnormal scan persists local store");
  assert.ok(abnormal.incidents.some((item) => item.marker.id === "socket_connection_closed" && item.state === "incident"), "socket closed is a confirmed incident");
  assert.ok(abnormal.incidents.some((item) => item.session_id === "token-error"), "token-bearing provider error is still detected");
  assert.equal(abnormal.incidents.some((item) => item.session_id === "medium-error"), false, "medium-confidence transport marker is not a confirmed incident");
  assert.ok(abnormal.candidates.some((item) => item.session_id === "medium-error" && item.state === "candidate_medium_confidence"), "medium-confidence transport marker remains candidate");
  assert.equal(JSON.stringify(abnormal.incidents).includes("sk-proj-FAKESECRET1234567890"), false, "incident preview redacts sk-proj token");
  assert.equal(abnormal.incidents.some((item) => item.session_id === "quoted-error"), false, "quoted user API Error prose is not a provider incident");
  assert.equal(abnormal.candidates.some((item) => item.session_id === "quoted-error" && item.marker.id !== "no_response_tail"), false, "quoted user API Error prose can only be a stall candidate");
  assert.ok(abnormal.suppressed.some((item) => item.state === "suppressed_recovered"), "recovered error is suppressed");
  assert.ok(abnormal.candidates.some((item) => item.marker.id === "no_response_tail" && item.state === "suspected_stall" && item.severity === "warning"), "stable nonterminal tail is suspected stall");
  assert.ok(existsSync(join(burnHome, "data", "agent-abnormal", "latest.json")), "latest abnormal snapshot written");
  assert.ok(existsSync(join(burnHome, "data", "agent-abnormal", "events.jsonl")), "abnormal event stream written");

  const perf = run(["observer", "perf"]);
  assert.equal(perf.schema, "burn.agent.observer.perf.v1", "perf schema");
  assert.equal(perf.sample.network_call_count, 0, "observer must not call provider/network");
  assert.equal(perf.sample.tail_read_max_bytes_per_changed_file, 65536, "bounded tail reads");
  assert.ok(perf.budget.cataloged_sessions_max >= 100000, "reference catalog budget present");

  const daemon = run(["observer", "daemon-run", "--once", "--interval-ms", "250", "--stability-ms", "0", "--no-response-ms", "0"]);
  assert.equal(daemon.mode, "daemon_run_complete", "daemon-run returns completion summary");
  assert.equal(daemon.iterations, 1, "daemon once runs one iteration");
  assert.ok(existsSync(join(burnHome, "data", "agent-observer", "daemon.json")), "daemon state written");

  const watchStart = run(["observer", "watch", "start", "--interval-ms", "250", "--lease-ms", "5000", "--stability-ms", "0", "--no-response-ms", "0"]);
  assert.equal(watchStart.running, true, "watch start reports running intent");
  assert.ok(watchStart.daemon_pid > 0, "watch start reports daemon pid");
  await sleep(500);
  const watchStatus = run(["observer", "watch", "status"]);
  assert.equal(watchStatus.watcher.requested_running, true, "watch status keeps requested_running while daemon is active");
  const watchStop = run(["observer", "watch", "stop"]);
  assert.equal(watchStop.running, false, "watch stop reports stopped");

  const publicOutput = JSON.stringify({ sources, firstDeltas, changedDeltas, abnormal, perf, daemon, watchStart, watchStatus, watchStop });
  assertNoLeak(publicOutput, [
    temp,
    home,
    burnHome,
    project,
    "secret prompt that must not leak",
    "Please explain this API Error",
    "sk-proj-FAKESECRET1234567890",
    "Recovered final answer",
    "claude-clean@example.com",
  ]);
  assertRelayWatchRedactionSource();

  console.log(JSON.stringify({
    ok: true,
    check: "panda-burn-abnormal-guardian",
    source_roots: sources.counts.source_roots,
    initial_deltas: firstDeltas.counts.deltas,
    incidents: abnormal.counts.incidents,
    candidates: abnormal.counts.candidates,
    daemon_iterations: daemon.iterations,
    watch_daemon_pid: watchStart.daemon_pid,
    network_call_count: perf.sample.network_call_count,
  }, null, 2));
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
}

function writeJsonl(file, rows) {
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function run(args) {
  return JSON.parse(execFileSync("node", [cli, ...args, "--json"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  }));
}

function futureTouch(file, offsetMs) {
  const when = new Date(Date.now() + offsetMs);
  utimesSync(file, when, when);
}

function assertNoLeak(text, forbidden) {
  for (const value of forbidden) {
    assert.equal(text.includes(value), false, `public observer output leaked ${value}`);
  }
  const latest = readFileSync(join(process.env.BURN_APP_HOME, "data", "agent-abnormal", "latest.json"), "utf8");
  for (const value of forbidden) {
    assert.equal(latest.includes(value), false, `persisted abnormal latest leaked ${value}`);
  }
}

function assertRelayWatchRedactionSource() {
  const source = readFileSync(relayRunner, "utf8");
  assert.equal(source.includes("transcript_path: transcriptPath"), false, "session watch must not emit raw transcript_path");
  assert.equal(source.includes("\"--state-path\""), false, "relay must not forward arbitrary observer state paths");
  assert.equal(source.includes("project: projectHandle"), true, "session watch emits project evidence handle");
  assert.equal(source.includes("transcript_path_display: evidenceHandle(transcriptPath"), true, "session watch emits transcript evidence handle");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
