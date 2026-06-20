import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export function createCodexQuota(deps) {
  const { cleanText, coded, envForDiscoveredProfile, maskHome, parsedErrorCode, walkJsonl, which } = deps;

  async function liveCodexQuota(profile, options = {}) {
    try {
      return normalizeCodexQuota(await codexAppServerRateLimits(profile, options), "codex_app_server", true);
    } catch (error) {
      const local = await localCodexQuota(profile, options);
      const code = cleanText(error?.code) || parsedErrorCode(error) || "codex_rate_limits_unavailable";
      const authFailure = isAuthFailureCode(code) || isAuthFailureText(error?.message || error);
      local.live_error = {
        code: authFailure ? "codex_auth_invalid" : code,
        message: authFailure ? "Codex app-server rejected current auth; login is required" : safeErrorMessage(error, 500),
      };
      if (authFailure) {
        Object.assign(local, {
          source_kind: "codex_app_server_auth_failed",
          live_status: "not_logged_in",
          allowed: false,
          error_code: "codex_auth_invalid",
          message: "Codex live auth failed; local snapshots are stale evidence only",
          safety_note: "Codex app-server reported invalid auth. Local quota snapshots may still be returned for diagnostics but cannot make this profile launchable.",
        });
      } else if (local.source_kind === "codex_unavailable") {
        Object.assign(local, { source_kind: "codex_app_server_failed", live_status: "live_probe_failed", error_code: local.live_error.code, message: local.live_error.message });
      }
      return local;
    }
  }

  async function localCodexQuota(profile, options = {}) {
    const snapshot = await latestCodexRateLimitSnapshot(profile, options);
    if (!snapshot) {
      return unavailableQuota("codex_rate_limit_snapshot_missing", "No Codex local rate-limit snapshot was found in session history", {
        provider: "codex",
        source_kind: "codex_unavailable",
        live_status: "local_snapshot_missing",
        allowed: profile.usable ? null : false,
        safety_note: "Run with --live to use the official Codex app-server account/rateLimits/read probe.",
      });
    }
    const quota = normalizeCodexQuota(snapshot.rate_limits_payload, "codex_local_snapshot", false);
    quota.latest_event_at = cleanText(snapshot.event_at);
    quota.latest_event_file = cleanText(snapshot.file_display);
    quota.safety_note = "Derived from local Codex JSONL token_count/rate-limit events; use --live for current app-server status.";
    return quota;
  }

  async function codexAppServerRateLimits(profile, options = {}) {
    const cli = await which("codex");
    if (!cli) throw coded("codex_runtime_missing", "codex CLI was not found on PATH");
    const timeoutMs = Math.max(3000, Math.min(Number(options.quotaTimeoutMs || options["quota-timeout-ms"] || process.env.BURN_AGENT_QUOTA_TIMEOUT_MS || 15000) || 15000, 60000));
    const child = spawn(cli, ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      env: envForDiscoveredProfile(profile),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stderrTail = "";
    let closed = false;
    const messages = [];
    const waiters = [];
    const rl = createInterface({ input: child.stdout });
    const timer = setTimeout(() => stopJsonRpcChild(child), timeoutMs);
    child.stderr.on("data", (chunk) => { stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-3000); });
    child.on("close", () => {
      closed = true;
      while (waiters.length) waiters.shift()(null);
    });
    rl.on("line", (line) => {
      const value = parseJsonLine(line.trim());
      if (!value) return;
      if (value?.id != null && value?.method && value?.result === undefined && value?.error === undefined) {
        sendJsonRpc(child, { jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "Burn quota probe only supports account/rateLimits/read responses" } });
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else messages.push(value);
    });
    const nextMessage = () => messages.length ? Promise.resolve(messages.shift()) : closed ? Promise.resolve(null) : new Promise((resolve) => waiters.push(resolve));
    async function request(id, method, params = {}) {
      sendJsonRpc(child, { id, method, params });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await nextMessage();
        if (!value) break;
        if (value.id !== id) continue;
        if (value.error) throw coded(cleanText(value.error.code) || "codex_app_server_error", cleanText(value.error.message) || "codex app-server returned an error");
        return value.result;
      }
      throw coded("codex_app_server_timeout", `timeout waiting for ${method}`);
    }
    try {
      await request(1, "initialize", {
        clientInfo: { name: "burn-agent-quota", title: "Burn Agent Quota", version: "0.73" },
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ["thread/status/changed", "thread/tokenUsage/updated", "account/rateLimits/updated"] },
      });
      sendJsonRpc(child, { method: "initialized" });
      return await request(2, "account/rateLimits/read", {});
    } catch (error) {
      if (stderrTail.trim()) error.message = `${error.message}; stderr: ${stderrTail.trim().slice(-800)}`;
      throw error;
    } finally {
      clearTimeout(timer);
      rl.close();
      stopJsonRpcChild(child);
    }
  }

  async function latestCodexRateLimitSnapshot(profile, options = {}) {
    const files = await recentJsonlFiles(path.join(profile.path, "sessions"), Number(options.quotaHistoryFiles || options["quota-history-files"] || 40));
    for (const file of files) {
      const text = await readFileTail(file.path, Number(options.quotaTailBytes || options["quota-tail-bytes"] || 512 * 1024));
      if (!text.includes("rate_limit") && !text.includes("rateLimits") && !text.includes("token_count")) continue;
      for (const line of text.split(/\r?\n/).filter(Boolean).slice(-3000).reverse()) {
        const parsed = parseJsonLine(line);
        const payload = rateLimitPayloadFromEvent(parsed);
        if (payload) return { rate_limits_payload: payload, event_at: eventTimestamp(parsed), file_display: maskHome(file.path) };
      }
    }
    return null;
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

  return { codexAppServerRateLimits, isAuthFailureCode, isAuthFailureText, liveCodexQuota, localCodexQuota, normalizeCodexQuota, safeErrorMessage, unavailableQuota };
}

