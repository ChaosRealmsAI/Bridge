import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  activitySummary,
  addUsage,
  costForUsage,
  createAggregation,
  currentProjectSummary,
  finalizeBucket,
  finalizeDimensions,
  hasAnyToken,
  mergeAggregation,
  normalizeProviderTokens,
  normalizeUsage,
  positiveUsageDelta,
  roundNumber,
  selectLedgerView,
  serializeAggregation,
} from "./usage-ledger-aggregation.mjs";
import { maskEmail, maskHome, redactLedgerForRelay, redactedError } from "./usage-ledger-redaction.mjs";
import {
  DEFAULT_DIMENSION_LIMIT,
  LEDGER_SCHEMA,
  PARSER_VERSION,
  PRICING,
  PRICING_VERSION,
  TOKEN_KEYS,
} from "./usage-ledger-schema.mjs";
import {
  fileSize,
  firstReadableJson,
  getCachedUsageFile,
  getCachedUsageFileAggregate,
  getCachedUsageResult,
  jsonFilesRecursive,
  loadUsageCache,
  pathSize,
  readJson,
  readUsageLedgerSnapshot,
  setCachedUsageFile,
  setCachedUsageFileAggregate,
  setCachedUsageResult,
  usageCachePath,
  usageFileAggregateQueryKey,
  usageResultCacheKey,
  writeJsonAtomic,
  writeLedgerViews,
  writeUsageCache,
  writeUsageSqlite,
} from "./usage-ledger-storage.mjs";
import {
  boundaryTime,
  cleanProject,
  cleanText,
  coded,
  decodeJwtPayload,
  eventTimestamp,
  firstText,
  homeDir,
  ledgerRunId,
  localCalendarParts,
  normalizeOptionalSource,
  normalizeResponseMode,
  normalizeStringList,
  normalizeTime,
  normalizeTimezone,
  objectValue,
  positiveInt,
  resolveBurnHome,
  resolveProjectPath,
  safeId,
  stableHash,
  timeMs,
  usageLedgerDir,
} from "./usage-ledger-utils.mjs";

