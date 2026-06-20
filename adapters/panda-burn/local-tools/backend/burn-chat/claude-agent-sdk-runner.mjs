#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin, stdout } from "node:process";
import { runSessionOperation } from "./claude-agent-sdk-session-ops.mjs";
const require = createRequire(import.meta.url);
const burnRoutingKeys = new Set(["cwd", "prompt", "resume"]);
if (process.argv.includes("--self-test-sanitize")) {
  runSanitizeSelfTest();
} else {
  await run();
}
async function run() {
  try {
    const request = JSON.parse(await readAllStdin());
    if ((request.op || "query") !== "query") {
      await runSessionOperation(request, { emit, sdkVersion });
      return;
    }
    const options = buildOptions(request);
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let resultMessage = null;
    let lastAssistantText = "";
    let sessionId = "";
    let initMessage = null;

    for await (const message of query({ prompt: request.prompt, options })) {
      emit({ type: "sdk_message", message });
      if (!sessionId) sessionId = extractSessionId(message);
      if (message?.type === "system" && message?.subtype === "init") initMessage = message;
      if (message?.type === "assistant") {
        const text = assistantText(message);
        if (text.trim()) lastAssistantText = text;
      }
      if (message?.type === "result") {
        if (message.subtype !== "success") {
          throw new Error(message.error || message.message || JSON.stringify(message));
        }
        resultMessage = message;
      }
    }

    const reply = String(resultMessage?.result || lastAssistantText || "").trim();
    if (!reply) throw new Error("Claude Agent SDK completed but no final assistant reply");
    emit({
      type: "burn_result",
      reply,
      session_id: resultMessage?.session_id || sessionId || "",
      transcript_path: resultMessage?.transcript_path || "",
      usage: resultMessage?.usage || null,
      total_cost_usd: resultMessage?.total_cost_usd ?? null,
      stop_reason: resultMessage?.stop_reason || "",
      model: initMessage?.model || resultMessage?.model || options.model || "",
      permissionMode: initMessage?.permissionMode || options.permissionMode || "",
      claude_code_version: initMessage?.claude_code_version || "",
      sdk_version: sdkVersion(),
    });
  } catch (error) {
    emit({
      type: "burn_error",
      message: error?.stack || error?.message || String(error),
    });
    process.exitCode = 1;
  }
}
function buildOptions(request) {
  if (!request || typeof request !== "object") throw new Error("request must be a JSON object");
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    throw new Error("request.prompt must be a non-empty string");
  }
  if (typeof request.cwd !== "string" || !request.cwd.trim()) {
    throw new Error("request.cwd must be a non-empty string");
  }

  const options = normalizeSdkOptions(request.sdkOptions || {});
  options.cwd = request.cwd;
  if (request.resume) options.resume = String(request.resume);
  if (request.mode === "plan" && !options.permissionMode) options.permissionMode = "plan";

  const cliPath = process.env.BURN_CLAUDE_AGENT_SDK_CLI_PATH;
  if (cliPath) options.pathToClaudeCodeExecutable = cliPath;
  return options;
}
function sanitizeSdkOptions(raw) {
  return normalizeSdkOptions(raw);
}
function normalizeSdkOptions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("sdkOptions must be a JSON object");
  }
  const options = {};
  for (const [key, value] of Object.entries(raw)) {
    if (burnRoutingKeys.has(key)) {
      throw new Error(`sdkOptions.${key} is controlled by Burn session routing`);
    }
    options[key] = value;
  }
  return options;
}
function runSanitizeSelfTest() {
  const failures = [];
  const assertThrows = (label, raw, expected) => {
    try {
      normalizeSdkOptions(raw);
      failures.push(`${label}: expected rejection`);
    } catch (error) {
      const text = error?.message || String(error);
      if (!text.includes(expected)) failures.push(`${label}: expected ${expected}, got ${text}`);
    }
  };
  const assertPasses = (label, raw) => {
    try {
      normalizeSdkOptions(raw);
    } catch (error) {
      failures.push(`${label}: unexpected rejection ${error?.message || error}`);
    }
  };
  assertThrows("cwd", { cwd: "bad" }, "sdkOptions.cwd is controlled by Burn session routing");
  assertThrows("prompt", { prompt: "bad" }, "sdkOptions.prompt is controlled by Burn session routing");
  assertThrows("resume", { resume: "bad" }, "sdkOptions.resume is controlled by Burn session routing");
  assertPasses("provider native options", {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: ["Read", "Bash(git status:*)"],
    canUseTool: { kind: "provider-native-sample" },
    env: { SAMPLE: "1" },
    hooks: { Stop: [] },
    mcpServers: { local: { type: "stdio", command: "node", args: ["server.mjs"] } },
    pathToClaudeCodeExecutable: "/tmp/claude",
    plugins: [{ path: "/tmp/plugin" }],
    settings: { permissions: { allow: ["Bash(*)"] } },
    skills: ["example"],
    tools: ["Read"],
  });
  assertPasses("unknown provider option left to SDK", { unsupportedOption: true });
  if (failures.length) {
    console.error(JSON.stringify({ ok: false, check: "claude-sdk-options-passthrough", failures }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, check: "claude-sdk-options-passthrough" }, null, 2));
}
function assistantText(message) {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}
function extractSessionId(message) {
  return message?.session_id || message?.sessionId || message?.message?.session_id || "";
}
function sdkVersion() {
  try {
    return require("@anthropic-ai/claude-agent-sdk/package.json").version || "";
  } catch {
    return "";
  }
}
function readAllStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      raw += chunk;
    });
    stdin.on("end", () => resolve(raw));
    stdin.on("error", reject);
  });
}
function emit(value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}
