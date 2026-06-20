import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { defaultBurnHome } from "../burn-store-lib.mjs";
import { displayPath, safeStat } from "../project/fs-utils.mjs";
import { gitSnapshot } from "../project/git-utils.mjs";
import { lastActivityLabel } from "../project/format.mjs";
import {
  BURN_BUSINESS_SCHEMA,
  assertSafeUserPath,
  boolOrCurrent,
  cleanText,
  codedError,
  compareProjects,
  normalizeProjectKind,
  nowIso,
  pageItems,
  projectId,
  slugify,
  withPayloadBytes,
} from "./common.mjs";
import {
  emitBurnEvent,
  ensureBurnBusinessStore,
  readPreferences,
  readProjectIndex,
  writePreferences,
  writeProjectIndex,
} from "./store.mjs";
import { discoverBurnProjectRows, mergeProjectRecord } from "./project-catalog.mjs";
import { canonicalAuthorizedRoots, canonicalPath, mergeDiscoveryTraces, projectAllowed } from "./project-auth.mjs";

export async function listBurnProjects(options = {}) {
  const startedAt = Date.now();
  const { home } = await ensureBurnBusinessStore(options);
  const root = await canonicalPath(options.root || process.cwd()).catch(() => path.resolve(options.root || process.cwd()));
  const authorizedRoots = await canonicalAuthorizedRoots(options.authorizedRoots);
  const scanRoots = authorizedRoots.length ? authorizedRoots : [root];
  const index = await readProjectIndex(home);
  const prefs = await readPreferences(home, "projects");
  const rows = new Map();
  const addRow = async (project) => {
    const normalizedProject = await normalizeProjectForAuthorizedRoots(project, authorizedRoots);
    if (!normalizedProject) return;
    const id = normalizedProject.id || projectId(normalizedProject.path || normalizedProject.name);
    rows.set(id, mergeProjectRecord(rows.get(id), { ...normalizedProject, id }));
  };
  const traces = [];
  for (const scanRoot of scanRoots) {
    const discovered = await discoverBurnProjectRows(scanRoot, options);
    traces.push(discovered.trace);
    for (const project of discovered.rows) await addRow(project);
    await addRow(implicitProject(scanRoot, "adapter_root"));
  }
  for (const project of index.projects || []) await addRow(project);
  const sortableRows = [...rows.values()].map((project) => ({
    ...project,
    pinned: Boolean(prefs.projects?.[project.id]?.pinned || project.pinned),
    favorite: Boolean(prefs.projects?.[project.id]?.favorite || project.favorite),
  }));
  const page = pageItems(sortableRows.sort(compareProjects), options.cursor, options.limit, "projects");
  const pageDecorated = await Promise.all(page.items.map((project) => decorateProject(project, prefs, home)));
  return withPayloadBytes({
    ok: true,
    kind: "burn-project-list",
    schema: BURN_BUSINESS_SCHEMA,
    storage_scope: "device_app_home",
    app_home_display: "[local]/burn",
    projects: pageDecorated,
    page: page.page,
    trace: { generated_at: nowIso(), adapter_ms: Date.now() - startedAt, partial: page.page.has_more, indexed_count: (index.projects || []).length, ...mergeDiscoveryTraces(traces), authorized_root_count: authorizedRoots.length, total_count: rows.size },
  });
}

