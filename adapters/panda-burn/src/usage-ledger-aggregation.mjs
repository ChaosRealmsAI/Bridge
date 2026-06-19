import {
  COST_KEYS,
  DEFAULT_DIMENSION_LIMIT,
  HIGH_CARDINALITY_DIMENSION_LIMIT,
  PRICING,
  TOKEN_KEYS,
} from "./usage-ledger-schema.mjs";
import { maskHome } from "./usage-ledger-redaction.mjs";
import { cleanText, coded, firstNumber, objectValue, stableHash, timeMs } from "./usage-ledger-utils.mjs";

export function normalizeUsage(value) {
  const usage = objectValue(value);
  const cacheCreation = objectValue(usage.cache_creation || usage.cacheCreation);
  const tokens = emptyTokens();
  tokens.input_tokens = firstNumber(
    usage.input_tokens,
    usage.inputTokens,
    usage.input,
    usage.prompt_tokens,
    usage.promptTokens,
  );
  tokens.output_tokens = firstNumber(
    usage.output_tokens,
    usage.outputTokens,
    usage.output,
    usage.completion_tokens,
    usage.completionTokens,
  );
  tokens.cached_input_tokens = firstNumber(
    usage.cached_input_tokens,
    usage.cachedInputTokens,
  );
  tokens.cache_creation_input_tokens = firstNumber(
    usage.cache_creation_input_tokens,
    usage.cacheCreationInputTokens,
    usage.cache_creation_tokens,
    cacheCreation.input_tokens,
    cacheCreation.inputTokens,
    Number(cacheCreation.ephemeral_1h_input_tokens || 0) + Number(cacheCreation.ephemeral_5m_input_tokens || 0),
  );
  tokens.cache_creation_5m_input_tokens = firstNumber(
    usage.cache_creation_5m_input_tokens,
    usage.cacheCreation5mInputTokens,
    cacheCreation.ephemeral_5m_input_tokens,
    cacheCreation.ephemeral5mInputTokens,
  );
  tokens.cache_creation_1h_input_tokens = firstNumber(
    usage.cache_creation_1h_input_tokens,
    usage.cacheCreation1hInputTokens,
    cacheCreation.ephemeral_1h_input_tokens,
    cacheCreation.ephemeral1hInputTokens,
  );
  const cacheCreationSplit = tokens.cache_creation_5m_input_tokens + tokens.cache_creation_1h_input_tokens;
  tokens.cache_creation_input_tokens = cacheCreationSplit || tokens.cache_creation_input_tokens;
  tokens.cache_read_input_tokens = firstNumber(
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    usage.cache_read_tokens,
  );
  tokens.reasoning_output_tokens = firstNumber(
    usage.reasoning_output_tokens,
    usage.reasoningOutputTokens,
    usage.reasoning_tokens,
    usage.reasoningTokens,
  );
  tokens.total_tokens = firstNumber(
    usage.total_tokens,
    usage.totalTokens,
    usage.total,
  );
  if (!tokens.total_tokens) {
    tokens.total_tokens = tokens.input_tokens
      + tokens.output_tokens
      + tokens.cached_input_tokens
      + tokens.cache_creation_input_tokens
      + tokens.cache_read_input_tokens;
  }
  return tokens;
}

export function normalizeProviderTokens(provider, tokens) {
  if (provider !== "codex") return tokens;
  const cached = Number(tokens.cached_input_tokens || 0);
  if (cached > 0) {
    tokens.input_tokens = Math.max(0, Number(tokens.input_tokens || 0) - cached);
    tokens.cache_read_input_tokens += cached;
    tokens.cached_input_tokens = 0;
  }
  tokens.total_tokens = tokens.input_tokens
    + tokens.output_tokens
    + tokens.cache_creation_input_tokens
    + tokens.cache_read_input_tokens;
  return tokens;
}

export function positiveUsageDelta(current, previous) {
  const delta = emptyTokens();
  for (const key of TOKEN_KEYS) delta[key] = Math.max(0, Number(current[key] || 0) - Number(previous?.[key] || 0));
  return delta;
}

