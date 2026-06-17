import { createBridgeClient } from "/sdk/index.js";

const params = new URLSearchParams(location.search);
const PRODUCT_PROFILES = Object.freeze({
  "bridge-demo": {
    id: "bridge-demo",
    name: "Bridge Demo",
    mark: "BD",
    domain: "bridge.chaos-realms.cc",
    accountLabel: "Bridge demo account",
    desktopLabel: "Bridge device",
    tagline: "Secure local relay",
    chatTitle: "Relay Authorization",
    chatSubtitle: "Sign in, connect Panda Bridge Desktop, and inspect relay readiness.",
    intro: "Bridge routes opaque relay envelopes only. Product payloads live in your app and local Product Adapter.",
    loginPlaceholder: "demo@bridge.example",
    deviceName: () => `Bridge Demo ${navigator.platform || "Desktop"}`,
    requestSource: "bridge_demo_web_authorization",
    risk: "Low risk: Bridge only sees encrypted envelope metadata and ACK state.",
    capabilities: ["relay.envelope", "relay.ack"],
    demoAccount: Object.freeze({
      email: "demo@bridge.example",
      password: "Bridge-Demo-Local-2026!",
    }),
  },
});

const PRODUCT = productProfile(params.get("product") || params.get("product_id") || "bridge-demo");
const PRODUCT_ID = PRODUCT.id;
const API_BASE = params.get("api") || defaultApiBase(PRODUCT);
const DEMO_ACCOUNT = PRODUCT.demoAccount;
const bridge = createBridgeClient({ apiBase: API_BASE, productId: PRODUCT_ID });

const state = {
  session: null,
  bridge: null,
  intent: null,
  busy: false,
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
  authTitle: document.querySelector("[data-auth-title]"),
  authOrigin: document.querySelector("[data-auth-origin]"),
  authRoot: document.querySelector("[data-auth-root]"),
  authRisk: document.querySelector("[data-auth-risk]"),
  authCapabilities: document.querySelector("[data-auth-capabilities]"),
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
  if (action === "refresh") await refresh();
  if (action === "mobile") await createMobileLink();
  if (action === "primary-bridge") await runPrimaryBridgeAction();
  if (action === "cancel-intent") clearIntent();
  if (action === "revoke-authorization") await revokeAuthorization();
});

nodes.loginForm?.addEventListener("submit", onLogin);
nodes.composer?.addEventListener("submit", (event) => {
  event.preventDefault();
  addMessage("assistant", "Bridge Web demo does not define product payloads. Use @panda-bridge/sdk relay.create/createCall from the product app, and keep encryption in your Product Adapter.");
});

renderShell();
prefillDemoAccount();
await bootstrap();

async function bootstrap() {
  const join = params.get("join");
  if (join) {
    try {
      state.session = await bridge.auth.join(join);
      history.replaceState(null, "", location.pathname);
      addMessage("assistant", `Joined the same ${PRODUCT.name} account.`);
    } catch (error) {
      addMessage("assistant", formatError(error), "error");
    }
  }
  await refresh().catch((error) => addMessage("assistant", formatError(error), "error"));
}

async function refresh() {
  setBusy(true);
  try {
    state.session = await bridge.auth.session().catch(() => null);
    state.bridge = await bridge.state();
    render();
  } finally {
    setBusy(false);
  }
}

async function onLogin(event) {
  event.preventDefault();
  const email = nodes.loginEmail.value.trim();
  const password = nodes.loginPassword.value;
  if (!email || !password) {
    addMessage("assistant", `Enter a ${PRODUCT.name} account email and password.`, "error");
    return;
  }
  setBusy(true);
  try {
    state.session = await bridge.auth.password(email, password, email);
    nodes.loginPanel.hidden = true;
    nodes.loginPassword.value = "";
    addMessage("assistant", `Signed in as ${email}.`);
    await refresh();
  } catch (error) {
    addMessage("assistant", formatError(error), "error");
  } finally {
    setBusy(false);
  }
}

async function logout() {
  setBusy(true);
  try {
    await bridge.auth.logout();
    state.session = null;
    state.bridge = await bridge.state();
    state.intent = null;
    addMessage("assistant", "Signed out.");
    render();
  } catch (error) {
    addMessage("assistant", formatError(error), "error");
  } finally {
    setBusy(false);
  }
}

async function createMobileLink() {
  try {
    const link = await bridge.auth.share();
    const url = new URL(location.href);
    url.searchParams.set("join", link.token);
    nodes.mobile.hidden = false;
    nodes.mobileLink.href = url.toString();
    nodes.mobileLink.textContent = url.toString();
  } catch (error) {
    addMessage("assistant", formatError(error), "error");
  }
}

