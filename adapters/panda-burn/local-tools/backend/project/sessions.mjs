import { env } from "node:process";

import { bin, exec, safeRealpath } from "./fs-utils.mjs";
import { latestSessionTime } from "./format.mjs";

const DEFAULT_SESSION_INDEX_TIMEOUT_MS = 2500;

export async function sessionProjectIndex(root, options = {}) {
  const index = new Map();
  const timeout = boundedTimeout(options.timeoutMs || env.BURN_PROJECT_SESSION_INDEX_TIMEOUT_MS);
  try {
    const stdout = await exec(bin("burn-monitor"), ["list", "--json"], {
      cwd: root,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    const report = JSON.parse(stdout);
    for (const row of Array.isArray(report.by_project) ? report.by_project : []) {
      const raw = row.path || row.cwd || row.project;
      if (!raw) continue;
      const projectPath = await safeRealpath(raw);
      if (!projectPath) continue;
      index.set(projectPath, {
        total: Number(row.total || row.sessions?.length || 0),
        running: Number(row.running || 0),
        last_activity_at: row.updated_at || row.last_activity || latestSessionTime(row.sessions),
      });
    }
  } catch {
    return index;
  }
  return index;
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_INDEX_TIMEOUT_MS;
  return Math.max(250, Math.min(30000, Math.floor(parsed)));
}
