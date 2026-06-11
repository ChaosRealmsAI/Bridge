import { createBridgeClient } from "/sdk/index.js";

const params = new URLSearchParams(location.search);
const API_BASE = params.get("api") || location.origin;
const BRAND_DOMAIN = params.get("domain") || "pandart.cc";
const PRODUCT_ID = "panda-chat";
const DEMO_ACCOUNT = Object.freeze({
  email: "chaos@pandart.cc",
  password: "Pandart-Local-2026!",
});

// Fallback is used only until W1 SDK v2 provides install() in the public SDK copy.
const FALLBACK_INSTALL = Object.freeze({
  download_url: "/downloads/panda-bridge-macos.dmg",
  version: "0.1.0",
  size_bytes: 3167118,
  sha256: "e65e04f08373ffe2363616dc1426516b74f12123f52c71d7225af4bac7225962",
  platform: "macos",
  open_url: "panda-bridge://open",
});

const bridge = createBridgeClient({ apiBase: API_BASE, productId: PRODUCT_ID });
const bridgeStateSource = createBridgeStateSource(bridge);

const state = {
  session: null,
  bridge: bridgeStateSource.emptyState(),
  selectedDeviceId: "",
  busy: false,
  activeJobId: "",
  activeBubble: null,
  cancelRequested: false,
  watchAbort: null,
  watchRunning: false,
};

const nodes = {
  session: document.querySelector("[data-session-status]"),
  deviceStatus: document.querySelector("[data-device-status]"),
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
  bridgePanel: document.querySelector("[data-bridge-panel]"),
  bridgeTitle: document.querySelector("[data-bridge-title]"),
  bridgeCopy: document.querySelector("[data-bridge-copy]"),
  bridgePrimary: document.querySelector("[data-bridge-primary]"),
  bridgeDownload: document.querySelector("[data-bridge-download]"),
  bridgeDevices: document.querySelector("[data-bridge-devices]"),
  bridgeMenu: document.querySelector("[data-bridge-menu]"),
  bridgeMenuActions: document.querySelector("[data-bridge-menu-actions]"),
  messages: document.querySelector("[data-messages]"),
  composer: document.querySelector("[data-composer]"),
  input: document.querySelector("[data-input]"),
  send: document.querySelector("[data-send]"),
  cancel: document.querySelector("[data-cancel]"),
};

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  const action = target?.dataset.action;
  if (!action) return;
  if (action === "login") showLogin();
  if (action === "logout") await logout();
  if (action === "refresh") await refresh({ reason: "manual" });
  if (action === "mobile") await createMobileLink();
  if (action === "primary-bridge") await runPrimaryBridgeAction(target);
  if (action === "cancel-intent") await cancelPendingIntent();
  if (action === "change-device") focusDeviceList();
  if (action === "revoke-authorization") await revokeCurrentAuthorization();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopStateWatch();
    return;
  }
  startStateWatch();
  refresh({ reason: "visible" }).catch(() => {});
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
    } catch (error) {
      addMessage("assistant", formatError(error), "error");
    }
  }
  await refresh({ reason: "bootstrap" }).catch(() => {});
  startStateWatch();
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
    await refresh({ reason: "login" });
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
  state.bridge = bridgeStateSource.emptyState();
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
  const next = await bridgeStateSource.state();
  applyBridgeState(next);
}

function startStateWatch() {
  if (state.watchRunning || document.visibilityState === "hidden") return;
  state.watchRunning = true;
  const controller = new AbortController();
  state.watchAbort = controller;
  (async () => {
    try {
      for await (const next of bridgeStateSource.watchState({ intervalMs: 3000, signal: controller.signal })) {
        if (controller.signal.aborted) break;
        applyBridgeState(next);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn("[bridge-state] watch failed", error);
      }
    } finally {
      if (state.watchAbort === controller) {
        state.watchAbort = null;
        state.watchRunning = false;
      }
    }
  })();
}

function stopStateWatch() {
  state.watchAbort?.abort();
  state.watchAbort = null;
  state.watchRunning = false;
}

function applyBridgeState(next) {
  state.bridge = normalizeBridgeState(next);
  state.session = state.bridge.session || state.session;
  const current = currentDevice();
  state.selectedDeviceId = current?.id || state.bridge.devices.find((item) => item.current)?.id || state.bridge.devices[0]?.id || "";
  render();
}