export async function generateUsageLedger(options = {}) {
  const startedAtMs = Date.now();
  const generatedAt = new Date().toISOString();
  const project = await resolveProjectPath(cleanText(options.project) || process.cwd());
  const burnHome = resolveBurnHome(options);
  const outputDir = usageLedgerDir(burnHome);
  const responseMode = normalizeResponseMode(options.responseMode || options.response_mode);
  const snapshot = options.snapshot === true || options.snapshot === "true" || options.snapshot === "1";
  if (snapshot) {
    const selected = await readUsageLedgerSnapshot(outputDir, options);
    return responseMode === "relay" ? redactLedgerForRelay(selected) : selected;
  }
  const timezone = normalizeTimezone(options.timezone || options.time_zone);
  const source = normalizeOptionalSource(options.source);
  const profileIds = normalizeStringList(options.profileIds || options.profile_ids || options.profileId || options.profile_id);
  const excludeProfileIds = normalizeStringList(options.excludeProfileIds || options.exclude_profile_ids);
  const fromTime = options.from ? boundaryTime(options.from, timezone, "start") : "";
  const toTime = options.to ? boundaryTime(options.to, timezone, "end") : "";
  const fromMs = fromTime ? timeMs(fromTime) : 0;
  const toMs = toTime ? timeMs(toTime) : 0;
  const maxFiles = positiveInt(options.maxFiles, 0);
  const maxDepth = positiveInt(options.maxDepth, 16);
  const dimensionLimit = positiveInt(options.dimensionLimit || options.dimension_limit, 0);
  const force = options.force === true || options.force === "true" || options.force === "1";
  const diagnostics = emptyDiagnostics();
  const discoveredProfiles = await discoverProfiles({ maxDepth, maxFiles });
  const profiles = discoveredProfiles
    .filter((profile) => !source || profile.provider === source)
    .filter((profile) => !profileIds.length || profileIds.includes(profile.id))
    .filter((profile) => !excludeProfileIds.includes(profile.id));
  const missingProfileIds = profileIds.filter((id) => !discoveredProfiles.some((profile) => profile.id === id));
  if (missingProfileIds.length) throw coded("profile_not_found", "profile was not found");

  const aggregation = createAggregation(project);
  const seenEventIds = new Set();
  const cache = await loadUsageCache(outputDir);
  const fileAggregateQueryKey = usageFileAggregateQueryKey({ fromMs, toMs, timezone });
  const profileContexts = [];
  const profileOutputs = [];
  for (const profile of profiles) {
    const account = await accountIdentity(profile);
    const files = [];
    for (const file of profile.files) {
      if (maxFiles && files.length >= maxFiles) break;
      const stat = await fs.stat(file).catch(() => null);
      if (stat?.isFile()) files.push({ file, stat });
    }
    profileContexts.push({ profile, account, files });
    profileOutputs.push({
      id: profile.id,
      provider: profile.provider,
      path_display: maskHome(profile.path),
      account,
      store_paths: profile.store_paths.map(maskHome),
    });
  }
  const resultCacheKey = usageResultCacheKey({
    source,
    profileIds,
    excludeProfileIds,
    from: fromTime,
    to: toTime,
    timezone,
    maxFiles,
    maxDepth,
    dimensionLimit: dimensionLimit || DEFAULT_DIMENSION_LIMIT,
    profiles: profileContexts,
  });
  const cachedResult = force ? null : await getCachedUsageResult(cache, outputDir, resultCacheKey);
  if (cachedResult) {
    const selected = selectLedgerView(cachedResult, options);
    return responseMode === "relay" ? redactLedgerForRelay(selected) : selected;
  }
  for (const { profile, account, files } of profileContexts) {
    diagnostics.profiles_scanned += 1;
    const profileStats = {
      profile_id: profile.id,
      provider: profile.provider,
      account_hash: account.account_hash,
      path_display: maskHome(profile.path),
      store_paths: profile.store_paths.map(maskHome),
      files_scanned: 0,
      lines_scanned: 0,
      usage_events: 0,
      skipped_lines: 0,
      duplicate_events: 0,
      cache_hits: 0,
      cache_misses: 0,
      errors: [],
    };
    try {
      for (const { file, stat } of files) {
        if (maxFiles && diagnostics.files_scanned >= maxFiles) break;
        await processUsageFile({
          file,
          stat,
          profile,
          account,
          aggregation,
          diagnostics,
          profileStats,
          seenEventIds,
          fromMs,
          toMs,
          timezone,
          cache,
          cacheRoot: outputDir,
          fileAggregateQueryKey,
        });
      }
    } catch (error) {
      profileStats.errors.push(redactedError(error));
      diagnostics.errors.push({ profile_id: profile.id, ...redactedError(error) });
    }
    diagnostics.profile_stats.push(profileStats);
  }
  const runId = ledgerRunId(generatedAt);
  const runPath = path.join(outputDir, "runs", `${runId}.json`);
  const latestPath = path.join(outputDir, "latest.json");
  const totals = finalizeBucket(aggregation.totals);
  const finalizedDimensions = finalizeDimensions(aggregation.dimensions, {
    defaultLimit: dimensionLimit || DEFAULT_DIMENSION_LIMIT,
  });
  const dimensions = finalizedDimensions.dimensions;
  diagnostics.dimension_meta = finalizedDimensions.meta;
  diagnostics.duration_ms = Date.now() - startedAtMs;
  diagnostics.events_per_second = diagnostics.duration_ms > 0 ? roundNumber((diagnostics.usage_events / diagnostics.duration_ms) * 1000, 3) : 0;
  const result = {
    ok: true,
    schema: LEDGER_SCHEMA,
    generated_at: generatedAt,
    run_id: runId,
    project,
    project_display: maskHome(project),
    source_policy: {
      only_jsonl: true,
      active_scan: true,
      no_provider_api: true,
      no_browser_cookie_or_token: true,
    },
    scan_scope: {
      source: source || "all",
      profile_ids: profileIds,
      exclude_profile_ids: excludeProfileIds,
      from: fromTime,
      to: toTime,
      timezone,
      storage_scope: "user_burn_home",
      user_level_storage: true,
      scanned_jsonl_scope: "all_discovered_profile_jsonl",
    },
    storage: {
      scope: "user",
      engine: "json_files",
      burn_home: burnHome,
      burn_home_display: maskHome(burnHome),
      ledger_dir: outputDir,
      ledger_dir_display: maskHome(outputDir),
    },
    pricing: {
      pricing_version: PRICING_VERSION,
      pricing_source_note: "API-equivalent estimate from local JSONL token counts; not a provider invoice.",
      table: PRICING.map((item) => ({
        provider: item.provider,
        model: item.label,
        input_usd_per_million: item.input,
        cached_input_usd_per_million: item.cachedInput,
        cache_creation_usd_per_million: item.cacheCreation,
        cache_creation_5m_usd_per_million: item.cacheCreation,
        cache_creation_1h_usd_per_million: item.cacheCreation1h,
        cache_read_usd_per_million: item.cacheRead,
        output_usd_per_million: item.output,
      })),
    },
    profiles: profileOutputs,
    available_filters: {
      sources: ["codex", "claude"],
      profiles: profileOutputs.map((profile) => ({
        id: profile.id,
        provider: profile.provider,
        account_hash: profile.account.account_hash,
        account_display: profile.account.display_name,
        path_display: profile.path_display,
      })),
      timezone,
    },
    totals,
    current_project: currentProjectSummary(aggregation, project),
    dimensions,
    activity: activitySummary({ totals, dimensions }),
    diagnostics: finalizeDiagnostics(diagnostics),
    warnings: diagnostics.warnings,
    output: {
      directory: outputDir,
      directory_display: maskHome(outputDir),
      latest_path: latestPath,
      latest_path_display: maskHome(latestPath),
      run_path: runPath,
      run_path_display: maskHome(runPath),
    },
  };
  result.storage.sqlite = await writeUsageSqlite(outputDir, result);
  if (result.storage.sqlite.enabled) {
    result.storage.engine = "sqlite_with_json_views";
  } else if (result.storage.sqlite.error) {
    result.warnings.push({
      code: "usage_sqlite_disabled",
      message: result.storage.sqlite.error,
    });
  }
  await setCachedUsageResult(cache, outputDir, resultCacheKey, result);
  await writeJsonAtomic(runPath, result);
  await writeJsonAtomic(latestPath, result);
  await writeLedgerViews(outputDir, result);
  await writeUsageCache(outputDir, cache);
  const selected = selectLedgerView(result, options);
  return responseMode === "relay" ? redactLedgerForRelay(selected) : selected;
}

