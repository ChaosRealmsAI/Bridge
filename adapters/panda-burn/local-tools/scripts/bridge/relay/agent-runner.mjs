import { env } from "node:process";
import { appendChatMemoryEvent } from "../../../backend/burn-chat-memory-lib.mjs";
import { agentAccountArgs } from "./agent-account-args.mjs";
import { runUsageLedgerCommand } from "./agent-usage-ledger.mjs";
import { parseCliError, runCli, runCliJsonStream, terminateProcessTree } from "./cli.mjs";
import { authorizedProjectRoots, resolveAuthorizedProject } from "./path-policy.mjs";
import { cleanText, positiveNumber, sha256 } from "./utils.mjs";

const AGENT_COMMANDS = new Set([
  "burn.agent.profiles.discover",
  "burn.agent.profile.status",
  "burn.agent.profile.resolve",
  "burn.agent.accounts.list",
  "burn.agent.accounts.get",
  "burn.agent.accounts.active",
  "burn.agent.login.diagnostics",
  "burn.agent.capabilities.get",
  "burn.agent.usage.summary",
  "burn.agent.usage.refresh",
  "burn.agent.usage.status",
  "burn.agent.usage.snapshot",
  "burn.agent.usage.totals",
  "burn.agent.usage.activity",
  "burn.agent.usage.heatmap",
  "burn.agent.usage.filters",
  "burn.agent.usage.diagnostics",
  "burn.agent.usage.pricing",
  "burn.agent.usage.dimension",
  "burn.agent.usage.dimensions",
  "burn.agent.usage.compact",
  "burn.agent.claude.quota.cache",
  "burn.agent.claude.quota.refresh",
  "burn.agent.quota.list",
  "burn.agent.quota.probe",
  "burn.agent.health.scan",
  "burn.agent.observer.status",
  "burn.agent.observer.sources",
  "burn.agent.observer.deltas.list",
  "burn.agent.observer.watch.start",
  "burn.agent.observer.watch.stop",
  "burn.agent.observer.perf",
  "burn.agent.abnormal.watch",
  "burn.agent.abnormal.list",
  "burn.agent.abnormal.scan",
  "burn.agent.sources.list",
  "burn.agent.source.status",
  "burn.agent.sessions.list",
  "burn.agent.session.show",
  "burn.agent.session.watch",
  "burn.agent.session.create",
  "burn.agent.session.continue",
  "burn.agent.turn.interrupt",
]);

export function isAgentCommand(type) {
  return AGENT_COMMANDS.has(type);
}