async function runPrimaryBridgeAction(target) {
  const action = target.dataset.bridgeAction || primaryActionForState(state.bridge);
  if (action === "login") {
    showLogin();
    return;
  }
  if (action === "download") {
    addMessage("assistant", "下载完成后打开 Panda Bridge，它会自动连接这个账号。");
    return;
  }
  if (action === "open_desktop" || action === "confirm_on_desktop") {
    const url = state.bridge.intent?.deep_link || actionUrl(state.bridge, action) || installInfo(state.bridge).open_url;
    if (url) openDesktop(url);
    addMessage("assistant", action === "confirm_on_desktop" ? "已重新唤起桌面端，请在桌面端确认。" : "已尝试打开 Panda Bridge。");
    return;
  }
  if (action === "authorize") {
    await authorizeBridge();
  }
}

async function authorizeBridge() {
  if (!state.session?.authenticated) {
    showLogin();
    addMessage("assistant", "先登录 Pandart 账号，再授权这台电脑。", "error");
    return;
  }
  try {
    const result = typeof bridge.ensureReady === "function"
      ? await bridge.ensureReady({ openDeepLink: openDesktop })
      : await bridgeStateSource.createIntent();
    const deepLink = result?.intent?.deep_link || result?.deep_link || result?.action?.deep_link || result?.url;
    if (deepLink) openDesktop(deepLink);
    addMessage("assistant", "请在桌面端确认 Pandart 使用这台电脑上的 Codex。");
    await refresh({ reason: "authorize" });
  } catch (error) {
    addMessage("assistant", formatError(error), "error");
  }
}

async function cancelPendingIntent() {
  bridgeStateSource.cancelPendingIntent?.();
  addMessage("assistant", "已取消这次桌面端确认。");
  await refresh({ reason: "cancel-intent" });
}

function focusDeviceList() {
  nodes.bridgeDevices.querySelector("[data-device-id]")?.focus?.();
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

async function revokeCurrentAuthorization() {
  const device = currentDevice();
  if (!device) {
    addMessage("assistant", "当前没有可撤销的授权。", "error");
    return;
  }
  const confirmed = confirm(`撤销 ${device.name} 的 Pandart 授权？\n\n设备仍会保留，之后可重新授权。`);
  if (!confirmed) return;
  try {
    await bridge.products.revokeAuthorization(device.id);
    addMessage("assistant", `已撤销 ${device.name} 的 Pandart 授权。`);
    await refresh({ reason: "revoke" });
  } catch (error) {
    addMessage("assistant", formatError(error), "error");
  }
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
  const device = readyDevice();
  if (!device) {
    addMessage("assistant", submitBlockedText(state.bridge), "error");
    return;
  }
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
  addTrace(pending, "已发送到 Panda Bridge", traceStartedAt);
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
    await refresh({ reason: "chat-complete" });
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
  nodes.deviceStatus.textContent = currentDevice() ? deviceOptionLabel(currentDevice()) : "未连接";
  nodes.readiness.textContent = readinessText();
  nodes.runtimePill.textContent = state.bridge.bridge_state === "ready" ? "local ready" : "bridge setup";
  renderBridgePanel();
}

function renderBridgePanel() {
  const model = bridgeUiModel(state.bridge);
  nodes.bridgePanel.dataset.bridgeState = state.bridge.bridge_state;
  nodes.bridgeTitle.textContent = model.title;
  nodes.bridgeCopy.textContent = model.copy;
  nodes.bridgePrimary.innerHTML = "";
  nodes.bridgeDownload.innerHTML = "";
  nodes.bridgeDevices.innerHTML = "";
  nodes.bridgeMenuActions.innerHTML = "";
  nodes.bridgeDownload.hidden = state.bridge.bridge_state !== "no_device";
  nodes.bridgeMenu.hidden = !model.menuActions.length;

  if (model.primary) {
    const primary = model.primary.kind === "download" ? document.createElement("a") : document.createElement("button");
    primary.className = "bridge-cta";
    primary.dataset.primaryCta = "true";
    primary.dataset.bridgeAction = model.primary.kind;
    if (primary.tagName === "A") {
      primary.href = model.primary.href;
      primary.download = "";
    } else {
      primary.type = "button";
      primary.dataset.action = "primary-bridge";
    }
    primary.textContent = model.primary.label;
    nodes.bridgePrimary.append(primary);
  }

  if (state.bridge.bridge_state === "no_device") renderDownloadCard();
  renderDeviceList();
  for (const item of model.menuActions) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = item.action;
    button.textContent = item.label;
    if (item.tone) button.className = item.tone;
    nodes.bridgeMenuActions.append(button);
  }
}

