#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cwd as processCwd } from "node:process";
import { fileURLToPath } from "node:url";

import { createBridgeProductAdapterRuntime } from "@bridge/adapter-sdk";

import { dispatchBurnCommand } from "../local-tools/scripts/bridge/relay/dispatcher.mjs";
import { authorizationRootValues } from "../local-tools/scripts/bridge/relay/path-policy.mjs";
import { compactUsageLedgerCache, generateUsageLedger } from "./usage-ledger.mjs";

const PRODUCT_ID = "panda-burn";
const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localToolsRoot = resolve(adapterRoot, "local-tools");
const localBackendCli = resolve(localToolsRoot, "backend", "burn");

export async function startPandaBurnAdapter(options = {}) {
  const dispatchContext = localDispatchContext(options);
  let authorizationMirror = providedAuthorizationMirror(options);
  const requireAuthorizationMirror = options.requireAuthorizationMirror === true
    || process.env.PANDA_BURN_REQUIRE_AUTHORIZATION_MIRROR === "1"
    || process.env.BURN_REQUIRE_AUTHORIZATION_MIRROR === "1";
  if (requireAuthorizationMirror && !authorizationMirror) {
    throw new Error("authorization_mirror_required");
  }
  return createBridgeProductAdapterRuntime({
    productId: PRODUCT_ID,
    schemaId: "burn-relay-v1",
    host: options.host || process.env.PANDA_BURN_ADAPTER_HOST || "127.0.0.1",
    port: Number(options.port || process.env.PANDA_BURN_ADAPTER_PORT || 0),
    keyB64: options.keyB64 || process.env.PANDA_BURN_RELAY_KEY_B64 || process.env.BRIDGE_RELAY_KEY_B64,
    relayKeyJwk: options.relayKeyJwk,
    authorizationMirror,
    requireAuthorizationMirror,
    selectAuthorizationMirror({ current, bootstrap, relayContext, bindRelayAuthorizationContext }) {
      authorizationMirror = selectPandaBurnAuthorizationMirror(current, bootstrap, relayContext, bindRelayAuthorizationContext, dispatchContext.authorizationMirror);
      dispatchContext.authorizationMirror = authorizationMirror;
      return authorizationMirror;
    },
    dispatchContext,
    dispatch(command, context) {
      const activeAuthorizationMirror = selectPandaBurnAuthorizationMirror(
        context.authorizationMirror,
        null,
        context.activeRelayContext || null,
        null,
        authorizationMirror || dispatchContext.authorizationMirror,
      );
      if (activeAuthorizationMirror) {
        authorizationMirror = activeAuthorizationMirror;
        dispatchContext.authorizationMirror = activeAuthorizationMirror;
      }
      return dispatchPandaBurnCommand(command, { ...dispatchContext, ...context, authorizationMirror: activeAuthorizationMirror });
    },
    errorResponse(error) {
      return errorPayload("panda_burn_adapter_error", String(error?.message || error));
    },
  });
}

export async function dispatchPandaBurnCommand(command, context = {}) {
  if (!command || typeof command !== "object") return errorPayload("invalid_command", "command must be an object");
  const commandDefaults = usageCommandDefaults(command.type);
  if (!commandDefaults) {
    return dispatchBurnCommand(normalizeBurnRelayCommand(command), ensureRelayDispatchContext(context));
  }
  const input = command.input && typeof command.input === "object" ? command.input : {};
  try {
    if (commandDefaults.maintenance === "compact") {
      return redactMaintenanceForRelay(await compactUsageLedgerCache({
        project: input.project || input.cwd,
        home: input.home || input.burn_home || input.burnHome,
      }));
    }
    return await generateUsageLedger({
      project: input.project || input.cwd,
      home: input.home || input.burn_home || input.burnHome,
      source: input.source,
      profileId: input.profile_id || input.profileId,
      profileIds: input.profile_ids || input.profileIds,
      excludeProfileIds: input.exclude_profile_ids || input.excludeProfileIds,
      from: input.from,
      to: input.to,
      timezone: input.timezone || input.time_zone,
      maxFiles: input.max_files || input.maxFiles,
      maxDepth: input.max_depth || input.maxDepth,
      dimensionLimit: input.dimension_limit || input.dimensionLimit,
      view: input.view || input.select || input.output_view || input.outputView || commandDefaults.view,
      dimension: input.dimension,
      limit: input.limit,
      force: commandDefaults.force || input.force,
      snapshot: commandDefaults.snapshot || input.snapshot || input.cached || input.cache_only,
      responseMode: "relay",
    });
  } catch (error) {
    return errorPayload(cleanErrorCode(error), safeBusinessErrorMessage(error));
  }
}

