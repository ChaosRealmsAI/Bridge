import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { execCommand } from "./cli.mjs";
import { authorizedProjectRoots, isWithinAuthorizedRoots, resolveAuthorizedRoots, safeRealpath } from "./path-policy.mjs";
import { cleanText, displayPath, lastActivityLabel, pageItems, projectName, sha256, withPayloadBytes } from "./utils.mjs";

// Short-TTL cache for the expensive read-only monitor scan (`burn sessions
// list`, ~6-10s walking thousands of ~/.codex + ~/.claude transcript files) and
// the profile discovery probe. Repeated snapshot.get calls (home re-visits, the
// sessions() transcript fallback) within the window reuse one scan instead of
// re-walking the whole HOME tree. Read-only: this never touches chat runtime.
// Pagination/auth shaping still runs fresh per request, so params are honored.
// Tune/disable via BURN_SNAPSHOT_SCAN_TTL_MS (default 60000, 0 disables).
// The full all-history scan walks every local Codex/Claude transcript root.
// Keep a warm result long enough for Projects/Monitor/Usage/Session fallback
// to share it during one user refresh instead of re-walking HOME repeatedly.
const SCAN_TTL_MS = Math.max(0, Number(process.env.BURN_SNAPSHOT_SCAN_TTL_MS ?? 60000) || 0);
const SCAN_TIMEOUT_MS = Math.max(30000, Number(process.env.BURN_SNAPSHOT_SCAN_TIMEOUT_MS ?? 180000) || 180000);
const scanCache = new Map();