export async function compactUsageLedgerCache(options = {}) {
  const startedAtMs = Date.now();
  const project = await resolveProjectPath(cleanText(options.project) || process.cwd());
  const burnHome = resolveBurnHome(options);
  const outputDir = usageLedgerDir(burnHome);
  const cacheDir = path.join(outputDir, "cache");
  const obsoleteDir = path.join(cacheDir, "file-aggregate-packs");
  const obsoleteBytes = await pathSize(obsoleteDir);
  await fs.rm(obsoleteDir, { recursive: true, force: true }).catch(() => {});
  const files = [
    usageCachePath(outputDir),
    ...await jsonFilesRecursive(path.join(cacheDir, "files")),
    ...await jsonFilesRecursive(path.join(cacheDir, "file-aggregates")),
    ...await jsonFilesRecursive(path.join(cacheDir, "results")),
  ];
  let compactedFiles = 0;
  let bytesBefore = obsoleteBytes;
  let bytesAfter = 0;
  for (const file of files) {
    const before = await fileSize(file);
    if (!before) continue;
    const value = await readJson(file);
    if (!Object.keys(value).length) continue;
    await writeJsonAtomic(file, value, { pretty: false });
    const after = await fileSize(file);
    compactedFiles += 1;
    bytesBefore += before;
    bytesAfter += after;
  }
  return {
    ok: true,
    schema: "panda-burn.agent-usage-ledger-cache-maintenance.v1",
    project,
    project_display: maskHome(project),
    storage: {
      scope: "user",
      burn_home: burnHome,
      burn_home_display: maskHome(burnHome),
      ledger_dir: outputDir,
      ledger_dir_display: maskHome(outputDir),
    },
    cache_dir: cacheDir,
    cache_dir_display: maskHome(cacheDir),
    removed_obsolete_bytes: obsoleteBytes,
    compacted_files: compactedFiles,
    bytes_before: bytesBefore,
    bytes_after: bytesAfter,
    bytes_saved: Math.max(0, bytesBefore - bytesAfter),
    duration_ms: Date.now() - startedAtMs,
  };
}

