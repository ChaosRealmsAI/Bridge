export function publicAccountInfo(account = {}) {
  return {
    provider: cleanTextValue(account.provider),
    display_name: cleanTextValue(account.display_name),
    email_display: cleanTextValue(account.email_display),
    account_hash: cleanTextValue(account.account_hash),
    identity_known: Boolean(account.identity_known),
    identity_kind: cleanTextValue(account.identity_kind),
    auth_method: cleanTextValue(account.auth_method),
    api_provider: cleanTextValue(account.api_provider),
    subscription_type: cleanTextValue(account.subscription_type),
    plan_type: cleanTextValue(account.plan_type),
    org_display: cleanTextValue(account.org_display),
    org_hash: cleanTextValue(account.org_hash),
  };
}

export function availabilityQuotaSummary(quota = {}) {
  const windows = normalizeWindows(quota.windows);
  const fiveHour = bestWindow(windows, 300);
  const weekly = bestWindow(windows, 10080);
  return {
    provider: cleanTextValue(quota.provider),
    source_kind: cleanTextValue(quota.source_kind),
    authoritative: Boolean(quota.authoritative),
    live_status: cleanTextValue(quota.live_status),
    allowed: quota.allowed === null || quota.allowed === undefined ? null : Boolean(quota.allowed),
    plan_type: cleanTextValue(quota.plan_type),
    remaining_display: cleanTextValue(quota.remaining_display),
    limit_reached_type: cleanTextValue(quota.limit_reached_type),
    quota_unavailable_reason: cleanTextValue(quota.quota_unavailable_reason || quota.error_code),
    windows,
    five_hour_remaining_display: displayPercent(fiveHour?.remaining_percent),
    five_hour_resets_at: cleanTextValue(fiveHour?.resets_at),
    weekly_remaining_display: displayPercent(weekly?.remaining_percent),
    weekly_resets_at: cleanTextValue(weekly?.resets_at),
    statusline_cache: publicStatuslineCache(quota.statusline_cache),
    stale_evidence: publicStaleQuotaEvidence(quota.stale_evidence),
    safety_note: cleanTextValue(quota.safety_note),
  };
}

export function emptyAvailabilityQuota(extra = {}) {
  return availabilityQuotaSummary({
    provider: cleanTextValue(extra.provider),
    source_kind: cleanTextValue(extra.source_kind),
    authoritative: Boolean(extra.authoritative),
    live_status: cleanTextValue(extra.live_status),
    allowed: extra.allowed,
    plan_type: cleanTextValue(extra.plan_type),
    remaining_display: cleanTextValue(extra.remaining_display),
    limit_reached_type: cleanTextValue(extra.limit_reached_type),
    windows: [],
  });
}

export function withQuotaWindowFields(quota = {}) {
  const summary = availabilityQuotaSummary(quota);
  return {
    ...quota,
    ...summary,
    windows: summary.windows,
    five_hour_remaining_display: summary.five_hour_remaining_display,
    five_hour_resets_at: summary.five_hour_resets_at,
    weekly_remaining_display: summary.weekly_remaining_display,
    weekly_resets_at: summary.weekly_resets_at,
  };
}

function normalizeWindows(windows) {
  if (!Array.isArray(windows)) return [];
  return windows.map((window) => ({
    limit_id: cleanTextValue(window.limit_id),
    kind: cleanTextValue(window.kind),
    used_percent: numberOrNull(window.used_percent),
    remaining_percent: numberOrNull(window.remaining_percent),
    window_minutes: numberOrNull(window.window_minutes),
    resets_at: cleanTextValue(window.resets_at),
  })).filter((window) => (
    window.used_percent !== null
    || window.remaining_percent !== null
    || window.window_minutes !== null
    || window.resets_at
  ));
}

function bestWindow(windows, minutes) {
  const candidates = windows.filter((window) => window.window_minutes === minutes && Number.isFinite(window.remaining_percent));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => a.remaining_percent - b.remaining_percent)[0];
}

function displayPercent(value) {
  return Number.isFinite(value) ? `${Math.max(0, Math.round(value))}%` : "";
}

function publicStatuslineCache(value) {
  if (!value || typeof value !== "object") return null;
  return {
    schema: cleanTextValue(value.schema),
    profile_id: cleanTextValue(value.profile_id),
    captured_at: cleanTextValue(value.captured_at),
    session_id: cleanTextValue(value.session_id),
    model_display_name: cleanTextValue(value.model_display_name),
    cache_path: cleanTextValue(value.cache_path),
  };
}

function publicStaleQuotaEvidence(value) {
  if (!value || typeof value !== "object") return null;
  const windows = normalizeWindows(value.windows);
  return {
    source_kind: cleanTextValue(value.source_kind),
    remaining_percent: numberOrNull(value.remaining_percent),
    remaining_display: cleanTextValue(value.remaining_display),
    windows,
    five_hour_remaining_display: cleanTextValue(value.five_hour_remaining_display),
    five_hour_resets_at: cleanTextValue(value.five_hour_resets_at),
    weekly_remaining_display: cleanTextValue(value.weekly_remaining_display),
    weekly_resets_at: cleanTextValue(value.weekly_resets_at),
    latest_event_at: cleanTextValue(value.latest_event_at),
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanTextValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
