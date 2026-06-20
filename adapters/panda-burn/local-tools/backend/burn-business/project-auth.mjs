import path from "node:path";

import { safeRealpath } from "../project/fs-utils.mjs";
import { codedError } from "./common.mjs";

export async function canonicalPath(value) {
  const real = await safeRealpath(value);
  if (!real) throw codedError("path_not_found", "path not found");
  return real;
}

export async function canonicalAuthorizedRoots(value = []) {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const roots = [];
  for (const entry of entries) {
    const canonical = await canonicalPath(entry).catch(() => "");
    if (canonical) roots.push(canonical);
  }
  return [...new Set(roots)];
}

export function projectAllowed(projectPath, authorizedRoots = []) {
  if (!authorizedRoots.length) return true;
  if (!projectPath) return false;
  const resolved = path.resolve(projectPath);
  return authorizedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

export function mergeDiscoveryTraces(traces) {
  return traces.reduce((acc, trace) => ({
    discovered_count: acc.discovered_count + Number(trace?.discovered_count || 0),
    session_index_count: acc.session_index_count + Number(trace?.session_index_count || 0),
    max_depth: Math.max(acc.max_depth, Number(trace?.max_depth || 0)),
  }), { discovered_count: 0, session_index_count: 0, max_depth: 0 });
}