export async function discoverProfiles(options = {}) {
  const maxFiles = positiveInt(options.maxFiles, 0);
  const maxDepth = positiveInt(options.maxDepth, 16);
  const codexDirs = await candidateDirs({
    explicit: process.env.CODEX_HOME,
    prefix: ".codex",
    defaultDir: path.join(homeDir(), ".codex"),
  });
  const claudeDirs = await candidateDirs({
    explicit: process.env.CLAUDE_CONFIG_DIR,
    prefix: ".claude",
    defaultDir: path.join(homeDir(), ".claude"),
  });
  const codex = await Promise.all(codexDirs.map(async (dir) => {
    const sessions = path.join(dir, "sessions");
    const files = await jsonlFiles([sessions], { maxDepth, maxFiles });
    const basename = path.basename(dir);
    return {
      id: basename === ".codex" ? "codex:default" : `codex:${safeId(basename.replace(/^\./, ""))}`,
      provider: "codex",
      path: dir,
      label: basename === ".codex" ? "Codex default" : `Codex ${basename}`,
      store_paths: existsSync(sessions) ? [sessions] : [],
      files,
    };
  }));
  const claude = await Promise.all(claudeDirs.map(async (dir) => {
    const projects = path.join(dir, "projects");
    const transcripts = path.join(dir, "transcripts");
    const roots = [projects, transcripts].filter((item) => existsSync(item));
    const files = await jsonlFiles(roots, { maxDepth, maxFiles });
    const basename = path.basename(dir);
    return {
      id: basename === ".claude" ? "claude:default" : `claude:${safeId(basename.replace(/^\./, ""))}`,
      provider: "claude",
      path: dir,
      label: basename === ".claude" ? "Claude Code default" : `Claude Code ${basename}`,
      store_paths: roots,
      files,
    };
  }));
  return [...codex, ...claude].sort((a, b) => a.id.localeCompare(b.id));
}

async function processUsageFile(context) {
  const { file, profile, account, cache, diagnostics, profileStats } = context;
  const stat = context.stat || await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return;
  diagnostics.files_scanned += 1;
  profileStats.files_scanned += 1;
  const aggregateQueryKey = context.fileAggregateQueryKey || usageFileAggregateQueryKey(context);
  const aggregateCached = await getCachedUsageFileAggregate(cache, {
    project: context.cacheRoot,
    file,
    profile,
    account,
    stat,
    queryKey: aggregateQueryKey,
  });
  if (aggregateCached) {
    if (!hasSeenEventIdConflict(context.seenEventIds, aggregateCached.event_ids)) {
      addSeenEventIds(context.seenEventIds, aggregateCached.event_ids);
      diagnostics.cache.files_hit += 1;
      diagnostics.cache.file_aggregate_hits += 1;
      diagnostics.cache.events_reused += Number(aggregateCached.usage_events || 0);
      diagnostics.usage_events += Number(aggregateCached.usage_events || 0);
      diagnostics.skipped_lines += Number(aggregateCached.skipped_lines || 0);
      diagnostics.duplicate_events += Number(aggregateCached.duplicate_events || 0);
      mergeWarnings(diagnostics, aggregateCached.warnings);
      mergeUnknownModelPricing(diagnostics, aggregateCached.unknown_model_pricing);
      profileStats.cache_hits += 1;
      profileStats.skipped_lines += Number(aggregateCached.skipped_lines || 0);
      profileStats.duplicate_events += Number(aggregateCached.duplicate_events || 0);
      profileStats.usage_events += Number(aggregateCached.usage_events || 0);
      mergeAggregation(context.aggregation, aggregateCached.aggregation);
      return;
    }
    diagnostics.cache.file_aggregate_conflicts += 1;
  }
  diagnostics.cache.file_aggregate_misses += 1;
  const cached = await getCachedUsageFile(cache, { project: context.cacheRoot, file, profile, account, stat });
  let parsed;
  if (cached) {
    diagnostics.cache.files_hit += 1;
    diagnostics.cache.events_reused += cached.events.length;
    diagnostics.skipped_lines += Number(cached.skipped_lines || 0);
    profileStats.cache_hits += 1;
    profileStats.skipped_lines += Number(cached.skipped_lines || 0);
    parsed = cached;
  } else {
    diagnostics.cache.files_miss += 1;
    profileStats.cache_misses += 1;
    parsed = await readUsageFileEvents(context, stat);
    await setCachedUsageFile(cache, { project: context.cacheRoot, file, profile, account, stat, parsed });
  }
  const fileAggregate = aggregateParsedUsageEvents(context, parsed.events, {
    seenEventIds: context.seenEventIds,
    diagnostics: context.diagnostics,
  });
  diagnostics.usage_events += fileAggregate.usage_events;
  diagnostics.duplicate_events += fileAggregate.duplicate_events;
  profileStats.duplicate_events += fileAggregate.duplicate_events;
  profileStats.usage_events += fileAggregate.usage_events;
  mergeAggregation(context.aggregation, fileAggregate.aggregation);
  const cacheAggregate = aggregateParsedUsageEvents(context, parsed.events, {
    seenEventIds: new Set(),
    diagnostics: emptyDiagnostics(),
    collectEventIds: true,
  });
  await setCachedUsageFileAggregate(cache, {
    project: context.cacheRoot,
    file,
    profile,
    account,
    stat,
    queryKey: aggregateQueryKey,
    parsed,
    fileAggregate: cacheAggregate,
  });
}