function localDispatchContext(options = {}) {
  const root = resolve(options.root || process.env.PANDA_BURN_ROOT || process.env.BURN_ROOT || processCwd());
  const cliExecutions = [];
  const syncExecutions = [];
  const chatMemoryErrors = [];
  const requireAuthorizationMirror = options.requireAuthorizationMirror === true
    || process.env.PANDA_BURN_REQUIRE_AUTHORIZATION_MIRROR === "1"
    || process.env.BURN_REQUIRE_AUTHORIZATION_MIRROR === "1";
  const explicitAuthorizationMirror = providedAuthorizationMirror(options);
  return {
    ...(options.dispatchContext || {}),
    root,
    cli: options.cli || process.env.PANDA_BURN_CLI || process.env.BURN_CLI || localBackendCli,
    burnCli: options.burnCli || process.env.PANDA_BURN_CLI || process.env.BURN_CLI || localBackendCli,
    burnAppHome: options.burnAppHome || options.burn_app_home || process.env.BURN_APP_HOME || "",
    localToolsRoot,
    cliExecutions,
    syncExecutions,
    chatMemoryErrors,
    chatTimeoutMs: positiveNumber(options.chatTimeoutMs || process.env.BURN_RELAY_CHAT_TIMEOUT_MS, 240000),
    codexMaxTimeoutMs: positiveNumber(options.codexMaxTimeoutMs || process.env.BURN_RELAY_CODEX_TIMEOUT_MS, 210000),
    agentTimeoutMs: positiveNumber(options.agentTimeoutMs || process.env.BURN_RELAY_AGENT_TIMEOUT_MS, 60000),
    usageLedgerTimeoutMs: positiveNumber(options.usageLedgerTimeoutMs || process.env.BURN_RELAY_USAGE_TIMEOUT_MS, 300000),
    authorizationMirror: explicitAuthorizationMirror || (requireAuthorizationMirror ? null : managedLocalAuthorizationMirror(root)),
  };
}

function providedAuthorizationMirror(options = {}) {
  return normalizeAuthorizationMirror(
    options.authorizationMirror
    || options.dispatchContext?.authorizationMirror
    || process.env.PANDA_BURN_AUTHORIZATION_MIRROR_JSON
    || process.env.BURN_AUTHORIZATION_MIRROR_JSON,
  );
}

function ensureRelayDispatchContext(context = {}) {
  const defaults = localDispatchContext(context);
  const merged = { ...defaults, ...context };
  merged.authorizationMirror = selectPandaBurnAuthorizationMirror(
    merged.authorizationMirror,
    null,
    merged.activeRelayContext || null,
    null,
    defaults.authorizationMirror,
  );
  return merged;
}

