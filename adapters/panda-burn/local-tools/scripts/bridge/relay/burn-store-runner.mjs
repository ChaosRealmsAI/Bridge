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
  return {
    schema: data.schema,
    product: "burn",
    store_exists: Boolean(data.store_exists),
    store_ready: Boolean(data.store_ready),
    storage_scope: data.storage_scope,
    app_home_display: safeDisplayPath(data.app_home_display),
    account_hash: data.account_hash,
    device_hash: data.device_hash,
    store_id_hash: data.store_id ? stableHash(data.store_id) : "",
    updated_at: data.updated_at,
    checks: data.checks,
  };
}

function safeDisplayPath(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text === "~" || text.startsWith("~/")) return "[local]/burn";
  if (path.isAbsolute(text)) return "[local]/burn";
  return text.replace(/[A-Za-z]:[\\/][^ ]+/g, "[local]/burn");
}