async function readUsageFileEvents(context, stat) {
  const { file, profile } = context;
  const events = [];
  const eventIndexes = new Map();
  let skippedLines = 0;
  let linesScanned = 0;
  context.diagnostics.cache.files_read += 1;
  const fileState = {
    model: "",
    project: "",
    session_id: "",
    thread_id: "",
    previous_total_usage: null,
    claude_assistant_usage_seen: false,
    claude_assistant_sessions: new Set(),
  };
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    lineNumber += 1;
    linesScanned += 1;
    context.diagnostics.lines_scanned += 1;
    context.profileStats.lines_scanned += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      skippedLines += 1;
      context.diagnostics.skipped_lines += 1;
      context.profileStats.skipped_lines += 1;
      continue;
    }
    updateFileState(fileState, event, profile, file);
    const usageEvents = usageEventsFromJsonlEvent(event, {
      provider: profile.provider,
      profile_id: profile.id,
      file,
      lineNumber,
      fileState,
    });
    if (!usageEvents.length) continue;
    for (const item of usageEvents) {
      const normalized = normalizeProviderTokens(profile.provider, normalizeUsage(item.usage));
      if (!hasAnyToken(normalized)) continue;
      const model = cleanText(item.model || fileState.model) || "unknown";
      const project = cleanProject(item.project || fileState.project || projectFromFile(profile, file));
      const occurredAt = normalizeTime(item.occurred_at) || normalizeTime(stat?.mtimeMs) || new Date(0).toISOString();
      appendUsageFileEvent(events, eventIndexes, {
        event_id: item.event_id || `${file}:${lineNumber}:${item.kind}`,
        provider: profile.provider,
        profile_id: profile.id,
        account_hash: context.account.account_hash,
        account_display: context.account.display_name,
        model,
        project,
        project_key: stableHash(project || "unknown"),
        project_display: project ? maskHome(project) : "unknown",
        session_id: cleanText(item.session_id || fileState.session_id),
        occurred_at: occurredAt,
        tokens: normalized,
      });
    }
  }
  context.diagnostics.cache.events_parsed += events.length;
  return { events, lines_scanned: linesScanned, skipped_lines: skippedLines };
}

function appendUsageFileEvent(events, eventIndexes, event) {
  if (event.provider !== "claude") {
    events.push(event);
    return;
  }
  const existingIndex = eventIndexes.get(event.event_id);
  if (existingIndex === undefined) {
    eventIndexes.set(event.event_id, events.length);
    events.push(event);
    return;
  }
  if (usageCompletenessScore(event.tokens) > usageCompletenessScore(events[existingIndex].tokens)) {
    events[existingIndex] = event;
  }
}

function usageCompletenessScore(tokens) {
  return TOKEN_KEYS.reduce((sum, key) => sum + Number(tokens?.[key] || 0), 0);
}

