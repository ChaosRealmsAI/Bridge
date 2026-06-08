import { createBridgeClient } from "/sdk/index.js";

const params = new URLSearchParams(location.search);
const API_BASE = params.get("api") || location.origin;
const BRAND_DOMAIN = params.get("domain") || "pandart.cc";
const DEMO_ACCOUNT = Object.freeze({
  email: "chaos@pandart.cc",
  password: "Pandart-Local-2026!",
});
const bridge = createBridgeClient({ apiBase: API_BASE, productId: "panda-chat" });

const state = {
  session: null,
  devices: [],
  preflight: null,
  selectedDeviceId: "",
  busy: false,
  activeJobId: "",
  activeBubble: null,
  cancelRequested: false,
  refreshTimer: null,
};

const nodes = {
  session: document.querySelector("[data-session-status]"),
  deviceStatus: document.querySelector("[data-device-status]"),
  select: document.querySelector("[data-device-select]"),
  install: document.querySelector("[data-install]"),
  installTitle: document.querySelector("[data-install-title]"),
  installText: document.querySelector("[data-install-text]"),
  installLink: document.querySelector("[data-install-link]"),
  installCommand: document.querySelector("[data-install-command]"),
  readiness: document.querySelector("[data-readiness-status]"),
  runtimePill: document.querySelector("[data-runtime-pill]"),
  domainBadge: document.querySelector("[data-domain-badge]"),
  apiBase: document.querySelector("[data-api-base]"),
  publicOrigin: document.querySelector("[data-public-origin]"),
  mobile: document.querySelector("[data-mobile]"),
  mobileLink: document.querySelector("[data-mobile-link]"),
  loginPanel: document.querySelector("[data-login-panel]"),
  loginForm: document.querySelector("[data-login-form]"),
  loginEmail: document.querySelector("[data-login-email]"),
  loginPassword: document.querySelector("[data-login-password]"),
  messages: document.querySelector("[data-messages]"),
  composer: document.querySelector("[data-composer]"),
  input: document.querySelector("[data-input]"),
  send: document.querySelector("[data-send]"),
  cancel: document.querySelector("[data-cancel]"),
};

document.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  if (action === "login") showLogin();
  if (action === "logout") await logout();
  if (action === "refresh") await refresh();
  if (action === "pair") await connectDesktop();
  if (action === "mobile") await createMobileLink();
  if (action === "revoke-device") await revokeCurrentDevice();
});

nodes.select.addEventListener("change", async () => {
  state.selectedDeviceId = nodes.select.value;
  await checkAuthorization().catch(() => {});
  state.preflight = state.session?.authenticated
    ? await bridge.preflight({ deviceId: state.selectedDeviceId }).catch(() => state.preflight)
    : null;
  render();
});

nodes.composer.addEventListener("submit", onSubmit);
nodes.cancel.addEventListener("click", cancelActiveJob);
nodes.loginForm.addEventListener("submit", onLogin);
nodes.input.addEventListener("input", () => {
  nodes.input.style.height = "auto";
  nodes.input.style.height = `${Math.min(nodes.input.scrollHeight, 140)}px`;
});

renderRuntime();
prefillDemoAccount();
await bootstrap();

async function bootstrap() {
  const join = params.get("join");
  if (join) {
    try {
      state.session = await bridge.auth.join(join);
      history.replaceState(null, "", location.pathname);
      addMessage("assistant", "手机已同步到同一个 Pandart 账号，可以使用已连接的本机 Codex。");
      await refresh();
      return;
    } catch (error) {
      addMessage("assistant", formatError(error), "error");
    }
  }
  await refresh().catch(() => {});
}

function showLogin() {
  nodes.loginPanel.hidden = false;
  prefillDemoAccount();
  nodes.loginEmail.focus();
}

async function onLogin(event) {
  event.preventDefault();
  const email = nodes.loginEmail.value.trim();
  const password = nodes.loginPassword.value;
  if (!email || !password) {
    addMessage("assistant", "请输入 Pandart 账号邮箱和密码。", "error");
    return;
  }
  try {
    state.session = await bridge.auth.password(email, password, email);
    nodes.loginPanel.hidden = true;
    nodes.loginPassword.value = "";
    addMessage("assistant", `已登录 ${email}。`);
    await refresh();
  } catch (error) {
    addMessage("assistant", formatError(error), "error");
  }
}

async function logout() {
  try {
    await bridge.auth.logout();
  } catch {
    // A missing or expired session still leaves the UI in a logged-out state.
  }
  state.session = null;
  state.devices = [];
  state.preflight = null;
  state.selectedDeviceId = "";
  state.busy = false;
  state.activeJobId = "";
  state.activeBubble = null;
  state.cancelRequested = false;
  nodes.loginPanel.hidden = false;
  prefillDemoAccount();
  addMessage("assistant", "已退出 Pandart 账号。");
  render();
}