function normalizeBurnRelayCommand(command) {
  return {
    ...command,
    version: command.version || "burn-relay-v1",
  };
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function selectPandaBurnAuthorizationMirror(current, bootstrap, relayContext, bindRelayAuthorizationContext, fallback) {
  if (current && mirrorHasLocalRoots(current) && (!bootstrap || !mirrorHasLocalRoots(bootstrap))) {
    return typeof bindRelayAuthorizationContext === "function" && relayContext
      ? bindRelayAuthorizationContext(current, relayContext)
      : current;
  }
  if (bootstrap) return bootstrap;
  if (current) {
    return typeof bindRelayAuthorizationContext === "function" && relayContext
      ? bindRelayAuthorizationContext(current, relayContext)
      : current;
  }
  return fallback || null;
}

function mirrorHasLocalRoots(mirror) {
  return authorizationRootValues(mirror).length > 0;
}

function normalizeAuthorizationMirror(input) {
  if (!input) return null;
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }
  return typeof input === "object" ? input : null;
}

function managedLocalAuthorizationMirror(root) {
  return {
    product_id: PRODUCT_ID,
    status: "active",
    authorization_epoch: 1,
    authorization_context: {
      product_id: PRODUCT_ID,
      device_id: "managed-local",
      authorization_id: "managed-local",
      authorization_epoch: 1,
      relay_key_id: "managed-local",
    },
    product_authorization: {
      control: "product-controlled",
      roots: [root],
    },
    policy: {
      product_authorization: {
        control: "product-controlled",
        roots: [root],
      },
    },
  };
}

function errorPayload(code, message) {
  return {
    ok: false,
    schema: "panda-burn.error.v1",
    code,
    error: code,
    message,
  };
}

function cleanErrorCode(error) {
  const code = String(error?.code || error?.error || "usage_ledger_failed").trim();
  return /^[a-z][a-z0-9_]{1,80}$/.test(code) ? code : "usage_ledger_failed";
}

function safeBusinessErrorMessage(error) {
  const code = cleanErrorCode(error);
  const messages = {
    invalid_source: "source must be codex or claude",
    invalid_dimension: "usage dimension is invalid",
    invalid_response_mode: "invalid response mode",
    invalid_timezone: "timezone is invalid",
    invalid_view: "usage view is invalid",
    profile_not_found: "profile was not found",
    project_not_directory: "project path must be a directory",
    project_not_found: "project path was not found",
    project_path_must_be_absolute: "project path must be absolute",
    project_required: "project path is required",
    usage_snapshot_not_found: "usage ledger snapshot was not found",
  };
  return messages[code] || "usage ledger failed";
}

function usageCommandDefaults(type) {
  const suffix = String(type || "").replace(/^burn\.agent\.usage\./, "");
  if (suffix === "summary") return { view: "summary", snapshot: false };
  if (suffix === "refresh") return { view: "summary", snapshot: false, force: true };
  if (suffix === "status") return { view: "diagnostics", snapshot: true };
  if (suffix === "snapshot") return { view: "summary", snapshot: true };
  if (["totals", "activity", "heatmap", "filters", "diagnostics", "pricing", "dimensions"].includes(suffix)) {
    return { view: suffix, snapshot: false };
  }
  if (suffix === "dimension") return { view: "dimension", snapshot: false };
  if (suffix === "compact") return { maintenance: "compact" };
  return null;
}

function redactMaintenanceForRelay(result) {
  const copy = JSON.parse(JSON.stringify(result));
  delete copy.project;
  delete copy.cache_dir;
  if (copy.storage) {
    delete copy.storage.burn_home;
    delete copy.storage.ledger_dir;
  }
  copy.redaction = {
    raw_paths: "omitted_from_relay_response",
    local_files: "raw paths remain only in the local Burn user data usage ledger",
  };
  return copy;
}

if (isMainModule()) {
  const command = process.argv[2] || "serve";
  if (command !== "serve") {
    process.stderr.write(`${JSON.stringify({ ok: false, error: "unknown_command", command })}\n`);
    process.exit(2);
  }
  startPandaBurnAdapter().then((runtime) => {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      product_id: PRODUCT_ID,
      url: runtime.url,
      relay_key_exchange: runtime.relayKeyExchange,
    })}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: String(error?.message || error),
      code: error?.code || "panda_burn_adapter_error",
    })}\n`);
    process.exit(1);
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return false;
  }
}
