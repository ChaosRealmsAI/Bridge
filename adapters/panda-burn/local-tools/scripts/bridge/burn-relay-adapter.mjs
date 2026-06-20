import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cwd as processCwd, env } from "node:process";

import { createBridgeProductAdapterRuntime } from "./relay/bridge-adapter-sdk.mjs";
import { normalizeAuthorizationMirror } from "./relay/auth.mjs";
import {
  createRelayKeyState,
  decryptEnvelope,
  decryptBurnResponseEnvelope,
  encryptResponseEnvelope,
  encryptBurnCommandEnvelope,
  keyBytesFromBase64,
} from "./relay/crypto.mjs";
import { dispatchBurnCommand } from "./relay/dispatcher.mjs";
import { authorizationRootValues } from "./relay/path-policy.mjs";
import { buildSnapshot } from "./relay/snapshot.mjs";
import { positiveNumber } from "./relay/utils.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultCli = resolve(repoRoot, "backend/burn");

export {
  buildSnapshot,
  decryptEnvelope,
  decryptBurnResponseEnvelope,
  dispatchBurnCommand,
  encryptResponseEnvelope,
  encryptBurnCommandEnvelope,
};

export async function startBurnRelayAdapter(options = {}) {
  const defaultKeyB64 = options.keyB64 || env.BURN_RELAY_KEY_B64 || "";
  const defaultKeyBytes = options.keyBytes || (defaultKeyB64 ? keyBytesFromBase64(defaultKeyB64) : null);
  const relayKeyState = options.relayKeyState || await createRelayKeyState(options.relayKeyJwk || options.relayKeyJWK || {});
  const root = await import("node:fs/promises").then(({ realpath }) => realpath(options.root || repoRoot));
  const cli = options.cli || env.BURN_CLI || defaultCli;
  const burnAppHome = options.burnAppHome || options.burn_app_home || env.BURN_APP_HOME || "";
  const cliExecutions = [];
  const syncExecutions = [];
  const activeAgentTurns = new Map();
  let authorizationMirror = normalizeAuthorizationMirror(options.authorizationMirror || env.BURN_AUTHORIZATION_MIRROR_JSON);
  const requireAuthorizationMirror = Boolean(options.requireAuthorizationMirror || env.BURN_REQUIRE_AUTHORIZATION_MIRROR === "1");
  if (requireAuthorizationMirror && !authorizationMirror) {
    throw new Error("authorization_mirror_required");
  }
  const runtime = await createBridgeProductAdapterRuntime({
    productId: "panda-burn",
    schemaId: "burn-relay-v1",
    host: options.host || "127.0.0.1",
    port: Number(options.port || env.PORT || 0),
    keyBytes: defaultKeyBytes,
    relayKeyState,
    responseCacheEntries: options.responseCacheEntries || 500,
    authorizationMirror,
    requireAuthorizationMirror,
    selectAuthorizationMirror({ current, bootstrap, relayContext, bindRelayAuthorizationContext }) {
      authorizationMirror = selectBurnAuthorizationMirror(current, bootstrap, relayContext, bindRelayAuthorizationContext);
      return authorizationMirror;
    },
    dispatchContext: {
      root,
      cli,
      burnAppHome,
      cliExecutions,
      syncExecutions,
      activeAgentTurns,
      chatTimeoutMs: positiveNumber(options.chatTimeoutMs || env.BURN_RELAY_CHAT_TIMEOUT_MS, 240000),
      codexMaxTimeoutMs: positiveNumber(options.codexMaxTimeoutMs || env.BURN_RELAY_CODEX_TIMEOUT_MS, 210000),
      agentTimeoutMs: positiveNumber(options.agentTimeoutMs || env.BURN_RELAY_AGENT_TIMEOUT_MS, 60000),
      usageLedgerTimeoutMs: positiveNumber(options.usageLedgerTimeoutMs || env.BURN_RELAY_USAGE_TIMEOUT_MS, 300000),
    },
    onProgressEnvelope: options.onProgressEnvelope,
    dispatch(command, context) {
      const activeAuthorizationMirror = mirrorHasLocalRoots(context.authorizationMirror)
        ? context.authorizationMirror
        : (mirrorHasLocalRoots(authorizationMirror) ? authorizationMirror : context.authorizationMirror || authorizationMirror);
      authorizationMirror = activeAuthorizationMirror;
      return dispatchBurnCommand(command, {
        ...context,
        authorizationMirror: activeAuthorizationMirror,
        root,
        cli,
        burnAppHome,
        cliExecutions,
        syncExecutions,
        activeAgentTurns,
        chatTimeoutMs: positiveNumber(options.chatTimeoutMs || env.BURN_RELAY_CHAT_TIMEOUT_MS, 240000),
        codexMaxTimeoutMs: positiveNumber(options.codexMaxTimeoutMs || env.BURN_RELAY_CODEX_TIMEOUT_MS, 210000),
        agentTimeoutMs: positiveNumber(options.agentTimeoutMs || env.BURN_RELAY_AGENT_TIMEOUT_MS, 60000),
        usageLedgerTimeoutMs: positiveNumber(options.usageLedgerTimeoutMs || env.BURN_RELAY_USAGE_TIMEOUT_MS, 300000),
      });
    },
    errorResponse(error) {
      return {
        ok: false,
        error: "burn_adapter_denied",
        reason: String(error?.message || error),
      };
    },
  });

  return {
    ...runtime,
    keyBytes: defaultKeyBytes,
    root,
    cli,
    cliExecutions,
    syncExecutions,
    relayKeyState,
    relayKeyExchange: runtime.relayKeyExchange,
    get authorizationMirror() {
      return runtime.authorizationMirror;
    },
  };
}

function selectBurnAuthorizationMirror(current, bootstrap, relayContext, bindRelayAuthorizationContext) {
  if (current && mirrorHasLocalRoots(current) && (!bootstrap || !mirrorHasLocalRoots(bootstrap))) {
    return bindRelayAuthorizationContext(current, relayContext);
  }
  if (bootstrap) return bootstrap;
  return current ? bindRelayAuthorizationContext(current, relayContext) : null;
}

function mirrorHasLocalRoots(mirror) {
  return authorizationRootValues(mirror).length > 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBurnRelayAdapter({ root: processCwd() }).then((adapter) => {
    console.log(JSON.stringify({
      ok: true,
      url: adapter.url,
      root: adapter.root,
      cli: adapter.cli,
      product_id: "panda-burn",
      relay_key_exchange: adapter.relayKeyExchange,
      env: {
        desktop_adapter_url: `PANDA_BRIDGE_ADAPTER_PANDA_BURN_URL=${adapter.url}`,
      },
    }, null, 2));
  }).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    process.exit(1);
  });
}