async function refresh() {
  try {
    state.session = await bridge.auth.session();
  } catch {
    state.session = null;
  }
  if (state.session?.authenticated) {
    const devices = await bridge.devices.list();
    state.devices = visibleDevices(devices.items || []);
    const selected = state.devices.find((item) => item.id === state.selectedDeviceId);
    state.selectedDeviceId = selected?.id || state.devices.find((item) => item.status === "online")?.id || state.devices[0]?.id || "";
    state.preflight = await bridge.preflight({ deviceId: state.selectedDeviceId }).catch((error) => ({
      ready: false,
      issues: [{ code: error?.payload?.error || error?.message || "preflight_failed" }],
      actions: [{ code: "retry_bridge", label: "Retry Bridge diagnostics or check the API base." }],
    }));
  } else {
    state.devices = [];
    state.preflight = null;
    state.selectedDeviceId = "";
  }
  render();
}

async function connectDesktop() {
  if (!state.session?.authenticated) {
    showLogin();
    addMessage("assistant", "先登录 Pandart 账号，再连接本机。", "error");
    return;
  }
  const payload = await bridge.connect.createIntent({
    deviceName: `Pandart Connector ${navigator.platform || "Desktop"}`,
  });
  const deepLink = payload.deep_link || `panda-bridge://connect?intent=${encodeURIComponent(payload.token)}&api=${encodeURIComponent(API_BASE)}`;
  const fallback = [
    "cd /path/to/panda-bridge",
    `cargo run --manifest-path apps/desktop/Cargo.toml -- --intent '${payload.token}'`,
  ].join("\n");
  nodes.install.hidden = false;
  nodes.installTitle.textContent = "正在打开 Pandart Connector";
  nodes.installText.textContent = "请在本机应用里允许 Pandart 使用这台电脑上的 Codex。";
  nodes.installLink.href = deepLink;
  nodes.installLink.textContent = "重新打开桌面端";
  nodes.installCommand.textContent = fallback;
  addMessage("assistant", "正在打开 Pandart Connector。请在本机应用里点“允许”。");
  openDesktop(deepLink);
  startRefreshLoop();
}

async function createMobileLink() {
  if (!state.session?.authenticated) {
    showLogin();
    addMessage("assistant", "先登录 Pandart 账号。", "error");
    return;
  }
  const payload = await bridge.auth.share();
  nodes.mobile.hidden = false;
  nodes.mobileLink.href = payload.join_url;
  nodes.mobileLink.textContent = "复制/打开手机同步链接";
  await navigator.clipboard?.writeText(payload.join_url).catch(() => {});
  addMessage("assistant", `手机同步链接已生成，10 分钟内有效：\n${payload.join_url}`);
}

async function revokeCurrentDevice() {
  const device = currentDevice();
  if (!device) {
    addMessage("assistant", "当前没有可断开的本机。", "error");
    return;
  }
  const confirmed = confirm(`断开 ${device.device_name}？\n\n断开后，这个 Pandart 账号将不能再使用这台电脑上的 Codex，除非重新连接本机。`);
  if (!confirmed) return;
  try {
    await bridge.devices.revoke(device.id);
    addMessage("assistant", `已断开 ${device.device_name}。`);
    state.selectedDeviceId = "";
    await refresh();
  } catch (error) {
    addMessage("assistant", formatError(error), "error");
  }
}

async function ensureAuthorization() {
  const device = currentDevice();
  if (!device) return;
  const payload = await bridge.products.authorization(device.id);
  if (!payload.authorization) {
    const error = new Error("desktop_authorization_required");
    error.payload = { error: "desktop_authorization_required" };
    throw error;
  }
  return payload.authorization;
}

