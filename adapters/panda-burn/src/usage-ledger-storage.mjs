import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { selectLedgerView } from "./usage-ledger-aggregation.mjs";
import {
  LEDGER_DIR,
  LEDGER_SCHEMA,
  PARSER_VERSION,
  PRICING_VERSION,
} from "./usage-ledger-schema.mjs";
import { maskHome } from "./usage-ledger-redaction.mjs";
import { coded, safeId, stableHash } from "./usage-ledger-utils.mjs";

export async function writeLedgerViews(outputDir, result) {
  const viewsDir = path.join(outputDir, "views");
  await writeJsonAtomic(path.join(viewsDir, "totals.json"), selectLedgerView(result, { view: "totals" }));
  await writeJsonAtomic(path.join(viewsDir, "activity.json"), selectLedgerView(result, { view: "activity" }));
  await writeJsonAtomic(path.join(viewsDir, "filters.json"), selectLedgerView(result, { view: "filters" }));
  await writeJsonAtomic(path.join(viewsDir, "pricing.json"), selectLedgerView(result, { view: "pricing" }));
  await writeJsonAtomic(path.join(viewsDir, "diagnostics.json"), selectLedgerView(result, { view: "diagnostics" }));
  const dimensionsDir = path.join(viewsDir, "dimensions");
  for (const dimension of Object.keys(result.dimensions || {})) {
    await writeJsonAtomic(path.join(dimensionsDir, `${safeId(dimension)}.json`), selectLedgerView(result, { dimension }));
  }
}

