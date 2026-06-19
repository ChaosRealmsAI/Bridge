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
// Tune/disable via BURN_SNAPSHOT_SCAN_TTL_MS (default 5000, 0 disables).
const SCAN_TTL_MS = Math.max(0, Number(process.env.BURN_SNAPSHOT_SCAN_TTL_MS ?? 5000) || 0);
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

export async function buildSnapshot(context, input = {}) {
  const requestedLimit = Number(input.sessions_limit || input.max_sessions_per_project || input.limit || DEFAULT_SESSIONS_LIMIT);
  const sessionsLimit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_SESSIONS_LIMIT, MAX_SESSIONS_LIMIT));
  const sessionsCursor = Math.max(0, Math.floor(Number(input.sessions_cursor || input.cursor || 0) || 0));
  const authorizedRoots = await snapshotAuthorizedRoots(context);
  const scanKey = `scan:${context.cli}\n${context.root}`;
  const report = await cachedScan(scanKey, () => runBurnSessionsList(context.cli, context.root));
  const profileDiscovery = await cachedScan(`profiles:${context.cli}\n${context.root}`, () => runAgentProfileDiscover(context));
  const generatedAt = report.generated_at || new Date().toISOString();
  const snapshotId = cleanText(input.snapshot_id || `snap_${sha256(`${context.root}\n${generatedAt}`).slice(0, 16)}`);
  const projectRows = await mergeProfileProjectRows(
    context,
    Array.isArray(report.by_project) ? report.by_project : [],
    profileDiscovery,
    sessionsLimit,
    input,
  );
  const projects = [];
  const byProject = [];
  const running = [];
  const agentCounts = { claude: 0, codex: 0 };

  for (const row of projectRows) {
    const rawPath = String(row.path || row.cwd || row.project || "");
    const candidatePath = rawPath || resolve(projectName(row.name || "project"));
    const realProjectPath = await safeRealpath(candidatePath);
    if (authorizedRoots.length && (!realProjectPath || !isWithinAuthorizedRoots(realProjectPath, authorizedRoots))) continue;
    const path = realProjectPath || candidatePath;
    const projectId = projectIdFromPath(path);
    const sortedSessions = dedupeSessionRows((Array.isArray(row.sessions) ? row.sessions : []).slice().sort(compareSession));
    const page = pageItems(sortedSessions, sessionsCursor, sessionsLimit, "sessions", MAX_SESSIONS_LIMIT);
    const sessions = page.items.map((session) => normalizeSession(session, row, projectId));
    const runningCount = sessions.filter((session) => session.running).length;
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
    const updatedAt = sessions[0]?.updated_at || row.updated_at || row.last_activity || null;
    projects.push({
      id: projectId,
      name: projectName(row.name || path),
      path,
      path_display: displayPath(path),
      session_count: Number(row.total || sortedSessions.length || 0),
      running_count: Number(row.running || runningCount || 0),
      last_activity_at: updatedAt,
      last_activity_label: lastActivityLabel(updatedAt),
      session_page: page.page,
    });
    byProject.push({
      id: projectId,
      name: projectName(row.name || path),
      path,
      path_display: displayPath(path),
      total: Number(row.total || sortedSessions.length || 0),
      running: Number(row.running || runningCount || 0),
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

  return withPayloadBytes({
    generated_at: generatedAt,
    snapshot_id: snapshotId,
    running_total: running.length,
    running_total_all: authorizedRoots.length ? running.length : Number(report.running_total || running.length || 0),
    agent_counts: agentCounts,
    running,
    projects,
    by_project: byProject,
    scanned: report.scanned || null,
    skipped: report.skipped || null,
    agent_profiles: profileDiscovery ? publicProfileDiscovery(profileDiscovery) : null,
    sections: {
      sessions: {
        section: "sessions",
        cursor: sessionsCursor,
        limit: sessionsLimit,
        next_cursor: byProject.some((project) => project.session_page?.has_more) ? sessionsCursor + sessionsLimit : null,
        has_more: byProject.some((project) => project.session_page?.has_more),
        end_of_list: byProject.every((project) => project.session_page?.end_of_list !== false),
        page_error_code: "",
        dedupe_count: 0,
        payload_bytes: Buffer.byteLength(JSON.stringify(byProject.flatMap((project) => project.sessions || [])), "utf8"),
      },
    },
  });
}

async function runBurnSessionsList(cli, workdir) {
  const stdout = await execCommand(cli, ["sessions", "list", "--json"], { cwd: workdir, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
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
    const key = [
      String(session.agent || session.source || "").toLowerCase(),
      String(session.id || session.session_id || session.raw_id || ""),
      String(session.transcript_path || session.path || ""),
    ].join("|");
    const existing = byKey.get(key);
    if (!existing || (!existing.profile_id && session.profile_id)) byKey.set(key, session);
  }
  return [...byKey.values()].sort(compareSession);
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

async function snapshotAuthorizedRoots(context) {
  const explicitRoots = await resolveAuthorizedRoots(authorizedProjectRoots(context));
  if (explicitRoots.length) return explicitRoots;
  const fallbackRoot = await safeRealpath(context.root);
  return fallbackRoot ? [fallbackRoot] : [];
}

function projectIdFromPath(path) {
  return `proj_${sha256(path).slice(0, 16)}`;
}

function sessionIdFromParts(agent, rawId, transcript) {
  return `sess_${sha256(`${agent}\n${rawId}\n${transcript}`).slice(0, 24)}`;
}