export function costForUsage(provider, model, tokens, diagnostics) {
  const matched = pricingFor(provider, model);
  if (!matched) {
    addUnknownModelWarning(diagnostics, provider, model);
    return emptyCost();
  }
  const codexLike = provider === "codex" || matched.provider === "openai";
  const inputTokens = tokens.input_tokens;
  const cost = emptyCost();
  cost.input_usd = perMillion(inputTokens, matched.input);
  cost.cached_input_usd = perMillion(tokens.cached_input_tokens, matched.cachedInput);
  const cacheCreation5m = Number(tokens.cache_creation_5m_input_tokens || 0);
  const cacheCreation1h = Number(tokens.cache_creation_1h_input_tokens || 0);
  if (cacheCreation5m || cacheCreation1h) {
    cost.cache_creation_usd = perMillion(cacheCreation5m, matched.cacheCreation)
      + perMillion(cacheCreation1h, matched.cacheCreation1h || matched.cacheCreation);
  } else {
    cost.cache_creation_usd = perMillion(tokens.cache_creation_input_tokens, matched.cacheCreation);
  }
  const cacheReadPrice = codexLike && !matched.cacheRead ? matched.cachedInput : matched.cacheRead;
  cost.cache_read_usd = perMillion(tokens.cache_read_input_tokens, cacheReadPrice);
  const outputTokens = tokens.output_tokens || tokens.reasoning_output_tokens;
  cost.output_usd = perMillion(outputTokens, matched.output);
  cost.total_usd = sumCost(cost);
  cost.pricing_model = matched.label;
  return cost;
}

export function createAggregation(targetProject) {
  return {
    targetProject,
    totals: emptyBucket(),
    dimensions: {
      by_provider: new Map(),
      by_account: new Map(),
      by_profile: new Map(),
      by_model: new Map(),
      by_day: new Map(),
      by_week: new Map(),
      by_month: new Map(),
      by_hour: new Map(),
      by_day_hour: new Map(),
      by_weekday_hour: new Map(),
      by_project: new Map(),
      by_account_day: new Map(),
      by_account_week: new Map(),
      by_account_month: new Map(),
      by_account_hour: new Map(),
      by_account_model: new Map(),
      by_account_project: new Map(),
      by_provider_day: new Map(),
      by_provider_week: new Map(),
      by_provider_hour: new Map(),
      by_project_month: new Map(),
      by_project_week: new Map(),
      by_model_day: new Map(),
      by_model_month: new Map(),
      by_session: new Map(),
      by_account_session: new Map(),
    },
  };
}