async function runPrimaryBridgeAction() {
  if (!state.session?.authenticated) {
    showLogin();
    return;
  }
  const account = currentAccount();
  if (account?.authorization?.status === "active" && account.connected) {
    addMessage("assistant", "Bridge is connected. The next step belongs to the product app: create an encrypted relay envelope with the SDK.");
    return;
  }
  setBusy(true);
  try {
    state.intent = await bridge.connect.createIntent({
      productId: PRODUCT_ID,
      deviceName: PRODUCT.deviceName(),
      policy: relayAuthorizationPolicy(),
    });
    addMessage("assistant", "Connection intent created. Open the deep link on Panda Bridge Desktop, approve it, then refresh.");
    render();
  } catch (error) {
    addMessage("assistant", formatError(error), "error");
  } finally {
    setBusy(false);
  }
}

async function revokeAuthorization() {
  const account = currentAccount();
  const deviceId = account?.current_device?.id;
  if (!deviceId) return;
  setBusy(true);
  try {
    await bridge.authorization.remove({ deviceId });
    addMessage("assistant", "Authorization removed.");
    await refresh();
  } catch (error) {
    addMessage("assistant", formatError(error), "error");
  } finally {
    setBusy(false);
  }
}

function clearIntent() {
  state.intent = null;
  render();
}

function renderShell() {
  document.title = `${PRODUCT.name} Bridge Relay`;
  setText(nodes.domainBadge, PRODUCT.domain);
  setText(nodes.apiBase, shortApiBase(API_BASE));
  setText(nodes.publicOrigin, location.host || "local");
  setText(nodes.runtimePill, "secure relay");
  document.querySelectorAll(".brand-mark").forEach((node) => { node.textContent = PRODUCT.mark; });
  const brandCopy = document.querySelector(".brand-copy");
  if (brandCopy) {
    brandCopy.querySelector("h1").textContent = PRODUCT.name;
    brandCopy.querySelector("p").textContent = PRODUCT.tagline;
  }
  const statusRows = document.querySelectorAll(".status-panel .row span");
  if (statusRows[0]) statusRows[0].textContent = PRODUCT.accountLabel;
  if (statusRows[1]) statusRows[1].textContent = "Bridge connection";
  const bridgeLabel = document.querySelector(".bridge-head .label");
  if (bridgeLabel) bridgeLabel.textContent = PRODUCT.desktopLabel;
  const chatHead = document.querySelector(".chat-head");
  if (chatHead) {
    chatHead.querySelector(".route-label").textContent = "product app / bridge cloud / desktop adapter";
    chatHead.querySelector("h2").textContent = PRODUCT.chatTitle;
    chatHead.querySelector("p").textContent = PRODUCT.chatSubtitle;
  }
  const intro = nodes.messages?.querySelector(".bubble-text");
  if (intro) intro.textContent = PRODUCT.intro;
  if (nodes.input) nodes.input.placeholder = "Bridge Web demo does not send product plaintext";
  if (nodes.send) nodes.send.textContent = "Inspect";
  if (nodes.cancel) nodes.cancel.hidden = true;
}

function render() {
  const account = currentAccount();
  const connected = Boolean(account?.connected);
  const authStatus = account?.authorization?.status || "missing";
  setText(nodes.session, state.session?.authenticated ? "signed in" : "not signed in");
  setText(nodes.deviceStatus, connected ? "connected" : authStatus === "active" ? "reconnecting" : "not connected");
  setText(nodes.readiness, state.bridge?.ready ? "ready" : "needs desktop approval");
  setText(nodes.authTitle, authStatus === "active" ? "Relay approved" : "Relay not approved");
  setText(nodes.authOrigin, account?.authorization?.source_origin || PRODUCT.domain);
  setText(nodes.authRoot, "Product Adapter owns payload scope");
  setText(nodes.authRisk, PRODUCT.risk);
  renderCapabilities();
  renderBridgePanel(account);
}

