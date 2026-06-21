import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = dirname(fileURLToPath(import.meta.url));
const burn = resolve(backendDir, "burn");

test("burn agent session show forwards --latest to source session show", async () => {
  const home = mkdtempSync(join(tmpdir(), "burn-agent-latest-"));
  const codexHome = join(home, ".codex");
  const sessionDir = join(codexHome, "sessions", "2026", "06", "21");
  const project = join(home, "project");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ token: "redacted" }));
  writeFileSync(
    join(sessionDir, "rollout-codex-latest.jsonl"),
    [
      { type: "session_meta", payload: { id: "codex-latest", cwd: project } },
      message("user", "one"),
      message("assistant", "two"),
      message("user", "three"),
      message("assistant", "four"),
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );

  const stdout = await execJson([
    "agent",
    "session",
    "show",
    "--source",
    "codex",
    "--project",
    project,
    "--session-id",
    "codex-latest",
    "--latest",
    "--limit",
    "1",
    "--json",
  ], {
    HOME: home,
    CODEX_HOME: codexHome,
  });
  const payload = JSON.parse(stdout);
  assert.equal(payload.order, "latest");
  assert.equal(payload.total_messages, 4);
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].blocks[0].text, "four");
});

// REQ-CHAT-CMD-002 / ISS-CHAT-CMD-001:
// Flutter sends slash commands through `burn.agent.command.run`, whose desktop
// wrapper enters here as `burn agent source command run`; this guards that the
// wrapper forwards the command id and args instead of dropping them before
// `burn-chat source command run`.
test("burn agent source command run forwards --command and --args", async () => {
  const home = mkdtempSync(join(tmpdir(), "burn-agent-command-run-"));
  const codexHome = join(home, ".codex");
  const project = join(home, "project");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ token: "redacted" }));

  const stdout = await execJson([
    "agent",
    "source",
    "command",
    "run",
    "--source",
    "codex",
    "--project",
    project,
    "--command",
    "approvals",
    "--args",
    JSON.stringify({ text: "show" }),
    "--json",
  ], {
    HOME: home,
    CODEX_HOME: codexHome,
  });
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "unsupported");
  assert.equal(payload.command.id, "approvals");
  assert.equal(payload.provider.command_id, "approvals");
});

function message(role, text) {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}

function execJson(args, extraEnv) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(burn, args, {
      env: { ...process.env, ...extraEnv },
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        rejectExec(new Error(stderr || error.message));
        return;
      }
      resolveExec(stdout);
    });
  });
}
