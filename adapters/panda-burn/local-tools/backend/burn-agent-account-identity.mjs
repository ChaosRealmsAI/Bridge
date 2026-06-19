import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { stableHash } from "./burn-store-lib.mjs";

export function createAccountIdentity(deps) {
  const { cleanText, envForDiscoveredProfile, homeDir, maskHome, parsedErrorCode, readJson, safeErrorMessage, walkJsonl, which } = deps;

  async function codexAccountIdentity(profile) {
    const auth = await readJson(path.join(profile.path, "auth.json"));
    const jwt = decodeJwtPayload(auth.tokens?.id_token || auth.id_token || auth.token);
    const email = cleanText(auth.email || auth.account?.email || auth.user?.email || auth.tokens?.email || jwt.email);
    const accountId = cleanText(auth.account_id || auth.account?.id || auth.tokens?.account_id || jwt.sub);
    const identityKnown = Boolean(email || accountId);
    return {
      provider: "codex",
      display_name: email ? maskEmail(email) : profile.label,
      email_display: email ? maskEmail(email) : "",
      account_hash: identityKnown ? stableHash(`${profile.source}:${String(email || accountId).toLowerCase()}`) : stableHash(`${profile.source}:profile:${profile.id}`),
      identity_known: identityKnown,
      identity_kind: email ? "email" : accountId ? "account_id" : "profile",
      auth_method: "",
      api_provider: "",
      subscription_type: "",
      plan_type: "",
      org_display: "",
      org_hash: "",
    };
  }

  async function claudeAccountIdentity(profile, authStatus = null) {
    let email = "";
    if (!authStatus?.account_hash && profile.id === "claude:default") {
      const auth = await readJson(path.join(homeDir(), ".claude.json"));
      email = cleanText(auth.email || auth.account?.email || auth.user?.email);
    }
    const emailDisplay = cleanText(authStatus?.email_display) || (email ? maskEmail(email) : "");
    const accountHash = cleanText(authStatus?.account_hash) || (email ? stableHash(`${profile.source}:${email.toLowerCase()}`) : "");
    const identityKnown = Boolean(authStatus?.identity_known || accountHash);
    return {
      provider: "claude",
      display_name: emailDisplay || profile.label,
      email_display: emailDisplay,
      account_hash: identityKnown ? accountHash : stableHash(`${profile.source}:profile:${profile.id}`),
      identity_known: identityKnown,
      identity_kind: identityKnown ? "email" : "profile",
      auth_method: cleanText(authStatus?.auth_method),
      api_provider: cleanText(authStatus?.api_provider),
      subscription_type: cleanText(authStatus?.subscription_type),
      plan_type: cleanText(authStatus?.subscription_type),
      org_display: cleanText(authStatus?.org_display),
      org_hash: cleanText(authStatus?.org_hash),
    };
  }

  async function claudeAuthStatus(profile, options = {}) {
    if (!profile.command_available) return { ok: false, code: "runtime_missing", logged_in: false };
    const cli = await which("claude");
    if (!cli) return { ok: false, code: "runtime_missing", logged_in: false };
    try {
      const stdout = await execClaudeAuthStatus(cli, profile, {
        envForProfile: envForDiscoveredProfile,
        timeoutMs: Number(options.claudeAuthTimeout || options["claude-auth-timeout"] || 10000),
      });
      const parsed = extractJsonObject(stdout) || {};
      const loggedIn = typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : /logged\s*in|authenticated|claude\.ai/i.test(stdout);
      return {
        ok: true,
        code: "ok",
        logged_in: Boolean(loggedIn),
        auth_method: cleanText(parsed.authMethod || parsed.auth_method),
        subscription_type: cleanText(parsed.subscriptionType || parsed.subscription_type),
        api_provider: cleanText(parsed.apiProvider || parsed.api_provider),
        account_email_hash: parsed.email ? stableHash(String(parsed.email).toLowerCase()) : "",
        account_hash: parsed.email ? stableHash(`claude:${String(parsed.email).toLowerCase()}`) : "",
        identity_known: Boolean(parsed.email),
        email_display: parsed.email ? maskEmail(parsed.email) : "",
        org_display: maskEmailsInText(parsed.orgName || parsed.org_name),
        org_hash: parsed.orgId || parsed.org_id ? stableHash(`claude-org:${String(parsed.orgId || parsed.org_id)}`) : "",
      };
    } catch (error) {
      return { ok: false, code: parsedErrorCode(error) || "claude_auth_status_failed", logged_in: false, message: safeErrorMessage(error, 500) };
    }
  }

  async function recentHistorySignals(profile, options = {}) {
    const root = profile.source === "codex" ? path.join(profile.path, "sessions") : path.join(profile.path, "projects");
    const files = await recentJsonlFiles(root, Number(options.signalHistoryFiles || options["signal-history-files"] || 20));
    const maxAgeHours = Math.max(1, Math.min(Number(options.signalMaxAgeHours || options["signal-max-age-hours"] || 168) || 168, 24 * 30));
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
    const signals = [];
    for (const file of files) {
      const text = await readFileTail(file.path, Number(options.signalTailBytes || options["signal-tail-bytes"] || 256 * 1024));
      for (const line of text.split(/\r?\n/).filter(Boolean).slice(-300)) {
        const type = signalTypeFromLine(line);
        if (!type) continue;
        const parsed = parseJsonLine(line);
        const occurredAt = eventTimestamp(parsed) || normalizeTime(file.mtimeMs);
        if (timeMs(occurredAt) && timeMs(occurredAt) < cutoff) continue;
        signals.push({ type, severity: signalSeverity(type), source_kind: "local_history", occurred_at: occurredAt, file: maskHome(file.path) });
      }
    }
    return dedupeSignals(signals).slice(0, 8);
  }

  async function recentJsonlFiles(root, limit) {
    const files = [];
    await walkJsonl(root, files, 0, Math.max(1, Math.min(limit || 40, 5000)));
    const withStats = await Promise.all(files.map(async (file) => {
      const stat = await fs.stat(file).catch(() => null);
      return stat ? { path: file, mtimeMs: stat.mtimeMs } : null;
    }));
    return withStats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(1, limit || 40));
  }

  async function readFileTail(file, maxBytes) {
    const bytes = Math.max(4096, Math.min(Number(maxBytes) || 256 * 1024, 2 * 1024 * 1024));
    let handle;
    try {
      const stat = await fs.stat(file);
      const length = Math.min(stat.size, bytes);
      const buffer = Buffer.alloc(length);
      handle = await fs.open(file, "r");
      await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      return buffer.toString("utf8");
    } catch {
      return "";
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  return { claudeAccountIdentity, claudeAuthStatus, codexAccountIdentity, recentHistorySignals };
}

function execClaudeAuthStatus(command, profile, options) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, ["auth", "status"], {
      cwd: process.cwd(),
      env: options.envForProfile(profile),
      timeout: Number(options.timeoutMs || 10000),
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const parsed = extractJsonObject(stdout);
      if (parsed && typeof parsed.loggedIn === "boolean") {
        resolveExec(stdout);
        return;
      }
      if (error) {
        const wrapped = new Error(stderr?.trim() || stdout?.trim() || error.message);
        wrapped.code = "agent_command_failed";
        rejectExec(wrapped);
        return;
      }
      resolveExec(stdout);
    });
  });
}

