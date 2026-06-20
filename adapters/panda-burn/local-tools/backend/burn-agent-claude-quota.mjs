import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeQuotaRefresh } from "./burn-agent-claude-refresh.mjs";

export function createClaudeQuota(deps) {
  const { cleanText } = deps;

  async function claudeQuota(profile, auth = {}, options = {}) {
    const base = baseQuota(auth);
    let cache = await readStatuslineCache({ ...options, profileId: profile.id });
    const loggedIn = Boolean(auth.ok ? auth.logged_in : auth.loggedIn);
    // 每次请求刷新都跑一次真实 Claude turn,拿「当下」的 rate_limits(不靠缓存时效),
    // 否则用户刚用掉的额度不会反映出来(缓存滞后)。超时由 runClaudeStatuslineRefresh
    // 内部的 timeoutMs 兜底,超时只让本账号拿不到、不影响其它账号。
    if (shouldRefreshQuota(options) && loggedIn) {
      // 注意:绝不要把 profile.path 当 CLAUDE_CONFIG_DIR 传进去。实测显式设
      // CLAUDE_CONFIG_DIR(哪怕就是默认 ~/.claude)会让刷新用的 claude turn 挂死
      // 直到超时;独立 quota-refresh 命令对 default 不设这个 env 所以 4s 就成。
      // 让 refreshQuota 内部用 derivedClaudeConfigDir(default→不设,非 default→~/.<name>)。
      await refreshQuota({ ...options, profileId: profile.id, profilePath: "", profile_path: "" });
      cache = await readStatuslineCache({ ...options, profileId: profile.id });
    }
    if (!cache.ok) return { ...base, quota_unavailable_reason: cache.code, statusline_cache: cache.public_cache || null };
    if (cache.stale) return {
      ...base,
      source_kind: "claude_statusline_cache",
      authoritative: false,
      live_status: "statusline_cache_stale",
      quota_unavailable_reason: cache.stale_reason || "statusline_cache_stale",
      statusline_cache: cache.public_cache,
      stale_evidence: cachedQuotaSummary(cache.cache),
      safety_note: "Claude Code statusLine quota cache is stale; current 5h/weekly fields are intentionally left empty until the next real Claude Code response is captured.",
    };
    const windows = quotaWindows(cache.cache.rate_limits);
    const remaining = minimumRemaining(windows);
    const limited = remaining !== null && remaining <= 0;
    return {
      ...base,
      source_kind: "claude_statusline_cache",
      authoritative: !cache.stale,
      live_status: cache.stale ? "statusline_cache_stale" : limited ? "limited" : "statusline_cache",
      allowed: limited ? false : base.allowed,
      remaining_percent: remaining,
      remaining_display: displayPercent(remaining),
      limit_reached_type: limited ? "claude_plan_limit" : "",
      windows,
      latest_event_at: cache.cache.captured_at,
      quota_unavailable_reason: cache.stale ? "statusline_cache_stale" : "",
      statusline_cache: cache.public_cache,
      safety_note: "Claude Code 5h/weekly quota comes from the official statusLine rate_limits JSON after a real API response; no browser cookies or claude.ai scraping are used.",
    };
  }

  async function ingestStatusline(inputText, options = {}) {
    const input = parseInput(inputText);
    const rateLimits = normalizeRateLimits(input.rate_limits || input.rateLimits);
    const profileId = normalizeProfileId(options.profileId || options["profile-id"] || options.profile_id || process.env.BURN_AGENT_PROFILE_ID);
    const capturedAt = new Date().toISOString();
    const cache = {
      schema: "burn.agent.claude-statusline-quota-cache.v1",
      provider: "claude",
      profile_id: profileId,
      captured_at: capturedAt,
      session_id: cleanText(input.session_id || input.sessionId),
      model_display_name: cleanText(input.model?.display_name || input.model?.name || input.model),
      rate_limits: rateLimits,
      context_window: safeContextWindow(input.context_window || input.contextWindow),
      source_kind: "claude_statusline",
    };
    if (rateLimits) await writeCache(profileId, cache, options);
    const result = {
      ok: Boolean(rateLimits),
      schema: "burn.agent.claude-statusline-ingest.v1",
      generated_at: capturedAt,
      profile_id: profileId,
      cached: Boolean(rateLimits),
      code: rateLimits ? "ok" : "rate_limits_missing",
      cache_path: rateLimits ? maskHome(cachePath(profileId, options)) : "",
      rate_limits: rateLimits,
      statusline_text: statuslineText(cache),
    };
    return result;
  }

  async function readStatuslineCache(options = {}) {
    const profileId = normalizeProfileId(options.profileId || options["profile-id"] || options.profile_id || "claude:default");
    const file = cachePath(profileId, options);
    if (!existsSync(file)) return missing("statusline_cache_missing", profileId);
    try {
      const cache = JSON.parse(await fs.readFile(file, "utf8"));
      const publicCache = publicCacheInfo(cache, file);
      if (!normalizeRateLimits(cache.rate_limits)) return { ok: false, code: "statusline_cache_invalid", profile_id: profileId, public_cache: publicCache };
      const maxAgeMs = Number(options.maxAgeMs || options["max-age-ms"] || 6 * 60 * 60 * 1000);
      const ageMs = Date.now() - Date.parse(cache.captured_at || 0);
      const staleReason = resetElapsed(cache.rate_limits) ? "statusline_window_reset_elapsed" : Number.isFinite(ageMs) && ageMs > maxAgeMs ? "statusline_cache_age_exceeded" : "";
      return { ok: true, schema: "burn.agent.claude-statusline-cache.v1", generated_at: new Date().toISOString(), profile_id: profileId, cache, public_cache: publicCache, stale: Boolean(staleReason), stale_reason: staleReason };
    } catch {
      return missing("statusline_cache_unreadable", profileId);
    }
  }

  function baseQuota(auth = {}) {
    const loggedIn = Boolean(auth.ok ? auth.logged_in : auth.loggedIn);
    return {
      provider: "claude",
      source_kind: "claude_local_auth_status",
      authoritative: false,
      live_status: auth.ok ? (loggedIn ? "subscription_status_only" : "not_logged_in") : "auth_status_unavailable",
      allowed: auth.ok ? loggedIn : null,
      plan_type: cleanText(auth.subscription_type || auth.subscriptionType),
      remaining_percent: null,
      remaining_display: "",
      limit_reached_type: "",
      windows: [],
      credits: null,
      account_status: auth,
      safety_note: "Claude Code remaining quota is unavailable until Burn receives official statusLine rate_limits JSON from a real Claude Code API response.",
      signals: [],
    };
  }

  const refreshQuota = createClaudeQuotaRefresh({ readStatuslineCache, normalizeProfileId, cachedQuotaSummary, cachePath });
  return { claudeQuota, ingestStatusline, readStatuslineCache, refreshQuota };
}

