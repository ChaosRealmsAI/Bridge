import path from "node:path";

import { discoverProjects, markerInfo } from "../project/discovery.mjs";
import { displayPath, isInside, safeStat } from "../project/fs-utils.mjs";
import { sessionProjectIndex } from "../project/sessions.mjs";
import { cleanText, clampInt, projectId } from "./common.mjs";

export async function discoverBurnProjectRows(root, options = {}) {
  if (options.include_discovered === false || options.includeDiscovered === false || !root) {
    return { rows: [], trace: { discovered_count: 0, session_index_count: 0, max_depth: 0 } };
  }
  const maxDepth = clampInt(options.max_depth || options.maxDepth, 4, 0, 6);
  const discovered = await discoverProjects(root, maxDepth);
  const sessionIndex = await sessionProjectIndex(root, { timeoutMs: options.session_index_timeout_ms || options.sessionIndexTimeoutMs });
  let sessionIndexCount = 0;
  for (const projectPath of sessionIndex.keys()) {
    if (!isInside(projectPath, root)) continue;
    sessionIndexCount += 1;
    if (!discovered.has(projectPath)) discovered.set(projectPath, await markerInfo(projectPath));
  }
  const rows = [];
  for (const [projectPath, marker] of discovered) {
    const sessions = sessionIndex.get(projectPath) || {};
    const st = await safeStat(projectPath);
    const lastActivity = cleanText(sessions.last_activity_at) || (st ? new Date(st.mtimeMs).toISOString() : "");
    rows.push({
      id: projectId(projectPath),
      name: path.basename(projectPath) || "Project",
      kind: "user_directory",
      source: marker.score > 0 ? "discovered" : "session_index",
      path: projectPath,
      path_display: displayPath(projectPath),
      markers: marker.markers || [],
      marker_score: Number(marker.score || 0),
      session_count: Number(sessions.total || 0),
      running_count: Number(sessions.running || 0),
      last_activity_at: lastActivity,
      updated_at: lastActivity,
    });
  }
  return { rows, trace: { discovered_count: rows.length, session_index_count: sessionIndexCount, max_depth: maxDepth } };
}

export function mergeProjectRecord(existing, incoming) {
  if (!existing) return incoming;
  const latestActivity = latestIso(existing.last_activity_at || existing.updated_at, incoming.last_activity_at || incoming.updated_at);
  return {
    ...incoming,
    ...existing,
    markers: existing.markers?.length ? existing.markers : incoming.markers,
    marker_score: Math.max(Number(existing.marker_score || 0), Number(incoming.marker_score || 0)),
    session_count: Math.max(Number(existing.session_count || 0), Number(incoming.session_count || 0)),
    running_count: Math.max(Number(existing.running_count || 0), Number(incoming.running_count || 0)),
    last_activity_at: latestActivity,
    updated_at: latestActivity || existing.updated_at || incoming.updated_at,
  };
}

function latestIso(left, right) {
  if (!left) return right || "";
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}
