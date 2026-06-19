import { basename } from "node:path";

import { displayPath, sha256 } from "./fs-utils.mjs";

export function projectInfo(path) {
  return { id: projectId(path), name: basename(path), path, path_display: displayPath(path) };
}

export function projectId(path) {
  return `proj_${sha256(path).slice(0, 16)}`;
}

export function compareProjects(a, b) {
  return Number(b.running_count > 0) - Number(a.running_count > 0)
    || Date.parse(b.last_activity_at || 0) - Date.parse(a.last_activity_at || 0)
    || b.marker_score - a.marker_score
    || a.name.localeCompare(b.name);
}

export function pageItems(items, cursor, limit, section) {
  const start = Math.min(Math.max(0, cursor), items.length);
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

export function withPayloadBytes(payload) {
  payload.payload_bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (payload.trace) payload.trace.payload_bytes = payload.payload_bytes;
  return payload;
}

export function latestSessionTime(sessions) {
  const times = (Array.isArray(sessions) ? sessions : [])
    .map((session) => Date.parse(session.updated_at || session.last_activity || session.timestamp || session.mtime || ""))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  return times.length ? new Date(times[0]).toISOString() : null;
}

export function lastActivityLabel(value) {
  const time = typeof value === "number" ? value : Date.parse(value || "");
  if (!Number.isFinite(time)) return "·";
  const delta = Math.max(0, Date.now() - time);
  const min = Math.floor(delta / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  const day = Math.floor(hour / 24);
  if (day === 1) return "昨天";
  if (day < 7) return `${day}d`;
  return new Date(time).toISOString().slice(5, 10);
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
