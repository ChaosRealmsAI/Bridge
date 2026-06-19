export function createAccountApiCommands(deps, core) {
  const {
    cleanText,
    coded,
    activeProfileCandidates,
    compareProfiles,
    normalizeOptionalSource,
    publicProfile,
    required,
  } = deps;
  const {
    accountAvailabilityCounts,
    accountAvailabilityRows,
    accountAvailabilitySafetyPolicy,
    selectedProfiles,
    wantsLiveAvailability,
  } = core;

  async function accountGet(options = {}) {
    const profileId = required(options.profileId || options["profile-id"] || options.profile_id || options.id, "profile-id");
    const result = await selectedAccountList({ ...options, profileId, "profile-id": profileId });
    return { ok: true, schema: "burn.agent.account.get.v1", generated_at: result.generated_at, live_probe: result.live_probe, safety: result.safety, counts: result.counts, account: result.accounts[0] || null };
  }

  async function accountActive(options = {}) {
    if (typeof activeProfileCandidates !== "function") throw coded("active_profile_unavailable", "active profile resolver is unavailable");
    const source = normalizeOptionalSource(options.source);
    const live = wantsLiveAvailability(options);
    const profiles = await activeProfileCandidates({ ...options, source });
    const accounts = (await accountAvailabilityRows(profiles, { ...options, live })).map((row) => {
      const sourceProfile = profiles.find((profile) => profile.id === row.profile.id) || {};
      return { active_reason: cleanText(sourceProfile.active_reason), env_keys: activeEnvKeys(sourceProfile, cleanText), ...row };
    });
    return {
      ok: true,
      schema: "burn.agent.accounts.active.v1",
      generated_at: new Date().toISOString(),
      live_probe: live,
      source: source || "all",
      safety: accountAvailabilitySafetyPolicy(),
      counts: accountAvailabilityCounts(accounts, profiles),
      active: source ? accounts[0] || null : null,
      accounts,
    };
  }

  async function loginDiagnostics(options = {}) {
    const { discovered, profiles, live } = await selectedProfiles(options, 300, wantsLiveAvailability(options), options.quick ?? true);
    const diagnostics = (await accountAvailabilityRows(profiles, { ...options, live })).map(diagnosticRow);
    return {
      ok: true,
      schema: "burn.agent.login-diagnostics.v1",
      generated_at: new Date().toISOString(),
      live_probe: live,
      safety: accountAvailabilitySafetyPolicy(),
      counts: {
        profiles_total: diagnostics.length,
        ok: diagnostics.filter((item) => item.status === "ok").length,
        needs_login: diagnostics.filter((item) => item.needs_login).length,
        blocked: diagnostics.filter((item) => item.status === "blocked").length,
      },
      runtimes: discovered.runtimes,
      diagnostics,
    };
  }

  async function capabilities() {
    return {
      ok: true,
      schema: "burn.agent.capabilities.v1",
      generated_at: new Date().toISOString(),
      providers: {
        codex: providerCapabilities({ live_auth: true, quota_windows: true, subscription_type: true, notes: ["live auth/quota uses codex app-server account/rateLimits/read only"] }),
        claude: providerCapabilities({ live_auth: true, quota_windows: true, subscription_type: true, notes: ["5h/week quota windows are available after Burn receives official Claude Code statusLine rate_limits JSON"] }),
      },
      api: {
        cli: { "burn agent account list": true, "burn agent account get": true, "burn agent account active": true, "burn agent login diagnostics": true, "burn agent claude quota-cache": true, "burn agent claude quota-refresh": true, "burn agent capabilities": true, "burn agent usage summary": true },
        desktop_actions: { "agent.accounts.list": true, "agent.accounts.get": true, "agent.accounts.active": true, "agent.login.diagnostics": true, "agent.claude.quota.cache": true, "agent.claude.quota.refresh": true, "agent.capabilities.get": true, "agent.usage.summary": true },
        bridge_commands: { "burn.agent.accounts.list": true, "burn.agent.accounts.get": true, "burn.agent.accounts.active": true, "burn.agent.login.diagnostics": true, "burn.agent.claude.quota.cache": true, "burn.agent.claude.quota.refresh": true, "burn.agent.capabilities.get": true, "burn.agent.usage.summary": true },
      },
      safety: { no_provider_turns: true, claude_prompt_probe_disabled: true, external_quota_pages_disabled: true, secret_policy: "credential values, cookies, raw tokens, raw account ids and full emails are never emitted" },
    };
  }

  async function usageSummary(options = {}) {
    const period = normalizeUsagePeriod(options.period || "day");
    const historyLimit = options.historyLimit || options["history-limit"] || 300;
    const { discovered, profiles } = await selectedProfiles({ ...options, quick: true, historyLimit, "history-limit": historyLimit }, 300, false, true);
    const profileRows = profiles.sort(compareProfiles).map((profile) => ({
      profile: publicProfile(profile),
      session_inventory: {
        count: Number(profile.history?.session_count || 0),
        capped: Boolean(profile.history?.session_count_capped),
        store_paths: Array.isArray(profile.history?.store_paths) ? profile.history.store_paths : [],
        store_hash: cleanText(profile.history?.store_hash),
      },
    }));
    return {
      ok: true,
      schema: "burn.agent.usage-summary.v1",
      generated_at: new Date().toISOString(),
      period,
      quick: true,
      exact_token_totals_available: false,
      cost_totals_available: false,
      token_totals: { input_tokens: null, output_tokens: null, total_tokens: null },
      cost_totals: { currency: "", total_cost: null },
      counts: {
        profiles_total: profiles.length,
        codex_profiles: profiles.filter((profile) => profile.source === "codex").length,
        claude_profiles: profiles.filter((profile) => profile.source === "claude").length,
        sessions_indexed: profiles.reduce((sum, profile) => sum + Number(profile.history?.session_count || 0), 0),
        session_count_capped: profiles.some((profile) => profile.history?.session_count_capped),
      },
      runtimes: discovered.runtimes,
      profiles: profileRows,
      safety: { default_mode: "quick metadata-only inventory", history_limit: Number(historyLimit), no_provider_turns: true, exact_token_totals_available: false, cost_totals_available: false },
      notes: [
        "This entrypoint is stable for future exact token/cost statistics, but today's default path does not parse all JSONL history.",
        "Period is accepted for API stability; quick mode reports bounded profile/session inventory rather than exact period usage totals.",
      ],
    };
  }

  async function selectedAccountList(options) {
    const { discovered, profiles, live } = await selectedProfiles(options, 300, wantsLiveAvailability(options), options.quick ?? true);
    const accounts = await accountAvailabilityRows(profiles, { ...options, live });
    return { generated_at: new Date().toISOString(), live_probe: live, safety: accountAvailabilitySafetyPolicy(), counts: accountAvailabilityCounts(accounts, profiles), runtimes: discovered.runtimes, accounts };
  }

  return { accountActive, accountGet, capabilities, loginDiagnostics, usageSummary };
}

