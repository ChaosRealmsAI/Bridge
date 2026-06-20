import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const burnCli = path.join(backendDir, "burn");

export function createClaudeQuotaRefresh(deps) {
  const { readStatuslineCache, normalizeProfileId, cachedQuotaSummary, cachePath } = deps;
  return async function refreshQuota(options = {}) {
    const profileId = normalizeProfileId(options.profileId || options["profile-id"] || options.profile_id || "claude:default");
    const cache = await readStatuslineCache({ ...options, profileId });
    const base = refreshBase(profileId, cache, cachedQuotaSummary);
    const run = await runClaudeStatuslineRefresh({ profileId, cacheFile: cachePath(profileId, options), options });
    const next = await readStatuslineCache({ ...options, profileId });
    const finalBase = { ...refreshBase(profileId, next, cachedQuotaSummary), token_spend_required: true, refresh_mode: run.refresh_mode, transcript_path: run.transcript_path, stdout_tail: run.stdout_tail, stderr_tail: run.stderr_tail };
    if (run.ok && next.ok && !next.stale) return { ok: true, ...finalBase, refreshed: true, code: "ok", message: "Claude Code statusLine quota cache refreshed from a real Claude Code response." };
    return { ok: false, ...finalBase, refreshed: false, code: run.code || next.stale_reason || "claude_refresh_failed", message: "Claude Code quota refresh did not produce a fresh statusLine quota cache." };
  };
}

export async function runClaudeStatuslineRefresh({ profileId, cacheFile, options = {} }) {
  // 「最大时间」上限:真 turn 一般 4-15s,给 60s 兜底;超时即放弃(防呆),
  // 只让本账号拿不到额度、不拖垮整体。可用 BURN_CLAUDE_REFRESH_TIMEOUT_MS 覆盖。
  const timeoutMs = clampNumber(options.refreshTimeoutMs || options["refresh-timeout-ms"] || process.env.BURN_CLAUDE_REFRESH_TIMEOUT_MS, 15000, 300000, 60000);
  const beforeMtime = fileMtime(cacheFile);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "burn-claude-refresh-"));
  const settingsFile = path.join(tempDir, "settings.json");
  const transcriptFile = path.join(tempDir, "typescript.log");
  const settings = { statusLine: { type: "command", command: `${shellQuote(burnCli)} agent claude statusline-ingest --profile-id ${shellQuote(profileId)}`, padding: 0 } };
  await fs.writeFile(settingsFile, `${JSON.stringify(settings)}\n`, "utf8");
  const args = ["-q", transcriptFile, "claude", "--settings", settingsFile, "--model", cleanText(options.model) || "sonnet", cleanText(options.prompt) || "Reply exactly: OK"];
  const child = spawn(scriptCommand(options), args, {
    cwd: process.cwd(),
    env: refreshEnv(profileId, options),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const tail = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { tail.stdout = `${tail.stdout}${chunk.toString("utf8")}`.slice(-3000); });
  child.stderr.on("data", (chunk) => { tail.stderr = `${tail.stderr}${chunk.toString("utf8")}`.slice(-3000); });
  try {
    const wait = waitForCacheUpdate(child, cacheFile, beforeMtime, timeoutMs);
    const result = await wait;
    if (result.updated) return { ok: true, refreshed: true, refresh_mode: "automated_tty_claude_turn", transcript_path: maskHome(transcriptFile), stdout_tail: sanitizeTail(tail.stdout), stderr_tail: sanitizeTail(tail.stderr) };
    return { ok: false, refreshed: false, code: result.code, refresh_mode: "automated_tty_claude_turn", transcript_path: maskHome(transcriptFile), stdout_tail: sanitizeTail(tail.stdout), stderr_tail: sanitizeTail(tail.stderr) };
  } finally {
    stopProcess(child);
    setTimeout(() => fs.rm(tempDir, { recursive: true, force: true }).catch(() => {}), 1000).unref?.();
  }
}

function refreshBase(profileId, cache, cachedQuotaSummary) {
  return {
    schema: "burn.agent.claude-quota-refresh.v1",
    generated_at: new Date().toISOString(),
    profile_id: profileId,
    capability: refreshCapability(profileId),
    cache: cache.public_cache || null,
    cache_stale: cache.ok ? cache.stale : null,
    stale_reason: cache.stale_reason || "",
    quota: cache.ok ? cachedQuotaSummary(cache.cache) : null,
  };
}

function refreshCapability(profileId) {
  return {
    passive_statusline_cache: true,
    automated_tty_refresh: true,
    headless_provider_query: false,
    token_spend_required_for_active_refresh: true,
    statusline_settings_fragment: { statusLine: { type: "command", command: `${shellQuote(burnCli)} agent claude statusline-ingest --profile-id ${shellQuote(profileId)}`, padding: 0 } },
  };
}

function waitForCacheUpdate(child, cacheFile, beforeMtime, timeoutMs) {
  const startedAt = Date.now();
  let closed = false, exitCode = null;
  child.on("close", (code) => { closed = true; exitCode = code; });
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (fileMtime(cacheFile) > beforeMtime) {
        clearInterval(timer);
        resolve({ updated: true });
      } else if (closed) {
        clearInterval(timer);
        resolve({ updated: false, code: exitCode === 0 ? "statusline_cache_not_updated" : "claude_refresh_failed" });
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve({ updated: false, code: "claude_refresh_timeout" });
      }
    }, 500);
  });
}

function refreshEnv(profileId, options) {
  const env = { ...process.env, BURN_AGENT_PROFILE_ID: profileId };
  const dir = cleanText(options.claudeConfigDir || options.claude_config_dir || options.profilePath || options.profile_path) || derivedClaudeConfigDir(profileId);
  if (dir) env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

function derivedClaudeConfigDir(profileId) {
  if (!profileId || profileId === "claude:default") return "";
  const suffix = profileId.replace(/^claude:/, "");
  return suffix ? path.join(homeDir(), `.${suffix}`) : "";
}

function stopProcess(child) {
  try {
    if (child.killed) return;
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
}

function scriptCommand(options) {
  const configured = cleanText(options.scriptPath || options["script-path"] || process.env.BURN_SCRIPT_PATH);
  if (configured) return configured;
  return existsSync("/usr/bin/script") ? "/usr/bin/script" : "script";
}

function fileMtime(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sanitizeTail(value) {
  return cleanText(String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")).slice(-500);
}

function maskHome(value) {
  const home = homeDir();
  const resolved = path.resolve(value || "");
  return resolved.startsWith(`${home}${path.sep}`) ? `~/${resolved.slice(home.length + 1)}` : resolved;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