async function checkAuthorization() {
  const device = currentDevice();
  if (!device) return null;
  return bridge.products.authorization(device.id);
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.busy) return;
  const prompt = nodes.input.value.trim();
  if (!prompt) return;
  if (!state.session?.authenticated) {
    addMessage("assistant", "先登录 Pandart 账号。", "error");
    return;
  }
  const device = currentDevice();
  if (!device) {
    addMessage("assistant", "先连接本机 Pandart Connector。", "error");
    return;
  }
  await ensureAuthorization();
  state.busy = true;
  state.activeJobId = "";
  state.activeBubble = null;
  state.cancelRequested = false;
  nodes.input.value = "";
  addMessage("user", prompt);
  const pending = addMessage("assistant", "正在发送到本机 Codex...", "pending");
  state.activeBubble = pending;
  const traceStartedAt = Date.now();
  pending.dataset.traceStartedAt = String(traceStartedAt);
  addTrace(pending, "已发送到 Pandart Bridge", traceStartedAt);
  pending.dataset.jobStatus = "queued";
  setEnabled(false);
  try {
    const created = await bridge.codex.chat({
      deviceId: device.id,
      workspaceRef: "default",
      prompt,
      stream: true,
      tokenBudget: 20000,
      timeoutMs: 240000,
      requestKey: `web-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    pending.dataset.jobId = created.job.id;
    pending.closest(".message").dataset.jobId = created.job.id;
    state.activeJobId = created.job.id;
    updateCancelState();
    addTrace(pending, "Cloud 已创建任务", traceStartedAt);
    setBubbleText(pending, "本机 Codex 正在实时接收...");
    let text = "";
    let sawFirstDelta = false;
    for await (const eventItem of bridge.jobs.stream(created.job.id, { deviceId: device.id, timeoutMs: 300000 })) {
      if (eventItem.type === "text_delta") {
        if (!sawFirstDelta) {
          sawFirstDelta = true;
          addTrace(pending, "收到 Codex 首段回复", traceStartedAt);
        }
        text += eventItem.payload?.delta || "";
        pending.dataset.jobStatus = "streaming";
        setBubbleText(pending, text || "生成中...");
      } else if (eventItem.type === "status" || eventItem.type === "started" || eventItem.type === "claimed") {
        addTraceForEvent(pending, eventItem, traceStartedAt);
        pending.dataset.jobStatus = eventItem.type;
        if (!text) setBubbleText(pending, statusText(eventItem));
      } else if (eventItem.type === "queued" || eventItem.type === "app_server_event") {
        addTraceForEvent(pending, eventItem, traceStartedAt);
      } else if (eventItem.type === "failed") {
        addTrace(pending, "任务失败", traceStartedAt, "error");
        pending.dataset.jobStatus = "failed";
        setBubbleText(pending, eventItem.payload?.error || "任务失败");
        pending.classList.add("error");
      } else if (eventItem.type === "cancelled") {
        addTrace(pending, "已停止", traceStartedAt, "done");
        pending.dataset.jobStatus = "cancelled";
        setBubbleText(pending, "已停止。");
        pending.classList.remove("pending", "error");
      }
    }
    const final = await bridge.jobs.get(created.job.id);
    if (final.job.status === "succeeded") {
      pending.dataset.jobStatus = "succeeded";
      setBubbleText(pending, final.job.result?.reply || text || "已完成，但没有返回文本。");
      addTrace(pending, "完成", traceStartedAt, "done");
      addTimingTrace(pending, final.job.timing, traceStartedAt);
      pending.classList.remove("pending", "error");
    } else if (final.job.status === "cancelled") {
      pending.dataset.jobStatus = "cancelled";
      setBubbleText(pending, "已停止。");
      addTrace(pending, "已停止", traceStartedAt, "done");
      pending.classList.remove("pending", "error");
    } else if (final.job.status !== "succeeded") {
      pending.dataset.jobStatus = final.job.status;
      setBubbleText(pending, final.job.result?.error || `任务状态：${final.job.status}`);
      pending.classList.add("error");
    }
  } catch (error) {
    pending.dataset.jobStatus = "failed";
    addTrace(pending, "请求失败", traceStartedAt, "error");
    setBubbleText(pending, formatError(error));
    pending.classList.add("error");
  } finally {
    state.busy = false;
    state.activeJobId = "";
    state.activeBubble = null;
    state.cancelRequested = false;
    setEnabled(true);
    await refresh();
  }
}

async function cancelActiveJob() {
  if (!state.activeJobId || state.cancelRequested) return;
  state.cancelRequested = true;
  updateCancelState();
  const startedAt = Number(state.activeBubble?.dataset.traceStartedAt || Date.now());
  if (state.activeBubble) addTrace(state.activeBubble, "正在停止", startedAt);
  try {
    await bridge.jobs.cancel(state.activeJobId);
  } catch (error) {
    state.cancelRequested = false;
    updateCancelState();
    if (state.activeBubble) addTrace(state.activeBubble, formatError(error), startedAt, "error");
  }
}

function render() {
  const account = state.session?.user?.email || state.session?.user?.display_name || "Pandart Account";
  nodes.session.textContent = state.session?.authenticated ? account : "未登录";
  if (state.session?.authenticated) nodes.loginPanel.hidden = true;
  const device = currentDevice();
  nodes.deviceStatus.textContent = device ? deviceOptionLabel(device) : "未连接";
  if (nodes.readiness) nodes.readiness.textContent = readinessText();
  if (nodes.runtimePill) nodes.runtimePill.textContent = state.preflight?.ready ? "local ready" : "setup required";
  nodes.select.innerHTML = "";
  if (!state.devices.length) {
    nodes.select.append(new Option("未连接本机", ""));
  } else {
    for (const item of state.devices) {
      nodes.select.append(new Option(deviceOptionLabel(item), item.id));
    }
    nodes.select.value = state.selectedDeviceId;
  }
}

function renderRuntime() {
  document.title = "Pandart Local Chat";
  if (nodes.domainBadge) nodes.domainBadge.textContent = BRAND_DOMAIN;
  if (nodes.publicOrigin) nodes.publicOrigin.textContent = compactUrl(location.origin);
  if (nodes.apiBase) nodes.apiBase.textContent = compactUrl(API_BASE);
  if (nodes.runtimePill) nodes.runtimePill.textContent = "local bridge";
}

function prefillDemoAccount() {
  if (!shouldPrefillDemoAccount()) return;
  if (nodes.loginEmail && !nodes.loginEmail.value) nodes.loginEmail.value = DEMO_ACCOUNT.email;
  if (nodes.loginPassword && !nodes.loginPassword.value) nodes.loginPassword.value = DEMO_ACCOUNT.password;
}

function shouldPrefillDemoAccount() {
  if (params.get("demo_account") === "0") return false;
  if (params.get("demo_account") === "1") return true;
  const host = location.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return true;
  if (/^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host.endsWith(".local")) return true;
  return host === BRAND_DOMAIN && Boolean(location.port);
}

function readinessText() {
  if (!state.session?.authenticated) return "需要登录";
  if (!state.preflight) return currentDevice() ? "检查中" : "需要连接本机";
  if (state.preflight.ready) return "ready";
  const issue = state.preflight.issues?.[0]?.code || "setup_required";
  const labels = {
    not_authenticated: "需要登录",
    no_devices: "需要连接本机",
    no_online_devices: "桌面端离线",
    device_not_found: "设备不可见",
    product_not_authorized: "需要授权",
    bridge_unreachable: "Bridge 不可达",
    queue_unavailable: "队列待检查",
    preflight_failed: "检查失败",
  };
  return labels[issue] || issue;
}

function compactUrl(value) {
  try {
    const url = new URL(value);
    return url.host;
  } catch {
    return value || "local";
  }
}

function openDesktop(url) {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = url;
  document.body.append(frame);
  setTimeout(() => frame.remove(), 3000);
}

function startRefreshLoop() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(async () => {
    await refresh().catch(() => {});
    if (currentDevice()) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
      nodes.install.hidden = true;
      addMessage("assistant", "本机 Pandart Connector 已连接，可以直接发送消息。");
    }
  }, 1800);
  setTimeout(() => {
    if (!state.refreshTimer) return;
    nodes.installTitle.textContent = "没有检测到桌面端";
    nodes.installText.textContent = "请先安装或打开 Pandart Connector。开发者可展开诊断命令。";
  }, 5000);
}

function currentDevice() {
  return state.devices.find((item) => item.id === state.selectedDeviceId) || null;
}

function visibleDevices(items) {
  const online = items
    .filter((item) => item.status === "online")
    .sort((a, b) => Date.parse(b.last_seen_at || b.updated_at || 0) - Date.parse(a.last_seen_at || a.updated_at || 0));
  const normal = online.filter((item) => !isVerificationDevice(item));
  const verification = online.filter(isVerificationDevice).slice(0, 1);
  return [...verification, ...normal].slice(0, 6);
}

function isVerificationDevice(device) {
  return /^Account Password E2E\b/.test(device?.device_name || "");
}

function deviceOptionLabel(device) {
  const status = device.status === "online" ? "已连接" : device.status;
  const lastSeen = relativeTime(device.last_seen_at);
  return `${device.device_name} · ${status}${lastSeen ? ` · ${lastSeen}` : ""}`;
}

function relativeTime(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚在线";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return "";
}

function addMessage(role, text, tone = "") {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.dataset.messageRole = role;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "你" : "PT";
  const bubble = document.createElement("div");
  bubble.className = `bubble ${tone}`.trim();
  bubble.dataset.messageRole = role;
  const body = document.createElement("div");
  body.className = "bubble-text";
  bubble.append(body);
  setBubbleText(bubble, text);
  article.append(avatar, bubble);
  nodes.messages.append(article);
  nodes.messages.scrollTop = nodes.messages.scrollHeight;
  return bubble;
}

function setBubbleText(bubble, text) {
  const value = text || "处理中...";
  const body = bubble.querySelector(".bubble-text") || bubble;
  body.textContent = value;
  bubble.dataset.messageText = value;
}

function statusText(eventItem) {
  if (eventItem.type === "claimed") return "本机已接收消息...";
  if (eventItem.type === "started") return "本机 Codex 正在回复...";
  return eventItem.payload?.message || "处理中...";
}

function addTraceForEvent(bubble, eventItem, startedAt) {
  if (eventItem.type === "queued") addTrace(bubble, "Cloud 已排队", startedAt);
  if (eventItem.type === "claimed") addTrace(bubble, "本机 Connector 已接收", startedAt);
  if (eventItem.type === "started") addTrace(bubble, "本机 Codex 已开始", startedAt);
  if (eventItem.type === "app_server_event") {
    const count = Number(bubble.dataset.appServerEventCount || 0);
    if (count >= 8) return;
    bubble.dataset.appServerEventCount = String(count + 1);
    addTrace(bubble, friendlyCodexMethod(eventItem.payload?.method), startedAt);
  }
}

function addTimingTrace(bubble, timing, startedAt) {
  if (!timing) return;
  const parts = [
    ["Bridge 接收", timing.queued_to_claimed_ms],
    ["Codex 首段", timing.started_to_first_delta_ms],
    ["总耗时", timing.total_job_ms],
  ]
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([label, value]) => `${label} ${formatDuration(value)}`);
  if (parts.length) addTrace(bubble, parts.join(" · "), startedAt, "metric");
}

function addTrace(bubble, label, startedAt, tone = "") {
  if (bubble.dataset.lastTraceLabel === label && tone !== "metric") return;
  bubble.dataset.lastTraceLabel = label;
  const trace = ensureTrace(bubble);
  const row = document.createElement("div");
  row.className = `trace-row ${tone}`.trim();
  const time = document.createElement("span");
  time.className = "trace-time";
  time.textContent = `+${formatDuration(Date.now() - startedAt)}`;
  const text = document.createElement("span");
  text.textContent = label;
  row.append(time, text);
  trace.append(row);
  nodes.messages.scrollTop = nodes.messages.scrollHeight;
}

function ensureTrace(bubble) {
  let trace = bubble.querySelector(".trace");
  if (!trace) {
    trace = document.createElement("div");
    trace.className = "trace";
    bubble.append(trace);
  }
  return trace;
}

function friendlyCodexMethod(method) {
  const value = String(method || "");
  if (value.includes("mcpServer/startupStatus")) return "Codex 工具环境准备中";
  if (value === "thread/started") return "Codex 线程已启动";
  if (value === "thread/status/changed") return "Codex 状态更新";
  if (value === "item/started") return "Codex 开始处理";
  if (value === "item/completed") return "Codex 处理完成";
  if (value === "turn/started") return "Codex turn 已启动";
  if (value === "turn/completed") return "Codex turn 已完成";
  if (value.includes("agentMessage")) return "Codex 正在生成回复";
  if (value.includes("exec")) return "Codex 执行事件";
  return value ? `Codex 事件：${value}` : "Codex app-server 事件";
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
}

function setEnabled(enabled) {
  nodes.input.disabled = !enabled;
  nodes.send.disabled = !enabled;
  updateCancelState();
}

function updateCancelState() {
  const cancellable = state.busy && Boolean(state.activeJobId);
  nodes.cancel.hidden = !cancellable;
  nodes.cancel.disabled = !cancellable || state.cancelRequested;
  nodes.cancel.textContent = state.cancelRequested ? "停止中" : "停止";
}

function formatError(error) {
  const code = error?.payload?.error || error?.message || String(error);
  if (code === "device_offline") return "本机 Pandart Connector 暂时离线，请确认桌面端正在运行后刷新。";
  if (code === "device_not_found") return "这个 Pandart 账号还没有连接本机。";
  if (code === "product_not_authorized" || code === "desktop_authorization_required") return "请点击“连接本机”，并在 Pandart Connector 里允许 Pandart。";
  if (code === "device_queue_full") return "这台电脑的任务队列已满，请稍后再发送。";
  if (code === "account_queue_full") return "这个账号当前任务太多，请稍后再发送。";
  if (code === "product_queue_full") return "Pandart 当前任务太多，请稍后再发送。";
  if (code === "invalid_credentials") return "账号或密码不正确。";
  if (code === "too_many_login_attempts") return "登录失败次数过多，请稍后再试。";
  if (code === "password_login_not_enabled") return "这个账号还没有启用密码登录，请换一个测试账号。";
  return code;
}