function activeEnvKeys(profile, cleanText) {
  return Array.isArray(profile.active_env_keys) ? profile.active_env_keys.map(cleanText).filter(Boolean) : [];
}

function diagnosticRow(row) {
  const availability = row.availability || {};
  const profile = row.profile || {};
  const needsLogin = Boolean(availability.needs_login || availability.logged_in === false);
  const canStart = Boolean(availability.can_start_new_turn);
  const status = canStart ? "ok" : needsLogin ? "needs_login" : "blocked";
  return { profile_id: cleanTextValue(profile.id), source: cleanTextValue(profile.source), status, can_start_new_turn: canStart, needs_login: needsLogin, code: cleanTextValue(availability.code || status), message: cleanTextValue(availability.message), suggested_action: suggestedDiagnosticAction(row), suggested_command: suggestedDiagnosticCommand(row), account: row.account || {}, profile };
}

function suggestedDiagnosticAction(row) {
  const availability = row.availability || {};
  const code = cleanTextValue(availability.code);
  if (availability.can_start_new_turn) return "none";
  if (/not_checked/.test(code)) return "run_live_diagnostics";
  if (availability.needs_login || availability.logged_in === false || /auth|login|token/i.test(code)) return "login";
  if (/runtime_missing/.test(code)) return "install_runtime";
  if (/quota_limited|limited/.test(code)) return "wait_or_switch_account";
  return "inspect_provider_status";
}

function suggestedDiagnosticCommand(row) {
  const profile = row.profile || {};
  const id = cleanTextValue(profile.id);
  const source = cleanTextValue(profile.source);
  const action = suggestedDiagnosticAction(row);
  if (action === "login") {
    if (source === "codex") return profile.path_display ? `CODEX_HOME=${profile.path_display} codex login` : "codex login";
    if (source === "claude" && id !== "claude:default") return profile.path_display ? `CLAUDE_CONFIG_DIR=${profile.path_display} claude login` : "claude login";
    if (source === "claude") return "claude login";
  }
  if (action === "run_live_diagnostics" && id) return `burn agent login diagnostics --profile-id ${id} --live --json`;
  return id ? `burn agent account get --profile-id ${id} --live --json` : "burn agent login diagnostics --live --json";
}

function providerCapabilities(overrides = {}) {
  return {
    profile_inventory: true,
    active_account: true,
    live_auth: Boolean(overrides.live_auth),
    quota_windows: Boolean(overrides.quota_windows),
    subscription_type: Boolean(overrides.subscription_type),
    login_diagnostics: true,
    usage_summary: true,
    exact_token_totals: false,
    cost_totals: false,
    notes: Array.isArray(overrides.notes) ? overrides.notes : [],
  };
}

function normalizeUsagePeriod(value) {
  const period = cleanTextValue(value).toLowerCase() || "day";
  if (["day", "week", "month", "all"].includes(period)) return period;
  const error = new Error(`invalid period: ${value}`);
  error.code = "invalid_period";
  throw error;
}

function cleanTextValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
