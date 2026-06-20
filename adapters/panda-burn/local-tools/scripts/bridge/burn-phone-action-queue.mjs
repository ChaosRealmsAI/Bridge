#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { getActionDescriptor, listActions, validateActionInput } from "../../backend/burn-actions.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PENDING = 200;
const DEFAULT_TTL_MS = 120_000;

export async function startPhoneActionQueue(options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number(options.port || process.env.PORT || 0);
  const enqueueToken = options.enqueueToken || options.token || process.env.BURN_PHONE_ACTION_TOKEN || randomBytes(24).toString("base64url");
  const appToken = options.appToken || process.env.BURN_PHONE_ACTION_APP_TOKEN || randomBytes(24).toString("base64url");
  const items = [];
  let nextSeq = 1;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://burn-phone-action.local");
      if (request.method === "GET" && url.pathname === "/v1/phone-actions/manifest") {
        assertAuth(request, [enqueueToken, appToken]);
        return writeJson(response, 200, { ok: true, actions: listActions({ target: "phone" }) });
      }
      if (request.method === "POST" && url.pathname === "/v1/phone-actions") {
        assertAuth(request, [enqueueToken]);
        expireItems(items);
        if (items.filter((item) => item.status === "pending").length >= MAX_PENDING) {
          return writeJson(response, 429, { ok: false, code: "phone_action_queue_full", error: "phone action queue full" });
        }
        const body = await readJson(request);
        validateCommand(body);
        const now = Date.now();
        const item = {
          id: `pa_${now}_${Math.random().toString(16).slice(2)}`,
          seq: nextSeq++,
          status: "pending",
          ok: null,
          version: "burn-phone-action-v1",
          request_id: clean(body.request_id) || `pa_req_${now}`,
          action_id: clean(body.action_id),
          input: body.input && typeof body.input === "object" ? body.input : {},
          created_at: new Date(now).toISOString(),
          expires_at_ms: now + Math.min(Math.max(Number(body.ttl_ms || DEFAULT_TTL_MS), 1000), 10 * 60_000),
          result: null,
          error: null,
        };
        items.push(item);
        return writeJson(response, 201, publicItem(item));
      }
      if (request.method === "GET" && url.pathname === "/v1/phone-actions/poll") {
        assertAuth(request, [appToken]);
        expireItems(items);
        const afterSeq = Number(url.searchParams.get("after_seq") || 0);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 50);
        const pending = items
          .filter((item) => item.status === "pending" && item.seq > afterSeq)
          .slice(0, limit)
          .map(publicItem);
        return writeJson(response, 200, { ok: true, items: pending, next_seq: pending.at(-1)?.seq || afterSeq });
      }
      const ackMatch = url.pathname.match(/^\/v1\/phone-actions\/([^/]+)\/ack$/);
      if (request.method === "POST" && ackMatch) {
        assertAuth(request, [appToken]);
        expireItems(items);
        const item = items.find((candidate) => candidate.id === decodeURIComponent(ackMatch[1]));
        if (!item) return writeJson(response, 404, { ok: false, code: "phone_action_not_found", error: "phone action not found" });
        if (item.status !== "pending") {
          const code = item.status === "expired" ? "phone_action_expired" : "phone_action_not_pending";
          return writeJson(response, 409, { ok: false, code, error: code, status: item.status });
        }
        const body = await readJson(request);
        item.ok = body.ok !== false;
        item.status = item.ok ? "acked" : "failed";
        item.result = body.result && typeof body.result === "object" ? body.result : null;
        item.error = item.ok ? null : clean(body.error || "phone_action_failed");
        item.acked_at = new Date().toISOString();
        return writeJson(response, 200, publicItem(item));
      }
      const getMatch = url.pathname.match(/^\/v1\/phone-actions\/([^/]+)$/);
      if (request.method === "GET" && getMatch) {
        assertAuth(request, [enqueueToken, appToken]);
        expireItems(items);
        const item = items.find((candidate) => candidate.id === decodeURIComponent(getMatch[1]));
        if (!item) return writeJson(response, 404, { ok: false, code: "phone_action_not_found", error: "phone action not found" });
        return writeJson(response, 200, publicItem(item));
      }
      return writeJson(response, 404, { ok: false, code: "not_found", error: "not found" });
    } catch (error) {
      return writeJson(response, Number(error.status || 400), {
        ok: false,
        code: error.code || "phone_action_queue_error",
        error: String(error.message || error),
      });
    }
  });

  await new Promise((resolveListen) => server.listen(port, host, resolveListen));
  const address = server.address();
  return {
    host: address.address,
    port: address.port,
    token: enqueueToken,
    enqueueToken,
    appToken,
    url: `http://${address.address}:${address.port}`,
    items,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function validateCommand(body) {
  if (!body || typeof body !== "object") throw coded("invalid_json", "invalid phone action body");
  if (body.version && body.version !== "burn-phone-action-v1") throw coded("unsupported_phone_action_version", "unsupported phone action version");
  const actionId = clean(body.action_id);
  if (!actionId) throw coded("missing_action_id", "missing action_id");
  const descriptor = getActionDescriptor(actionId);
  if (!descriptor || descriptor.target !== "phone") throw coded("unknown_phone_action", `phone action not allowed: ${actionId}`, 403);
  if (body.input !== undefined && (typeof body.input !== "object" || Array.isArray(body.input))) {
    throw coded("invalid_input", "input must be an object");
  }
  try {
    validateActionInput(descriptor, body.input || {});
  } catch (error) {
    throw coded(error.code || "invalid_input", error.message || "invalid phone action input");
  }
}

function assertAuth(request, validTokens) {
  const header = request.headers.authorization || "";
  if (!validTokens.some((token) => header === `Bearer ${token}`)) {
    throw coded("unauthorized", "invalid phone action token", 401);
  }
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw coded("body_too_large", "phone action body too large", 413);
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function expireItems(items) {
  const now = Date.now();
  for (const item of items) {
    if (item.status === "pending" && item.expires_at_ms <= now) {
      item.status = "expired";
      item.ok = false;
      item.error = "phone_action_expired";
    }
  }
}

function publicItem(item) {
  return {
    ok: item.ok !== false,
    id: item.id,
    seq: item.seq,
    status: item.status,
    version: item.version,
    request_id: item.request_id,
    action_id: item.action_id,
    input: item.input,
    created_at: item.created_at,
    acked_at: item.acked_at || null,
    result: item.result,
    error: item.error,
  };
}

function writeJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function clean(value) {
  return String(value || "").trim();
}

function coded(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") out.host = argv[++index];
    else if (arg === "--port") out.port = Number(argv[++index] || 0);
    else if (arg === "--token") out.token = argv[++index];
    else if (arg === "--enqueue-token") out.enqueueToken = argv[++index];
    else if (arg === "--app-token") out.appToken = argv[++index];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw coded("unknown_argument", `unknown argument: ${arg}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`Usage: node scripts/bridge/burn-phone-action-queue.mjs [--host 127.0.0.1] [--port 8798] [--enqueue-token TOKEN] [--app-token TOKEN]\n`);
    process.exit(0);
  }
  startPhoneActionQueue(args).then((queue) => {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      url: queue.url,
      enqueueToken: queue.enqueueToken,
      appToken: queue.appToken,
      env: {
        BURN_PHONE_ACTION_URL: queue.url,
        BURN_PHONE_ACTION_TOKEN: queue.enqueueToken,
        BURN_PHONE_ACTION_APP_TOKEN: queue.appToken,
      },
    }, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || "phone_action_queue_error", error: String(error.message || error) })}\n`);
    process.exit(1);
  });
}