export function addUsage(aggregation, event) {
  addToBucket(aggregation.totals, event);
  addDimension(aggregation.dimensions.by_provider, event.provider, event, { provider: event.provider });
  addDimension(aggregation.dimensions.by_account, event.account_hash, event, {
    account_hash: event.account_hash,
    account_display: event.account_display,
    provider: event.provider,
  });
  addDimension(aggregation.dimensions.by_profile, event.profile_id, event, {
    profile_id: event.profile_id,
    provider: event.provider,
    account_hash: event.account_hash,
  });
  addDimension(aggregation.dimensions.by_model, event.model, event, { model: event.model, provider: event.provider });
  addDimension(aggregation.dimensions.by_day, event.day, event, { day: event.day });
  addDimension(aggregation.dimensions.by_week, event.week, event, { week: event.week });
  addDimension(aggregation.dimensions.by_month, event.month, event, { month: event.month });
  addDimension(aggregation.dimensions.by_hour, event.hour, event, { hour: event.hour });
  addDimension(aggregation.dimensions.by_day_hour, `${event.day}|${event.hour}`, event, {
    day: event.day,
    hour: event.hour,
  });
  addDimension(aggregation.dimensions.by_weekday_hour, `${event.weekday}|${event.hour}`, event, {
    weekday: event.weekday,
    hour: event.hour,
  });
  addDimension(aggregation.dimensions.by_project, event.project_key, event, {
    project: event.project,
    project_display: event.project_display,
    project_key: event.project_key,
  });
  addDimension(aggregation.dimensions.by_account_day, `${event.account_hash}|${event.day}`, event, {
    account_hash: event.account_hash,
    account_display: event.account_display,
    day: event.day,
  });
  addDimension(aggregation.dimensions.by_account_week, `${event.account_hash}|${event.week}`, event, {
    account_hash: event.account_hash,
    account_display: event.account_display,
    week: event.week,
  });
  addDimension(aggregation.dimensions.by_account_month, `${event.account_hash}|${event.month}`, event, {
    account_hash: event.account_hash,
    account_display: event.account_display,
    month: event.month,
  });
  addDimension(aggregation.dimensions.by_account_hour, `${event.account_hash}|${event.hour}`, event, {
    account_hash: event.account_hash,
    account_display: event.account_display,
    hour: event.hour,
  });
  addDimension(aggregation.dimensions.by_account_model, `${event.account_hash}|${event.model}`, event, {
    account_hash: event.account_hash,
    account_display: event.account_display,
    model: event.model,
  });
  addDimension(aggregation.dimensions.by_account_project, `${event.account_hash}|${event.project_key}`, event, {
    account_hash: event.account_hash,
    account_display: event.account_display,
    project: event.project,
    project_display: event.project_display,
    project_key: event.project_key,
  });
  addDimension(aggregation.dimensions.by_provider_day, `${event.provider}|${event.day}`, event, {
    provider: event.provider,
    day: event.day,
  });
  addDimension(aggregation.dimensions.by_provider_week, `${event.provider}|${event.week}`, event, {
    provider: event.provider,
    week: event.week,
  });
  addDimension(aggregation.dimensions.by_provider_hour, `${event.provider}|${event.hour}`, event, {
    provider: event.provider,
    hour: event.hour,
  });
  addDimension(aggregation.dimensions.by_project_month, `${event.project_key}|${event.month}`, event, {
    project: event.project,
    project_display: event.project_display,
    project_key: event.project_key,
    month: event.month,
  });
  addDimension(aggregation.dimensions.by_project_week, `${event.project_key}|${event.week}`, event, {
    project: event.project,
    project_display: event.project_display,
    project_key: event.project_key,
    week: event.week,
  });
  addDimension(aggregation.dimensions.by_model_day, `${event.model}|${event.day}`, event, {
    model: event.model,
    provider: event.provider,
    day: event.day,
  });
  addDimension(aggregation.dimensions.by_model_month, `${event.model}|${event.month}`, event, {
    model: event.model,
    provider: event.provider,
    month: event.month,
  });
  const sessionKey = sessionDimensionKey(event);
  addDimension(aggregation.dimensions.by_session, sessionKey, event, {
    session_id_hash: stableHash(event.session_id || sessionKey),
    provider: event.provider,
    profile_id: event.profile_id,
    account_hash: event.account_hash,
    account_display: event.account_display,
    model: event.model,
    project: event.project,
    project_display: event.project_display,
    project_key: event.project_key,
  });
  addDimension(aggregation.dimensions.by_account_session, `${event.account_hash}|${sessionKey}`, event, {
    session_id_hash: stableHash(event.session_id || sessionKey),
    account_hash: event.account_hash,
    account_display: event.account_display,
    provider: event.provider,
    profile_id: event.profile_id,
    model: event.model,
    project: event.project,
    project_display: event.project_display,
    project_key: event.project_key,
  });
}

function addDimension(map, key, event, fields) {
  const safeKey = cleanText(key) || "unknown";
  let bucket = map.get(safeKey);
  if (!bucket) {
    bucket = { key: safeKey, ...fields, ...emptyBucket() };
    map.set(safeKey, bucket);
  }
  addToBucket(bucket, event);
}

export function serializeAggregation(aggregation) {
  return {
    totals: serializeBucket(aggregation.totals),
    dimensions: Object.fromEntries(Object.entries(aggregation.dimensions).map(([name, map]) => [
      name,
      [...map.values()].map(serializeBucket),
    ])),
  };
}

