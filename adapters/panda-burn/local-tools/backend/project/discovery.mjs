import { resolve } from "node:path";

import { IGNORE_DIRS, MARKERS } from "./constants.mjs";
import { exists, safeReaddir, safeReaddirWithTypes } from "./fs-utils.mjs";

export async function discoverProjects(root, maxDepth) {
  const found = new Map();
  async function visit(dir, depth) {
    const marker = await markerInfo(dir);
    if (marker.score > 0) found.set(dir, marker);
    if (depth >= maxDepth) return;
    let entries = [];
    try {
      entries = await safeReaddirWithTypes(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await visit(resolve(dir, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  return found;
}

export async function markerInfo(projectPath) {
  const markers = [];
  for (const marker of MARKERS) {
    if (marker === "xcodeproj") {
      const entries = await safeReaddir(projectPath);
      if (entries.some((entry) => entry.endsWith(".xcodeproj"))) markers.push("*.xcodeproj");
      continue;
    }
    if (await exists(resolve(projectPath, marker))) markers.push(marker);
  }
  return { markers, score: markers.length };
}