export async function createBurnProject(input = {}, options = {}) {
  const { home } = await ensureBurnBusinessStore(options);
  const kind = normalizeProjectKind(input.kind || input.project_kind || input.projectKind || input.type);
  const name = cleanText(input.name || input.title || "New project").slice(0, 80) || "New project";
  const createdAt = nowIso();
  let projectPath;
  let source;
  if (kind === "burn_public") {
    const slug = await uniqueProjectSlug(path.join(home, "projects", "public"), slugify(name));
    projectPath = path.join(home, "projects", "public", slug);
    source = "burn_public";
  } else {
    projectPath = await resolveUserProjectTarget(input, options.root || process.cwd(), home, name, options.authorizedRoots);
    source = "user_directory";
  }
  await fs.mkdir(projectPath, { recursive: true });
  const canonical = await canonicalPath(projectPath);
  const index = await readProjectIndex(home);
  const id = projectId(canonical);
  const existingIndex = (index.projects || []).findIndex((item) => item.id === id || item.path === canonical);
  const record = { id, name, kind, source, path: canonical, path_display: displayPath(canonical), created_at: createdAt, updated_at: createdAt };
  if (existingIndex >= 0) index.projects[existingIndex] = { ...index.projects[existingIndex], ...record, created_at: index.projects[existingIndex].created_at || createdAt };
  else index.projects.unshift(record);
  await writeProjectIndex(home, index);
  const project = await decorateProject(record, await readPreferences(home, "projects"), home);
  await emitBurnEvent(home, { streamId: "burn:projects", project: "burn-app", entityType: "project", entityId: id, op: "upsert", payload: project });
  return { ok: true, kind: "burn-project-created", project };
}

export async function setBurnProjectPreference(input = {}, options = {}) {
  const { home } = await ensureBurnBusinessStore(options);
  const project = await resolveProjectRef(input, { home, root: options.root, authorizedRoots: options.authorizedRoots });
  const prefs = await readPreferences(home, "projects");
  const current = prefs.projects[project.id] || {};
  const next = { ...current, pinned: boolOrCurrent(input.pinned, current.pinned), favorite: boolOrCurrent(input.favorite, current.favorite), updated_at: nowIso() };
  prefs.projects[project.id] = next;
  await writePreferences(home, "projects", prefs);
  const payload = { id: project.id, project_id: project.id, project_path: project.path, ...next };
  await emitBurnEvent(home, { streamId: "burn:project-preferences", project: "burn-app", entityType: "project.preference", entityId: project.id, op: "upsert", payload });
  return { ok: true, kind: "burn-project-preference", preference: payload };
}

export async function setBurnSessionPreference(input = {}, options = {}) {
  const { home } = await ensureBurnBusinessStore(options);
  const sessionId = cleanText(input.session_id || input.sessionId || input.id || input.raw_id || input.rawId);
  if (!sessionId) throw codedError("missing_session_id", "missing session_id");
  const prefs = await readPreferences(home, "sessions");
  const current = prefs.sessions[sessionId] || {};
  const next = { ...current, pinned: boolOrCurrent(input.pinned, current.pinned), favorite: boolOrCurrent(input.favorite, current.favorite), project: cleanText(input.project || input.project_path || input.projectPath || current.project || ""), updated_at: nowIso() };
  prefs.sessions[sessionId] = next;
  await writePreferences(home, "sessions", prefs);
  const payload = { id: sessionId, session_id: sessionId, ...next };
  await emitBurnEvent(home, { streamId: "burn:session-preferences", project: "burn-app", entityType: "session.preference", entityId: sessionId, op: "upsert", payload });
  return { ok: true, kind: "burn-session-preference", preference: payload };
}

export async function monitorBurnSessions(input = {}, options = {}) {
  const { home } = await ensureBurnBusinessStore(options);
  const snapshot = input.snapshot && typeof input.snapshot === "object" ? input.snapshot : { by_project: [], running: [], projects: [] };
  const sessionPrefs = await readPreferences(home, "sessions");
  const projectPrefs = await readPreferences(home, "projects");
  const listedProjects = await listAllBurnProjects({ ...input, home, root: options.root, authorizedRoots: options.authorizedRoots });
  const projectRows = await filterAuthorizedProjectRows(
    mergeSnapshotProjects(listedProjects, snapshot.projects || []),
    options.authorizedRoots,
  );
  const snapshotByProject = await filterAuthorizedProjectRows(snapshot.by_project || [], options.authorizedRoots);
  const { byProject, running } = decorateSnapshotProjects(snapshotByProject, sessionPrefs, projectPrefs);
  const changed = await changedProjectRows(projectRows, projectPrefs);
  const runningDecorated = running.map((session) => decorateSession(session, sessionPrefs));
  return withPayloadBytes({
    ...snapshot,
    kind: "burn-monitor-sessions",
    schema: BURN_BUSINESS_SCHEMA,
    running_total: runningDecorated.length,
    running: runningDecorated,
    changed,
    changed_total: changed.length,
    by_project: byProject,
    projects: projectRows.map((project) => ({ ...project, pinned: Boolean(projectPrefs.projects?.[project.id]?.pinned || project.pinned), favorite: Boolean(projectPrefs.projects?.[project.id]?.favorite || project.favorite) })),
    monitor: { running_count: runningDecorated.length, changed_count: changed.length },
  });
}

