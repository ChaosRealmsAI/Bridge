import { createAccountIdentity } from "./burn-agent-account-identity.mjs";
import { createAccountApiCommands } from "./burn-agent-account-api.mjs";
import { availabilityQuotaSummary, emptyAvailabilityQuota, publicAccountInfo, withQuotaWindowFields } from "./burn-agent-account-shape.mjs";
import { createClaudeQuota } from "./burn-agent-claude-quota.mjs";
import { createCodexQuota } from "./burn-agent-codex-quota.mjs";

export function createAccountCommands(deps) {
  const {
    cleanText,
    coded,
    compareProfiles,
    discoverProfiles,
    normalizeOptionalSource,
    publicProfile,
    required,
  } = deps;
  const codex = createCodexQuota(deps);
  const claude = createClaudeQuota(deps);
  const identity = createAccountIdentity({ ...deps, safeErrorMessage: codex.safeErrorMessage });
  const apiCommands = createAccountApiCommands(deps, {
    accountAvailabilityCounts,
    accountAvailabilityRows,
    accountAvailabilitySafetyPolicy,
    selectedProfiles,
    wantsLiveAvailability,
  });

  async function quotaList(options = {}) {
    const { discovered, profiles, live } = await selectedProfiles(options, 80, wantsLiveQuota(options));
    const accounts = [];
    for (const profile of profiles.sort(compareProfiles)) accounts.push(await accountQuota(profile, { ...options, live }));
    return {
      ok: true,
      schema: "burn.agent.account-quota.v1",
      generated_at: new Date().toISOString(),
      live_probe: live,
      safety: quotaSafetyPolicy(),
      counts: accountQuotaCounts(accounts),
      runtimes: discovered.runtimes,
      accounts,
    };
  }

  async function accountList(options = {}) {
    const { discovered, profiles, live } = await selectedProfiles(options, 300, wantsLiveAvailability(options), options.quick ?? true);
    const accounts = await accountAvailabilityRows(profiles, { ...options, live });
    return {
      ok: true,
      schema: "burn.agent.accounts.v1",
      generated_at: new Date().toISOString(),
      live_probe: live,
      safety: accountAvailabilitySafetyPolicy(),
      counts: accountAvailabilityCounts(accounts, profiles),
      runtimes: discovered.runtimes,
      accounts,
    };
  }

  async function quotaProbe(options = {}) {
    const profileId = required(options.profileId || options["profile-id"] || options.profile_id || options.id, "profile-id");
    const result = await quotaList({ ...options, profileId, "profile-id": profileId });
    return { ok: true, schema: "burn.agent.account-quota.probe.v1", generated_at: result.generated_at, live_probe: result.live_probe, safety: result.safety, account: result.accounts[0] || null };
  }

  async function healthScan(options = {}) {
    const result = await quotaList(options);
    const incidents = result.accounts.flatMap((account) => (Array.isArray(account.health?.anomalies) ? account.health.anomalies : []).map((anomaly) => ({
      ...anomaly,
      profile_id: account.profile.id,
      source: account.profile.source,
      label: account.profile.label,
      account_hash: account.account.account_hash,
    })));
    return {
      ok: true,
      schema: "burn.agent.account-health.v1",
      generated_at: result.generated_at,
      live_probe: result.live_probe,
      safety: result.safety,
      counts: { accounts: result.counts.total, abnormal: incidents.filter((item) => item.severity === "error" || item.severity === "critical").length, warnings: incidents.filter((item) => item.severity === "warning").length, incidents: incidents.length },
      incidents,
      accounts: result.accounts.map((account) => ({ profile: account.profile, account: account.account, health: account.health, frontend: account.frontend })),
    };
  }

  async function selectedProfiles(options, historyLimit, live, quick = true) {
    const limit = options.historyLimit || options["history-limit"] || historyLimit;
    const discovered = await discoverProfiles({ ...options, quick, historyLimit: limit, "history-limit": limit });
    const source = normalizeOptionalSource(options.source);
    const profileId = cleanText(options.profileId || options["profile-id"] || options.profile_id || options.id);
    const profiles = discovered.profiles.filter((profile) => (!source || profile.source === source) && (!profileId || profile.id === profileId));
    if (profileId && !profiles.length) throw coded("profile_not_found", `profile not found: ${profileId}`);
    return { discovered, profiles, live };
  }

  async function accountAvailabilityRows(profiles, options = {}) {
    const rows = [];
    for (const profile of profiles.sort(compareProfiles)) rows.push(await accountAvailability(profile, options));
    return rows;
  }

  async function accountAvailability(profile, options = {}) {
    if (profile.source === "codex") return codexAccountAvailability(profile, options);
    if (profile.source === "claude") return claudeAccountAvailability(profile, options);
    throw coded("invalid_source", `invalid source: ${profile.source}`);
  }

  async function accountQuota(profile, options = {}) {
    if (profile.source === "codex") return codexAccountQuota(profile, options);
    if (profile.source === "claude") return claudeAccountQuota(profile, options);
    throw coded("invalid_source", `invalid source: ${profile.source}`);
  }

  async function codexAccountAvailability(profile, options = {}) {
    const account = await identity.codexAccountIdentity(profile);
    if (!profile.command_available) return availabilityEnvelope(profile, account, unavailableAvailability("codex_runtime_missing", "codex CLI was not found on PATH", { provider: "codex", auth_status: "runtime_missing" }));
    if (!profile.auth_hint_present) return availabilityEnvelope(profile, account, unavailableAvailability("codex_auth_missing", "Codex auth hint was not found", { provider: "codex", auth_status: "needs_login", needs_login: true }));
    if (!options.live) return availabilityEnvelope(profile, account, unavailableAvailability("codex_live_auth_not_checked", "Codex live auth was not checked", { provider: "codex", auth_status: "not_checked" }));
    try {
      const quota = codex.normalizeCodexQuota(await codex.codexAppServerRateLimits(profile, options), "codex_app_server", true);
      const limited = quota.allowed === false || quota.live_status === "limited";
      return availabilityEnvelope(profile, account, { provider: "codex", auth_status: limited ? "limited" : "logged_in", logged_in: true, launchable: !limited, can_start_new_turn: !limited, needs_login: false, live_authoritative: true, code: limited ? "quota_limited" : "ok", message: limited ? "Codex account is logged in but quota is limited" : "", quota: availabilityQuotaSummary(quota) });
    } catch (error) {
      const code = cleanText(error?.code) || deps.parsedErrorCode(error) || "codex_app_server_unavailable";
      const authFailure = codex.isAuthFailureCode(code) || codex.isAuthFailureText(error?.message || error);
      const local = await codex.localCodexQuota(profile, options);
      return availabilityEnvelope(profile, account, {
        provider: "codex",
        auth_status: authFailure ? "needs_login" : "auth_status_unavailable",
        logged_in: authFailure ? false : null,
        launchable: false,
        can_start_new_turn: false,
        needs_login: authFailure,
        live_authoritative: true,
        code: authFailure ? "codex_auth_invalid" : code,
        message: authFailure ? "Codex app-server rejected current auth; login is required" : codex.safeErrorMessage(error, 300),
        stale_evidence: local?.source_kind && local.source_kind !== "codex_unavailable" ? { source_kind: local.source_kind, remaining_display: local.remaining_display, latest_event_at: cleanText(local.latest_event_at), note: "local quota snapshot is stale evidence only and does not make this account launchable" } : null,
      });
    }
  }

  async function claudeAccountAvailability(profile, options = {}) {
    const auth = await identity.claudeAuthStatus(profile, options);
    const account = await identity.claudeAccountIdentity(profile, auth);
    if (!profile.command_available) return availabilityEnvelope(profile, account, unavailableAvailability("claude_runtime_missing", "claude CLI was not found on PATH", { provider: "claude", auth_status: "runtime_missing" }));
    if (!auth.ok) return availabilityEnvelope(profile, account, unavailableAvailability(auth.code || "claude_auth_status_unavailable", auth.message || "Claude auth status was unavailable", { provider: "claude", auth_status: "auth_status_unavailable" }));
    const loggedIn = Boolean(auth.logged_in);
    const quota = await claude.claudeQuota(profile, auth, options);
    const limited = loggedIn && quota.allowed === false && quota.live_status === "limited";
    return availabilityEnvelope(profile, account, {
      provider: "claude",
      auth_status: loggedIn ? limited ? "limited" : "logged_in" : "needs_login",
      logged_in: loggedIn,
      launchable: loggedIn && !limited,
      can_start_new_turn: loggedIn && !limited,
      needs_login: !loggedIn,
      live_authoritative: true,
      code: loggedIn ? limited ? "quota_limited" : "ok" : "claude_needs_login",
      message: loggedIn ? limited ? "Claude account is logged in but quota is limited" : "" : "Claude auth status is not logged in for this profile",
      auth_method: cleanText(auth.auth_method),
      api_provider: cleanText(auth.api_provider),
      subscription_type: cleanText(auth.subscription_type),
      quota: availabilityQuotaSummary(quota),
    });
  }

  async function codexAccountQuota(profile, options = {}) {
    const account = await identity.codexAccountIdentity(profile);
    const quota = !profile.command_available
      ? codex.unavailableQuota("codex_runtime_missing", "codex CLI was not found on PATH", { provider: "codex" })
      : !profile.auth_hint_present
        ? codex.unavailableQuota("codex_auth_missing", "Codex auth hint was not found", { provider: "codex" })
        : options.live ? await codex.liveCodexQuota(profile, options) : await codex.localCodexQuota(profile, options);
    const health = buildAccountHealth(profile, quota, await identity.recentHistorySignals(profile, options));
    return accountQuotaEnvelope(profile, account, quota, health, publicProfile);
  }

  async function claudeAccountQuota(profile, options = {}) {
    const auth = await identity.claudeAuthStatus(profile, options);
    const account = await identity.claudeAccountIdentity(profile, auth);
    const quota = await claude.claudeQuota(profile, auth, options);
    if (!profile.command_available) Object.assign(quota, { live_status: "runtime_missing", allowed: false, error_code: "claude_runtime_missing", message: "claude CLI was not found on PATH" });
    else if (!profile.auth_hint_present) Object.assign(quota, { live_status: "auth_hint_missing", allowed: false, error_code: "claude_auth_missing", message: "Claude auth hint was not found" });
    else if (!auth.ok) Object.assign(quota, { error_code: auth.code && auth.code !== "probe_failed" ? auth.code : "claude_auth_status_unavailable", message: auth.message || "Claude auth status was unavailable" });
    const health = buildAccountHealth(profile, quota, await identity.recentHistorySignals(profile, options));
    return accountQuotaEnvelope(profile, account, quota, health, publicProfile);
  }

  function availabilityEnvelope(profile, account, availability) {
    const normalized = {
      provider: cleanText(availability.provider || profile.source),
      auth_status: cleanText(availability.auth_status),
      logged_in: availability.logged_in === null ? null : Boolean(availability.logged_in),
      launchable: Boolean(availability.launchable),
      can_start_new_turn: Boolean(availability.can_start_new_turn),
      needs_login: Boolean(availability.needs_login),
      live_authoritative: Boolean(availability.live_authoritative),
      code: cleanText(availability.code),
      message: cleanText(availability.message),
      auth_method: cleanText(availability.auth_method),
      subscription_type: cleanText(availability.subscription_type),
      api_provider: cleanText(availability.api_provider),
      quota: availability.quota || emptyAvailabilityQuota({ provider: profile.source, allowed: availability.can_start_new_turn }),
      stale_evidence: availability.stale_evidence || null,
    };
    return { schema: "burn.agent.account-availability.v1", profile: publicProfile(profile), account: publicAccountInfo(account), availability: normalized, health: availabilityHealth(normalized), frontend: availabilityFrontend(normalized) };
  }

  return {
    ...apiCommands,
    accountAvailabilityCounts,
    accountAvailabilityRows,
    accountList,
    claudeQuotaRefresh: claude.refreshQuota,
    claudeStatuslineCache: claude.readStatuslineCache, claudeStatuslineIngest: claude.ingestStatusline,
    healthScan,
    quotaList,
    quotaProbe,
    wantsLiveAvailability,
  };
}