function aggregateParsedUsageEvents(context, events, options = {}) {
  const aggregation = createAggregation(context.aggregation.targetProject);
  const seenEventIds = options.seenEventIds || new Set();
  const diagnostics = options.diagnostics || context.diagnostics;
  const usageWarningsStart = diagnostics.warnings.length;
  const unknownStart = diagnostics.unknown_model_pricing.length;
  const eventIds = [];
  let usageEvents = 0;
  let duplicateEvents = 0;
  for (const event of events) {
    const occurredMs = timeMs(event.occurred_at);
    if (context.fromMs && occurredMs && occurredMs < context.fromMs) continue;
    if (context.toMs && occurredMs && occurredMs > context.toMs) continue;
    const eventId = `${event.profile_id}:${event.event_id}`;
    if (seenEventIds.has(eventId)) {
      duplicateEvents += 1;
      continue;
    }
    seenEventIds.add(eventId);
    if (options.collectEventIds) eventIds.push(eventId);
    const calendar = localCalendarParts(event.occurred_at, context.timezone);
    addUsage(aggregation, {
      ...event,
      day: calendar.day,
      week: calendar.week,
      month: calendar.month,
      hour: calendar.hour,
      weekday: calendar.weekday,
      cost: costForUsage(event.provider, event.model, event.tokens, diagnostics),
    });
    usageEvents += 1;
  }
  return {
    usage_events: usageEvents,
    duplicate_events: duplicateEvents,
    event_ids: eventIds,
    unknown_model_pricing: diagnostics.unknown_model_pricing.slice(unknownStart),
    warnings: diagnostics.warnings.slice(usageWarningsStart),
    aggregation: serializeAggregation(aggregation),
  };
}

function hasSeenEventIdConflict(seenEventIds, eventIds = []) {
  for (const eventId of eventIds || []) {
    if (seenEventIds.has(eventId)) return true;
  }
  return false;
}

function addSeenEventIds(seenEventIds, eventIds = []) {
  for (const eventId of eventIds || []) seenEventIds.add(eventId);
}

function usageEventsFromJsonlEvent(event, context) {
  if (!event || typeof event !== "object") return [];
  if (context.provider === "codex") return codexUsageEvents(event, context);
  if (context.provider === "claude") return claudeUsageEvents(event, context);
  return [];
}

function codexUsageEvents(event, context) {
  const payload = objectValue(event.payload);
  const info = objectValue(payload.info || event.info);
  const method = cleanText(event.method || payload.method);
  const out = [];
  const total = objectValue(info.total_token_usage || info.totalTokenUsage || payload.total_token_usage || payload.totalTokenUsage);
  if (Object.keys(total).length) {
    const current = normalizeUsage(total);
    const previous = context.fileState.previous_total_usage;
    const delta = previous ? positiveUsageDelta(current, previous) : current;
    context.fileState.previous_total_usage = current;
    if (hasAnyToken(delta)) {
      out.push({
        kind: "codex_total_token_usage_delta",
        usage: delta,
        model: firstText(event.model, payload.model, info.model, context.fileState.model),
        project: firstText(event.cwd, payload.cwd, event.params?.cwd, context.fileState.project),
        session_id: firstText(event.session_id, event.sessionId, payload.session_id, payload.sessionId, context.fileState.session_id),
        occurred_at: eventTimestamp(event),
        event_id: `${context.provider}:${context.file}:${context.lineNumber}:total-delta`,
      });
    }
    return out;
  }
  const last = objectValue(info.last_token_usage || info.lastTokenUsage || payload.last_token_usage || payload.lastTokenUsage);
  if (Object.keys(last).length) {
    out.push({
      kind: "codex_last_token_usage",
      usage: last,
      model: firstText(event.model, payload.model, info.model, context.fileState.model),
      project: firstText(event.cwd, payload.cwd, event.params?.cwd, context.fileState.project),
      session_id: firstText(event.session_id, event.sessionId, payload.session_id, payload.sessionId, context.fileState.session_id),
      occurred_at: eventTimestamp(event),
      event_id: `${context.provider}:${context.file}:${context.lineNumber}:last`,
    });
    return out;
  }
  if (method === "thread/tokenUsage/updated") {
    const params = objectValue(event.params);
    const usage = objectValue(params.usage || params.tokenUsage || params.last || params.total);
    if (Object.keys(usage).length) {
      out.push({
        kind: "codex_thread_token_usage",
        usage,
        model: firstText(params.model, context.fileState.model),
        project: firstText(params.cwd, context.fileState.project),
        session_id: firstText(params.threadId, params.thread_id, context.fileState.session_id),
        occurred_at: eventTimestamp(event) || normalizeTime(params.updatedAtMs || params.updated_at_ms),
        event_id: `${context.provider}:${context.file}:${context.lineNumber}:thread-token`,
      });
    }
  }
  const directUsage = objectValue(event.usage || payload.usage);
  if (Object.keys(directUsage).length && /usage|completed|turn/i.test(cleanText(event.type || payload.type || method))) {
    out.push({
      kind: "codex_direct_usage",
      usage: directUsage,
      model: firstText(event.model, payload.model, context.fileState.model),
      project: firstText(event.cwd, payload.cwd, context.fileState.project),
      session_id: firstText(event.session_id, event.sessionId, payload.session_id, payload.sessionId, context.fileState.session_id),
      occurred_at: eventTimestamp(event),
      event_id: firstText(event.id, payload.id) || `${context.provider}:${context.file}:${context.lineNumber}:direct`,
    });
  }
  return out;
}

