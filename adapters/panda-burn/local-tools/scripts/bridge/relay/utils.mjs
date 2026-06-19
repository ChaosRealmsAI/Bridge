import { createHash } from "node:crypto";
import { basename } from "node:path";
import { env } from "node:process";

export function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function actionIdFromInput(input) {
  const id = cleanText(input?.id);
  if (id) return id;
  return cleanText(input?.action_id);
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function projectName(value) {
  const v = String(value || "").trim();
  if (!v) return "Project";
  if (v.includes("/")) return basename(v) || "Project";
  return v;
}

export function displayPath(path) {
  const home = env.HOME || "";
  const raw = String(path || "");
  return home && raw.startsWith(`${home}/`) ? `~/${raw.slice(home.length + 1)}` : raw;
}

export function lastActivityLabel(value) {
  const raw = cleanText(value);
  const time = /^\d{10}$/.test(raw)
    ? Number(raw) * 1000
    : /^\d{13}$/.test(raw)
      ? Number(raw)
      : Date.parse(raw || "");
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

export function pageItems(items, cursor, limit, section, maxLimit = 200) {
  const source = Array.isArray(items) ? items : [];
  const start = Math.min(Math.max(0, Number.isFinite(cursor) ? Math.floor(cursor) : 0), source.length);
  const cap = Math.max(1, Number.isFinite(maxLimit) ? Math.floor(maxLimit) : 200);
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 80, cap));
  const end = Math.min(start + safeLimit, source.length);
  const pageItems = source.slice(start, end);
  const hasMore = end < source.length;
  return {
    items: pageItems,
    page: {
      section,
      cursor: start,
      limit: safeLimit,
      item_count: pageItems.length,
      total: source.length,
      next_cursor: hasMore ? end : null,
      has_more: hasMore,
      end_of_list: !hasMore,
      page_error_code: "",
      dedupe_count: 0,
      payload_bytes: Buffer.byteLength(JSON.stringify(pageItems), "utf8"),
    },
  };
}

export function withPayloadBytes(payload) {
  payload.payload_bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  return payload;
}

export function parseJsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseJsonObject(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const value = JSON.parse(raw.slice(start, end + 1));
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}
