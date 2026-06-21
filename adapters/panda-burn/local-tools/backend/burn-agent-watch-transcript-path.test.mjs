import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { runBurnAgentCommand } from "../scripts/bridge/relay/agent-runner.mjs";

const backendDir = dirname(fileURLToPath(import.meta.url));
const burn = resolve(backendDir, "burn");

for (const source of ["codex", "claude"]) {
  test(`${source} session watch polls direct transcript_path for monitor-discovered JSONL sessions`, async () => {
  const home = mkdtempSync(join(tmpdir(), "burn-agent-watch-path-"));
  const project = join(home, "project");
  const homeBacked = mkdtempSync(join(homedir(), ".burn-agent-watch-path-"));
  const transcript = join(homeBacked, source === "codex" ? "rollout-watch-path-session.jsonl" : "watch-path-session.jsonl");
  const transcriptInput = `~/${transcript.slice(homedir().length + 1)}`;
  const sessionId = "watch-path-session";
  mkdirSync(project, { recursive: true });
  writeFileSync(
    transcript,
    fixtureRows(source, sessionId, project, "baseline").map((row) => JSON.stringify(row)).join("\n") + "\n",
  );

  const events = [];
  const context = {
    cli: burn,
    root: project,
    authorizationMirror: { status: "active", roots: [project] },
    cliExecutions: [],
    emitProgress: async (event) => events.push(event),
  };

  try {
    setTimeout(() => {
      appendFileSync(
        transcript,
        fixtureRows(source, sessionId, project, "update", { includeMeta: false })
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
    }, 800);

    const result = await runBurnAgentCommand({
      type: "burn.agent.session.watch",
      request_id: "watch-path-test",
      input: {
        source,
        project,
        session_id: sessionId,
        transcript_path: transcriptInput,
        cursor: 2,
        total_messages: 2,
        lease_ms: 5000,
        interval_ms: 750,
      },
    }, context);

    assert.equal(result.ok, true);
    assert.equal(result.data.status, "lease_expired");
    assert.ok(result.data.emitted >= 1, "expected at least one watch event");
    assert.ok(events.length >= 1, "expected progress event");
    assert.equal(events.at(-1).data.session_id, sessionId);
    assert.equal(events.at(-1).data.total_messages, 4);
    assert.match(events.at(-1).data.transcript_path_display, /^<transcript:[0-9a-f]{16}>$/);
    assert.deepEqual(
      context.cliExecutions.map((entry) => entry.args[0]),
      context.cliExecutions.map(() => "sessions"),
      "watch should poll the durable transcript reader",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(homeBacked, { recursive: true, force: true });
  }
});
}

function fixtureRows(source, sessionId, project, label, { includeMeta = true } = {}) {
  const rows = [];
  if (includeMeta && source === "codex") {
    rows.push({ type: "session_meta", payload: { id: sessionId, cwd: project } });
  }
  rows.push(message(source, sessionId, project, "user", `${label} user`));
  rows.push(message(source, sessionId, project, "assistant", `${label} assistant`));
  return rows;
}

function message(source, sessionId, project, role, text) {
  if (source === "claude") {
    return {
      type: role,
      sessionId,
      cwd: project,
      timestamp: "2026-06-21T07:00:00Z",
      message: {
        role,
        content: [{ type: "text", text }],
      },
    };
  }
  return {
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}
