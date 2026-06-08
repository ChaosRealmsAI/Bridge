export function createBridgeClient(options = {}) {
  const apiBase = String(options.apiBase || "").replace(/\/$/, "");
  const productId = options.productId || "panda-chat";
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!apiBase) throw new Error("apiBase is required");
  if (!fetchImpl) throw new Error("fetch is required");

  const request = async (method, path, body) => {
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `Bridge API ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  };

  return {
    productId,
    diagnostics: () => request("GET", "/v1/diagnostics"),
    auth: {
      session: () => request("GET", "/v1/session"),
      password: (email, password, displayName = "") =>
        request("POST", "/v1/sessions/password", { email, password, display_name: displayName }),
      guest: (displayName = "Guest") => request("POST", "/v1/sessions/guest", { display_name: displayName }),
      share: () => request("POST", "/v1/sessions/share", {}),
      join: (token) => request("POST", "/v1/sessions/join", { token }),
      logout: () => request("POST", "/v1/sessions/logout", {}),
    },
    devices: {
      list: () => request("GET", "/v1/devices"),
      createPairingCode: (deviceName = "Panda Bridge Desktop") =>
        request("POST", "/v1/devices/pairing-codes", { device_name: deviceName }),
      revoke: (deviceId) => request("DELETE", `/v1/devices/${encodeURIComponent(deviceId)}`),
    },
    connect: {
      createIntent: (input = {}) =>
        request("POST", "/v1/connect-intents", {
          product_id: input.productId || input.product_id || productId,
          device_name: input.deviceName || input.device_name || "Panda Bridge Desktop",
        }),
      intent: (token) => request("GET", `/v1/connect-intents/${encodeURIComponent(token)}`),
      claim: (token, input = {}) =>
        request("POST", `/v1/connect-intents/${encodeURIComponent(token)}/claim`, {
          device_name: input.deviceName || input.device_name || "Panda Bridge Desktop",
          app_version: input.appVersion || input.app_version || null,
          capabilities: input.capabilities || {},
          local_state: input.localState || input.local_state || {},
          policy: input.policy || {},
        }),
    },
    products: {
      list: () => request("GET", "/v1/products"),
      requestAuthorization: (deviceId, policy = {}) =>
        request("POST", `/v1/products/${encodeURIComponent(productId)}/authorization/request`, {
          device_id: deviceId,
          policy,
        }),
      authorization: (deviceId) =>
        request("GET", `/v1/products/${encodeURIComponent(productId)}/authorization?device_id=${encodeURIComponent(deviceId)}`),
      revokeAuthorization: (deviceId) =>
        request("DELETE", `/v1/products/${encodeURIComponent(productId)}/authorization?device_id=${encodeURIComponent(deviceId)}`),
    },
    codex: {
      chat: (input) => createJob(request, productId, { ...input, kind: "codex.chat" }),
      run: (input) => createJob(request, productId, { ...input, kind: "codex.run" }),
      rpc: (input) => createJob(request, productId, { ...input, kind: "codex.rpc" }),
    },
    jobs: {
      create: (input = {}) => createJob(request, productId, input),
      get: (jobId) => request("GET", `/v1/jobs/${encodeURIComponent(jobId)}`),
      events: (jobId, after = 0) =>
        request("GET", `/v1/jobs/${encodeURIComponent(jobId)}/events?after=${encodeURIComponent(String(after))}`),
      wait: (jobId, options = {}) => waitForJob(request, jobId, options),
      stream: (jobId, options = {}) => streamEvents(request, apiBase, jobId, options),
      cancel: (jobId) => request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/cancel`),
    },
  };
}

async function createJob(request, productId, input) {
  const deviceId = input.deviceId || input.device_id;
  const jobInput = input.input || input.payload || { prompt: input.prompt, calls: input.calls };
  const normalized = normalizeBridgeJob({
    ...input,
    productId,
    deviceId,
    input: jobInput,
    policy: input.policy || {},
  });
  const validation = validateBridgeJob(normalized);
  if (!validation.ok) {
    const error = new Error(`invalid_bridge_job: ${validation.errors.join(",")}`);
    error.errors = validation.errors;
    throw error;
  }
  return request("POST", `/v1/products/${encodeURIComponent(productId)}/jobs`, validation.job);
}

function normalizeBridgeJob(input = {}) {
  const kind = normalizeKind(input.kind || input.job_kind);
  const productId = stringValue(input.productId || input.product_id, 80);
  const deviceId = stringValue(input.deviceId || input.device_id || input.connector_id, 80);
  const workspaceRef = stringPassthrough(input.workspaceRef ?? input.workspace_ref);
  const requestKey = stringValue(input.requestKey || input.request_key, 160);
  return {
    kind,
    product_id: productId,
    device_id: deviceId,
    workspace_ref: workspaceRef || null,
    request_key: requestKey || null,
    input: objectValue(input.input || input.payload),
    policy: normalizePolicy(input.policy || {}),
  };
}

