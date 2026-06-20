import { runCli, parseCliError } from "./cli.mjs";
import { authorizedProjectRoots, resolveAuthorizedRoots } from "./path-policy.mjs";

export async function runBurnProject(command, context) {
  const input = command.input || {};
  try {
    if (command.type === "burn.project.list") {
      const roots = await resolveAuthorizedRoots(authorizedProjectRoots(context));
      const listRoots = roots.length ? roots : [context.root];
      const merged = await listAllAuthorizedProjects(context, listRoots, input);
      return projectResponse(command, merged);
    }
    throw new Error("project_command_not_allowed");
  } catch (error) {
    return projectError(command, error);
  }
}

async function listAllAuthorizedProjects(context, roots, input) {
  const projectsByPath = new Map();
  const startedAt = Date.now();
  for (const root of roots) {
    const args = ["project", "list", "--root", root, "--json", "--cursor", "0", "--limit", "200"];
    appendOptional(args, "--max-depth", input.max_depth || input.maxDepth);
    const data = await runCliJson(context, args, root);
    for (const project of data.projects || []) projectsByPath.set(project.path, project);
  }
  const projects = [...projectsByPath.values()].sort(compareProjects);
  const page = pageItems(projects, input.cursor, input.limit, "projects");
  return {
    ok: true,
    kind: "burn-project-list",
    roots: roots.map((path) => ({ path })),
    projects: page.items,
    page: page.page,
    trace: { generated_at: new Date().toISOString(), adapter_ms: Date.now() - startedAt, partial: page.page.has_more },
    payload_bytes: Buffer.byteLength(JSON.stringify(page.items), "utf8"),
  };
}

export function isProjectCommand(type) {
  return typeof type === "string" && type.startsWith("burn.project.");
}

async function runCliJson(context, args, cwd) {
  const stdout = await runCli(context, args, { cwd, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function projectResponse(command, data) {
  return {
    ok: true,
    version: "burn-relay-v1",
    type: command.type,
    request_id: command.request_id || null,
    generated_at: new Date().toISOString(),
    data,
  };
}

function projectError(command, error) {
  const parsed = parseCliError(error, "burn_project_failed");
  if (error?.code === "local_policy_denied" || String(error?.message || error).includes("local_policy_denied")) {
    parsed.code = "local_policy_denied";
    parsed.causeCode = "local_policy_denied";
  }
  return {
    ok: false,
    version: "burn-relay-v1",
    type: command.type,
    request_id: command.request_id || null,
    error: parsed.code,
    code: parsed.code,
    message: parsed.message,
    cause_code: parsed.causeCode,
  };
}

function appendOptional(args, flag, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, String(value));
}

function compareProjects(a, b) {
  return Number((b.running_count || 0) > 0) - Number((a.running_count || 0) > 0)
    || Date.parse(b.last_activity_at || 0) - Date.parse(a.last_activity_at || 0)
    || (b.marker_score || 0) - (a.marker_score || 0)
    || String(a.name || "").localeCompare(String(b.name || ""));
}

function pageItems(items, cursorValue, limitValue, section) {
  const limit = clampInt(limitValue, 80, 1, 200);
  const cursor = clampInt(cursorValue, 0, 0, items.length);
  const start = Math.min(cursor, items.length);
  const end = Math.min(start + limit, items.length);
  const chunk = items.slice(start, end);
  const hasMore = end < items.length;
  return {
    items: chunk,
    page: {
      section,
      cursor: start,
      limit,
      item_count: chunk.length,
      total: items.length,
      next_cursor: hasMore ? end : null,
      has_more: hasMore,
      end_of_list: !hasMore,
      page_error_code: "",
      dedupe_count: 0,
      payload_bytes: Buffer.byteLength(JSON.stringify(chunk), "utf8"),
    },
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