export async function resolveProjectRef(input = {}, context = {}) {
  const home = path.resolve(context.home || defaultBurnHome());
  const token = cleanText(input.project_id || input.projectId || input.project_path || input.projectPath || input.project || input.cwd || context.root || process.cwd());
  return resolveProjectByIdOrPath(token, { home, root: context.root, authorizedRoots: context.authorizedRoots });
}

export async function resolveProjectByIdOrPath(token, context = {}) {
  const home = path.resolve(context.home || defaultBurnHome());
  const root = path.resolve(context.root || process.cwd());
  const authorizedRoots = await canonicalAuthorizedRoots(context.authorizedRoots);
  const projects = await listAllBurnProjects({ home, root, authorizedRoots });
  const normalizedToken = cleanText(token);
  for (const project of projects) {
    if ([project.id, project.path, project.path_display, project.name].includes(normalizedToken)) return project;
  }
  const candidate = path.isAbsolute(normalizedToken) ? normalizedToken : path.resolve(root, normalizedToken || ".");
  const canonical = await canonicalPath(candidate).catch(() => "");
  if (canonical && !projectAllowed(canonical, authorizedRoots)) throw codedError("local_policy_denied", "project outside authorized roots");
  if (canonical) return implicitProject(canonical, "implicit_path");
  throw codedError("project_not_found", "project not found");
}

async function listAllBurnProjects(options = {}) {
  const out = [];
  let cursor = 0;
  for (let pageIndex = 0; pageIndex < 80; pageIndex += 1) {
    const listed = await listBurnProjects({ ...options, cursor, limit: 200 });
    out.push(...(listed.projects || []));
    const page = listed.page || {};
    if (!page.has_more || !Number.isFinite(page.next_cursor)) break;
    cursor = page.next_cursor;
  }
  return out;
}

async function decorateProject(project, prefs, home) {
  const appOwned = project.kind === "burn_public" || project.source === "burn_public", st = project.path ? await safeStat(project.path) : null;
  const git = !appOwned && st?.isDirectory() ? await gitSnapshot(project.path).catch(() => null) : null, pref = prefs.projects?.[project.id] || {};
  return {
    ...project,
    exists: Boolean(st?.isDirectory()),
    path: appOwned ? "" : project.path,
    path_display: appOwned ? `[local]/burn/projects/public/${path.basename(project.path || project.id || "project")}` : (project.path_display || (project.path ? displayPath(project.path) : "")),
    session_count: Number(project.session_count || 0),
    running_count: Number(project.running_count || 0),
    dirty_count: Number(git?.dirty_count || 0),
    changed_count: Number(git?.dirty_count || 0),
    workspace_counts: {},
    last_activity_at: project.updated_at || project.last_activity_at || (st ? new Date(st.mtimeMs).toISOString() : ""),
    last_activity_label: lastActivityLabel(project.updated_at || project.last_activity_at || st?.mtimeMs),
    pinned: Boolean(pref.pinned || project.pinned),
    favorite: Boolean(pref.favorite || project.favorite),
  };
}

function decorateSession(session, prefs) {
  const id = cleanText(session.id || session.session_id || session.raw_id || session.rawId);
  const pref = prefs.sessions?.[id] || prefs.sessions?.[session.raw_id] || {};
  return { ...session, id, pinned: Boolean(pref.pinned || session.pinned), favorite: Boolean(pref.favorite || session.favorite) };
}

function mergeSnapshotProjects(listed, snapshotProjects) {
  const byPath = new Map();
  const rows = [];
  for (const project of listed) {
    if (project.path) byPath.set(project.path, project);
    rows.push(project);
  }
  for (const project of snapshotProjects) {
    if (project.path && !byPath.has(project.path)) rows.push({ ...project, id: project.id || projectId(project.path) });
  }
  return rows;
}