function serializeBucket(bucket) {
  const out = {
    ...Object.fromEntries(Object.entries(bucket).filter(([key]) => !["tokens", "cost", "_activity"].includes(key))),
    tokens: { ...(bucket.tokens || emptyTokens()) },
    cost: { ...(bucket.cost || emptyCost()) },
  };
  if (bucket._activity) {
    out.activity_parts = {
      first_ms: bucket._activity.first_ms,
      last_ms: bucket._activity.last_ms,
      days: [...bucket._activity.days],
      hours: [...bucket._activity.hours],
      sessions: [...bucket._activity.sessions],
    };
  }
  return out;
}

export function mergeAggregation(target, serialized) {
  if (!serialized || typeof serialized !== "object") return;
  mergeBucketInto(target.totals, serialized.totals);
  for (const [name, rows] of Object.entries(serialized.dimensions || {})) {
    const map = target.dimensions[name];
    if (!map || !Array.isArray(rows)) continue;
    for (const row of rows) mergeDimensionBucket(map, row);
  }
}

function mergeDimensionBucket(map, source) {
  const key = cleanText(source?.key) || "unknown";
  let bucket = map.get(key);
  if (!bucket) {
    bucket = {
      ...Object.fromEntries(Object.entries(source || {}).filter(([field]) => ![
        "usage_events",
        "tokens",
        "cost",
        "activity_parts",
        "_activity",
      ].includes(field))),
      usage_events: 0,
      tokens: emptyTokens(),
      cost: emptyCost(),
    };
    map.set(key, bucket);
  }
  mergeBucketInto(bucket, source);
}

function mergeBucketInto(target, source) {
  if (!target || !source) return;
  target.usage_events += Number(source.usage_events || 0);
  for (const key of TOKEN_KEYS) target.tokens[key] += Number(source.tokens?.[key] || 0);
  for (const key of COST_KEYS) target.cost[key] += Number(source.cost?.[key] || 0);
  mergeActivityParts(target, source.activity_parts);
}

function mergeActivityParts(bucket, parts) {
  if (!parts || typeof parts !== "object") return;
  const firstMs = Number(parts.first_ms || 0);
  const lastMs = Number(parts.last_ms || 0);
  if (!firstMs || !lastMs) return;
  if (!bucket._activity) {
    bucket._activity = {
      first_ms: firstMs,
      last_ms: lastMs,
      days: new Set(),
      hours: new Set(),
      sessions: new Set(),
    };
  }
  bucket._activity.first_ms = Math.min(bucket._activity.first_ms, firstMs);
  bucket._activity.last_ms = Math.max(bucket._activity.last_ms, lastMs);
  for (const day of parts.days || []) bucket._activity.days.add(day);
  for (const hour of parts.hours || []) bucket._activity.hours.add(hour);
  for (const session of parts.sessions || []) bucket._activity.sessions.add(session);
}

function addToBucket(bucket, event) {
  bucket.usage_events += 1;
  updateActivity(bucket, event);
  for (const key of TOKEN_KEYS) bucket.tokens[key] += Number(event.tokens[key] || 0);
  for (const key of COST_KEYS) bucket.cost[key] += Number(event.cost[key] || 0);
}

function updateActivity(bucket, event) {
  const ms = timeMs(event.occurred_at);
  if (!ms) return;
  if (!bucket._activity) {
    bucket._activity = {
      first_ms: ms,
      last_ms: ms,
      days: new Set(),
      hours: new Set(),
      sessions: new Set(),
    };
  }
  const activity = bucket._activity;
  activity.first_ms = Math.min(activity.first_ms, ms);
  activity.last_ms = Math.max(activity.last_ms, ms);
  if (event.day && event.day !== "unknown") activity.days.add(event.day);
  if (event.day && event.hour && event.day !== "unknown" && event.hour !== "unknown") activity.hours.add(`${event.day}T${event.hour}`);
  if (event.session_id) activity.sessions.add(`${event.provider}:${event.profile_id}:${event.session_id}`);
}