function unavailableAvailability(code, message, extra = {}) {
  return { provider: cleanTextValue(extra.provider), auth_status: cleanTextValue(extra.auth_status) || "unavailable", logged_in: extra.logged_in !== undefined ? extra.logged_in : extra.needs_login ? false : null, launchable: false, can_start_new_turn: false, needs_login: Boolean(extra.needs_login), live_authoritative: false, code, message };
}

function accountQuotaEnvelope(profile, account, quota, health, publicProfile) {
  const shapedQuota = withQuotaWindowFields(quota);
  return { schema: "burn.agent.account.v1", profile: publicProfile(profile), account: publicAccountInfo(account), quota: shapedQuota, health, frontend: frontendAccountStatus(shapedQuota, health) };
}

function availabilityHealth(availability) {
  const needsLogin = availability.needs_login || availability.logged_in === false;
  return { status: availability.can_start_new_turn ? "ok" : needsLogin ? "needs_login" : "blocked", severity: availability.can_start_new_turn ? "info" : "error", action_required: !availability.can_start_new_turn, can_start_new_turn: Boolean(availability.can_start_new_turn), needs_login: needsLogin, reason: availability.code };
}

function availabilityFrontend(availability) {
  return { display_status: availability.can_start_new_turn ? "ok" : availability.auth_status, can_start_new_turn: Boolean(availability.can_start_new_turn), should_warn_user: !availability.can_start_new_turn, primary_badge: availability.auth_status || availability.code, detail: availability.can_start_new_turn ? "live account auth is launchable" : availability.needs_login ? "login required before starting a new turn" : "account cannot start a new turn" };
}

