import os from "node:os";
import path from "node:path";

import { stableHash } from "../burn-store-lib.mjs";
import { projectId as formatProjectId } from "../project/format.mjs";

export const BURN_BUSINESS_SCHEMA = "burn.business.v1";
export const EVENT_LIMIT = 80;
export const TEXT_PREVIEW_BYTES = 64 * 1024;

export function normalizeProjectKind(value) {
  const text = cleanText(value).toLowerCase();
  if (["public", "burn_public", "app", "application"].includes(text)) return "burn_public";
  return "user_directory";
}

export function projectId(projectPath) {
  return formatProjectId ? formatProjectId(projectPath) : `proj_${stableHash(projectPath)}`;
}

export function slugify(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
}

export function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function requireText(value, code) {
  const text = cleanText(value);
  if (!text) throw codedError(code, code);
  return text;
}

export function normalizeRelPath(value) {
  const text = String(value || "").trim();
  if (!text || path.isAbsolute(text) || text.split(/[\\/]+/).includes("..")) {
    throw codedError("local_policy_denied", "invalid relative path");
  }
  return text;
}

export function boolOrCurrent(value, current) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return Boolean(current);
}

export function compareProjects(a, b) {
  return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    || Number((b.running_count || 0) > 0) - Number((a.running_count || 0) > 0)
    || Number(Boolean(b.favorite)) - Number(Boolean(a.favorite))
    || Date.parse(b.last_activity_at || 0) - Date.parse(a.last_activity_at || 0)
    || String(a.name || "").localeCompare(String(b.name || ""));
}

export function compareUpdated(a, b) {
  return Date.parse(b.updated_at || b.created_at || b.linked_at || 0) - Date.parse(a.updated_at || a.created_at || a.linked_at || 0);
}

export function pageItems(items, cursorValue, limitValue, section) {
  const safeItems = Array.isArray(items) ? items : [];
  const limit = clampInt(limitValue, 80, 1, 200);
  const cursor = clampInt(cursorValue, 0, 0, safeItems.length);
  const start = Math.min(cursor, safeItems.length);
  const end = Math.min(start + limit, safeItems.length);
  const chunk = safeItems.slice(start, end);
  const hasMore = end < safeItems.length;
  return {
    items: chunk,
    page: {
      section,
      cursor: start,
      limit,
      item_count: chunk.length,
      total: safeItems.length,
      next_cursor: hasMore ? end : null,
      has_more: hasMore,
      end_of_list: !hasMore,
      page_error_code: "",
      dedupe_count: 0,
      payload_bytes: Buffer.byteLength(JSON.stringify(chunk), "utf8"),
    },
  };
}

export function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function withPayloadBytes(payload) {
  payload.payload_bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (payload.trace) payload.trace.payload_bytes = payload.payload_bytes;
  return payload;
}

export function assertSafeUserPath(target, home, label) {
  const resolved = path.resolve(target);
  const burn = path.resolve(home);
  const root = path.parse(resolved).root;
  const forbidden = new Set([root, os.homedir(), burn, "/System", "/bin", "/sbin", "/usr", "/etc", "/var", "/private", "/dev"]);
  if (forbidden.has(resolved) || resolved.startsWith(`${burn}${path.sep}`)) {
    throw codedError("local_policy_denied", `${label} path is not a safe Burn user target`);
  }
}

export function safeFileName(value) {
  return stableHash(value);
}

export function nowIso() {
  return new Date().toISOString();
}

export function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}