export function finalizeDimensions(dimensions, options = {}) {
  const out = {};
  const meta = {};
  for (const [name, map] of Object.entries(dimensions)) {
    const rows = [...map.values()].map(finalizeBucket).sort(compareDimensionRows);
    const limit = dimensionLimitFor(name, options.defaultLimit || DEFAULT_DIMENSION_LIMIT);
    out[name] = limit > 0 ? rows.slice(0, limit) : rows;
    meta[name] = {
      total_rows: rows.length,
      returned_rows: out[name].length,
      truncated: limit > 0 && rows.length > limit,
      limit,
    };
  }
  return { dimensions: out, meta };
}

function dimensionLimitFor(name, defaultLimit) {
  if (["by_session", "by_account_session"].includes(name)) {
    return Math.min(defaultLimit || HIGH_CARDINALITY_DIMENSION_LIMIT, HIGH_CARDINALITY_DIMENSION_LIMIT);
  }
  return defaultLimit;
}

export function finalizeBucket(bucket) {
  const activity = finalizeActivity(bucket);
  return {
    ...Object.fromEntries(Object.entries(bucket).filter(([key]) => !["tokens", "cost", "_activity"].includes(key))),
    tokens: roundTokens(bucket.tokens),
    cost: roundCost(bucket.cost),
    metrics: usageMetrics(bucket, activity),
    activity,
  };
}

function finalizeActivity(bucket) {
  const activity = bucket._activity;
  if (!activity) {
    return {
      first_seen_at: "",
      last_seen_at: "",
      active_span_minutes: 0,
      active_span_days: 0,
      active_days: 0,
      active_hours: 0,
      sessions: 0,
    };
  }
  const spanMinutes = Math.max(0, (activity.last_ms - activity.first_ms) / 60000);
  return {
    first_seen_at: new Date(activity.first_ms).toISOString(),
    last_seen_at: new Date(activity.last_ms).toISOString(),
    active_span_minutes: roundNumber(spanMinutes, 3),
    active_span_days: roundNumber(spanMinutes / 1440, 6),
    active_days: activity.days.size,
    active_hours: activity.hours.size,
    sessions: activity.sessions.size,
  };
}

function usageMetrics(bucket, activity) {
  const tokens = bucket.tokens || {};
  const cost = bucket.cost || {};
  const totalTokens = Number(tokens.total_tokens || 0);
  const cacheTokens = Number(tokens.cached_input_tokens || 0) + Number(tokens.cache_read_input_tokens || 0);
  const cacheBase = Number(tokens.input_tokens || 0)
    + Number(tokens.cached_input_tokens || 0)
    + Number(tokens.cache_creation_input_tokens || 0)
    + Number(tokens.cache_read_input_tokens || 0);
  const inputLike = Number(tokens.input_tokens || 0)
    + Number(tokens.cached_input_tokens || 0)
    + Number(tokens.cache_creation_input_tokens || 0)
    + Number(tokens.cache_read_input_tokens || 0);
  const outputLike = Number(tokens.output_tokens || 0) + Number(tokens.reasoning_output_tokens || 0);
  const activeHours = Number(activity?.active_hours || 0);
  return {
    cache_hit_ratio: cacheBase > 0 ? roundNumber(cacheTokens / cacheBase, 6) : 0,
    output_input_ratio: inputLike > 0 ? roundNumber(outputLike / inputLike, 6) : 0,
    avg_tokens_per_event: bucket.usage_events > 0 ? roundNumber(totalTokens / bucket.usage_events, 3) : 0,
    avg_usd_per_event: bucket.usage_events > 0 ? roundUsd(Number(cost.total_usd || 0) / bucket.usage_events) : 0,
    usd_per_1m_tokens: totalTokens > 0 ? roundUsd((Number(cost.total_usd || 0) / totalTokens) * 1_000_000) : 0,
    tokens_per_active_hour: activeHours > 0 ? roundNumber(totalTokens / activeHours, 3) : 0,
    events_per_active_hour: activeHours > 0 ? roundNumber(bucket.usage_events / activeHours, 3) : 0,
  };
}