function buildAccountHealth(profile, quota, historySignals = []) {
  const anomalies = [];
  const add = (type, severity, message) => anomalies.push({ type, severity, message });
  if (!profile.command_available) add("runtime_missing", "error", `${profile.command} CLI is unavailable`);
  if (!profile.auth_hint_present || quota.error_code?.includes("auth") || quota.live_status === "not_logged_in") add("auth_unavailable", "error", "account authentication is missing or invalid");
  if (quota.live_status === "limited" || quota.limit_reached_type || quota.remaining_percent === 0) add("quota_limited", "critical", quota.limit_reached_type || "provider quota limit reached");
  for (const signal of historySignals) add(signal.type, quota.authoritative && quota.live_status === "live" && ["usage_limit", "auth_failure"].includes(signal.type) ? "warning" : signal.severity, `${signal.type} signal in local history (${signal.count || 1})`);
  const severity = anomalies.some((item) => item.severity === "critical") ? "critical" : anomalies.some((item) => item.severity === "error") ? "error" : anomalies.some((item) => item.severity === "warning") ? "warning" : "info";
  const status = severity === "critical" ? "limited" : severity === "error" ? "blocked" : severity === "warning" ? "warning" : "ok";
  return { status, severity, action_required: severity === "critical" || severity === "error", signals: historySignals, anomalies, can_start_new_turn: quota.allowed !== false && status !== "limited" && status !== "blocked" };
}