function renderDownloadCard() {
  const install = installInfo(state.bridge);
  const card = document.createElement("div");
  card.className = "download-card";
  card.innerHTML = `
    <div class="download-meta">
      <span>macOS</span>
      <span data-install-version>${escapeHtml(install.version)}</span>
      <span>${escapeHtml(formatBytes(install.size_bytes))}</span>
    </div>
    <p>下载后打开 Panda Bridge，它会自动连接这个 Pandart 账号。</p>
    <details>
      <summary>sha256</summary>
      <code>${escapeHtml(install.sha256)}</code>
    </details>
  `;
  nodes.bridgeDownload.append(card);
}

function renderDeviceList() {
  const devices = state.bridge.devices;
  if (!devices.length) {
    nodes.bridgeDevices.innerHTML = `<p class="empty-devices">还没有连接过的电脑。</p>`;
    return;
  }
  const list = document.createElement("div");
  list.className = "device-list";
  for (const device of devices) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "device-row";
    row.dataset.deviceId = device.id;
    row.dataset.current = device.id === state.selectedDeviceId ? "true" : "false";
    row.addEventListener("click", () => {
      state.selectedDeviceId = device.id;
      render();
    });
    row.innerHTML = `
      <span class="device-presence" data-online="${device.online ? "true" : "false"}"></span>
      <span class="device-main">
        <strong>${escapeHtml(device.name)}</strong>
        <small>${device.online ? "在线" : "离线"}${relativeTime(device.last_seen_at) ? ` · ${escapeHtml(relativeTime(device.last_seen_at))}` : ""}</small>
      </span>
    `;
    list.append(row);
  }
  nodes.bridgeDevices.append(list);
}

