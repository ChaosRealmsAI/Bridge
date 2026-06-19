import {
  ackBurnSyncEvents,
  collectBurnSyncEvents,
  createBurnProject,
  listBurnProjects,
  monitorBurnSessions,
  setBurnProjectPreference,
  setBurnSessionPreference,
} from "../../../backend/burn-business-lib.mjs";
import { authorizedProjectRoots, resolveAuthorizedRoots } from "./path-policy.mjs";
import { buildSnapshot } from "./snapshot.mjs";

const BURN_BUSINESS_TYPES = new Set([
  "burn.project.list",
  "burn.project.create",
  "burn.project.preference.set",
  "burn.session.preference.set",
  "burn.monitor.sessions",
  "burn.business.sync.ack",
]);

export function isBurnBusinessCommand(type) {
  return BURN_BUSINESS_TYPES.has(String(type || ""));
}

export async function runBurnBusinessCommand(command, context) {
  const input = command.input || {};
  const authorizedRoots = await resolveAuthorizedRoots(authorizedProjectRoots(context));
  const options = {
    home: context.burnAppHome || process.env.BURN_APP_HOME,
    root: authorizedRoots[0] || context.root,
    authorizedRoots,
  };
  try {
    let data;
    switch (command.type) {
      case "burn.project.list":
        data = await listBurnProjects({ ...input, ...options });
        break;
      case "burn.project.create":
        data = await createBurnProject(input, options);
        break;
      case "burn.project.preference.set":
        data = await setBurnProjectPreference(input, options);
        break;
      case "burn.session.preference.set":
        data = await setBurnSessionPreference(input, options);
        break;
      case "burn.monitor.sessions": {
        const snapshot = await buildSnapshot(context, input);
        data = await monitorBurnSessions({ ...input, snapshot }, options);
        break;
      }
      case "burn.business.sync.ack":
        data = await ackBurnSyncEvents(input, options);
        break;
      default:
        throw codedError("burn_business_command_not_allowed", "Burn business command not allowed");
    }
    const response = {
      ok: true,
      version: command.version || "burn-relay-v1",
      type: command.type,
      request_id: command.request_id || null,
      generated_at: new Date().toISOString(),
      data,
    };
    return attachBurnSyncEvents(command, response, options);
  } catch (error) {
    return {
      ok: false,
      version: command.version || "burn-relay-v1",
      type: command.type,
      request_id: command.request_id || null,
      error: error.code || "burn_business_failed",
      code: error.code || "burn_business_failed",
      message: String(error.message || error).slice(0, 800),
      cause_code: error.code || "",
    };
  }
}

export async function attachBurnSyncEvents(command, response, options = {}) {
  if (!response || response.ok !== true || command.type === "burn.business.sync.ack") return response;
  const events = await collectBurnSyncEvents({ ...options, limit: 80 }).catch((error) => {
    response.sync = {
      schema: "burn.sync.response.v1",
      project: "",
      channel: "burn-business",
      events: [],
      error: "burn_sync_outbox_failed",
      message: String(error?.message || error).slice(0, 300),
    };
    return [];
  });
  if (!events.length) return response;
  response.sync = {
    schema: "burn.sync.response.v1",
    project: events[0]?.project || "burn-app",
    channel: "burn-business",
    events,
    cursor: {
      stream_id: events.at(-1)?.stream_id || "",
      seq: events.at(-1)?.seq || 0,
    },
    ack_type: "burn.business.sync.ack",
  };
  return response;
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}
