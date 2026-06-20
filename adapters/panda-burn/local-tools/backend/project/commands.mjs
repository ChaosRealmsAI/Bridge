import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { env } from "node:process";

import { discoverProjects, markerInfo } from "./discovery.mjs";
import { displayPath, isInside, safeStat } from "./fs-utils.mjs";
import { compareProjects, lastActivityLabel, pageItems, projectId, withPayloadBytes } from "./format.mjs";
import { sessionProjectIndex } from "./sessions.mjs";

export async function listProjects(options) {
  const startedAt = Date.now();
  const root = await realpath(resolve(options.root || env.HOME || process.cwd()));
  const discovered = await discoverProjects(root, options.maxDepth);
  const sessionIndex = await sessionProjectIndex(root);
  for (const projectPath of sessionIndex.keys()) {
    if (isInside(projectPath, root)) discovered.set(projectPath, await markerInfo(projectPath));
  }
  const rows = [];
  for (const [projectPath, marker] of discovered) {
    const sessions = sessionIndex.get(projectPath) || { total: 0, running: 0, last_activity_at: null };
    const st = await safeStat(projectPath);
    rows.push({
      id: projectId(projectPath),
      name: basename(projectPath),
      path: projectPath,
      path_display: displayPath(projectPath),
      markers: marker.markers,
      marker_score: marker.score,
      session_count: sessions.total,
      running_count: sessions.running,
      last_activity_at: sessions.last_activity_at || (st ? new Date(st.mtimeMs).toISOString() : null),
      last_activity_label: lastActivityLabel(sessions.last_activity_at || st?.mtimeMs),
    });
  }
  rows.sort(compareProjects);
  const page = pageItems(rows, options.cursor, options.limit, "projects");
  return withPayloadBytes({
    ok: true,
    kind: "burn-project-list",
    root: { path: root, path_display: displayPath(root) },
    projects: page.items,
    page: page.page,
    trace: { generated_at: new Date().toISOString(), adapter_ms: Date.now() - startedAt, partial: page.page.has_more },
  });
}