export function currentProjectSummary(aggregation, project) {
  const key = stableHash(cleanProjectForAggregation(project));
  const bucket = aggregation.dimensions.by_project.get(key);
  return bucket ? finalizeBucket(bucket) : finalizeBucket({ key, project, project_display: maskHome(project), ...emptyBucket() });
}

function cleanProjectForAggregation(value) {
  const text = cleanText(value);
  if (!text || text === "unknown") return "";
  return text;
}

export function activitySummary({ totals, dimensions }) {
  const byDay = dimensions.by_day || [];
  const byDayHour = dimensions.by_day_hour || [];
  const byWeekdayHour = dimensions.by_weekday_hour || [];
  const byHour = dimensions.by_hour || [];
  const bySession = dimensions.by_session || [];
  const sessionSpans = bySession
    .map((row) => Number(row.activity?.active_span_minutes || 0))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  return {
    first_seen_at: totals.activity?.first_seen_at || "",
    last_seen_at: totals.activity?.last_seen_at || "",
    active_span_minutes: totals.activity?.active_span_minutes || 0,
    active_span_days: totals.activity?.active_span_days || 0,
    active_days: totals.activity?.active_days || 0,
    active_hours: totals.activity?.active_hours || 0,
    sessions: totals.activity?.sessions || bySession.length,
    daily_heatmap: byDay.map((row) => heatmapPoint(row, { day: row.day })),
    hourly_heatmap: byDayHour.map((row) => heatmapPoint(row, { day: row.day, hour: row.hour })),
    weekday_hour_heatmap: byWeekdayHour.map((row) => heatmapPoint(row, { weekday: row.weekday, hour: row.hour })),
    peak_hours: byHour.slice(0, 6).map((row) => heatmapPoint(row, { hour: row.hour })),
    session_span_minutes: {
      min: percentile(sessionSpans, 0),
      p50: percentile(sessionSpans, 0.5),
      p90: percentile(sessionSpans, 0.9),
      max: percentile(sessionSpans, 1),
      avg: sessionSpans.length ? roundNumber(sessionSpans.reduce((sum, value) => sum + value, 0) / sessionSpans.length, 3) : 0,
    },
  };
}

export function selectLedgerView(result, options = {}) {
  const view = cleanText(options.view || options.select || options.output_view).toLowerCase();
  const dimension = cleanText(options.dimension);
  const limit = positiveLimit(options.limit);
  if (dimension) return ledgerDimensionView(result, dimension, limit);
  if (!view || view === "summary" || view === "full") return applyDimensionLimit(result, limit);
  if (view === "totals") return ledgerPick(result, { view, totals: result.totals, activity: result.activity });
  if (view === "activity" || view === "heatmap") return ledgerPick(result, { view, activity: result.activity, totals: result.totals });
  if (view === "filters") return ledgerPick(result, { view, available_filters: result.available_filters, profiles: result.profiles });
  if (view === "diagnostics") return ledgerPick(result, { view, diagnostics: result.diagnostics, warnings: result.warnings });
  if (view === "pricing") return ledgerPick(result, { view, pricing: result.pricing });
  if (view === "dimensions") return ledgerPick(result, { view, dimensions: limitDimensions(result.dimensions, limit) });
  throw coded("invalid_view", `invalid usage ledger view: ${view}`);
}

function ledgerDimensionView(result, dimension, limit) {
  const rows = result.dimensions?.[dimension];
  if (!Array.isArray(rows)) throw coded("invalid_dimension", `invalid usage ledger dimension: ${dimension}`);
  return ledgerPick(result, {
    view: "dimension",
    dimension,
    rows: limit > 0 ? rows.slice(0, limit) : rows,
  });
}

function ledgerPick(result, fields) {
  return {
    ok: result.ok,
    schema: result.schema,
    generated_at: result.generated_at,
    run_id: result.run_id,
    project: result.project,
    project_display: result.project_display,
    source_policy: result.source_policy,
    scan_scope: result.scan_scope,
    output: result.output,
    served_from_cache: result.served_from_cache,
    cache_hit_kind: result.cache_hit_kind,
    ...fields,
  };
}