export async function runBurnAgentCommand(command, context) {
  const input = command.input || {};
  if (command.type.startsWith("burn.agent.usage.")) {
    return runUsageLedgerCommand(command, context);
  }
  const project = projectInput(input);
  const cwd = project
    ? await resolveAuthorizedProject(project, context.root, authorizedProjectRoots(context))
    : context.root;
  if (command.type === "burn.agent.session.watch") {
    return runAgentSessionWatch(command, input, cwd, context);
  }
  if (command.type === "burn.agent.turn.interrupt") {
    const activeInterrupt = interruptActiveAgentTurn(command, input, cwd, context);
    if (activeInterrupt) return activeInterrupt;
  }
  await recordAgentMemory(context, command, input, cwd, {
    event_type: "user_prompt",
    role: "user",
    status: "pending",
    text: cleanText(input.prompt),
    meta: { command_type: command.type, mode: cleanText(input.mode), model: cleanText(input.model) },
  });
  try {
    const args = await agentArgs(command.type, input, context);
    if (wantsStream(command.type, input)) {
      const activeTurn = createActiveAgentTurn(context, command, input, cwd);
      const data = await runCliJsonStream(context, args, {
        cwd,
        timeout: positiveNumber(context.agentTimeoutMs, 60000),
        env: agentEnv(context),
        wasInterrupted: () => activeTurn.status === "interrupted",
        onChild: (child) => {
          activeTurn.child = child;
          activeTurn.pid = child.pid || 0;
        },
      }, (event) => emitAgentProgress(command, input, cwd, event, context, activeTurn))
        .finally(() => cleanupActiveAgentTurn(context, activeTurn));
      await recordAgentMemory(context, command, input, cwd, {
        event_type: "assistant_final",
        role: "assistant",
        status: "final",
        session_id: finalSessionId(data),
        text: finalText(data),
        payload: data,
      });
      return {
        ok: true,
        version: "burn-relay-v1",
        type: command.type,
        request_id: command.request_id || null,
        data,
      };
    }
    const stdout = await runCli(context, args, {
      cwd,
      timeout: positiveNumber(context.agentTimeoutMs, 60000),
      maxBuffer: 16 * 1024 * 1024,
      env: agentEnv(context),
    });
    const data = JSON.parse(stdout);
    await recordAgentMemory(context, command, input, cwd, {
      event_type: "assistant_final",
      role: "assistant",
      status: "final",
      session_id: finalSessionId(data),
      text: finalText(data),
      payload: data,
    });
    return {
      ok: true,
      version: "burn-relay-v1",
      type: command.type,
      request_id: command.request_id || null,
      data,
    };
  } catch (error) {
    const parsed = parseCliError(error, "burn_agent_failed");
    await recordAgentMemory(context, command, input, cwd, {
      event_type: "agent_failed",
      role: "system",
      status: "failed",
      text: parsed.message,
      payload: { ok: false, error: parsed.code, code: parsed.code, message: parsed.message, cause_code: parsed.causeCode },
    });
    return {
      ok: false,
      version: "burn-relay-v1",
      type: command.type,
      request_id: command.request_id || null,
      error: parsed.code,
      code: parsed.code,
      message: parsed.message,
      cause_code: parsed.causeCode,
    };
  }
}

async function agentArgs(type, input, context) {
  if (type === "burn.agent.profiles.discover") {
    const args = ["agent", "profile", "discover"];
    if (input.quick !== false) args.push("--quick");
    args.push("--json");
    return args;
  }
  if (type === "burn.agent.profile.status") {
    const args = ["agent", "profile", "status", "--profile-id", required(input.profile_id || input.profileId, "profile_id")];
    if (input.deep === true) args.push("--deep");
    args.push("--json");
    return args;
  }
  if (type === "burn.agent.profile.resolve") {
    const args = [
      "agent",
      "profile",
      "resolve",
      "--source",
      required(input.source, "source"),
      "--project",
      await resolvedProject(input, context),
    ];
    const operation = cleanText(input.operation || input.op);
    if (operation) args.push("--operation", operation);
    const sessionId = cleanText(input.session_id || input.sessionId || input.id);
    if (sessionId) args.push("--session-id", sessionId);
    const preferred = cleanText(input.preferred_profile_id || input.preferredProfileId || input.profile_id || input.profileId);
    if (preferred) args.push("--preferred-profile-id", preferred);
    args.push("--json");
    return args;
  }
  const accountArgs = agentAccountArgs(type, input);
  if (accountArgs) return accountArgs;
  const observerArgs = agentObserverArgs(type, input);
  if (observerArgs) return observerArgs;
  if (type === "burn.agent.sources.list") return ["sources", "list", "--json"];
  const source = required(input.source, "source");
  if (type === "burn.agent.source.status") {
    return withProfile(["source", "status", "--source", source, "--project", await resolvedProject(input, context), "--json"], input);
  }
  if (type === "burn.agent.sessions.list") {
    return withProfile([
      "source",
      "sessions",
      "list",
      "--source",
      source,
      "--project",
      await resolvedProject(input, context),
      "--limit",
      String(limit(input, 50)),
      "--json",
    ], input);
  }
  if (type === "burn.agent.session.show") {
    const args = [
      "source",
      "session",
      "show",
      "--source",
      source,
      "--project",
      await resolvedProject(input, context),
      "--session-id",
      required(input.session_id || input.id, "session_id"),
      "--cursor",
      String(cursor(input)),
      "--limit",
      String(limit(input, 50)),
      "--json",
    ];
    if (input.latest === true || cleanText(input.order) === "latest") {
      args.splice(args.length - 1, 0, "--latest");
    }
    return withProfile(args, input);
  }
  if (type === "burn.agent.session.watch") {
    return withProfile(await sessionShowArgs(source, input, context), input);
  }
  if (type === "burn.agent.session.create") {
    return turnArgs("create", source, input, context);
  }
  if (type === "burn.agent.session.continue") {
    return turnArgs("continue", source, input, context);
  }
  if (type === "burn.agent.turn.interrupt") {
    const args = [
      "source",
      "turn",
      "interrupt",
      "--source",
      source,
      "--project",
      await resolvedProject(input, context),
      "--session-id",
      required(input.session_id || input.id, "session_id"),
      "--json",
    ];
    const turnId = cleanText(input.turn_id || input.turnId);
    if (turnId) args.splice(args.length - 1, 0, "--turn-id", turnId);
    return withProfile(args, input);
  }
  throw new Error("agent_command_not_allowed");
}