function claudeUsageEvents(event, context) {
  const type = cleanText(event.type);
  const message = objectValue(event.message);
  const usage = objectValue(message.usage || event.usage);
  if (!Object.keys(usage).length) return [];
  const isAssistant = type === "assistant" || message.role === "assistant" || message.type === "message";
  const isResult = type === "result" || event.subtype === "success";
  const sessionId = firstText(event.session_id, event.sessionId, message.session_id, message.sessionId, context.fileState.session_id);
  if (isAssistant) {
    context.fileState.claude_assistant_usage_seen = true;
    if (sessionId) context.fileState.claude_assistant_sessions.add(sessionId);
  }
  if (isResult && ((sessionId && context.fileState.claude_assistant_sessions.has(sessionId)) || (!sessionId && context.fileState.claude_assistant_usage_seen))) return [];
  if (!isAssistant && !isResult) return [];
  const eventId = firstText(
    event.request_id,
    event.requestId,
    message.id,
    event.uuid,
    isResult ? event.session_id || event.sessionId : "",
  );
  return [{
    kind: isResult ? "claude_result_usage" : "claude_assistant_usage",
    usage,
    model: firstText(message.model, event.model, usage.model, context.fileState.model),
    project: firstText(event.cwd, event.project, context.fileState.project),
    session_id: sessionId,
    occurred_at: eventTimestamp(event),
    event_id: eventId ? `claude:${eventId}` : `${context.provider}:${context.file}:${context.lineNumber}:claude`,
  }];
}

function updateFileState(state, event, profile, file) {
  if (!event || typeof event !== "object") return;
  const payload = objectValue(event.payload);
  const params = objectValue(event.params);
  const settings = objectValue(params.threadSettings || params.thread_settings);
  const message = objectValue(event.message);
  const candidates = [
    event.model,
    payload.model,
    params.model,
    settings.model,
    message.model,
    event.payload?.info?.model,
  ];
  state.model = firstText(...candidates, state.model);
  state.project = cleanProject(firstText(
    event.cwd,
    event.project,
    payload.cwd,
    payload.project,
    params.cwd,
    settings.cwd,
    message.cwd,
    state.project,
  ));
  state.session_id = firstText(
    event.session_id,
    event.sessionId,
    event.conversation_id,
    event.conversationId,
    payload.session_id,
    payload.sessionId,
    params.threadId,
    params.thread_id,
    message.id,
    state.session_id,
  );
  if (!state.project) state.project = projectFromFile(profile, file);
}

async function accountIdentity(profile) {
  if (profile.provider === "codex") return codexAccountIdentity(profile);
  return claudeAccountIdentity(profile);
}

async function codexAccountIdentity(profile) {
  const auth = await readJson(path.join(profile.path, "auth.json"));
  const jwt = decodeJwtPayload(auth.tokens?.id_token || auth.id_token || auth.token);
  const email = cleanText(auth.email || auth.account?.email || auth.user?.email || auth.tokens?.email || jwt.email);
  const accountId = cleanText(auth.account_id || auth.account?.id || auth.tokens?.account_id || jwt.sub);
  return {
    provider: "codex",
    display_name: email ? maskEmail(email) : profile.label,
    email_display: email ? maskEmail(email) : "",
    account_hash: stableHash(`codex:${email || accountId || profile.id}`),
  };
}