function applyDimensionLimit(result, limit) {
  if (!limit) return result;
  return {
    ...result,
    dimensions: limitDimensions(result.dimensions, limit),
  };
}

function limitDimensions(dimensions, limit) {
  if (!limit) return dimensions;
  return Object.fromEntries(Object.entries(dimensions || {}).map(([key, rows]) => [
    key,
    Array.isArray(rows) ? rows.slice(0, limit) : rows,
  ]));
}

function heatmapPoint(row, fields) {
  return {
    ...fields,
    usage_events: row.usage_events || 0,
    total_tokens: row.tokens?.total_tokens || 0,
    input_tokens: row.tokens?.input_tokens || 0,
    output_tokens: row.tokens?.output_tokens || 0,
    cached_input_tokens: row.tokens?.cached_input_tokens || 0,
    cache_creation_input_tokens: row.tokens?.cache_creation_input_tokens || 0,
    cache_read_input_tokens: row.tokens?.cache_read_input_tokens || 0,
    total_usd: row.cost?.total_usd || 0,
    cache_hit_ratio: row.metrics?.cache_hit_ratio || 0,
  };
}

function percentile(values, p) {
  if (!values.length) return 0;
  if (p <= 0) return roundNumber(values[0], 3);
  if (p >= 1) return roundNumber(values[values.length - 1], 3);
  const index = (values.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return roundNumber(values[lower], 3);
  const weight = index - lower;
  return roundNumber(values[lower] * (1 - weight) + values[upper] * weight, 3);
}

function sessionDimensionKey(event) {
  return [
    event.provider,
    event.profile_id,
    event.session_id || event.event_id || "unknown",
  ].map((item) => cleanText(item) || "unknown").join("|");
}

function compareDimensionRows(a, b) {
  return Number(b.cost?.total_usd || 0) - Number(a.cost?.total_usd || 0)
    || Number(b.tokens?.total_tokens || 0) - Number(a.tokens?.total_tokens || 0)
    || String(a.key || "").localeCompare(String(b.key || ""));
}

function addUnknownModelWarning(diagnostics, provider, model) {
  const key = `${provider}:${model || "unknown"}`;
  if (!diagnostics.unknown_model_pricing.includes(key)) diagnostics.unknown_model_pricing.push(key);
  if (!diagnostics.warnings.some((item) => item.code === "unknown_model_pricing" && item.key === key)) {
    diagnostics.warnings.push({
      code: "unknown_model_pricing",
      key,
      provider,
      model: model || "unknown",
      message: "Model pricing was not found; cost for these events is 0 while token counts are preserved.",
    });
  }
}

function pricingFor(provider, model) {
  const normalizedProvider = provider === "claude" ? "anthropic" : provider === "codex" ? "openai" : provider;
  return PRICING.find((item) => item.provider === normalizedProvider && item.pattern.test(model || ""));
}

function perMillion(tokens, usdPerMillion) {
  return (Number(tokens || 0) / 1_000_000) * Number(usdPerMillion || 0);
}

function sumCost(cost) {
  return COST_KEYS.filter((key) => key !== "total_usd").reduce((sum, key) => sum + Number(cost[key] || 0), 0);
}

function emptyBucket() {
  return {
    usage_events: 0,
    tokens: emptyTokens(),
    cost: emptyCost(),
  };
}

export function emptyTokens() {
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, 0]));
}

function emptyCost() {
  return Object.fromEntries(COST_KEYS.map((key) => [key, 0]));
}

function roundTokens(tokens) {
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, Math.round(Number(tokens[key] || 0))]));
}

function roundCost(cost) {
  const out = Object.fromEntries(COST_KEYS.map((key) => [key, roundUsd(Number(cost[key] || 0))]));
  if (cost.pricing_model) out.pricing_model = cost.pricing_model;
  return out;
}

function roundUsd(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function roundNumber(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

export function hasAnyToken(tokens) {
  return TOKEN_KEYS.some((key) => Number(tokens[key] || 0) > 0);
}

function positiveLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