async function sessionShowArgs(source, input, context) {
  const args = [
    "source",
    "session",
    "show",
    "--source",
    source,
    "--project",
    await resolvedProject(input, context),
    "--session-id",
    required(input.session_id || input.id, "session_id"),
    "--cursor",
    String(cursor(input)),
    "--limit",
    String(limit(input, 1)),
    "--json",
  ];
  if (input.latest === true || input.latest !== false || cleanText(input.order) === "latest") {
    args.splice(args.length - 1, 0, "--latest");
  }
  return args;
}

async function runAgentSessionWatch(command, input, cwd, context) {
  const source = required(input.source, "source");
  const sessionId = required(input.session_id || input.id, "session_id");
  const project = await resolvedProject(input, context);
  const projectHandle = evidenceHandle(project, "project");
  const projectHash = evidenceHash(project);
  const profileId = cleanText(input.profile_id || input.profileId);
  const leaseMs = Math.max(5000, Math.min(positiveNumber(input.lease_ms || input.leaseMs, 30000), 120000));
  const intervalMs = Math.max(750, Math.min(positiveNumber(input.interval_ms || input.intervalMs, 2000), 10000));
  const startedAt = Date.now();
  const deadline = startedAt + leaseMs;
  let lastCursor = Math.max(0, positiveNumber(input.cursor, 0));
  let lastTotal = Math.max(0, positiveNumber(input.total_messages || input.totalMessages || input.total, 0));
  let lastFingerprint = cleanText(input.fingerprint || input.timeline_fingerprint || input.timelineFingerprint);
  let latestMeta = {
    source,
    project: projectHandle,
    project_hash: projectHash,
    session_id: sessionId,
    profile_id: profileId,
    cursor: lastCursor,
    total_messages: lastTotal,
    latest_page_item_count: 0,
    order: "latest",
    latest_message_id: "",
    latest_message_order_key: "",
    fingerprint: lastFingerprint,
    fingerprint_basis: "session.show/latest-page",
  };
  let emitted = 0;

  while (Date.now() < deadline) {
    const page = await readSessionWatchPage(source, input, project, cwd, context);
    const meta = sessionWatchPageMeta(page, {
      source,
      projectHandle,
      projectHash,
      sessionId,
      profileId,
    });
    const changed = lastFingerprint
      ? meta.fingerprint !== lastFingerprint
      : meta.cursor > lastCursor || (lastTotal > 0 && meta.total_messages > lastTotal);
    lastFingerprint = meta.fingerprint;
    latestMeta = meta;
    if (changed) {
      lastCursor = Math.max(lastCursor, meta.cursor);
      lastTotal = Math.max(lastTotal, meta.total_messages);
      emitted += 1;
      await emitSessionWatchProgress(command, input, context, {
        schema: "burn.agent.session.watch.event.v1",
        ...meta,
        reason: "jsonl_changed",
      });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  }

  return {
    ok: true,
    version: "burn-relay-v1",
    type: command.type,
    request_id: command.request_id || null,
    data: {
      schema: "burn.agent.session.watch.final.v1",
      ...latestMeta,
      emitted,
      status: "lease_expired",
    },
  };
}

function sessionWatchPageMeta(page, identity) {
  const messages = pageMessages(page);
  const cursorNow = pageCursor(page);
  const totalMessages = pageTotal(page);
  const order = pageOrder(page);
  const latestMessage = messages[messages.length - 1] || null;
  const latestMessageId = messageId(latestMessage);
  const latestMessageOrderIndex = messages.length > 0 ? cursorNow + messages.length - 1 : null;
  const latestMessageOrderKey = latestMessageOrderIndex === null ? "" : `${order}:${latestMessageOrderIndex}`;
  const transcriptPath = pageTranscriptPath(page);
  const transcriptHash = evidenceHash(transcriptPath);
  const latestPageItemCount = messages.length;
  const fingerprint = sessionWatchFingerprint({
    source: identity.source,
    projectHash: identity.projectHash,
    sessionId: identity.sessionId,
    profileId: identity.profileId,
    transcriptHash,
    cursor: cursorNow,
    totalMessages,
    latestPageItemCount,
    order,
    latestMessageId,
    latestMessageOrderKey,
    messages,
  });
  return {
    source: identity.source,
    project: identity.projectHandle,
    project_hash: identity.projectHash,
    session_id: identity.sessionId,
    profile_id: identity.profileId,
    transcript_path_display: evidenceHandle(transcriptPath, "transcript"),
    transcript_hash: transcriptHash,
    cursor: cursorNow,
    total_messages: totalMessages,
    latest_page_item_count: latestPageItemCount,
    order,
    latest_message_id: latestMessageId,
    latest_message_order_key: latestMessageOrderKey,
    fingerprint,
    fingerprint_basis: "session.show/latest-page",
  };
}

function sessionWatchFingerprint(meta) {
  return sha256(JSON.stringify({
    source: meta.source,
    project_hash: meta.projectHash,
    session_id: meta.sessionId,
    profile_id: meta.profileId,
    transcript_hash: meta.transcriptHash,
    cursor: meta.cursor,
    total_messages: meta.totalMessages,
    latest_page_item_count: meta.latestPageItemCount,
    order: meta.order,
    latest_message_id: meta.latestMessageId,
    latest_message_order_key: meta.latestMessageOrderKey,
    messages: meta.messages.map(messageFingerprintInput),
  }));
}

function messageFingerprintInput(message, index) {
  return {
    index,
    id: messageId(message),
    role: cleanText(message?.role),
    created_at: cleanText(message?.created_at || message?.ts || message?.timestamp),
    status: cleanText(message?.status),
    blocks: message?.blocks || [],
  };
}

function pageMessages(page) {
  if (Array.isArray(page?.messages)) return page.messages;
  if (Array.isArray(page?.data?.messages)) return page.data.messages;
  if (Array.isArray(page?.page?.messages)) return page.page.messages;
  return [];
}

function pageOrder(page) {
  return cleanText(page?.order || page?.page?.order) || "latest";
}

function messageId(message) {
  return cleanText(message?.id || message?.message_id || message?.messageId);
}

function evidenceHash(value) {
  const text = cleanText(value);
  return text ? sha256(text) : "";
}

function evidenceHandle(value, label) {
  const hash = evidenceHash(value);
  return hash ? `<${label}:${hash.slice(0, 16)}>` : "";
}

async function readSessionWatchPage(source, input, project, cwd, context) {
  const args = withProfile(await sessionShowArgs(source, {
    ...input,
    project,
    cursor: 0,
    limit: 1,
    latest: true,
  }, context), input);
  const stdout = await runCli(context, args, {
    cwd,
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    env: agentEnv(context),
  });
  return JSON.parse(stdout);
}

async function emitSessionWatchProgress(command, input, context, data) {
  if (typeof context.emitProgress !== "function") return;
  await context.emitProgress({
    ok: true,
    version: "burn-relay-v1",
    type: command.type,
    request_id: command.request_id || null,
    progress: true,
    schema: "burn.agent.session.watch.event.v1",
    data,
  });
}

function pageCursor(page) {
  return Math.max(0, positiveNumber(page?.cursor ?? page?.page?.cursor, 0));
}

function pageTotal(page) {
  return Math.max(0, positiveNumber(page?.total_messages ?? page?.total ?? page?.page?.total, 0));
}

function pageTranscriptPath(page) {
  return cleanText(page?.transcript_path || page?.summary?.transcript_path || page?.page?.transcript_path);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function turnArgs(kind, source, input, context) {
  const args = [
    "source",
    "session",
    kind,
    "--source",
    source,
    "--project",
    await resolvedProject(input, context),
  ];
  if (kind === "continue") args.push("--session-id", required(input.session_id || input.id, "session_id"));
  args.push("--prompt", required(input.prompt, "prompt"));
  const model = cleanText(input.model);
  if (model) args.push("--model", model);
  const mode = cleanText(input.mode);
  if (mode) args.push("--mode", mode);
  addOptions(args, input);
  if (wantsStream(`burn.agent.session.${kind}`, input)) args.push("--json-stream");
  args.push("--json");
  return withProfile(args, input);
}

function withProfile(args, input) {
  const profileId = cleanText(input.profile_id || input.profileId);
  if (!profileId) return args;
  return ["agent", ...args, "--profile-id", profileId];
}

function agentObserverArgs(type, input) {
  const map = {
    "burn.agent.observer.status": ["agent", "observer", "status"],
    "burn.agent.observer.sources": ["agent", "observer", "sources"],
    "burn.agent.observer.deltas.list": ["agent", "observer", "deltas", "list"],
    "burn.agent.observer.watch.start": ["agent", "observer", "watch", "start"],
    "burn.agent.observer.watch.stop": ["agent", "observer", "watch", "stop"],
    "burn.agent.observer.perf": ["agent", "observer", "perf"],
    "burn.agent.abnormal.list": ["agent", "abnormal", "list"],
    "burn.agent.abnormal.scan": ["agent", "abnormal", "scan"],
  };
  let args = map[type]?.slice();
  if (type === "burn.agent.abnormal.watch") {
    const action = cleanText(input.action || input.mode || input.watch_action || input.watchAction || "status");
    args = ["agent", "abnormal", "watch", ["start", "stop", "status"].includes(action) ? action : "status"];
  }
  if (!args) return null;
  appendOptional(args, "--source", input.source);
  appendOptional(args, "--history-limit", firstDefined(input.history_limit, input.historyLimit));
  appendOptional(args, "--max-files", firstDefined(input.max_files, input.maxFiles));
  appendOptional(args, "--max-depth", firstDefined(input.max_depth, input.maxDepth));
  appendOptional(args, "--stability-ms", firstDefined(input.stability_ms, input.stabilityMs));
  appendOptional(args, "--no-response-ms", firstDefined(input.no_response_ms, input.noResponseMs));
  appendOptional(args, "--interval-ms", firstDefined(input.interval_ms, input.intervalMs));
  appendOptional(args, "--lease-ms", firstDefined(input.lease_ms, input.leaseMs));
  appendOptional(args, "--classify-limit", firstDefined(input.classify_limit, input.classifyLimit));
  if (input.dry_run === true || input.dryRun === true) args.push("--dry-run");
  if (input.include_suppressed === true || input.includeSuppressed === true) args.push("--include-suppressed");
  args.push("--json");
  return args;
}

function appendOptional(args, flag, value) {
  const text = value === null || value === undefined ? "" : String(value).trim();
  if (!text) return;
  args.push(flag, text);
}

function firstDefined(...values) {
  return values.find((value) => value !== null && value !== undefined);
}

async function resolvedProject(input, context) {
  return resolveAuthorizedProject(projectInput(input) || context.root, context.root, authorizedProjectRoots(context));
}

function projectInput(input) {
  return cleanText(input.project || input.project_path || input.cwd);
}

function addOptions(args, input) {
  const options = input.options || input.options_json || input.sdk_options || input.sdkOptions;
  if (!options) return;
  if (typeof options !== "object" || Array.isArray(options)) throw new Error("agent options must be a JSON object");
  args.push("--options-json", JSON.stringify(options));
}

function limit(input, fallback) { return Math.max(1, Math.min(positiveNumber(input.limit, fallback), 200)); }

function cursor(input) { return Math.max(0, positiveNumber(input.cursor, 0)); }

function required(value, name) {
  const text = cleanText(value);
  if (!text) throw new Error(`missing_${name}`);
  return text;
}

function agentEnv(context) {
  const out = {
    ...env,
    PATH: pathWithCommonCliDirs(env.PATH),
  };
  if (context.burnAppHome) out.BURN_APP_HOME = context.burnAppHome;
  return out;
}

function pathWithCommonCliDirs(pathValue) {
  const parts = String(pathValue || "").split(":").filter(Boolean);
  for (const dir of ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"]) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(":");
}

function wantsStream(type, input) {
  if (!["burn.agent.session.create", "burn.agent.session.continue"].includes(type)) return false;
  return input.stream === true || input.json_stream === true || input.jsonStream === true;
}

function agentEventSessionId(event) {
  const raw = objectValue(event.raw_json);
  return firstText([
    event.session_id,
    event.sessionId,
    raw?.session_id,
    raw?.sessionId,
    raw?.params?.threadId,
    raw?.params?.turn?.threadId,
    raw?.result?.thread?.id,
    raw?.result?.threadId,
  ]);
}

function agentEventTurnId(event) {
  const raw = objectValue(event.raw_json);
  return firstText([
    event.turn_id,
    event.turnId,
    raw?.turn_id,
    raw?.turnId,
    raw?.params?.turn?.id,
    raw?.params?.turnId,
    raw?.result?.turn?.id,
  ]);
}

function firstText(values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function emitAgentProgress(command, input, project, event, context, activeTurn = null) {
  const commandId = cleanText(input.command_id || input.commandId || command.request_id);
  const source = cleanText(input.source);
  const progress = {
    schema: "burn.agent.turn.event.v1",
    command_id: commandId,
    source,
    project,
    seq: positiveNumber(event.seq, 0),
    status: cleanText(event.status) || "streaming",
    session_id: agentEventSessionId(event),
    turn_id: agentEventTurnId(event),
    block: event.block || null,
    raw_json: event.raw_json || null,
  };
  updateActiveAgentTurn(context, activeTurn, progress);
  await recordAgentMemory(context, command, input, project, {
    event_type: "agent_progress",
    role: "assistant",
    status: progress.status,
    seq: progress.seq,
    text: cleanText(progress.block?.text || progress.block?.summary),
    block: progress.block,
    raw_json: progress.raw_json,
  });
  if (typeof context.emitProgress !== "function") return;
  await context.emitProgress({
    ok: true,
    version: "burn-relay-v1",
    type: command.type,
    request_id: command.request_id || null,
    schema: "burn.agent.turn.event.v1",
    progress: true,
    data: progress,
  });
}

function createActiveAgentTurn(context, command, input, project) {
  const commandId = cleanText(input.command_id || input.commandId || command.request_id);
  const entry = {
    source: cleanText(input.source),
    project: String(project || ""),
    commandId,
    sessionId: cleanText(input.session_id || input.sessionId || input.id),
    turnId: "",
    child: null,
    pid: 0,
    status: "running",
    aliases: new Set(),
    started_at: new Date().toISOString(),
  };
  registerActiveAgentTurn(context, entry);
  return entry;
}

function updateActiveAgentTurn(context, entry, progress) {
  if (!entry) return;
  const sessionId = cleanText(progress.session_id || progress.sessionId);
  const turnId = cleanText(progress.turn_id || progress.turnId);
  if (sessionId) entry.sessionId = sessionId;
  if (turnId) entry.turnId = turnId;
  registerActiveAgentTurn(context, entry);
}

function registerActiveAgentTurn(context, entry) {
  const registry = activeAgentTurnRegistry(context);
  for (const key of activeAgentTurnKeys(entry)) {
    entry.aliases.add(key);
    registry.set(key, entry);
  }
}

function cleanupActiveAgentTurn(context, entry) {
  if (!entry) return;
  entry.status = entry.status === "interrupted" ? "interrupted" : "closed";
  const registry = activeAgentTurnRegistry(context);
  for (const key of entry.aliases) {
    if (registry.get(key) === entry) registry.delete(key);
  }
}

function interruptActiveAgentTurn(command, input, project, context) {
  const source = cleanText(input.source);
  const sessionId = cleanText(input.session_id || input.sessionId || input.id);
  const turnId = cleanText(input.turn_id || input.turnId);
  const commandId = cleanText(input.command_id || input.commandId);
  const entry = findActiveAgentTurn(context, { source, project: String(project || ""), sessionId, turnId, commandId });
  if (!entry) return null;
  entry.status = "interrupted";
  entry.interrupted_at = new Date().toISOString();
  const signaled = terminateProcessTree(entry.child, "SIGTERM");
  setTimeout(() => terminateProcessTree(entry.child, "SIGKILL"), 2500).unref?.();
  return {
    ok: true,
    version: "burn-relay-v1",
    type: command.type,
    request_id: command.request_id || null,
    data: {
      ok: true,
      interface_version: "burn-agent-session-v1",
      source,
      project: entry.project,
      session_id: sessionId || entry.sessionId,
      turn_id: turnId || entry.turnId || null,
      status: "interrupted",
      provider: {
        runtime: "burn_adapter_active_process",
        transport: "local_process_signal",
      },
      provider_result: {
        reason: "active_agent_turn_process_signalled",
        pid: entry.pid || null,
        signaled,
      },
    },
  };
}

function findActiveAgentTurn(context, query) {
  const registry = activeAgentTurnRegistry(context);
  for (const key of activeAgentTurnQueryKeys(query)) {
    const entry = registry.get(key);
    if (entry) return entry;
  }
  return null;
}

function activeAgentTurnKeys(entry) {
  return activeAgentTurnQueryKeys(entry).filter(Boolean);
}

function activeAgentTurnQueryKeys({ source, project, sessionId, turnId, commandId }) {
  const s = cleanText(source);
  const p = String(project || "");
  const sid = cleanText(sessionId);
  const tid = cleanText(turnId);
  const cid = cleanText(commandId);
  return [
    tid && sid ? `turn:${s}:${p}:${sid}:${tid}` : "",
    sid ? `session:${s}:${p}:${sid}` : "",
    cid ? `command:${s}:${p}:${cid}` : "",
  ].filter(Boolean);
}

function activeAgentTurnRegistry(context) {
  if (!context.activeAgentTurns) context.activeAgentTurns = new Map();
  return context.activeAgentTurns;
}

async function recordAgentMemory(context, command, input, project, event) {
  if (!isAgentTurnCommand(command.type)) return;
  try {
    const commandId = cleanText(input.command_id || input.commandId || command.request_id);
    await appendChatMemoryEvent({
      home: context.burnAppHome,
      project,
      source: cleanText(input.source),
      session_key: cleanText(input.session_id || input.id) || commandId,
      session_id: cleanText(event.session_id || input.session_id || input.id),
      command_id: commandId,
      ...event,
    });
  } catch (error) {
    context.chatMemoryErrors?.push?.({
      at: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 400),
    });
  }
}

function isAgentTurnCommand(type) {
  return type === "burn.agent.session.create" || type === "burn.agent.session.continue";
}

function finalSessionId(data) {
  return cleanText(data?.session_id || data?.summary?.id || data?.turn?.common?.session_id || data?.data?.session_id);
}

function finalText(data) {
  return cleanText(data?.reply || data?.data?.reply || data?.turn?.chat?.reply || data?.result);
}
