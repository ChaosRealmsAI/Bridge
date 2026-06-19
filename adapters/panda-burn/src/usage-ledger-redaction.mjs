import path from "node:path";

import { LEDGER_DIR } from "./usage-ledger-schema.mjs";
import { cleanText, homeDir } from "./usage-ledger-utils.mjs";

export function redactLedgerForRelay(result) {
  const copy = JSON.parse(JSON.stringify(result));
  copy.redaction = {
    raw_paths: "omitted_from_relay_response",
    local_files: "raw paths remain only in the local Burn user data usage ledger",
  };
  scrubRawPathFields(copy);
  if (copy.output) {
    copy.output.directory_display = `<burn-home>/${LEDGER_DIR}`;
    copy.output.latest_path_display = `<burn-home>/${LEDGER_DIR}/latest.json`;
    copy.output.run_path_display = `<burn-home>/${LEDGER_DIR}/runs/${copy.run_id}.json`;
  }
  return copy;
}

function scrubRawPathFields(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) scrubRawPathFields(item);
    return value;
  }
  for (const key of Object.keys(value)) {
    if (["project", "directory", "latest_path", "run_path", "burn_home", "ledger_dir", "cache_dir", "sqlite_path"].includes(key)) {
      delete value[key];
      continue;
    }
    if (key.endsWith("_display") && typeof value[key] === "string") {
      value[key] = safeRelayDisplayPath(value[key]);
      continue;
    }
    scrubRawPathFields(value[key]);
  }
  return value;
}

function safeRelayDisplayPath(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (text === "unknown") return text;
  if (text.startsWith("~/")) return text;
  if (path.isAbsolute(text)) {
    const base = path.basename(text) || "path";
    return `.../${base}`;
  }
  return text;
}

export function maskHome(value) {
  const text = cleanText(value);
  if (!text) return "";
  const resolved = path.resolve(text);
  const home = path.resolve(homeDir());
  if (resolved === home) return "~";
  if (resolved.startsWith(`${home}${path.sep}`)) return `~/${resolved.slice(home.length + 1)}`;
  return resolved;
}

export function maskEmail(value) {
  const email = cleanText(value).toLowerCase();
  const at = email.indexOf("@");
  if (at <= 1) return email ? "***" : "";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export function redactedError(error) {
  return {
    code: cleanText(error?.code) || "usage_ledger_error",
    message: cleanText(error?.message || error).slice(0, 500),
  };
}