function frontendAccountStatus(quota, health) {
  return { display_status: health.status, display_remaining: quota.remaining_display || "unknown", can_start_new_turn: Boolean(health.can_start_new_turn), should_warn_user: health.severity === "warning" || health.severity === "error" || health.severity === "critical", primary_badge: quota.live_status || health.status, detail: quota.authoritative ? "live provider quota" : quota.provider === "claude" ? "Claude local status; exact remaining quota unavailable by safe default" : "local snapshot or unavailable" };
}

function accountQuotaCounts(accounts) {
  return { total: accounts.length, codex: accounts.filter((item) => item.profile.source === "codex").length, claude: accounts.filter((item) => item.profile.source === "claude").length, unique_accounts: uniqueAccountKeys(accounts).size, live_authoritative: accounts.filter((item) => item.quota.authoritative).length, local_or_estimated: accounts.filter((item) => !item.quota.authoritative).length, limited: accounts.filter((item) => item.health.status === "limited").length, blocked: accounts.filter((item) => item.health.status === "blocked").length, warnings: accounts.filter((item) => item.health.status === "warning").length, ok: accounts.filter((item) => item.health.status === "ok").length };
}

function accountAvailabilityCounts(accounts, profiles) {
  return { profiles_total: profiles.length, configured_profiles: profiles.filter((profile) => profile.auth_hint_present).length, unique_accounts: uniqueAccountKeys(accounts).size, logged_in_accounts: uniqueAccountKeys(accounts.filter((item) => item.availability.logged_in === true)).size, launchable_profiles: accounts.filter((item) => item.availability.can_start_new_turn).length, needs_login_profiles: accounts.filter((item) => item.availability.needs_login || item.availability.logged_in === false).length, blocked_profiles: accounts.filter((item) => !item.availability.can_start_new_turn && !(item.availability.needs_login || item.availability.logged_in === false)).length, codex_profiles: profiles.filter((profile) => profile.source === "codex").length, claude_profiles: profiles.filter((profile) => profile.source === "claude").length };
}