function readScanCache(key) {
  if (SCAN_TTL_MS <= 0) return null;
  const entry = scanCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > SCAN_TTL_MS) {
    scanCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeScanCache(key, value) {
  if (SCAN_TTL_MS <= 0) return;
  scanCache.set(key, { at: Date.now(), value });
}

async function cachedScan(key, produce) {
  const hit = readScanCache(key);
  if (hit !== null) return hit;
  // Coalesce concurrent callers onto one in-flight scan.
  const inflightKey = `inflight:${key}`;
  if (scanCache.has(inflightKey)) {
    try {
      return await scanCache.get(inflightKey);
    } catch {
      // fall through and re-run below if the shared scan failed
    }
  }
  const promise = (async () => produce())();
  scanCache.set(inflightKey, promise);
  try {
    const value = await promise;
    writeScanCache(key, value);
    return value;
  } finally {
    scanCache.delete(inflightKey);
  }
}

// Per-project session page size. The old default (80) capped every project's
// list at 80 even when thousands of transcripts existed across accounts — the
// "only 94 shown" bug. Default raised to 500 so a normal project shows its real
// list in one page; MAX 2000 lets a focused single-project request pull the full
// history. Per-project `next_cursor` still drives load-more for larger projects,
// so we never have to slam every project's full list into one payload.
const DEFAULT_SESSIONS_LIMIT = Math.max(1, Number(process.env.BURN_SNAPSHOT_SESSIONS_LIMIT || 500) || 500);
const MAX_SESSIONS_LIMIT = Math.max(DEFAULT_SESSIONS_LIMIT, Number(process.env.BURN_SNAPSHOT_SESSIONS_MAX || 2000) || 2000);

// 真实加载进度:首页/监控扫描时,把「扫描中 → 汇总(N 账号 · N 项目)」作为进度信封吐给手机。
// best-effort:没有 emitProgress(非流式调用)或出错都静默,绝不影响 snapshot 本身。
async function emitSnapshotProgress(context, data) {
  if (!context || typeof context.emitProgress !== "function") return;
  try {
    await context.emitProgress({
      ok: true,
      version: "burn-relay-v1",
      type: "burn.snapshot.get",
      request_id: null,
      progress: true,
      schema: "burn.snapshot.progress.v1",
      data,
    });
  } catch {
    // progress is best-effort
  }
}

export async function buildSnapshot(context, input = {}) {
  const requestedLimit = Number(input.sessions_limit || input.max_sessions_per_project || input.limit || DEFAULT_SESSIONS_LIMIT);
  const sessionsLimit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_SESSIONS_LIMIT, MAX_SESSIONS_LIMIT));
  const sessionsCursor = Math.max(0, Math.floor(Number(input.sessions_cursor || input.cursor || 0) || 0));
  const scanScope = normalizeScanScope(input.scan_scope || input.scanScope || input.scope || "all-history");
  const rootFilter = await snapshotAuthorizedRoots(context, input, scanScope);
  const authorizedRoots = rootFilter.roots;
  const scanKey = [
    "scan",
    scanScope.value,
    context.cli,
    context.root,
    process.env.CODEX_HOME || "",
    process.env.CLAUDE_CONFIG_DIR || "",
    process.env.BURN_AGENT_PROFILE_ID || "",
  ].join("\n");
  await emitSnapshotProgress(context, { phase: "scan", scanned: 0, total: 0 });
  const report = await cachedScan(scanKey, () => runBurnSessionsList(context.cli, context.root, scanScope.cli));
  const profileDiscovery = await cachedScan(`profiles:${context.cli}\n${context.root}`, () => runAgentProfileDiscover(context));
  const accounts = Array.isArray(profileDiscovery?.profiles) ? profileDiscovery.profiles.length : 0;
  const generatedAt = report.generated_at || new Date().toISOString();
  const snapshotId = cleanText(input.snapshot_id || `snap_${sha256(`${context.root}\n${generatedAt}`).slice(0, 16)}`);
  const projectRows = await mergeProfileProjectRows(
    context,
    Array.isArray(report.by_project) ? report.by_project : [],
    profileDiscovery,
    sessionsLimit,
    input,
  );
  await emitSnapshotProgress(context, { phase: "aggregate", accounts, projects: projectRows.length });
  const projects = [];
  const byProject = [];
  const running = [];
  const agentCounts = { claude: 0, codex: 0 };
  let rawSessionRows = 0;
  let dedupedSessionRows = 0;

  for (const row of projectRows) {
    const rawPath = String(row.path || row.cwd || row.project || "");
    const candidatePath = rawPath || resolve(projectName(row.name || "project"));
    const realProjectPath = await safeRealpath(candidatePath);
    const comparableProjectPath = realProjectPath || resolve(candidatePath);
    if (authorizedRoots.length && (!comparableProjectPath || !isWithinAuthorizedRoots(comparableProjectPath, authorizedRoots))) continue;
    const path = realProjectPath || candidatePath;
    const projectId = projectIdFromPath(path);
    const rawSessions = (Array.isArray(row.sessions) ? row.sessions : []).slice().sort(compareSession);
    const sortedSessions = dedupeSessionRows(rawSessions);
    rawSessionRows += rawSessions.length;
    dedupedSessionRows += sortedSessions.length;
    const page = pageItems(sortedSessions, sessionsCursor, sessionsLimit, "sessions", MAX_SESSIONS_LIMIT);
    page.page.dedupe_count = Math.max(0, rawSessions.length - sortedSessions.length);
    const sessions = page.items.map((session) => normalizeSession(session, row, projectId));
    const runningCount = sortedSessions.filter((session) => Boolean(session.running)).length;
    for (const session of sessions) {
      agentCounts[session.agent] = (agentCounts[session.agent] || 0) + 1;
      if (session.running) running.push({
        id: session.id,
        title: session.title,
        project_id: projectId,
        project_name: projectName(row.name || path),
        agent: session.agent,
        profile_id: session.profile_id,
        profile_label: session.profile_label,
        profile_path_display: session.profile_path_display,
        updated_at: session.updated_at,
        last_activity_label: session.last_activity_label,
        preview: session.preview,
      });
    }
    const latestSession = sortedSessions[0] || null;
    const updatedAt = latestSession?.updated_at || latestSession?.last_activity || latestSession?.timestamp || latestSession?.mtime || row.updated_at || row.last_activity || null;
    const sessionTotal = sortedSessions.length;
    projects.push({
      id: projectId,
      name: projectName(row.name || path),
      path,
      path_display: displayPath(path),
      session_count: sessionTotal,
      running_count: runningCount,
      last_activity_at: updatedAt,
      last_activity_label: lastActivityLabel(updatedAt),
      session_page: page.page,
    });
    byProject.push({
      id: projectId,
      name: projectName(row.name || path),
      path,
      path_display: displayPath(path),
      total: sessionTotal,
      running: runningCount,
      sessions,
      session_page: page.page,
      next_cursor: page.page.next_cursor,
      end_of_list: page.page.end_of_list,
    });
  }

  projects.sort((a, b) => Number(b.running_count > 0) - Number(a.running_count > 0)
    || Date.parse(b.last_activity_at || 0) - Date.parse(a.last_activity_at || 0)
    || a.name.localeCompare(b.name));
  byProject.sort((a, b) => projects.findIndex((p) => p.id === a.id) - projects.findIndex((p) => p.id === b.id));
  running.sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0));
  const sessionsSection = {
    section: "sessions",
    cursor: sessionsCursor,
    limit: sessionsLimit,
    next_cursor: byProject.some((project) => project.session_page?.has_more) ? sessionsCursor + sessionsLimit : null,
    has_more: byProject.some((project) => project.session_page?.has_more),
    end_of_list: byProject.every((project) => project.session_page?.end_of_list !== false),
    page_error_code: "",
    dedupe_count: Math.max(0, rawSessionRows - dedupedSessionRows),
    payload_bytes: Buffer.byteLength(JSON.stringify(byProject.flatMap((project) => project.sessions || [])), "utf8"),
  };

  return withPayloadBytes({
    generated_at: generatedAt,
    snapshot_id: snapshotId,
    running_total: running.length,
    running_total_all: authorizedRoots.length ? running.length : Number(report.running_total || running.length || 0),
    agent_counts: agentCounts,
    running,
    projects,
    by_project: byProject,
    scanned: Number(report.totals?.scanned || report.scanned || 0) || null,
    skipped: Number(report.totals?.skipped || report.skipped || 0) || null,
    scan: normalizedScanReport(report, scanScope, projects, byProject, sessionsSection, rootFilter.applied),
    agent_profiles: profileDiscovery ? publicProfileDiscovery(profileDiscovery) : null,
    sections: {
      sessions: sessionsSection,
    },
  });
}