export async function writeUsageSqlite(outputDir, result) {
  const sqlitePath = path.join(outputDir, "usage.sqlite");
  try {
    const { DatabaseSync } = await importNodeSqliteQuietly();
    await fs.mkdir(outputDir, { recursive: true });
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec(`
        pragma journal_mode = wal;
        create table if not exists scan_runs (
          run_id text primary key,
          generated_at text not null,
          parser_version text not null,
          pricing_version text not null,
          source_policy_json text not null,
          scan_scope_json text not null,
          totals_json text not null,
          diagnostics_json text not null,
          created_at text not null default current_timestamp
        );
        create table if not exists profiles (
          run_id text not null,
          profile_id text not null,
          provider text not null,
          account_hash text,
          account_display text,
          profile_json text not null,
          primary key (run_id, profile_id)
        );
        create table if not exists dimensions (
          run_id text not null,
          dimension text not null,
          row_key text not null,
          row_json text not null,
          primary key (run_id, dimension, row_key)
        );
        create index if not exists dimensions_lookup_idx
          on dimensions (dimension, row_key);
      `);
      db.prepare(`
        insert or replace into scan_runs (
          run_id, generated_at, parser_version, pricing_version,
          source_policy_json, scan_scope_json, totals_json, diagnostics_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.run_id,
        result.generated_at,
        PARSER_VERSION,
        PRICING_VERSION,
        JSON.stringify(result.source_policy || {}),
        JSON.stringify(result.scan_scope || {}),
        JSON.stringify(result.totals || {}),
        JSON.stringify(result.diagnostics || {}),
      );
      const insertProfile = db.prepare(`
        insert or replace into profiles (
          run_id, profile_id, provider, account_hash, account_display, profile_json
        ) values (?, ?, ?, ?, ?, ?)
      `);
      for (const profile of result.profiles || []) {
        insertProfile.run(
          result.run_id,
          profile.id,
          profile.provider,
          profile.account?.account_hash || null,
          profile.account?.display_name || null,
          JSON.stringify(profile),
        );
      }
      const insertDimension = db.prepare(`
        insert or replace into dimensions (run_id, dimension, row_key, row_json)
        values (?, ?, ?, ?)
      `);
      for (const [dimension, rows] of Object.entries(result.dimensions || {})) {
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          insertDimension.run(result.run_id, dimension, dimensionRowKey(row), JSON.stringify(row));
        }
      }
    } finally {
      db.close();
    }
    return {
      enabled: true,
      sqlite_path: sqlitePath,
      sqlite_path_display: maskHome(sqlitePath),
      tables: ["scan_runs", "profiles", "dimensions"],
      json_views: true,
    };
  } catch (error) {
    return {
      enabled: false,
      sqlite_path: sqlitePath,
      sqlite_path_display: maskHome(sqlitePath),
      error: safeSqliteError(error),
      json_views: true,
    };
  }
}

async function importNodeSqliteQuietly() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function filteredSqliteWarning(warning, ...args) {
    const text = typeof warning === "string" ? warning : String(warning?.message || warning || "");
    const type = typeof args[0] === "string" ? args[0] : warning?.name || "";
    if (type === "ExperimentalWarning" && text.includes("SQLite")) return;
    return emitWarning.call(process, warning, ...args);
  };
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

function dimensionRowKey(row) {
  for (const key of [
    "key",
    "id",
    "profile_id",
    "account_hash",
    "model",
    "project_key",
    "session_id",
    "day",
    "week",
    "month",
    "hour",
    "weekday",
  ]) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value) !== "") return String(value);
  }
  return stableHash(JSON.stringify(row || {}));
}

function safeSqliteError(error) {
  const message = String(error?.message || error || "sqlite unavailable");
  if (message.includes("No such built-in module") || message.includes("Cannot find")) return "node:sqlite unavailable";
  return message.split("\n")[0].slice(0, 160);
}

export async function readUsageLedgerSnapshot(outputDir, options = {}) {
  const view = String(options.view || options.select || options.output_view || "").replace(/\s+/g, " ").trim().toLowerCase();
  const dimension = String(options.dimension || "").replace(/\s+/g, " ").trim();
  const limit = positiveLimit(options.limit);
  let value = {};
  if (dimension) {
    value = await readJson(path.join(outputDir, "views", "dimensions", `${safeId(dimension)}.json`));
  } else if (["totals", "activity", "heatmap", "filters", "diagnostics", "pricing"].includes(view)) {
    const fileView = view === "heatmap" ? "activity" : view;
    value = await readJson(path.join(outputDir, "views", `${fileView}.json`));
  } else {
    const latest = await readJson(path.join(outputDir, "latest.json"));
    if (latest.schema === LEDGER_SCHEMA && latest.ok === true) value = selectLedgerView(latest, options);
  }
  if (value.schema !== LEDGER_SCHEMA || value.ok !== true) {
    throw coded("usage_snapshot_not_found", "usage ledger snapshot was not found; run a non-snapshot usage scan first");
  }
  const selected = dimension || ["totals", "activity", "heatmap", "filters", "diagnostics", "pricing"].includes(view)
    ? applySnapshotLimit(value, limit)
    : value;
  return markSnapshotCacheHit(selected);
}

export async function writeJsonAtomic(file, value, options = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const body = options.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  await fs.writeFile(tmp, `${body}\n`, "utf8");
  await fs.rename(tmp, file);
}

export async function loadUsageCache(project) {
  const file = usageCachePath(project);
  const cache = await readJson(file);
  if (cache.schema !== "panda-burn.agent-usage-ledger-cache.v1" || cache.parser_version !== PARSER_VERSION || !cache.files || typeof cache.files !== "object") {
    return emptyUsageCache();
  }
  if (!cache.results || typeof cache.results !== "object") cache.results = {};
  if (!cache.file_aggregates || typeof cache.file_aggregates !== "object") cache.file_aggregates = {};
  return cache;
}

export async function writeUsageCache(project, cache) {
  cache.updated_at = new Date().toISOString();
  await writeJsonAtomic(usageCachePath(project), cache, { pretty: false });
}

function emptyUsageCache() {
  return {
    schema: "panda-burn.agent-usage-ledger-cache.v1",
    parser_version: PARSER_VERSION,
    updated_at: "",
    files: {},
    file_aggregates: {},
    results: {},
  };
}

export function usageCachePath(project) {
  return path.join(project, "cache", "index.json");
}

export async function getCachedUsageFile(cache, { project, file, profile, account, stat }) {
  const entry = cache.files[usageCacheKey(file)];
  if (!entry) return null;
  if (entry.parser_version !== PARSER_VERSION) return null;
  if (entry.file !== file) return null;
  if (entry.provider !== profile.provider || entry.profile_id !== profile.id) return null;
  if (entry.account_hash !== account.account_hash) return null;
  if (entry.size !== stat.size || entry.mtime_ms !== stat.mtimeMs) return null;
  if (Array.isArray(entry.events)) return entry;
  const parsed = await readJson(usageFileCachePath(project, usageCacheKey(file)));
  if (!Array.isArray(parsed.events)) return null;
  return {
    ...entry,
    events: parsed.events,
    lines_scanned: parsed.lines_scanned,
    skipped_lines: parsed.skipped_lines,
  };
}

export async function setCachedUsageFile(cache, { project, file, profile, account, stat, parsed }) {
  const key = usageCacheKey(file);
  await writeJsonAtomic(usageFileCachePath(project, key), {
    parser_version: PARSER_VERSION,
    file,
    lines_scanned: parsed.lines_scanned,
    skipped_lines: parsed.skipped_lines,
    events: parsed.events,
  }, { pretty: false });
  cache.files[key] = {
    parser_version: PARSER_VERSION,
    file,
    provider: profile.provider,
    profile_id: profile.id,
    account_hash: account.account_hash,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    lines_scanned: parsed.lines_scanned,
    skipped_lines: parsed.skipped_lines,
    events_count: parsed.events.length,
    cache_path_display: `<burn-home>/${LEDGER_DIR}/cache/files/${key}.json`,
  };
}

export function usageFileAggregateQueryKey(context) {
  return stableHash(JSON.stringify({
    schema: LEDGER_SCHEMA,
    parser_version: PARSER_VERSION,
    pricing_version: PRICING_VERSION,
    from: context.fromMs || 0,
    to: context.toMs || 0,
    timezone: context.timezone,
  }));
}

export async function getCachedUsageFileAggregate(cache, { project, file, profile, account, stat, queryKey }) {
  const key = usageCacheKey(file);
  const indexKey = `${queryKey}:${key}`;
  const entry = cache.file_aggregates?.[indexKey];
  if (!entry) return null;
  if (!isValidUsageFileAggregate(entry, { file, profile, account, stat }, { metadataOnly: true })) return null;
  const aggregate = await readJson(usageFileAggregateCachePath(project, queryKey, key));
  if (!isValidUsageFileAggregate(aggregate, { file, profile, account, stat })) return null;
  return aggregate;
}

export async function setCachedUsageFileAggregate(cache, { project, file, profile, account, stat, queryKey, parsed, fileAggregate }) {
  const key = usageCacheKey(file);
  const indexKey = `${queryKey}:${key}`;
  const aggregate = {
    schema: "panda-burn.agent-usage-file-aggregate.v1",
    parser_version: PARSER_VERSION,
    pricing_version: PRICING_VERSION,
    file,
    provider: profile.provider,
    profile_id: profile.id,
    account_hash: account.account_hash,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    lines_scanned: Number(parsed.lines_scanned || 0),
    skipped_lines: Number(parsed.skipped_lines || 0),
    usage_events: Number(fileAggregate.usage_events || 0),
    duplicate_events: Number(fileAggregate.duplicate_events || 0),
    event_ids: fileAggregate.event_ids || [],
    unknown_model_pricing: fileAggregate.unknown_model_pricing || [],
    warnings: fileAggregate.warnings || [],
    aggregation: fileAggregate.aggregation,
  };
  await writeJsonAtomic(usageFileAggregateCachePath(project, queryKey, key), aggregate, { pretty: false });
  if (!cache.file_aggregates || typeof cache.file_aggregates !== "object") cache.file_aggregates = {};
  cache.file_aggregates[indexKey] = {
    parser_version: PARSER_VERSION,
    pricing_version: PRICING_VERSION,
    file,
    provider: profile.provider,
    profile_id: profile.id,
    account_hash: account.account_hash,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    lines_scanned: aggregate.lines_scanned,
    skipped_lines: aggregate.skipped_lines,
    usage_events: aggregate.usage_events,
    duplicate_events: aggregate.duplicate_events,
    cache_path_display: `<burn-home>/${LEDGER_DIR}/cache/file-aggregates/${queryKey}/${key}.json`,
  };
}

function isValidUsageFileAggregate(value, { file, profile, account, stat }, options = {}) {
  if (!value || typeof value !== "object") return false;
  if (!options.metadataOnly && value.schema !== "panda-burn.agent-usage-file-aggregate.v1") return false;
  if (value.parser_version !== PARSER_VERSION || value.pricing_version !== PRICING_VERSION) return false;
  if (value.file !== file) return false;
  if (value.provider !== profile.provider || value.profile_id !== profile.id) return false;
  if (value.account_hash !== account.account_hash) return false;
  if (value.size !== stat.size || value.mtime_ms !== stat.mtimeMs) return false;
  if (options.metadataOnly) return true;
  if (!value.aggregation || typeof value.aggregation !== "object") return false;
  if (!Array.isArray(value.event_ids)) return false;
  return true;
}

export function usageResultCacheKey({ source, profileIds, excludeProfileIds, from, to, timezone, maxFiles, maxDepth, dimensionLimit, profiles }) {
  const fileSignatures = [];
  for (const { profile, account, files } of profiles) {
    for (const { file, stat } of files) {
      fileSignatures.push({
        profile_id: profile.id,
        provider: profile.provider,
        account_hash: account.account_hash,
        file,
        size: stat.size,
        mtime_ms: stat.mtimeMs,
      });
    }
  }
  fileSignatures.sort((a, b) => `${a.profile_id}:${a.file}`.localeCompare(`${b.profile_id}:${b.file}`));
  return stableHash(JSON.stringify({
    schema: LEDGER_SCHEMA,
    parser_version: PARSER_VERSION,
    pricing_version: PRICING_VERSION,
    source: source || "",
    profile_ids: profileIds,
    exclude_profile_ids: excludeProfileIds,
    from,
    to,
    timezone,
    max_files: maxFiles,
    max_depth: maxDepth,
    dimension_limit: dimensionLimit,
    files: fileSignatures,
  }));
}

export async function getCachedUsageResult(cache, project, key) {
  const entry = cache.results?.[key];
  if (!entry || entry.parser_version !== PARSER_VERSION || entry.pricing_version !== PRICING_VERSION) return null;
  const resultPath = usageResultCachePath(project, key);
  const result = await readJson(resultPath);
  if (result.schema !== LEDGER_SCHEMA || result.ok !== true) return null;
  return markResultCacheHit(result);
}

export async function setCachedUsageResult(cache, project, key, result) {
  if (!cache.results || typeof cache.results !== "object") cache.results = {};
  await writeJsonAtomic(usageResultCachePath(project, key), result, { pretty: false });
  cache.results[key] = {
    parser_version: PARSER_VERSION,
    pricing_version: PRICING_VERSION,
    cached_at: new Date().toISOString(),
    run_id: result.run_id,
    result_path_display: `<burn-home>/${LEDGER_DIR}/cache/results/${key}.json`,
  };
  pruneCachedUsageResults(cache);
}

function pruneCachedUsageResults(cache) {
  const entries = Object.entries(cache.results || {});
  if (entries.length <= 16) return;
  entries
    .sort((a, b) => String(b[1]?.cached_at || "").localeCompare(String(a[1]?.cached_at || "")))
    .slice(16)
    .forEach(([key]) => { delete cache.results[key]; });
}

function usageResultCachePath(project, key) {
  return path.join(project, "cache", "results", `${key}.json`);
}

function markResultCacheHit(result) {
  const copy = JSON.parse(JSON.stringify(result));
  copy.served_from_cache = true;
  copy.cache_hit_kind = "result";
  copy.diagnostics = {
    ...(copy.diagnostics || {}),
    result_cache_hit: true,
    cache: {
      ...(copy.diagnostics?.cache || {}),
      result_hit: true,
    },
  };
  return copy;
}

function markSnapshotCacheHit(result) {
  const copy = JSON.parse(JSON.stringify(result));
  copy.served_from_cache = true;
  copy.cache_hit_kind = "snapshot";
  copy.snapshot = {
    source: "local_burn_usage_ledger_views",
    active_scan: false,
  };
  return copy;
}

function applySnapshotLimit(value, limit) {
  if (!limit) return value;
  if (Array.isArray(value.rows)) return { ...value, rows: value.rows.slice(0, limit) };
  return value;
}

function usageCacheKey(file) {
  return stableHash(file);
}

function usageFileCachePath(project, key) {
  return path.join(project, "cache", "files", `${key}.json`);
}

function usageFileAggregateCachePath(project, queryKey, fileKey) {
  return path.join(project, "cache", "file-aggregates", queryKey, `${fileKey}.json`);
}

export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

export async function firstReadableJson(files) {
  for (const file of files) {
    const value = await readJson(file);
    if (Object.keys(value).length) return value;
  }
  return {};
}

export async function jsonFilesRecursive(root, out = [], depth = 0, maxDepth = 32) {
  if (!root || depth > maxDepth) return out;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await jsonFilesRecursive(full, out, depth + 1, maxDepth);
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
  }
  return out;
}

export async function pathSize(target) {
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) total += await pathSize(path.join(target, entry.name));
  return total;
}

export async function fileSize(file) {
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() ? stat.size : 0;
}

function positiveLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
