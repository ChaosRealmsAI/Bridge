import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { ACTION_VERSION, defaultCli, PHONE_ACTION_VERSION } from "./constants.mjs";
import { getActionDescriptor } from "./registry.mjs";
import { codedError, validateActionInput } from "./validation.mjs";

export async function runAction(id, options = {}) {
  const descriptor = getActionDescriptor(id);
  if (!descriptor) throw codedError("unknown_action", `unknown action: ${id}`);
  const input = options.input || {};
  validateActionInput(descriptor, input);
  const requestId = options.requestId || `act_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  if (options.dryRun) {
    return {
      ok: true,
      version: ACTION_VERSION,
      action_id: descriptor.id,
      request_id: requestId,
      dry_run: true,
      target: descriptor.target,
      risk: descriptor.risk,
      input,
    };
  }
  if (descriptor.target === "phone") {
    return postPhoneAction(descriptor, input, { ...options, requestId });
  }
  const project = await realpath(resolve(options.project || input.project || process.cwd()));
  const cli = options.cli || defaultCli;
  const args = descriptor.toCli(input, project);
  const stdout = await exec(await runnable(cli), args, {
    cwd: project,
    timeout: options.timeoutMs || 240000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: true,
    version: ACTION_VERSION,
    action_id: descriptor.id,
    request_id: requestId,
    target: descriptor.target,
    risk: descriptor.risk,
    command: { argv: ["burn", ...args] },
    data: stdout.trim() ? JSON.parse(stdout) : null,
  };
}

async function postPhoneAction(descriptor, input, options) {
  const baseUrl = String(options.phoneUrl || process.env.BURN_PHONE_ACTION_URL || "").replace(/\/$/, "");
  const token = String(options.phoneToken || process.env.BURN_PHONE_ACTION_TOKEN || "");
  if (!baseUrl) throw codedError("phone_action_transport_missing", "missing --phone-url or BURN_PHONE_ACTION_URL");
  if (!token) throw codedError("phone_action_token_missing", "missing --phone-token or BURN_PHONE_ACTION_TOKEN");
  const body = {
    version: PHONE_ACTION_VERSION,
    request_id: options.requestId,
    action_id: descriptor.id,
    input,
    ttl_ms: Number(options.ttlMs || 120000),
    created_at: new Date().toISOString(),
  };
  const queued = await httpJson(`${baseUrl}/v1/phone-actions`, { method: "POST", token, body });
  const waitMs = Number(options.waitMs ?? 30000);
  if (!waitMs) {
    return {
      ok: true,
      version: ACTION_VERSION,
      action_id: descriptor.id,
      request_id: options.requestId,
      target: "phone",
      queued,
    };
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const current = await httpJson(`${baseUrl}/v1/phone-actions/${encodeURIComponent(queued.id)}`, {
      method: "GET",
      token,
    });
    if (["acked", "failed", "expired"].includes(current.status)) {
      return {
        ok: current.status === "acked" && current.ok !== false,
        version: ACTION_VERSION,
        action_id: descriptor.id,
        request_id: options.requestId,
        target: "phone",
        phone_action: current,
      };
    }
    await sleep(350);
  }
  throw codedError("phone_action_ack_timeout", `phone action did not ack within ${waitMs}ms`);
}

async function httpJson(url, { method, token, body }) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
      authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw codedError(payload.code || payload.error || `http_${response.status}`, payload.message || payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function runnable(command) {
  if (command !== defaultCli) return command;
  try {
    await access(command, constants.X_OK);
    return command;
  } catch {
    return defaultCli;
  }
}

function exec(command, args, options) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) return rejectExec(codedError("action_command_failed", stderr.trim() || error.message));
      resolveExec(stdout);
    });
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