function validateBridgeJob(input = {}) {
  const job = normalizeBridgeJob(input);
  const errors = [];
  if (!job.kind) errors.push("missing_kind");
  if (!job.product_id) errors.push("missing_product_id");
  if (!job.device_id) errors.push("missing_device_id");
  return { ok: errors.length === 0, errors, job };
}

function normalizeKind(kind) {
  return stringPassthrough(kind);
}

function normalizePolicy(input = {}) {
  return objectValue(input);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringPassthrough(value) {
  return typeof value === "string" ? value : "";
}

async function waitForJob(request, jobId, options = {}) {
  const timeoutMs = options.timeoutMs || 300000;
  const intervalMs = options.intervalMs || 1500;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await request("GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
    if (payload.job && !["queued", "pending", "running"].includes(payload.job.status)) return payload.job;
    await sleep(intervalMs);
  }
  throw new Error("bridge_job_timeout");
}

async function* pollEvents(request, jobId, options = {}) {
  let after = Number(options.after || 0);
  const intervalMs = options.intervalMs || 900;
  const timeoutMs = options.timeoutMs || 300000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await request("GET", `/v1/jobs/${encodeURIComponent(jobId)}/events?after=${after}`);
    for (const event of payload.items || []) {
      after = Math.max(after, Number(event.seq || 0));
      yield event;
    }
    const job = payload.job;
    if (job && !["queued", "pending", "running"].includes(job.status)) return;
    await sleep(intervalMs);
  }
}

async function* streamEvents(request, apiBase, jobId, options = {}) {
  const deviceId = stringValue(options.deviceId || options.device_id, 120);
  if (options.realtime === false || !deviceId || typeof WebSocket === "undefined") {
    yield* pollEvents(request, jobId, options);
    return;
  }

  let after = Number(options.after || 0);
  const timeoutMs = options.timeoutMs || 300000;
  const fallbackIntervalMs = options.intervalMs || 900;
  const started = Date.now();
  const queue = [];
  let ws = null;
  let opened = false;
  let closed = false;
  let failed = null;
  let wake = null;
  const wakeWaiter = () => {
    if (wake) {
      wake();
      wake = null;
    }
  };

  try {
    ws = new WebSocket(realtimeDeviceUrl(apiBase, deviceId, "web"));
    ws.addEventListener("open", () => {
      opened = true;
      wakeWaiter();
    });
    ws.addEventListener("message", (message) => {
      let payload = null;
      try {
        payload = JSON.parse(String(message.data || ""));
      } catch {
        return;
      }
      if (payload.type === "job.event" && payload.event?.job_id === jobId) {
        queue.push(payload.event);
        wakeWaiter();
      }
    });
    ws.addEventListener("error", () => {
      failed = new Error("bridge_realtime_error");
      wakeWaiter();
    });
    ws.addEventListener("close", () => {
      closed = true;
      wakeWaiter();
    });

    await waitFor(() => opened || failed || closed, 5000);
    if (!opened) throw failed || new Error("bridge_realtime_unavailable");

    const initial = await request("GET", `/v1/jobs/${encodeURIComponent(jobId)}/events?after=${after}`);
    for (const event of initial.items || []) {
      after = Math.max(after, Number(event.seq || 0));
      yield event;
    }
    if (isTerminalJob(initial.job)) return;

    while (Date.now() - started < timeoutMs) {
      while (queue.length) {
        const event = queue.shift();
        const seq = Number(event.seq || 0);
        if (seq <= after) continue;
        after = seq;
        yield event;
        if (isTerminalEvent(event)) return;
      }
      if (closed || failed) break;
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, 15000);
      });
    }
  } catch {
    // Fall back to the durable HTTP event log without surfacing transport details to users.
  } finally {
    if (ws && ws.readyState < 2) ws.close();
  }

  yield* pollEvents(request, jobId, { ...options, after, intervalMs: fallbackIntervalMs });
}

function realtimeDeviceUrl(apiBase, deviceId, role) {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/v1/realtime/devices/${encodeURIComponent(deviceId)}`;
  url.search = `?role=${encodeURIComponent(role)}`;
  return url.toString();
}

function isTerminalJob(job) {
  return job && !["queued", "pending", "running"].includes(job.status);
}

function isTerminalEvent(event) {
  return ["completed", "failed", "cancelled"].includes(event?.type);
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
