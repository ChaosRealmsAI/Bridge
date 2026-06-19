import { git } from "./fs-utils.mjs";
import { lastActivityLabel } from "./format.mjs";

export async function gitSnapshot(project) {
  const inside = await git(project, ["rev-parse", "--is-inside-work-tree"])
    .then((stdout) => stdout.trim() === "true")
    .catch(() => false);
  if (!inside) {
    return {
      is_git: false,
      branch: "",
      upstream: "",
      ahead: 0,
      behind: 0,
      dirty_count: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      changed_files: [],
      recent_commits: [],
      status_by_path: {},
    };
  }
  const [branchRaw, upstreamRaw, countsRaw, statusRaw, logRaw] = await Promise.all([
    git(project, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
    git(project, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => ""),
    git(project, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).catch(() => "0\t0"),
    git(project, ["status", "--porcelain=v1", "-z"]).catch(() => ""),
    git(project, ["log", "-n", "8", "--pretty=format:%h%x1f%s%x1f%an%x1f%ct%x1e"]).catch(() => ""),
  ]);
  const changed = parseGitStatus(statusRaw);
  const counts = countsRaw.trim().split(/\s+/).map((item) => Number(item) || 0);
  return {
    is_git: true,
    branch: branchRaw.trim(),
    upstream: upstreamRaw.trim(),
    behind: counts[0] || 0,
    ahead: counts[1] || 0,
    dirty_count: changed.files.length,
    added: changed.files.filter((file) => file.status === "A").length,
    modified: changed.files.filter((file) => file.status === "M").length,
    deleted: changed.files.filter((file) => file.status === "D").length,
    changed_files: changed.files,
    recent_commits: parseGitLog(logRaw),
    status_by_path: changed.statusByPath,
  };
}

function parseGitStatus(raw) {
  const parts = String(raw || "").split("\0").filter(Boolean);
  const files = [];
  const statusByPath = {};
  for (const part of parts) {
    const code = part.slice(0, 2);
    const path = part.slice(3);
    if (!path) continue;
    const status = code.includes("D") ? "D" : code.includes("A") || code.includes("?") ? "A" : "M";
    files.push({ path, status, raw: code.trim() });
    statusByPath[path] = status;
  }
  return { files, statusByPath };
}

function parseGitLog(raw) {
  const records = String(raw || "").split("\x1e").map((item) => item.trim()).filter(Boolean);
  const commits = [];
  for (const record of records) {
    const parts = record.split("\x1f");
    if (parts.length < 4) continue;
    const ts = Number(parts[3]) * 1000;
    commits.push({
      hash: parts[0],
      message: parts[1],
      author: parts[2],
      committed_at: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
      ago: lastActivityLabel(ts),
    });
  }
  return commits;
}
