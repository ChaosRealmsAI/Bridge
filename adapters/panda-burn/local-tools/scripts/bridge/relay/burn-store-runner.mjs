import path from "node:path";
import { doctorBurnStore, stableHash, statusBurnStore } from "../../../backend/burn-store-lib.mjs";

export function isBurnStoreCommand(type) {
  return type === "burn.store.status" || type === "burn.store.doctor";
}

export async function runBurnStoreCommand(command, context) {
  try {
    const options = {
      home: process.env.BURN_APP_HOME,
      project: context.root,
      create: false,
    };
    const data = command.type === "burn.store.doctor"
      ? await doctorBurnStore(options)
      : await statusBurnStore(options);
    return {
      ok: true,
      version: command.version || "burn-relay-v1",
      type: command.type,
      request_id: command.request_id || null,
      generated_at: new Date().toISOString(),
      data: publicStoreData(data),
    };
  } catch (error) {
    return {
      ok: false,
      version: command.version || "burn-relay-v1",
      type: command.type,
      request_id: command.request_id || null,
      error: error.code || "burn_store_failed",
      code: error.code || "burn_store_failed",
      message: String(error.message || error),
    };
  }
}

export function publicStoreData(data) {
  const responseSchema = data.response_schema || "burn.store.status.v1";
  return {
    schema: responseSchema,
    response_schema: responseSchema,
    store_schema: cleanText(data.schema),
    product: "burn",
    store_exists: Boolean(data.store_exists),
    store_ready: Boolean(data.store_ready),
    initialized: Boolean(data.initialized),
    storage_scope: data.storage_scope,
    app_home_display: safeDisplayPath(data.app_home_display),
    account_hash: data.account_hash,
    device_hash: data.device_hash,
    store_id: cleanIdentifier(data.store_id),
    store_id_hash: data.store_id ? stableHash(data.store_id) : "",
    updated_at: data.updated_at,
    diagnostics: publicDiagnostics(data.diagnostics),
    checks: Array.isArray(data.checks) ? data.checks.map(publicCheck) : [],
  };
}

function safeDisplayPath(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text === "~" || text.startsWith("~/")) return "[local]/burn";
  if (path.isAbsolute(text)) return "[local]/burn";
  return text.replace(/[A-Za-z]:[\\/][^ ]+/g, "[local]/burn");
}

function publicDiagnostics(value) {
  if (!value || typeof value !== "object") {
    return {
      schema_expected: "burn.store.v1",
      schema_found: "",
      app_home_exists: false,
      meta_exists: false,
      schema_current: false,
      required_dirs_present: false,
      missing_required_dirs: [],
      ready_reason: "diagnostics_unavailable",
      storage_scope: "device_app_home",
    };
  }
  return {
    schema_expected: cleanText(value.schema_expected),
    schema_found: cleanText(value.schema_found),
    app_home_exists: Boolean(value.app_home_exists),
    meta_exists: Boolean(value.meta_exists),
    schema_current: Boolean(value.schema_current),
    required_dirs_present: Boolean(value.required_dirs_present),
    missing_required_dirs: Array.isArray(value.missing_required_dirs) ? value.missing_required_dirs.map(cleanText).filter(Boolean) : [],
    ready_reason: cleanText(value.ready_reason),
    storage_scope: cleanText(value.storage_scope),
  };
}

function publicCheck(value) {
  return { id: cleanText(value?.id), ok: Boolean(value?.ok) };
}

function cleanIdentifier(value) {
  return cleanText(value).replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 160);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
