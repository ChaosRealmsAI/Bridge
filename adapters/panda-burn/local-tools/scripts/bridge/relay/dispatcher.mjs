import { adapterAuthorizationDenial, adapterDeniedResponse } from "./auth.mjs";
import { isBurnBusinessCommand, runBurnBusinessCommand } from "./burn-business-runner.mjs";
import { isBurnStoreCommand, publicStoreData, runBurnStoreCommand } from "./burn-store-runner.mjs";
import { stableHash, statusBurnStore } from "../../../backend/burn-store-lib.mjs";
import { isAgentCommand, runBurnAgentCommand } from "./agent-runner.mjs";
import { runBurnChat, runBurnSessionsShow } from "./chat-runner.mjs";
import { isProjectCommand, runBurnProject } from "./project-runner.mjs";
import { buildSnapshot, listRootEntries } from "./snapshot.mjs";
import { authorizationRootValues, authorizedProjectRoots, resolveAuthorizedRoots } from "./path-policy.mjs";
import { isActionCommand, runBurnActionCommand } from "./workspace-runner.mjs";

// Burn store diagnostics stay in the product adapter: burn.store.status / burn.store.doctor.
export async function dispatchBurnCommand(command, context) {
  try {
    return await dispatchBurnCommandUnsafe(command, context);
  } catch (error) {
    if (isLocalPolicyDenied(error)) {
      return adapterDeniedResponse(command || {}, {
        error: "local_policy_denied",
        message: "local_policy_denied",
      });
    }
    throw error;
  }
}

async function dispatchBurnCommandUnsafe(command, context) {
  if (!command || typeof command !== "object") throw new Error("invalid_command");
  if (!["burn-relay-v1", "burn-relay-v1"].includes(command.version)) throw new Error("unsupported_schema");
  const policyDenial = adapterAuthorizationDenial(command, context.authorizationMirror);
  if (policyDenial) return adapterDeniedResponse(command, policyDenial);
  if (command.type === "burn.relay.health" || command.type === "burn.relay.health") {
    const data = relayHealthData(context.authorizationMirror);
    if (command.type === "burn.relay.health") {
      data.burn_store = publicStoreData(await statusBurnStore({ home: context.burnAppHome, project: context.root }));
    }
    return {
      ok: true,
      version: command.version,
      type: command.type,
      request_id: command.request_id || null,
      generated_at: new Date().toISOString(),
      data,
    };
  }
  if (isBurnStoreCommand(command.type)) return runBurnStoreCommand(command, context);
  if (isBurnBusinessCommand(command.type)) return runBurnBusinessCommand(command, context);
  if (command.type === "burn.snapshot.get") {
    return {
      ok: true,
      version: "burn-relay-v1",
      type: command.type,
      request_id: command.request_id || null,
      generated_at: new Date().toISOString(),
      data: await buildSnapshot(context, command.input || {}),
    };
  }
  if (isProjectCommand(command.type)) return runBurnProject(command, context);
  if (command.type === "burn.sessions.show") return runBurnSessionsShow(command, context);
  if (command.type === "burn.probe.pwd") {
    const root = await diagnosticRoot(context);
    return { ok: true, version: "burn-relay-v1", type: command.type, request_id: command.request_id || null, data: { cwd: root } };
  }
  if (command.type === "burn.probe.ls") {
    const root = await diagnosticRoot(context);
    const entries = await listRootEntries(root);
    return { ok: true, version: "burn-relay-v1", type: command.type, request_id: command.request_id || null, data: { path: ".", entries } };
  }
  if (isAgentCommand(command.type)) return runBurnAgentCommand(command, context);
  if (command.type === "burn.chat") return runBurnChat(command, context);
  if (isActionCommand(command.type)) return runBurnActionCommand(command, context);
  throw new Error("command_not_allowed");
}

function isLocalPolicyDenied(error) {
  const message = String(error?.message || error || "");
  return error?.code === "local_policy_denied" || message.includes("local_policy_denied");
}

async function diagnosticRoot(context) {
  const roots = await resolveAuthorizedRoots(authorizedProjectRoots(context));
  return roots[0] || context.root;
}

function relayHealthData(mirror) {
  const authorizationContext = mirror?.authorization_context || mirror?.authorizationContext || {};
  const productAuthorization = mirror?.product_authorization || mirror?.productAuthorization || mirror?.policy?.product_authorization || mirror?.policy?.productAuthorization || {};
  const roots = authorizationRootValues(mirror);
  const control = productAuthorization.control || productAuthorization.mode || productAuthorization.enforcement || "product-controlled";
  return {
    product_id: mirror?.product_id || authorizationContext.product_id || "panda-burn",
    adapter_ready: true,
    authorization_status: mirror?.status || "unknown",
    product_control: control,
    authorization_epoch: Number(mirror?.authorization_epoch || authorizationContext.authorization_epoch || 1),
    device_hash: shortHash(mirror?.device_id || authorizationContext.device_id || ""),
    authorization_hash: shortHash(mirror?.authorization_id || authorizationContext.authorization_id || ""),
    relay_key_hash: shortHash(mirror?.relay_key_id || authorizationContext.relay_key_id || ""),
    authorized_root_count: new Set(roots).size,
    checked_at: new Date().toISOString(),
  };
}

function shortHash(value) {
  const text = String(value || "");
  if (!text) return "";
  return stableHash(text);
}
