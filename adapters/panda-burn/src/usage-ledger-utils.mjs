import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LEDGER_DIR } from "./usage-ledger-schema.mjs";

export function eventTimestamp(event) {
  return normalizeTime(event?.timestamp || event?.time || event?.created_at || event?.createdAt || event?.ts || event?.updated_at || event?.updatedAt);
}

export function normalizeTime(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    const ms = value > 9999999999 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : "";
  }
  const text = cleanText(value);
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000).toISOString();
  if (/^\d{13}$/.test(text)) return new Date(Number(text)).toISOString();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

export function timeMs(value) {
  const normalized = normalizeTime(value);
  if (!normalized) return 0;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function boundaryTime(value, timezone, edge) {
  const text = cleanText(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!dateOnly) return normalizeTime(value);
  const year = Number(dateOnly[1]);
  const month = Number(dateOnly[2]);
  const day = Number(dateOnly[3]);
  if (edge === "end") {
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    return new Date(localDateStartMs(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      timezone,
    ) - 1).toISOString();
  }
  return new Date(localDateStartMs(year, month, day, timezone)).toISOString();
}

function localDateStartMs(year, month, day, timezone) {
  const localAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let utcMs = localAsUtc;
  for (let i = 0; i < 3; i += 1) {
    utcMs = localAsUtc - timezoneOffsetMs(utcMs, timezone);
  }
  return utcMs;
}

function timezoneOffsetMs(utcMs, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return localAsUtc - utcMs;
}

export function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(0, number);
  }
  return 0;
}

export function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

export function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function cleanProject(value) {
  const text = cleanText(value);
  if (!text || text === "unknown") return "";
  if (text.startsWith("~")) return text;
  return path.isAbsolute(text) ? path.resolve(text) : text;
}

export function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function normalizeOptionalSource(value) {
  const source = cleanText(value).toLowerCase();
  if (!source) return "";
  if (source !== "codex" && source !== "claude") throw coded("invalid_source", `invalid source: ${source}`);
  return source;
}

export function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  const text = cleanText(value);
  if (!text) return [];
  return text.split(",").map(cleanText).filter(Boolean);
}

export function normalizeResponseMode(value) {
  const mode = cleanText(value).toLowerCase();
  if (!mode) return "local";
  if (mode !== "local" && mode !== "relay") throw coded("invalid_response_mode", "invalid response mode");
  return mode;
}

export function normalizeTimezone(value) {
  const timezone = cleanText(value) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw coded("invalid_timezone", "invalid timezone");
  }
}

export function resolveBurnHome(options = {}) {
  const explicit = cleanText(options.burnHome || options.burn_home || options.home || process.env.BURN_APP_HOME);
  if (explicit) return path.resolve(explicit);
  const userHome = homeDir();
  if (process.platform === "darwin") return path.join(userHome, "Library", "Application Support", "Burn");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(userHome, "AppData", "Local"), "Burn");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(userHome, ".local", "share"), "Burn");
}

export function usageLedgerDir(burnHome) {
  return path.join(burnHome, LEDGER_DIR);
}

export function localCalendarParts(value, timezone) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return { day: "unknown", week: "unknown", month: "unknown" };
  const date = new Date(parsed);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    day,
    week: localWeekStart(day),
    month: `${parts.year}-${parts.month}`,
    hour: parts.hour || "00",
    weekday: weekdayNumber(day),
  };
}

export async function resolveProjectPath(input) {
  const raw = cleanText(input);
  if (!raw) throw coded("project_required", "project path is required");
  if (!path.isAbsolute(raw)) throw coded("project_path_must_be_absolute", "project path must be absolute");
  let resolved;
  try {
    resolved = await fs.realpath(raw);
  } catch {
    throw coded("project_not_found", "project path was not found");
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw coded("project_not_directory", "project path must be a directory");
  return resolved;
}

function localWeekStart(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "unknown";
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  const offset = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - offset);
  return utc.toISOString().slice(0, 10);
}

function weekdayNumber(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "unknown";
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  return String((utc.getUTCDay() + 6) % 7);
}

export function safeId(value) {
  return String(value || "default").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

export function stableHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

export function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function decodeJwtPayload(token) {
  const text = cleanText(token);
  const parts = text.split(".");
  if (parts.length < 2) return {};
  try {
    const padded = `${parts[1]}${"=".repeat((4 - (parts[1].length % 4)) % 4)}`;
    return JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

export function ledgerRunId(generatedAt) {
  return `${generatedAt.replace(/[-:.TZ]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
}

export function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