function decodeJwtPayload(token) {
  const parts = cleanTextValue(token).split(".");
  if (parts.length < 2) return {};
  try {
    const padded = `${parts[1]}${"=".repeat((4 - (parts[1].length % 4)) % 4)}`;
    return JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function maskEmail(value) {
  const email = cleanTextValue(value).toLowerCase();
  const at = email.indexOf("@");
  if (at <= 1) return email ? "***" : "";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function maskEmailsInText(value) {
  return cleanTextValue(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => maskEmail(email));
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  }
}

function signalTypeFromLine(line) {
  const text = line.toLowerCase();
  if (/usage_limit_exceeded|usage limit exceeded|limit reached|rate.?limit|5.?hour|weekly limit|week.?limit|quota.?exceeded|quota.?limit/.test(text)) return "usage_limit";
  if (/authentication|unauthorized|invalid api key|invalid token|login required|auth failed|expired token/.test(text)) return "auth_failure";
  if (/econnreset|etimedout|network|offline|connection closed|connection reset|tls|dns|timeout/.test(text)) return "network_instability";
  if (/interrupted|aborted|cancelled|canceled|process exited|panic|crash|exception|non-zero|terminated/.test(text)) return "abnormal_stop";
  return "";
}

function signalSeverity(type) {
  if (type === "usage_limit") return "critical";
  if (type === "auth_failure") return "error";
  if (type === "network_instability" || type === "abnormal_stop") return "warning";
  return "info";
}

function dedupeSignals(signals) {
  const byType = new Map();
  for (const signal of signals.sort((a, b) => timeMs(b.occurred_at) - timeMs(a.occurred_at))) {
    const current = byType.get(signal.type);
    if (!current) {
      byType.set(signal.type, { ...signal, count: 1, sample_files: [signal.file] });
    } else {
      current.count += 1;
      if (current.sample_files.length < 3 && !current.sample_files.includes(signal.file)) current.sample_files.push(signal.file);
    }
  }
  return [...byType.values()];
}

function cleanTextValue(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function parseJsonLine(line) { try { return JSON.parse(line); } catch { return null; } }
function eventTimestamp(event) { return event && typeof event === "object" ? normalizeTime(event.timestamp || event.time || event.created_at || event.createdAt || event.ts) : ""; }
function timeMs(value) {
  const text = cleanTextValue(value);
  if (!text) return 0;
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}
function normalizeTime(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") { const ms = value > 9999999999 ? value : value * 1000; const date = new Date(ms); return Number.isFinite(date.getTime()) ? date.toISOString() : ""; }
  const text = cleanTextValue(value);
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000).toISOString();
  if (/^\d{13}$/.test(text)) return new Date(Number(text)).toISOString();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}