function bridgeUiModel(next) {
  const device = currentDevice();
  const stateName = next.bridge_state;
  const models = {
    no_session: {
      title: "需要登录",
      copy: "先登录 Pandart 账号，再连接这台电脑上的 Codex。",
      primary: { kind: "login", label: "登录" },
      menuActions: [],
    },
    no_device: {
      title: "下载 Panda Bridge",
      copy: "这台账号还没有可用电脑。下载后打开即自动连接。",
      primary: { kind: "download", label: "下载 Bridge", href: downloadHref(installInfo(next)) },
      menuActions: [],
    },
    authorization_pending: {
      title: "等待桌面端确认",
      copy: "已发起连接请求，请在桌面端确认 Pandart 使用本机 Codex。",
      primary: { kind: "confirm_on_desktop", label: "去桌面端确认" },
      menuActions: [{ action: "cancel-intent", label: "取消" }],
    },
    authorized_offline: {
      title: "已授权，桌面端离线",
      copy: "这个账号已授权，打开 Panda Bridge 即可使用。",
      primary: { kind: "open_desktop", label: "打开 Bridge" },
      menuActions: [{ action: "refresh", label: "刷新" }],
    },
    not_authorized: {
      title: "需要授权",
      copy: "电脑已连接，请授权 Pandart 使用这台电脑上的 Codex。",
      primary: { kind: "authorize", label: "授权" },
      menuActions: [{ action: "refresh", label: "刷新" }],
    },
    ready: {
      title: "已就绪",
      copy: `${device?.name || "这台电脑"} 已在线，可以直接发送消息到本机 Codex。`,
      primary: null,
      menuActions: [
        { action: "change-device", label: "换一台电脑" },
        { action: "refresh", label: "刷新" },
        { action: "revoke-authorization", label: "撤销授权", tone: "danger" },
      ],
    },
  };
  return models[stateName] || {
    title: "检查中",
    copy: "正在读取 Bridge 状态。",
    primary: null,
    menuActions: [{ action: "refresh", label: "刷新" }],
  };
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

function createBridgeStateSource(client) {
  if (typeof client.state === "function") {
    return {
      emptyState: () => normalizeBridgeState({ bridge_state: "no_session", install: installInfo({}) }),
      state: () => client.state(),
      watchState: (options = {}) => {
        if (typeof client.watchState === "function") return client.watchState(options);
        return sdkStatePoller(client, options);
      },
      createIntent: () => client.ensureReady?.({ openDeepLink: openDesktop }),
      cancelPendingIntent: () => {},
    };
  }

  let pendingIntent = null;
  let cachedInstall = null;
  return {
    emptyState: () => normalizeBridgeState({ bridge_state: "no_session", install: installInfo({}) }),
    state: async () => {
      const session = await client.auth.session().catch(() => null);
      if (!session?.authenticated) {
        return normalizeBridgeState({ bridge_state: "no_session", session, install: await legacyInstall(client, cachedInstall) });
      }
      cachedInstall = await legacyInstall(client, cachedInstall);
      const devicesPayload = await client.devices.list().catch(() => ({ items: [] }));
      const devices = normalizeDevices(devicesPayload.items || []);
      pendingIntent = await livePendingIntent(client, pendingIntent);
      if (pendingIntent) {
        return normalizeBridgeState({
          bridge_state: "authorization_pending",
          session,
          install: cachedInstall,
          devices,
          intent: pendingIntent,
          actions: [{ kind: "confirm_on_desktop", deep_link: pendingIntent.deep_link }],
        });
      }
      if (!devices.length) {
        return normalizeBridgeState({
          bridge_state: "no_device",
          session,
          install: cachedInstall,
          devices,
          actions: [{ kind: "download", url: cachedInstall.download_url }],
        });
      }
      const authorizations = await Promise.all(devices.map(async (device) => {
        const payload = await client.products.authorization(device.id).catch(() => null);
        return payload?.authorization ? { device, authorization: payload.authorization } : null;
      }));
      const active = authorizations.filter(Boolean);
      const authorizedOnline = active.find((item) => item.device.online);
      const selected = authorizedOnline?.device || active[0]?.device || devices.find((item) => item.online) || devices[0];
      const selectedAuth = active.find((item) => item.device.id === selected?.id)?.authorization || null;
      return normalizeBridgeState({
        bridge_state: active.length ? (authorizedOnline ? "ready" : "authorized_offline") : "not_authorized",
        session,
        install: cachedInstall,
        devices: devices.map((device) => ({ ...device, current: device.id === selected?.id })),
        authorization: selectedAuth,
        actions: active.length
          ? [{ kind: authorizedOnline ? "ready" : "open_desktop", url: cachedInstall.open_url }]
          : [{ kind: "authorize" }],
      });
    },
    watchState: async function* watchState(options = {}) {
      while (!options.signal?.aborted) {
        yield await this.state();
        await sleep(options.intervalMs || 3000, options.signal);
      }
    },
    createIntent: async () => {
      const payload = await client.connect.createIntent({
        deviceName: `Pandart Connector ${navigator.platform || "Desktop"}`,
      });
      pendingIntent = normalizeIntent(payload);
      return { ...payload, intent: pendingIntent };
    },
    cancelPendingIntent: () => {
      pendingIntent = null;
    },
  };
}

async function* sdkStatePoller(client, options = {}) {
  while (!options.signal?.aborted) {
    yield await client.state();
    await sleep(options.intervalMs || 3000, options.signal);
  }
}

async function legacyInstall(client, cachedInstall) {
  if (cachedInstall) return cachedInstall;
  if (typeof client.install === "function") {
    const install = await client.install().catch(() => null);
    if (install) return normalizeInstall(install);
  }
  return normalizeInstall(FALLBACK_INSTALL);
}

async function livePendingIntent(client, pendingIntent) {
  if (!pendingIntent?.token) return null;
  const inspected = await client.connect.intent(pendingIntent.token).catch(() => null);
  if (!inspected?.connect_intent && !inspected?.intent) return null;
  return normalizeIntent({ ...inspected, token: pendingIntent.token });
}

function normalizeBridgeState(input = {}) {
  const raw = input || {};
  return {
    bridge_state: raw.bridge_state || raw.state || "no_session",
    session: raw.session || null,
    install: normalizeInstall(raw.install || raw.download || FALLBACK_INSTALL),
    devices: normalizeDevices(raw.devices || []),
    authorization: raw.authorization || null,
    intent: raw.intent ? normalizeIntent(raw.intent) : null,
    actions: Array.isArray(raw.actions) ? raw.actions : [],
  };
}

function normalizeInstall(input = {}) {
  const raw = input || {};
  return {
    download_url: raw.download_url || raw.downloadUrl || raw.url || FALLBACK_INSTALL.download_url,
    version: raw.version || raw.app_version || FALLBACK_INSTALL.version,
    size_bytes: Number(raw.size_bytes || raw.sizeBytes || raw.file_size || raw.fileSize || FALLBACK_INSTALL.size_bytes),
    sha256: raw.sha256 || FALLBACK_INSTALL.sha256,
    platform: raw.platform || FALLBACK_INSTALL.platform,
    open_url: raw.open_url || raw.openUrl || FALLBACK_INSTALL.open_url,
  };
}

function normalizeIntent(input = {}) {
  const raw = input.intent || input.connect_intent || input;
  return {
    token: input.token || raw.token || "",
    expires_at: raw.expires_at || input.expires_at || "",
    deep_link: input.deep_link || raw.deep_link || (input.token ? `panda-bridge://connect?intent=${encodeURIComponent(input.token)}&api=${encodeURIComponent(API_BASE)}` : ""),
  };
}

function normalizeDevices(items) {
  const deduped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.status === "revoked") continue;
    const id = String(item.id || "");
    if (!id) continue;
    const name = item.name || item.device_name || "Panda Bridge";
    const key = String(item.account_id || item.install_id || item.install_id_hash || name).toLowerCase();
    const device = {
      id,
      name,
      online: item.online === true || item.status === "online",
      last_seen_at: item.last_seen_at || item.updated_at || "",
      current: item.current === true,
    };
    const existing = deduped.get(key);
    if (!existing || scoreDevice(device) > scoreDevice(existing)) deduped.set(key, device);
  }
  return [...deduped.values()].sort((a, b) => scoreDevice(b) - scoreDevice(a)).slice(0, 8);
}