function quotaWindows(rateLimits) {
  const five = rateLimits?.five_hour || rateLimits?.fiveHour;
  const week = rateLimits?.seven_day || rateLimits?.sevenDay;
  return [
    windowRow("five_hour", "primary", five, 300),
    windowRow("seven_day", "secondary", week, 10080),
  ].filter(Boolean);
}

function windowRow(limitId, kind, value, minutes) {
  if (!value || typeof value !== "object") return null;
  const used = numberOrNull(value.used_percentage ?? value.usedPercent);
  const reset = value.resets_at ?? value.resetsAt;
  if (used === null && !reset) return null;
  return { limit_id: limitId, kind, used_percent: used, remaining_percent: used === null ? null : Math.max(0, 100 - used), window_minutes: minutes, resets_at: isoTime(reset) };
}

function normalizeRateLimits(value) {
  const windows = quotaWindows(value);
  return windows.length ? {
    five_hour: publicWindow(value?.five_hour || value?.fiveHour),
    seven_day: publicWindow(value?.seven_day || value?.sevenDay),
  } : null;
}

function publicWindow(value) {
  if (!value || typeof value !== "object") return null;
  return { used_percentage: numberOrNull(value.used_percentage ?? value.usedPercent), resets_at: isoTime(value.resets_at ?? value.resetsAt) };
}