function uniqueAccountKeys(rows) {
  const keys = new Set();
  for (const row of rows) {
    const provider = cleanTextValue(row.account?.provider || row.profile?.source);
    const hash = cleanTextValue(row.account?.account_hash);
    const known = row.account?.identity_known === true;
    const profileId = cleanTextValue(row.profile?.id);
    keys.add(known && hash ? `${provider}:${hash}` : `${provider}:profile:${profileId || hash}`);
  }
  return keys;
}

function quotaSafetyPolicy() {
  return { codex_live_probe: "official codex app-server account/rateLimits/read only; no model turn is started", claude_live_probe: "disabled by default; no claude.ai browser cookie or web quota scraping", claude_local_probe: "claude auth status plus local history anomaly scan only", secret_policy: "credential values, cookies, raw tokens and raw account ids are never emitted" };
}

function accountAvailabilitySafetyPolicy() {
  return { profile_inventory: "profile means local config/history directory only; profile discovery remains separate from launchability", codex_live_auth: "Codex launchability uses official codex app-server account/rateLimits/read only; no model turn is started", claude_live_auth: "Claude launchability uses claude auth status with each profile's CLAUDE_CONFIG_DIR; claude -p is never called", secret_policy: "credential values, cookies, raw tokens, raw account ids and full emails are never emitted" };
}

function wantsLiveQuota(options = {}) {
  if (options.quick === true) return false;
  if (options.live === false || options["no-live"] === true || options.noLive === true) return false;
  if (process.env.BURN_AGENT_QUOTA_DISABLE_LIVE === "1") return false;
  return true;
}

function wantsLiveAvailability(options = {}) {
  if (options.live === false || options["no-live"] === true || options.noLive === true) return false;
  if (process.env.BURN_AGENT_ACCOUNT_DISABLE_LIVE === "1") return false;
  return true;
}

function cleanTextValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
