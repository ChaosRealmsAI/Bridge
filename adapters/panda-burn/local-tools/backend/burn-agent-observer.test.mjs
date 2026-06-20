import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const backendDir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(backendDir, "burn-agent.mjs");

test("observer tracks source roots, JSONL deltas, abnormal errors, and recovered tails", () => {
  const temp = mkdtempSync(join(tmpdir(), "burn-agent-observer-"));
  try {
    const home = join(temp, "home");
    const burnHome = join(temp, "burn-home");
    const project = join(temp, "project");
    const codexDir = join(home, ".codex", "sessions", "2026", "06", "21");
    const claudeDir = join(home, ".claude", "projects", "-tmp-project");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(project, { recursive: true });

    const codexError = join(codexDir, "rollout-codex-error.jsonl");
    const codexRecovered = join(codexDir, "rollout-codex-recovered.jsonl");
    const claudeSession = join(claudeDir, "claude-session.jsonl");
    writeFileSync(codexError, [
      JSON.stringify({ timestamp: "2026-06-21T00:00:00.000Z", type: "session_meta", payload: { id: "codex-error", cwd: project } }),
      JSON.stringify({ timestamp: "2026-06-21T00:00:01.000Z", type: "event_msg", payload: { type: "error", message: "API Error: The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()" } }),
      "",
    ].join("\n"));
    writeFileSync(codexRecovered, [
      JSON.stringify({ timestamp: "2026-06-21T00:00:00.000Z", type: "session_meta", payload: { id: "codex-recovered", cwd: project } }),
      JSON.stringify({ timestamp: "2026-06-21T00:00:01.000Z", type: "event_msg", payload: { type: "error", message: "API Error: transient transport failure" } }),
      JSON.stringify({ timestamp: "2026-06-21T00:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "Recovered with a normal reply" } }),
      "",
    ].join("\n"));
    writeFileSync(claudeSession, [
      JSON.stringify({ type: "user", sessionId: "claude-session", cwd: project, message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "assistant", sessionId: "claude-session", cwd: project, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      "",
    ].join("\n"));

    const env = {
      ...process.env,
      HOME: home,
      BURN_APP_HOME: burnHome,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    };

    const sources = run(["observer", "sources"], env);
    assert.equal(sources.schema, "burn.agent.observer.sources.v1");
    assert.equal(sources.counts.readable >= 2, true, "Codex and Claude roots should be readable");
    assert.equal(sources.sources.some((item) => item.source === "codex" && item.monitoring_included), true);
    assert.equal(sources.sources.some((item) => item.source === "claude" && item.monitoring_included), true);

    const firstDeltas = run(["observer", "deltas", "list"], env);
    assert.equal(firstDeltas.schema, "burn.agent.observer.deltas.v1");
    assert.equal(firstDeltas.counts.session_added >= 3, true, "first scan should emit baseline session_added events");

    const secondDeltas = run(["observer", "deltas", "list"], env);
    assert.equal(secondDeltas.counts.deltas, 0, "unchanged second scan should be quiet");

    appendFileSync(claudeSession, `${JSON.stringify({ type: "assistant", sessionId: "claude-session", cwd: project, message: { role: "assistant", content: [{ type: "text", text: "changed" }] } })}\n`);
    const changedAt = new Date(Date.now() + 2000);
    utimesSync(claudeSession, changedAt, changedAt);
    const changedDeltas = run(["observer", "deltas", "list"], env);
    assert.equal(changedDeltas.deltas.some((item) => item.kind === "transcript_delta" && item.source === "claude"), true);

    const abnormal = run(["abnormal", "list", "--stability-ms", "0", "--include-suppressed"], env);
    assert.equal(abnormal.schema, "burn.agent.abnormal.list.v1");
    assert.equal(abnormal.incidents.some((item) => item.marker.id === "socket_connection_closed"), true);
    assert.equal(abnormal.suppressed.some((item) => item.state === "suppressed_recovered"), true);
    assert.equal(JSON.stringify(abnormal).includes(project), false, "raw project path must not leak");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function run(args, env) {
  return JSON.parse(execFileSync("node", [cli, ...args, "--json"], {
    cwd: backendDir,
    env,
    encoding: "utf8",
  }));
}