function minimumRemaining(windows) {
  const values = windows.map((item) => item.remaining_percent).filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function resetElapsed(rateLimits) { return quotaWindows(rateLimits).some((item) => item.resets_at && Date.parse(item.resets_at) <= Date.now()); }

function shouldRefreshQuota(options = {}) {
  return boolOption(options, "refreshQuota", "refresh-quota", "refresh_quota");
}

function boolOption(options = {}, ...keys) {
  return keys.some((key) => options[key] === true || options[key] === "true" || options[key] === "1" || options[key] === 1);
}

function cachedQuotaSummary(cache) {
  const windows = quotaWindows(cache.rate_limits);
  const remaining = minimumRemaining(windows);
  return {
    source_kind: "claude_statusline_cache",
    remaining_percent: remaining,
    remaining_display: displayPercent(remaining),
    windows,
    five_hour_remaining_display: displayPercent(windows.find((item) => item.limit_id === "five_hour")?.remaining_percent),
    five_hour_resets_at: windows.find((item) => item.limit_id === "five_hour")?.resets_at || "",
    weekly_remaining_display: displayPercent(windows.find((item) => item.limit_id === "seven_day")?.remaining_percent),
    weekly_resets_at: windows.find((item) => item.limit_id === "seven_day")?.resets_at || "",
    latest_event_at: cache.captured_at || "",
  };
}

function statuslineText(cache) {
  const windows = quotaWindows(cache.rate_limits);
  const parts = windows.map((item) => item.limit_id === "five_hour" ? `5h ${displayPercent(item.remaining_percent)} left` : `7d ${displayPercent(item.remaining_percent)} left`);
  return [cache.model_display_name || "Claude", ...parts].filter(Boolean).join(" | ");
}

async function writeCache(profileId, cache, options) {
  const dir = cacheDir(options);
  await fs.mkdir(dir, { recursive: true });
  const target = cachePath(profileId, options);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await fs.rename(temp, target);
}

function publicCacheInfo(cache, file) {
  return { schema: cache.schema || "", profile_id: cache.profile_id || "", captured_at: cache.captured_at || "", session_id: cache.session_id || "", model_display_name: cache.model_display_name || "", cache_path: maskHome(file) };
}

function missing(code, profileId) {
  return { ok: false, schema: "burn.agent.claude-statusline-cache.v1", generated_at: new Date().toISOString(), code, profile_id: profileId, public_cache: null };
}

function cachePath(profileId, options = {}) {
  return path.join(cacheDir(options), `${safeFile(profileId)}.json`);
}

function cacheDir(options = {}) {
  return path.resolve(options.cacheDir || options["cache-dir"] || process.env.BURN_CLAUDE_QUOTA_CACHE_DIR || path.join(homeDir(), ".burn/agent/claude-quota"));
}

function parseInput(text) {
  try {
    return JSON.parse(String(text || "{}"));
  } catch {
    return {};
  }
}

function safeContextWindow(value) {
  if (!value || typeof value !== "object") return null;
  return { used_percentage: numberOrNull(value.used_percentage ?? value.usedPercentage), remaining_percentage: numberOrNull(value.remaining_percentage ?? value.remainingPercentage), context_window_size: numberOrNull(value.context_window_size ?? value.contextWindowSize) };
}

function normalizeProfileId(value) {
  const text = String(value || "").trim();
  if (text) return text;
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return "claude:default";
  const base = path.basename(path.resolve(dir));
  return base === ".claude" ? "claude:default" : `claude:${base.replace(/^\./, "").replace(/[^a-zA-Z0-9_.-]+/g, "-")}`;
}

function isoTime(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  const date = Number.isFinite(number) ? new Date(number > 10_000_000_000 ? number : number * 1000) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function displayPercent(value) {
  return Number.isFinite(value) ? `${Math.max(0, Math.round(value))}%` : "";
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeFile(value) {
  return String(value || "claude-default").replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function maskHome(value) {
  const home = homeDir();
  const resolved = path.resolve(value || "");
  return resolved.startsWith(`${home}${path.sep}`) ? `~/${resolved.slice(home.length + 1)}` : resolved;
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