async function filterAuthorizedProjectRows(rows, authorizedRootsValue = []) {
  const authorizedRoots = await canonicalAuthorizedRoots(authorizedRootsValue);
  const filtered = [];
  for (const project of rows) {
    const normalizedProject = await normalizeProjectForAuthorizedRoots(project, authorizedRoots);
    if (normalizedProject) filtered.push(normalizedProject);
  }
  return filtered;
}

async function normalizeProjectForAuthorizedRoots(project, authorizedRoots = []) {
  if (!authorizedRoots.length || project?.kind === "burn_public" || project?.source === "burn_public") return project;
  const canonical = await canonicalPath(project?.path || "").catch(() => "");
  if (!canonical || !projectAllowed(canonical, authorizedRoots)) return null;
  return {
    ...project,
    path: canonical,
    path_display: project.path_display || displayPath(canonical),
  };
}

function decorateSnapshotProjects(rows, sessionPrefs, projectPrefs) {
  const byProject = [];
  const running = [];
  for (const row of rows) {
    const sessions = (row.sessions || []).map((session) => decorateSession(session, sessionPrefs));
    sessions.filter((session) => session.running).forEach((session) => running.push({ ...session, project_id: row.id || session.project_id, project_name: row.name || session.project_name }));
    byProject.push({ ...row, pinned: Boolean(projectPrefs.projects?.[row.id]?.pinned), favorite: Boolean(projectPrefs.projects?.[row.id]?.favorite), sessions });
  }
  return { byProject, running };
}

async function changedProjectRows(projectRows, projectPrefs) {
  const changed = [];
  for (const project of projectRows) {
    if (!project.path || !existsSync(project.path)) continue;
    const git = await gitSnapshot(project.path).catch(() => null);
    if (!git?.dirty_count) continue;
    changed.push({
      id: `changed_${project.id || projectId(project.path)}`,
      raw_id: `changed_${project.id || projectId(project.path)}`,
      title: `${project.name || path.basename(project.path)} has local changes`,
      project_id: project.id || projectId(project.path),
      project_name: project.name || path.basename(project.path),
      cwd: project.path,
      agent: "codex",
      preview: `${git.dirty_count} changed file${git.dirty_count === 1 ? "" : "s"}`,
      running: false,
      changed: true,
      dirty_count: git.dirty_count,
      changed_files: git.changed_files || [],
      updated_at: nowIso(),
      last_activity_label: "changed",
      pinned: Boolean(projectPrefs.projects?.[project.id]?.pinned),
      favorite: Boolean(projectPrefs.projects?.[project.id]?.favorite),
    });
  }
  return changed;
}

function implicitProject(projectPath, source) {
  return { id: projectId(projectPath), name: path.basename(projectPath) || "Project", kind: "user_directory", source, path: projectPath, path_display: displayPath(projectPath), created_at: nowIso(), updated_at: nowIso(), exists: true, pinned: false, favorite: false };
}

async function uniqueProjectSlug(parent, base) {
  let current = base || "project";
  let index = 2;
  while (existsSync(path.join(parent, current))) {
    current = `${base}-${index}`;
    index += 1;
  }
  return current;
}

async function resolveUserProjectTarget(input, rootValue, home, name, authorizedRootsValue = []) {
  const raw = cleanText(input.path || input.directory_path || input.directoryPath || input.project_path || input.projectPath);
  const parent = cleanText(input.parent_path || input.parentPath);
  const base = raw ? (path.isAbsolute(raw) ? raw : path.resolve(rootValue || process.cwd(), raw)) : path.resolve(parent || rootValue || process.cwd(), slugify(name));
  const resolved = path.resolve(base);
  assertSafeUserPath(resolved, home, "project");
  const authorizedRoots = await canonicalAuthorizedRoots(authorizedRootsValue);
  if (!projectAllowed(resolved, authorizedRoots)) throw codedError("local_policy_denied", "project outside authorized roots");
  return resolved;
}