function scoreDevice(device) {
  return (device.current ? 4e15 : 0) + (device.online ? 2e15 : 0) + (Date.parse(device.last_seen_at || "") || 0);
}

function currentDevice() {
  return state.bridge.devices.find((item) => item.id === state.selectedDeviceId)
    || state.bridge.devices.find((item) => item.current)
    || state.bridge.devices[0]
    || null;
}

function readyDevice() {
  if (state.bridge.bridge_state !== "ready") return null;
  return currentDevice();
}

function installInfo(next) {
  return normalizeInstall(next.install || FALLBACK_INSTALL);
}

function primaryActionForState(next) {
  return {
    no_session: "login",
    no_device: "download",
    authorization_pending: "confirm_on_desktop",
    authorized_offline: "open_desktop",
    not_authorized: "authorize",
  }[next.bridge_state] || "";
}

function actionUrl(next, kind) {
  return next.actions.find((item) => item.kind === kind)?.url
    || next.actions.find((item) => item.kind === kind)?.deep_link
    || "";
}

function downloadHref(install) {
  const href = install.download_url || FALLBACK_INSTALL.download_url;
  try {
    const url = new URL(href, location.origin);
    url.searchParams.set("version", install.version);
    return url.href;
  } catch {
    const separator = href.includes("?") ? "&" : "?";
    return `${href}${separator}version=${encodeURIComponent(install.version)}`;
  }
}

function readinessText() {
  const labels = {
    no_session: "需要登录",
    no_device: "需要下载",
    authorization_pending: "等待确认",
    authorized_offline: "已授权，离线",
    not_authorized: "需要授权",
    ready: "ready",
  };
  return labels[state.bridge.bridge_state] || "检查中";
}

function submitBlockedText(next) {
  if (next.bridge_state === "authorized_offline") return "已授权，打开桌面端即可使用。";
  if (next.bridge_state === "not_authorized") return "请先授权这台电脑。";
  if (next.bridge_state === "authorization_pending") return "请先在桌面端确认授权。";
  if (next.bridge_state === "no_device") return "请先下载并打开 Panda Bridge。";
  return "Bridge 还没有就绪。";
}

function deviceOptionLabel(device) {
  const lastSeen = relativeTime(device.last_seen_at);
  return `${device.name} · ${device.online ? "已连接" : "离线"}${lastSeen ? ` · ${lastSeen}` : ""}`;
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
  const days = Math.round(hours / 24);
  return `${days}天前`;
}

function openDesktop(url) {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = url;
  document.body.append(frame);
  setTimeout(() => frame.remove(), 3000);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function compactUrl(value) {
  try {
    const url = new URL(value);
    return url.host;
  } catch {
    return value || "local";
  }
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "size pending";
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  if (code === "device_offline") return "本机 Panda Bridge 暂时离线，请打开桌面端后刷新。";
  if (code === "device_not_found") return "这个 Pandart 账号还没有连接本机。";
  if (code === "product_not_authorized" || code === "desktop_authorization_required") return "请先在桌面端确认授权。";
  if (code === "device_queue_full") return "这台电脑的任务队列已满，请稍后再发送。";
  if (code === "account_queue_full") return "这个账号当前任务太多，请稍后再试。";
  if (code === "product_queue_full") return "Pandart 当前任务太多，请稍后再试。";
  if (code === "invalid_credentials") return "账号或密码不正确。";
  if (code === "too_many_login_attempts") return "登录失败次数过多，请稍后再试。";
  if (code === "password_login_not_enabled") return "这个账号还没有启用密码登录，请换一个测试账号。";
  return code;
}