async function runBurnSessionsList(cli, workdir, scanScope) {
  const stdout = await execCommand(cli, ["sessions", "list", "--scope", scanScope, "--json"], { cwd: workdir, timeout: SCAN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function normalizeScanScope(raw) {
  const value = cleanText(raw).toLowerCase().replace(/_/g, "-");
  if (!value || value === "all" || value === "all-history" || value === "history") {
    return { value: "all_history", cli: "all-history" };
  }
  if (value === "configured" || value === "active" || value === "profile") {
    return { value: "configured", cli: "configured" };
  }
  const error = new Error(`invalid scan_scope: ${raw}`);
  error.code = "invalid_scan_scope";
  throw error;
}

function normalizedScanReport(report, scanScope, projects, byProject, sessionsSection, authorizedFilterApplied = false) {
  const diagnostics = report && typeof report.diagnostics === "object" ? report.diagnostics : {};
  const totals = report && typeof report.totals === "object" ? report.totals : {};
  const sourceRoots = Array.isArray(diagnostics.source_roots) ? diagnostics.source_roots.map(cleanText).filter(Boolean) : [];
  const errors = scanErrors(diagnostics);
  return {
    schema: "burn.snapshot.scan.v1",
    requested_scope: scanScope.value,
    scope: cleanText(report?.scan_scope || diagnostics.scope) || scanScope.value,
    source_roots: sourceRoots,
    counts: {
      projects: Number(totals.projects || report?.by_project?.length || 0),
      sessions: Number(totals.sessions || 0),
      running: Number(totals.running || report?.running_total || 0),
      scanned: Number(totals.scanned || report?.scanned || 0),
      valid: Number(totals.valid || 0),
      skipped: Number(totals.skipped || report?.skipped || 0),
      returned_projects: projects.length,
      returned_sessions: byProject.reduce((sum, project) => sum + (Array.isArray(project.sessions) ? project.sessions.length : 0), 0),
    },
    diagnostics: {
      mode: cleanText(diagnostics.mode),
      elapsed_ms: Number(diagnostics.elapsed_ms || 0),
      cache: diagnostics.cache || null,
      limits: diagnostics.limits || null,
    },
    partial: Boolean(diagnostics.partial || errors.length),
    errors,
    page: {
      projects: {
        returned: projects.length,
        total: Number(totals.projects || report?.by_project?.length || 0),
        authorized_filter_applied: Boolean(authorizedFilterApplied),
      },
      sessions: sessionsSection,
    },
  };
}

function scanErrors(diagnostics) {
  const errors = Array.isArray(diagnostics?.errors) ? diagnostics.errors.map(cleanText).filter(Boolean) : [];
  for (const [code, message] of [
    ["cache_read_error", diagnostics?.cache?.read_error],
    ["cache_write_error", diagnostics?.cache?.write_error],
  ]) {
    const text = cleanText(message);
    if (text) errors.push(`${code}: ${text}`);
  }
  return errors;
}

async function runAgentProfileDiscover(context) {
  try {
    const stdout = await execCommand(context.cli, ["agent", "profile", "discover", "--quick", "--json"], {
      cwd: context.root,
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function mergeProfileProjectRows(context, rows, discovery, sessionsLimit, input) {
  const rowList = Array.isArray(rows) ? rows.slice() : [];
  if (input.include_profile_sessions !== true && input.includeProfileSessions !== true) return rowList;
  const projects = knownProjectPaths(context, rowList, input);
  const profiles = Array.isArray(discovery?.profiles)
    ? discovery.profiles.filter((profile) => profile.usable && (profile.source === "codex" || profile.source === "claude"))
    : [];
  const profileRows = [];
  const maxProfiles = Math.max(1, Math.min(Number(input.profile_limit || 16) || 16, 32));
  const probes = profiles.slice(0, maxProfiles).flatMap((profile) =>
    projects.map((project) => ({ profile, project })),
  );
  const results = await Promise.all(probes.map(async ({ profile, project }) => ({
    profile,
    project,
    payload: await runProfileSessionsList(context, profile, project, sessionsLimit),
  })));
  for (const { profile, project, payload } of results) {
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      if (!sessions.length) continue;
      profileRows.push({
        path: project,
        project,
        name: projectName(project),
        total: sessions.length,
        running: sessions.filter((session) => session.running).length,
        sessions: sessions.map((session) => normalizeProfileSession(session, profile, project)),
      });
  }
  return mergeProjectRows([...profileRows, ...rowList]);
}

async function runProfileSessionsList(context, profile, project, sessionsLimit) {
  try {
    const stdout = await execCommand(context.cli, [
      "agent",
      "source",
      "sessions",
      "list",
      "--source",
      profile.source,
      "--project",
      project,
      "--profile-id",
      profile.id,
      "--limit",
      String(Math.max(1, Math.min(sessionsLimit, 200))),
      "--json",
    ], {
      cwd: project,
      timeout: 12000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function knownProjectPaths(context, rows, input) {
  const seen = new Set();
  const out = [];
  function add(value) {
    const text = cleanText(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push(text);
  }
  add(input.project || input.project_path || input.cwd);
  add(context.root);
  for (const row of rows) add(row.path || row.cwd || row.project);
  return out.slice(0, Math.max(1, Math.min(Number(input.profile_project_limit || 24) || 24, 100)));
}

function mergeProjectRows(rows) {
  const byPath = new Map();
  for (const row of rows) {
    const key = cleanText(row.path || row.cwd || row.project || row.name);
    if (!key) continue;
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, { ...row, sessions: Array.isArray(row.sessions) ? row.sessions.slice() : [] });
      continue;
    }
    existing.sessions.push(...(Array.isArray(row.sessions) ? row.sessions : []));
    existing.total = Math.max(Number(existing.total || 0), existing.sessions.length);
    existing.running = existing.sessions.filter((session) => session.running).length;
  }
  return [...byPath.values()];
}

function normalizeProfileSession(session, profile, project) {
  return {
    id: session.id || session.session_id,
    raw_id: session.id || session.session_id,
    agent: session.source || profile.source,
    project,
    cwd: session.project || project,
    title: session.title,
    started_at: session.started_at,
    last_activity: session.last_activity,
    updated_at: session.updated_at || session.last_activity,
    running: Boolean(session.running),
    status: session.status,
    transcript_path: session.transcript_path,
    last_message_preview: session.last_message_preview || session.preview,
    provider: session.provider,
    profile_id: profile.id,
    profile_label: profile.label,
    profile_path_display: profile.path_display,
    profile_runtime: profile.runtime,
  };
}

export async function listRootEntries(root) {
  const names = (await readdir(root)).filter((name) => !name.startsWith(".")).slice(0, 80);
  return Promise.all(names.map(async (name) => {
    const item = await stat(resolve(root, name));
    return { name, type: item.isDirectory() ? "dir" : "file" };
  }));
}

function normalizeSession(session, project, projectId) {
  const agent = String(session.agent || "claude").toLowerCase() === "codex" ? "codex" : "claude";
  const rawId = String(session.id || session.session_id || session.transcript_path || `${agent}-${session.updated_at || ""}`);
  const transcript = String(session.transcript_path || session.path || "");
  const updatedAt = session.updated_at || session.last_activity || session.timestamp || session.mtime || null;
  const title = cleanText(session.title) || cleanText(session.first_user_message) || cleanText(session.last_message_preview) || "(会话)";
  const preview = cleanText(session.last_message_preview) || cleanText(session.preview) || title;
  return {
    id: sessionIdFromParts(agent, rawId, transcript),
    raw_id: rawId,
    agent,
    project_id: projectId,
    project_name: projectName(project.name || project.path || ""),
    cwd: String(session.cwd || project.path || ""),
    title,
    preview,
    updated_at: updatedAt,
    last_activity_label: lastActivityLabel(updatedAt),
    running: Boolean(session.running),
    transcript_path: transcript ? displayPath(transcript) : "",
    profile_id: cleanText(session.profile_id || session.profileId),
    profile_label: cleanText(session.profile_label || session.profileLabel),
    profile_path_display: cleanText(session.profile_path_display || session.profilePathDisplay),
    profile_runtime: cleanText(session.profile_runtime || session.profileRuntime),
  };
}

function dedupeSessionRows(sessions) {
  const byKey = new Map();
  for (const session of sessions) {
    const agent = String(session.agent || session.source || "").toLowerCase();
    const rawId = cleanText(session.id || session.session_id || session.raw_id);
    const transcript = cleanText(session.transcript_path || session.path);
    const fallback = cleanText(`${session.title || session.last_message_preview || ""}|${session.updated_at || session.last_activity || session.timestamp || ""}`);
    const profile = cleanText(session.profile_id || session.profileId);
    const key = rawId
      ? `${agent}|session|${rawId}|${transcript || profile || fallback}`
      : `${agent}|path|${transcript || fallback}`;
    const existing = byKey.get(key);
    if (!existing || sessionCompletenessScore(session) > sessionCompletenessScore(existing)) byKey.set(key, session);
  }
  return [...byKey.values()].sort(compareSession);
}

function sessionCompletenessScore(session) {
  return [
    session.profile_id,
    session.profile_label,
    session.profile_path_display,
    session.transcript_path || session.path,
    session.title,
    session.last_message_preview || session.preview,
    session.updated_at || session.last_activity,
    session.running,
  ].filter(Boolean).length;
}

function publicProfileDiscovery(discovery) {
  return {
    schema: discovery.schema,
    generated_at: discovery.generated_at,
    counts: discovery.counts,
    runtimes: discovery.runtimes,
    profiles: Array.isArray(discovery.profiles) ? discovery.profiles.map((profile) => ({
      id: profile.id,
      source: profile.source,
      label: profile.label,
      path_display: profile.path_display,
      runtime: profile.runtime,
      command: profile.command,
      command_available: Boolean(profile.command_available),
      usable: Boolean(profile.usable),
      auth_hint_present: Boolean(profile.auth_hint_present),
      history: {
        session_count: Number(profile.history?.session_count || 0),
        session_count_capped: Boolean(profile.history?.session_count_capped),
        store_paths: Array.isArray(profile.history?.store_paths) ? profile.history.store_paths : [],
        store_hash: cleanText(profile.history?.store_hash),
      },
    })) : [],
  };
}

function compareSession(a, b) {
  return Number(Boolean(b.running)) - Number(Boolean(a.running))
    || Date.parse(b.updated_at || b.last_activity || b.timestamp || b.mtime || 0) - Date.parse(a.updated_at || a.last_activity || a.timestamp || a.mtime || 0);
}

async function snapshotAuthorizedRoots(context, input = {}, scanScope = { value: "all_history" }) {
  // Default snapshot.get is the phone's read-only AI history catalog:
  // show every local Codex/Claude transcript/project that exists. Product
  // authorization roots still protect write/project commands, but they must not
  // clip the all-history catalog or the phone cannot satisfy the "all accounts,
  // all projects, all sessions" acceptance gate. Tests/smokes that need the old
  // root-scoped behavior opt in explicitly.
  const forceFilter = input.filter_authorized_roots === true
    || input.filterAuthorizedRoots === true
    || input.root_scoped === true
    || input.rootScoped === true
    || cleanText(input.catalog_scope || input.catalogScope) === "authorized";
  if (!forceFilter && scanScope.value === "all_history") {
    return { roots: [], applied: false };
  }
  const explicitRoots = await resolveAuthorizedRoots(authorizedProjectRoots(context));
  if (explicitRoots.length) return { roots: explicitRoots, applied: true };
  if (forceFilter) {
    const fallbackRoots = await resolveAuthorizedRoots([context.root]);
    return { roots: fallbackRoots, applied: fallbackRoots.length > 0 };
  }
  return { roots: [], applied: false };
}

function projectIdFromPath(path) {
  return `proj_${sha256(path).slice(0, 16)}`;
}

function sessionIdFromParts(agent, rawId, transcript) {
  return `sess_${sha256(`${agent}\n${rawId}\n${transcript}`).slice(0, 24)}`;
}
