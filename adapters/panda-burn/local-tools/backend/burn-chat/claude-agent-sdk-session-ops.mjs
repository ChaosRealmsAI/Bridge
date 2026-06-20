export async function runSessionOperation(request, { emit, sdkVersion }) {
  if (!request || typeof request !== "object") throw new Error("request must be a JSON object");
  if (typeof request.cwd !== "string" || !request.cwd.trim()) {
    throw new Error("request.cwd must be a non-empty string");
  }
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const op = String(request.op || "");
  if (op === "sessions.list") {
    const fn = firstFunction(sdk, ["listSessions", "listSessionSummaries", "sessionsList"]);
    if (!fn) throw new Error("Claude Agent SDK session list is unavailable in this installed package");
    const result = await callSessionFunction(fn, [
      [{ cwd: request.cwd, limit: positiveInt(request.limit, 50) }],
      [{ cwd: request.cwd }],
      [request.cwd],
      [],
    ]);
    emit({
      type: "burn_result",
      op,
      sessions: arrayFromResult(result, ["sessions", "data", "items"]),
      raw: result,
      history_source: "claude_agent_sdk",
      sdk_version: sdkVersion(),
    });
    return;
  }
  if (op === "session.info") {
    const sessionId = requiredSessionId(request);
    const fn = firstFunction(sdk, ["getSessionInfo", "sessionInfo", "getSession"]);
    if (!fn) throw new Error("Claude Agent SDK session info is unavailable in this installed package");
    const result = await callSessionFunction(fn, [
      [{ cwd: request.cwd, sessionId, session_id: sessionId }],
      [sessionId, { cwd: request.cwd }],
      [sessionId],
    ]);
    emit({
      type: "burn_result",
      op,
      session: result?.session || result,
      raw: result,
      history_source: "claude_agent_sdk",
      sdk_version: sdkVersion(),
    });
    return;
  }
  if (op === "session.messages") {
    const sessionId = requiredSessionId(request);
    const fn = firstFunction(sdk, ["getSessionMessages", "sessionMessages", "readSessionMessages"]);
    if (!fn) throw new Error("Claude Agent SDK session messages are unavailable in this installed package");
    const cursor = request.cursor || 0;
    const limit = positiveInt(request.limit, 50);
    const latest = request.latest === true || request.order === "latest";
    const result = await callSessionFunction(fn, [
      [{ cwd: request.cwd, sessionId, session_id: sessionId, cursor, limit, latest, order: latest ? "latest" : "cursor" }],
      [sessionId, { cwd: request.cwd, cursor, limit, latest, order: latest ? "latest" : "cursor" }],
      [sessionId],
    ]);
    emit({
      type: "burn_result",
      op,
      session: result?.session || result?.metadata || { id: sessionId },
      messages: arrayFromResult(result, ["messages", "data", "items"]),
      nextCursor: result?.nextCursor ?? result?.next_cursor ?? null,
      raw: result,
      history_source: "claude_agent_sdk",
      sdk_version: sdkVersion(),
    });
    return;
  }
  throw new Error(`unsupported Claude Agent SDK runner op: ${op}`);
}

function firstFunction(object, names) {
  for (const name of names) {
    if (typeof object?.[name] === "function") return object[name];
  }
  return null;
}

async function callSessionFunction(fn, argumentSets) {
  let lastError = null;
  for (const args of argumentSets) {
    try {
      return await fn(...args);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Claude Agent SDK session call failed");
}

function arrayFromResult(result, keys) {
  if (Array.isArray(result)) return result;
  for (const key of keys) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return [];
}

function requiredSessionId(request) {
  const sessionId = request.session_id || request.sessionId || request.id;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error("request.session_id must be a non-empty string");
  }
  return sessionId;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
