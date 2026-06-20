import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BURN_STORE_SCHEMA = "burn.store.v1";

export function defaultBurnHome(env = process.env) {
  if (env.BURN_APP_HOME) return path.resolve(env.BURN_APP_HOME);
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Burn");
  if (process.platform === "win32") {
    return path.resolve(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Burn");
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "burn");
}

export function maskPath(value) {
  const resolved = path.resolve(value || defaultBurnHome());
  const home = os.homedir();
  if (resolved === home) return "~";
  if (resolved.startsWith(`${home}${path.sep}`)) return `~/${resolved.slice(home.length + 1)}`;
  return resolved;
}

export async function initBurnStore(options = {}) {
  const home = path.resolve(options.home || defaultBurnHome());
  const now = new Date().toISOString();
  await fs.mkdir(home, { recursive: true });
  for (const dir of requiredStoreDirs()) {
    await fs.mkdir(path.join(home, dir), { recursive: true });
  }
  const metaPath = path.join(home, "meta.json");
  const previous = await readJson(metaPath);
  const accountIdentity = options.accountId || process.env.BURN_ACCOUNT_ID || "";
  const deviceIdentity = options.deviceId || process.env.BURN_DEVICE_ID || "";
  const accountHash = accountIdentity ? stableHash(accountIdentity) : (previous.account_hash || stableHash("local-account"));
  const deviceHash = deviceIdentity ? stableHash(deviceIdentity) : (previous.device_hash || stableHash(os.hostname()));
  const meta = {
    schema: BURN_STORE_SCHEMA,
    product: "burn",
    store_id: previous.store_id || `burn_store_${randomUUID()}`,
    storage_scope: "device_app_home",
    app_home: home,
    account_hash: accountHash,
    device_hash: deviceHash,
    created_at: previous.created_at || now,
    updated_at: now,
  };
  await writeJson(metaPath, meta);
  await writeJson(path.join(home, "devices", `${deviceHash}.json`), {
    schema: "burn.device-store.v1",
    account_hash: accountHash,
    device_hash: deviceHash,
    app_home: home,
    updated_at: now,
  });
  await reconcileDeviceRecords(home, deviceHash);
  return statusPayload(home, meta, true);
}

export async function statusBurnStore(options = {}) {
  const home = path.resolve(options.home || defaultBurnHome());
  const meta = await readJson(path.join(home, "meta.json"));
  return statusPayload(home, meta, false, options.project || process.cwd());
}

export async function doctorBurnStore(options = {}) {
  const status = options.create === true
    ? await initBurnStore(options)
    : await statusBurnStore(options);
  const checks = [
    check("app_home_exists", existsSync(status.app_home)),
    check("meta_exists", existsSync(path.join(status.app_home, "meta.json"))),
    ...requiredStoreDirs().map((dir) => check(`${safeCheckId(dir)}_dir_exists`, existsSync(path.join(status.app_home, dir)))),
    check("schema_current", status.store_exists && status.schema === BURN_STORE_SCHEMA),
  ];
  return { ...status, checks, ok: checks.every((item) => item.ok) };
}

function statusPayload(home, meta, initialized, project = process.cwd()) {
  const exists = existsSync(path.join(home, "meta.json"));
  const schemaCurrent = exists && meta.schema === BURN_STORE_SCHEMA;
  const diagnostics = storeDiagnostics(home, meta, exists, schemaCurrent);
  const storeReady = schemaCurrent && diagnostics.required_dirs_present;
  const payload = {
    ok: true,
    schema: meta.schema || "",
    response_schema: "burn.store.status.v1",
    product: "burn",
    store_exists: exists,
    store_ready: storeReady,
    initialized,
    storage_scope: meta.storage_scope || "device_app_home",
    app_home: home,
    app_home_display: maskPath(home),
    account_hash: meta.account_hash || "",
    device_hash: meta.device_hash || "",
    store_id: meta.store_id || "",
    updated_at: meta.updated_at || "",
    diagnostics,
  };
  return payload;
}

function storeDiagnostics(home, meta, metaExists, schemaCurrent) {
  const missingRequiredDirs = requiredStoreDirs().filter((dir) => !existsSync(path.join(home, dir)));
  const appHomeExists = existsSync(home);
  let readyReason = "ready";
  if (!appHomeExists) readyReason = "app_home_missing";
  else if (!metaExists) readyReason = "meta_missing";
  else if (!schemaCurrent) readyReason = "schema_mismatch";
  else if (missingRequiredDirs.length) readyReason = "required_dirs_missing";
  return {
    schema_expected: BURN_STORE_SCHEMA,
    schema_found: meta.schema || "",
    app_home_exists: appHomeExists,
    meta_exists: metaExists,
    schema_current: schemaCurrent,
    required_dirs_present: missingRequiredDirs.length === 0,
    missing_required_dirs: missingRequiredDirs,
    ready_reason: readyReason,
    storage_scope: meta.storage_scope || "device_app_home",
  };
}

function requiredStoreDirs() {
  return [
    "events",
    "outbox",
    "read-model",
    "data",
    "data/agent-usage",
    "devices",
    "diagnostics",
    "projects",
    "projects/public",
    "preferences",
  ];
}

export function stableHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

async function reconcileDeviceRecords(home, currentDeviceHash) {
  const devicesDir = path.join(home, "devices");
  const entries = await fs.readdir(devicesDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== `${currentDeviceHash}.json`)
    .map((entry) => fs.rm(path.join(devicesDir, entry.name), { force: true })));
}

function check(id, ok) {
  return { id, ok: Boolean(ok) };
}

function safeCheckId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "path";
}

async function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, file);
}