function sendJsonRpc(child, payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function stopJsonRpcChild(child) {
  try {
    if (child.killed) return;
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
}

function normalizeCodexQuota(payload, sourceKind, authoritative) {
  const root = payload && typeof payload === "object" ? payload : {};
  const rawLimits = collectRateLimitObjects(root);
  const windows = rawLimits.flatMap((item, index) => rateLimitWindows(item, index));
  const remaining = minRemainingPercent(windows);
  const limitReachedType = cleanTextValue(firstDefined(root.rateLimitReachedType, root.rate_limit_reached_type, ...rawLimits.map((item) => item.rateLimitReachedType || item.rate_limit_reached_type)));
  return {
    provider: "codex",
    source_kind: sourceKind,
    authoritative: Boolean(authoritative),
    live_status: limitReachedType ? "limited" : windows.length ? (authoritative ? "live" : "local_snapshot") : (authoritative ? "live_no_limits" : "local_snapshot_no_limits"),
    allowed: limitReachedType ? false : remaining === null ? null : remaining > 0,
    plan_type: cleanTextValue(firstDefined(root.planType, root.plan_type, ...rawLimits.map((item) => item.planType || item.plan_type))),
    remaining_percent: remaining,
    remaining_display: remaining === null ? "unknown" : `${Math.max(0, Math.round(remaining))}%`,
    limit_reached_type: limitReachedType,
    windows,
    credits: normalizeCredits(root, rawLimits),
    raw_shape: { has_rate_limits: rawLimits.length > 0, top_level_keys: Object.keys(root).filter((key) => !/token|secret|credential|cookie/i.test(key)).slice(0, 20) },
    signals: [],
  };
}

function collectRateLimitObjects(root) {
  const out = [];
  if (Array.isArray(root.rateLimits)) out.push(...root.rateLimits);
  if (Array.isArray(root.rate_limits)) out.push(...root.rate_limits);
  for (const field of ["rateLimitsByLimitId", "rate_limits_by_limit_id"]) {
    if (root[field] && typeof root[field] === "object") {
      for (const [limitId, value] of Object.entries(root[field])) out.push({ limitId, ...(value && typeof value === "object" ? value : {}) });
    }
  }
  if (!out.length && looksLikeRateLimit(root)) out.push(root);
  return out.filter((item) => item && typeof item === "object");
}

function looksLikeRateLimit(value) {
  return Boolean(value && typeof value === "object" && (value.usedPercent !== undefined || value.used_percent !== undefined || value.primary || value.secondary || value.windowDurationMins !== undefined || value.window_minutes !== undefined));
}

function rateLimitWindows(limit, index) {
  const id = cleanTextValue(limit.limitId || limit.limit_id || limit.id || `limit-${index + 1}`);
  const buckets = [];
  if (looksLikeRateLimit(limit)) buckets.push(["primary", limit]);
  if (limit.primary) buckets.push(["primary", limit.primary]);
  if (limit.secondary) buckets.push(["secondary", limit.secondary]);
  if (Array.isArray(limit.windows)) limit.windows.forEach((item, offset) => buckets.push([cleanTextValue(item.kind) || `window-${offset + 1}`, item]));
  return buckets.map(([kind, bucket]) => normalizeRateLimitWindow(id, kind, bucket)).filter(Boolean);
}

function normalizeRateLimitWindow(limitId, kind, bucket) {
  if (!bucket || typeof bucket !== "object") return null;
  const used = firstNumber(bucket.usedPercent, bucket.used_percent, bucket.used_pct, bucket.percent);
  const remaining = firstNumber(bucket.remainingPercent, bucket.remaining_percent, bucket.remainingPercentage, bucket.remaining_percentage);
  return {
    limit_id: limitId,
    kind,
    used_percent: used,
    remaining_percent: remaining === null ? used === null ? null : Math.max(0, 100 - used) : remaining,
    window_minutes: firstNumber(
      bucket.windowDurationMins,
      bucket.windowDurationMinutes,
      bucket.window_duration_mins,
      bucket.window_duration_minutes,
      bucket.window_minutes,
      bucket.windowMinutes,
      bucket.windowMins,
      bucket.durationMinutes,
      bucket.duration_minutes,
    ),
    resets_at: normalizeTime(firstDefined(bucket.resetsAt, bucket.resets_at, bucket.resetAt, bucket.reset_at)),
  };
}

function normalizeCredits(root, rawLimits) {
  const value = firstDefined(root.credits, root.credit, ...rawLimits.map((item) => item.credits || item.credit));
  if (!value || typeof value !== "object") return null;
  return { balance: firstNumber(value.balance, value.remaining, value.available, value.available_count), used: firstNumber(value.used, value.used_count), total: firstNumber(value.total, value.limit), unlimited: value.unlimited === true };
}

function rateLimitPayloadFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  const candidates = [event.rateLimits, event.rate_limits, event.payload?.rateLimits, event.payload?.rate_limits, event.payload?.info?.rateLimits, event.payload?.info?.rate_limits, event.info?.rateLimits, event.info?.rate_limits].filter(Boolean);
  const payload = candidates[0];
  if (Array.isArray(payload)) return { rateLimits: payload };
  if (payload && typeof payload === "object") return payload.rateLimits || payload.rate_limits || payload.rateLimitsByLimitId || payload.rate_limits_by_limit_id ? payload : { rateLimits: [payload] };
  return null;
}

function unavailableQuota(code, message, extra = {}) {
  return { provider: cleanTextValue(extra.provider), source_kind: cleanTextValue(extra.source_kind) || "unavailable", authoritative: false, live_status: cleanTextValue(extra.live_status) || "unavailable", allowed: extra.allowed ?? false, plan_type: "", remaining_percent: null, remaining_display: "unknown", limit_reached_type: "", windows: [], credits: null, error_code: code, message, safety_note: cleanTextValue(extra.safety_note), signals: [] };
}

function isAuthFailureCode(code) {
  return /401|403|unauth|forbid|invalid.?token|expired.?token|not.?logged|login.?required|auth/i.test(cleanTextValue(code));
}

function isAuthFailureText(value) {
  return /401|403|unauthori[sz]ed|forbidden|invalid token|token invalid|expired token|login required|not logged in|authentication/i.test(cleanTextValue(value));
}

function safeErrorMessage(error, maxLength = 500) {
  return redactSensitiveText(error?.message || error).slice(0, maxLength);
}

function redactSensitiveText(value) {
  let text = String(value || "");
  if (!text.trim()) return "";
  text = text.replace(/\b(authorization|proxy-authorization)\s*:\s*bearer\s+[^,;\r\n}\]]+/gi, "$1: Bearer [redacted]");
  text = text.replace(/\b(authorization|proxy-authorization)\s*:\s*[^\r\n,;}]+/gi, "$1: [redacted]");
  text = text.replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, "$1: [redacted]");
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
  text = text.replace(/\b(access_token|refresh_token|id_token|authorization|cookie|session|token)\s*[:=]\s*["']?[^"',;&\s}]+/gi, "$1=[redacted]");
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})\b/g, "[secret]");
  return cleanTextValue(text);
}

function firstDefined(...values) { return values.find((value) => value !== undefined && value !== null && value !== ""); }
function firstNumber(...values) { const number = Number(firstDefined(...values)); return Number.isFinite(number) ? number : null; }
function minRemainingPercent(windows) { const values = windows.map((item) => item.remaining_percent).filter((value) => Number.isFinite(value)); return values.length ? Math.min(...values) : null; }
function cleanTextValue(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function parseJsonLine(line) { try { return JSON.parse(line); } catch { return null; } }
function eventTimestamp(event) { return event && typeof event === "object" ? normalizeTime(event.timestamp || event.time || event.created_at || event.createdAt || event.ts) : ""; }
function normalizeTime(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") { const ms = value > 9999999999 ? value : value * 1000; const date = new Date(ms); return Number.isFinite(date.getTime()) ? date.toISOString() : ""; }
  const text = cleanTextValue(value);
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000).toISOString();
  if (/^\d{13}$/.test(text)) return new Date(Number(text)).toISOString();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}