async function claudeAccountIdentity(profile) {
  const profileAuth = await firstReadableJson([
    path.join(profile.path, ".credentials.json"),
    path.join(profile.path, "credentials.json"),
    path.join(profile.path, "settings.json"),
  ]);
  const globalAuth = await readJson(path.join(homeDir(), ".claude.json"));
  const email = cleanText(
    profileAuth.email
    || profileAuth.account?.email
    || profileAuth.user?.email
    || globalAuth.email
    || globalAuth.account?.email
    || globalAuth.user?.email,
  );
  const accountId = cleanText(profileAuth.account_id || profileAuth.account?.id || globalAuth.account_id || globalAuth.account?.id);
  return {
    provider: "claude",
    display_name: email ? maskEmail(email) : profile.label,
    email_display: email ? maskEmail(email) : "",
    account_hash: stableHash(`claude:${email || accountId || profile.id}`),
  };
}

async function candidateDirs({ explicit, prefix, defaultDir }) {
  const seen = new Set();
  const dirs = [];
  const add = (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    if (existsSync(resolved)) dirs.push(resolved);
  };
  add(explicit);
  add(defaultDir);
  const entries = await fs.readdir(homeDir(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(prefix)) add(path.join(homeDir(), entry.name));
  }
  return dirs;
}

async function jsonlFiles(roots, options = {}) {
  const out = [];
  for (const root of roots) await walkJsonl(root, out, 0, options.maxDepth || 16, options.maxFiles || 0);
  const withStats = await Promise.all(out.map(async (file) => {
    const stat = await fs.stat(file).catch(() => null);
    return stat ? { file, mtimeMs: stat.mtimeMs } : null;
  }));
  return withStats.filter(Boolean).sort((a, b) => a.file.localeCompare(b.file)).map((item) => item.file);
}

async function walkJsonl(dir, out, depth, maxDepth, maxFiles) {
  if (!dir || depth > maxDepth || (maxFiles && out.length >= maxFiles)) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(full, out, depth + 1, maxDepth, maxFiles);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    if (maxFiles && out.length >= maxFiles) return;
  }
}

function projectFromFile(profile, file) {
  if (profile.provider !== "claude") return "";
  const rel = path.relative(path.join(profile.path, "projects"), file);
  if (rel.startsWith("..")) return "";
  const first = rel.split(path.sep)[0] || "";
  if (!first) return "";
  if (first.startsWith("-Users-")) return `/${first.slice(1).replace(/-/g, "/")}`;
  return first;
}

function emptyDiagnostics() {
  return {
    profiles_scanned: 0,
    files_scanned: 0,
    lines_scanned: 0,
    usage_events: 0,
    skipped_lines: 0,
    duplicate_events: 0,
    duration_ms: 0,
    events_per_second: 0,
    result_cache_hit: false,
    cache: {
      parser_version: PARSER_VERSION,
      files_hit: 0,
      files_miss: 0,
      files_read: 0,
      file_aggregate_hits: 0,
      file_aggregate_misses: 0,
      file_aggregate_conflicts: 0,
      events_reused: 0,
      events_parsed: 0,
      result_hit: false,
    },
    unknown_model_pricing: [],
    warnings: [],
    errors: [],
    profile_stats: [],
  };
}

function finalizeDiagnostics(diagnostics) {
  return {
    ...diagnostics,
    unknown_model_pricing: [...new Set(diagnostics.unknown_model_pricing)].sort(),
  };
}

function mergeWarnings(diagnostics, warnings = []) {
  for (const warning of warnings || []) {
    const key = `${warning?.code || ""}:${warning?.key || ""}:${warning?.message || ""}`;
    if (!diagnostics.warnings.some((item) => `${item?.code || ""}:${item?.key || ""}:${item?.message || ""}` === key)) {
      diagnostics.warnings.push(warning);
    }
  }
}

function mergeUnknownModelPricing(diagnostics, values = []) {
  for (const value of values || []) {
    if (!diagnostics.unknown_model_pricing.includes(value)) diagnostics.unknown_model_pricing.push(value);
  }
}