function renderBridgePanel(account) {
  const authStatus = account?.authorization?.status || "missing";
  const connected = Boolean(account?.connected);
  const device = account?.current_device || null;
  nodes.bridgePanel.dataset.bridgeState = connected ? "ready" : authStatus === "active" ? "waiting" : "missing";
  if (connected) {
    setText(nodes.bridgeTitle, "Ready for relay");
    setText(nodes.bridgeCopy, `${device?.name || "Panda Bridge Desktop"} is online. Product payloads must stay encrypted.`);
  } else if (authStatus === "active") {
    setText(nodes.bridgeTitle, "Waiting for desktop");
    setText(nodes.bridgeCopy, "Authorization is active, but no online Desktop is currently heartbeating.");
  } else if (state.intent?.deep_link) {
    setText(nodes.bridgeTitle, "Intent ready");
    setText(nodes.bridgeCopy, "Open Panda Bridge Desktop with the deep link below, approve, then refresh this page.");
  } else {
    setText(nodes.bridgeTitle, "Approval required");
    setText(nodes.bridgeCopy, "Create a connection intent and approve it from Panda Bridge Desktop.");
  }
  renderBridgePrimary(connected);
  renderDevices(account);
}

function renderBridgePrimary(connected) {
  nodes.bridgePrimary.innerHTML = "";
  if (state.intent?.deep_link) {
    nodes.bridgePrimary.append(buttonLink(state.intent.deep_link, "Open Panda Bridge"));
    nodes.bridgePrimary.append(actionButton("cancel-intent", "Clear"));
    return;
  }
  nodes.bridgePrimary.append(actionButton("primary-bridge", connected ? "Connected" : "Connect Desktop", connected));
  if (connected) nodes.bridgePrimary.append(actionButton("revoke-authorization", "Revoke"));
}

function renderDevices(account) {
  const devices = Array.isArray(state.bridge?.devices) ? state.bridge.devices : [];
  nodes.bridgeDevices.innerHTML = "";
  if (!devices.length) {
    nodes.bridgeDevices.textContent = "No Bridge devices on this account.";
    return;
  }
  for (const device of devices) {
    const item = document.createElement("div");
    item.className = "device-row";
    item.textContent = `${device.name || device.id} · ${device.status || "unknown"}${account?.current_device?.id === device.id ? " · current" : ""}`;
    nodes.bridgeDevices.append(item);
  }
}

function renderCapabilities() {
  nodes.authCapabilities.innerHTML = "";
  for (const cap of PRODUCT.capabilities) {
    const item = document.createElement("span");
    item.textContent = cap;
    nodes.authCapabilities.append(item);
  }
}

function currentAccount() {
  return state.bridge?.current_account || state.bridge?.accounts?.[0] || null;
}

function showLogin() {
  nodes.loginPanel.hidden = false;
  prefillDemoAccount();
  nodes.loginEmail.focus();
}

function prefillDemoAccount() {
  if (!DEMO_ACCOUNT) return;
  nodes.loginEmail.value ||= DEMO_ACCOUNT.email;
  nodes.loginPassword.value ||= DEMO_ACCOUNT.password;
}

function relayAuthorizationPolicy() {
  return {
    version: "BRIDGE-RELAY-AUTH-v1",
    request_source: PRODUCT.requestSource,
    capabilities: PRODUCT.capabilities,
    product_authorization: {
      owner: "product-adapter",
      capabilities: ["demo.message"],
      roots: [{ id: "adapter", path_display: "Product Adapter scope" }],
    },
  };
}

function productProfile(productId) {
  const key = String(productId || "").trim() || "bridge-demo";
  return PRODUCT_PROFILES[key] || { ...PRODUCT_PROFILES["bridge-demo"], id: key, name: key };
}

function defaultApiBase(product) {
  return location.origin;
}

function setBusy(value) {
  state.busy = value;
  for (const node of [nodes.send, ...document.querySelectorAll("[data-action]")]) {
    if (node) node.disabled = value;
  }
}

function addMessage(role, text, tone = "") {
  const article = document.createElement("article");
  article.className = `message ${role} ${tone}`.trim();
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "assistant" ? PRODUCT.mark : "ME";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const bubbleText = document.createElement("div");
  bubbleText.className = "bubble-text";
  bubbleText.textContent = text;
  bubble.append(bubbleText);
  article.append(avatar, bubble);
  nodes.messages.append(article);
  article.scrollIntoView({ block: "end" });
}

function actionButton(action, label, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = label;
  button.disabled = disabled;
  return button;
}

function buttonLink(href, label) {
  const link = document.createElement("a");
  link.className = "install-link";
  link.href = href;
  link.textContent = label;
  return link;
}

function setText(node, value) {
  if (node) node.textContent = value == null ? "" : String(value);
}

function shortApiBase(value) {
  try {
    return new URL(value).host;
  } catch {
    return String(value || "local");
  }
}

function formatError(error) {
  if (!error) return "Bridge request failed.";
  const code = error.code || error.payload?.error;
  return code ? `${code}: ${error.message}` : error.message || String(error);
}
