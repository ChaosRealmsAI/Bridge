#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

const VERSION = "v15-productized-onboarding";
const evidenceDir = resolve("spec/verification/evidence", VERSION);
mkdirSync(evidenceDir, { recursive: true });

const env = {
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_WEB_ORIGIN: "http://chat.local.test",
  BRIDGE_ALLOWED_ORIGINS: "http://chat.local.test http://dev.local.test http://127.0.0.1",
  BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({
    "panda-chat": ["http://chat.local.test"],
    "panda-dev": ["http://dev.local.test"],
  }),
  BRIDGE_PUBLIC_API_BASE: "http://127.0.0.1:0",
  BRIDGE_DEVICE_MAX_QUEUED_JOBS: "50",
  BRIDGE_ACCOUNT_MAX_ACTIVE_JOBS: "50",
  BRIDGE_PRODUCT_MAX_ACTIVE_JOBS: "50",
  SESSION_COOKIE_NAME: "pb_session",
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const body = await readIncoming(incoming);
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}${incoming.url}`;
    const request = new Request(url, {
      method: incoming.method,
      headers: incomingHeaders(incoming.headers),
      body: body.length && incoming.method !== "GET" && incoming.method !== "HEAD" ? body : undefined,
    });
    const response = await worker.fetch(request, {
      ...env,
      BRIDGE_PUBLIC_API_BASE: `http://127.0.0.1:${port}`,
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ error: "productized_onboarding_proxy_error", message: error.message || String(error) }));
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const apiBase = `http://127.0.0.1:${server.address().port}`;
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-productized-"));
const statePath = resolve(temp, "desktop.json");
const deviceName = "Productized Onboarding Device";
const password = "PandaProductized-2026-0610!";
const suffix = Date.now();
const accountEmail = `v15-product-${suffix}@pandart.cc`;

try {
  const accountJar = jar();
  const aChat = createBridgeClient({ apiBase, productId: "panda-chat", fetch: fetchJar(accountJar, "http://chat.local.test") });
  const aDev = createBridgeClient({ apiBase, productId: "panda-dev", fetch: fetchJar(accountJar, "http://dev.local.test") });

  const session = await aChat.auth.password(accountEmail, password, "V15 Productized User");
  assert.equal(session.authenticated, true);

  const chatIntent = await aChat.connect.createIntent({ deviceName });
  assert.ok(chatIntent.deep_link.includes("panda-bridge://connect"), "connect intent must expose desktop deep link");

  await expectSdkError(
    () => aChat.connect.claim(chatIntent.token, { deviceName }),
    403,
    "desktop_claim_required",
  );

  const deniedHeadless = await runDesktop([
    "headless-connect",
    "--api",
    apiBase,
    "--intent",
    chatIntent.token,
    "--device-name",
    deviceName,
  ]);
  assert.notEqual(deniedHeadless.status, 0, "headless-connect must require explicit test flag");
  assert.match(deniedHeadless.stderr, /PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT=1/);

  const chatClaim = await desktopJson([
    "headless-connect",
    "--api",
    apiBase,
    "--intent",
    chatIntent.token,
    "--device-name",
    deviceName,
  ], { allowConnect: true });
  assert.equal(chatClaim.account_id, session.user.id);
  assert.equal(chatClaim.product_id, "panda-chat");
  assertNoSecretKeys(chatClaim);

  const chatDevice = await visibleDevice(aChat, deviceName);
  assert.equal(chatClaim.device_id, chatDevice.id);
  const statusAfterChat = await desktopJson(["headless-status"]);
  assertGrant(statusAfterChat, "panda-chat", session.user.id, chatDevice.id);
  assertNoSecretKeys(statusAfterChat);
  await assertReady(aChat, chatDevice.id, true, "panda-chat should be ready after desktop authorization");
  const chatRpc = await aChat.codex.rpc({
    deviceId: chatDevice.id,
    calls: [{ method: "initialize" }],
    requestKey: `v15-chat-rpc-scope-${suffix}`,
  });
  assert.equal(chatRpc.job.status, "queued");
  await aChat.jobs.cancel(chatRpc.job.id);

  const chatBeforeRevoke = await chatAndPoll(aChat, chatDevice.id, "v15 chat before revoke", "chat-before-revoke");

  const devIntent = await aDev.connect.createIntent({ deviceName });
  const devClaim = await desktopJson([
    "headless-connect",
    "--api",
    apiBase,
    "--intent",
    devIntent.token,
    "--device-name",
    deviceName,
  ], { allowConnect: true });
  assert.equal(devClaim.account_id, session.user.id);
  assert.equal(devClaim.product_id, "panda-dev");
  assert.equal(devClaim.device_id, chatDevice.id, "same account should reuse the same desktop device");
  assertNoSecretKeys(devClaim);

  const statusAfterDev = await desktopJson(["headless-status"]);
  assertGrant(statusAfterDev, "panda-chat", session.user.id, chatDevice.id);
  assertGrant(statusAfterDev, "panda-dev", session.user.id, chatDevice.id);
  assertNoSecretKeys(statusAfterDev);
  await assertReady(aChat, chatDevice.id, true, "panda-chat should remain ready after panda-dev authorization");
  await assertReady(aDev, chatDevice.id, true, "panda-dev should be ready after authorization");

  const devBeforeRevoke = await chatAndPoll(aDev, chatDevice.id, "v15 dev before revoke", "dev-before-revoke");

  const revokeChat = await desktopJson([
    "headless-revoke-authorization",
    "--product-id",
    "panda-chat",
    "--account-id",
    session.user.id,
    "--device-id",
    chatDevice.id,
  ]);
  assert.equal(revokeChat.ok, true);
  assert.equal(revokeChat.remote_revoke_ok, true);
  assertNoSecretKeys(revokeChat);

  const statusAfterRevoke = await desktopJson(["headless-status"]);
  assertMissingGrant(statusAfterRevoke, "panda-chat", session.user.id);
  assertGrant(statusAfterRevoke, "panda-dev", session.user.id, chatDevice.id);
  assertNoSecretKeys(statusAfterRevoke);
  await assertReady(aChat, chatDevice.id, false, "panda-chat should not be ready after revoke");
  await expectSdkError(
    () => aChat.codex.chat({
      deviceId: chatDevice.id,
      prompt: "v15 chat after revoke must fail",
      requestKey: `v15-chat-after-revoke-${suffix}`,
      tokenBudget: 1000,
      timeoutMs: 60000,
    }),
    403,
    "product_not_authorized",
  );
  await assertReady(aDev, chatDevice.id, true, "panda-dev should survive panda-chat revoke");
  const devAfterRevoke = await chatAndPoll(aDev, chatDevice.id, "v15 dev survives chat revoke", "dev-after-revoke");

  const summary = redact({
    ok: true,
    version: VERSION,
    api_base: apiBase,
    desktop_state_path: statePath,
    account: { id: session.user.id, email: accountEmail },
    device: { id: chatDevice.id, name: chatDevice.device_name },
    browser_claim_rejected: true,
    headless_connect_requires_flag: true,
    local_authorization_record: {
      after_chat: statusSummary(statusAfterChat),
      after_dev: statusSummary(statusAfterDev),
      after_revoke: statusSummary(statusAfterRevoke),
    },
    jobs: {
      chat_before_revoke: chatBeforeRevoke,
      dev_before_revoke: devBeforeRevoke,
      dev_after_revoke: devAfterRevoke,
    },
    negative_paths: {
      browser_claim_error: "desktop_claim_required",
      chat_rpc_job_accepted: chatRpc.job.id,
      chat_after_revoke_error: "product_not_authorized",
    },
    docs: [
      "docs/product-integration.md",
      "docs/desktop-user-guide.md",
      "docs/desktop-ai-cli.md",
      "packages/sdk/README.md",
    ],
    cli_contract: [
      "headless-status",
      "headless-connect",
      "headless-poll",
      "headless-revoke-authorization",
      "installed-app verify-control",
      "open_deep_link",
      "click_allow_intent",
      "click_revoke_authorization",
      "GET /v1/screenshot",
    ],
    source_access: "SDK and documented Desktop CLI only; private credential storage was not used as the oracle.",
    checked_at: new Date().toISOString(),
  });
  writeFileSync(resolve(evidenceDir, "productized-onboarding.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, "summary.json"), `${JSON.stringify({
    ok: true,
    version: VERSION,
    checked_at: summary.checked_at,
    evidence: "productized-onboarding.json",
    browser_claim_rejected: true,
    headless_connect_requires_flag: true,
    product_records_after_dev: summary.local_authorization_record.after_dev.products.map((item) => item.id),
    panda_chat_revoked: !summary.local_authorization_record.after_revoke.products.some((item) => item.id === "panda-chat"),
    panda_dev_survived: summary.local_authorization_record.after_revoke.products.some((item) => item.id === "panda-dev"),
    docs: summary.docs,
    cli_contract: summary.cli_contract,
  }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function chatAndPoll(client, deviceId, prompt, key) {
  const created = await client.codex.chat({
    deviceId,
    prompt,
    requestKey: `v15-${key}-${suffix}`,
    tokenBudget: 1000,
    timeoutMs: 60000,
  });
  assert.equal(created.job.status, "queued");
  const poll = await desktopJson(["headless-poll"]);
  assert.equal(poll.ok, true);
  assert.ok(poll.count >= 1, `expected at least one job to be polled for ${key}`);
  assertNoSecretKeys(poll);
  const final = await client.jobs.wait(created.job.id, { timeoutMs: 30000, intervalMs: 500 });
  assert.equal(final.status, "succeeded");
  assert.match(final.result.reply, new RegExp(escapeRegExp(prompt)));
  return { job_id: created.job.id, status: final.status, reply: final.result.reply, poll_count: poll.count };
}

async function assertReady(client, deviceId, expected, message) {
  const preflight = await client.preflight({ deviceId });
  assert.equal(preflight.ready, expected, `${message}: ${JSON.stringify(preflight.issues)}`);
  if (!expected) {
    assert.equal(preflight.issues.some((item) => item.code === "product_not_authorized"), true, message);
  }
  return preflight;
}

function assertGrant(status, productId, accountId, deviceId) {
  const product = (status.authorized_products || []).find((item) => item.id === productId);
  assert.ok(product, `${productId} missing from desktop status`);
  assert.ok(product.name, `${productId} missing display name`);
  assert.ok(product.origin, `${productId} missing origin`);
  assert.ok(Array.isArray(product.capabilities) && product.capabilities.length, `${productId} missing capabilities`);
  assert.equal(product.policy?.version, "AUTH-SCOPE-v1", `${productId} missing AUTH-SCOPE-v1 policy`);
  assert.ok(product.policy?.source_origin, `${productId} missing policy source_origin`);
  assert.ok(product.authorized_at, `${productId} missing authorized_at`);
  const account = (product.accounts || []).find((item) => item.id === accountId);
  assert.ok(account, `${productId} missing account ${accountId}`);
  assert.equal(account.device_id, deviceId);
  assert.ok(account.authorized_at, `${productId} account missing authorized_at`);
}

function assertMissingGrant(status, productId, accountId) {
  const product = (status.authorized_products || []).find((item) => item.id === productId);
  assert.equal(Boolean(product?.accounts?.some((account) => account.id === accountId)), false, `${productId} unexpectedly contains ${accountId}`);
}

async function visibleDevice(client, name) {
  const devices = await client.devices.list();
  const device = devices.items.find((item) => item.device_name === name && item.status === "online");
  assert.ok(device, `device ${name} was not visible`);
  return device;
}

async function desktopJson(args, options = {}) {
  const result = await runDesktop(args, options);
  assert.equal(result.status, 0, childMessage(result));
  return JSON.parse(result.stdout);
}

function runDesktop(args, options = {}) {
  return new Promise((resolveChild) => {
    const childEnv = {
      ...process.env,
      PANDA_BRIDGE_DESKTOP_STATE: statePath,
      PANDA_BRIDGE_FAKE_CODEX: "1",
    };
    if (options.allowConnect) childEnv.PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT = "1";
    else delete childEnv.PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT;
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    let error = null;
    const timer = setTimeout(() => {
      error = new Error("desktop child timed out");
      child.kill("SIGTERM");
    }, 90000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (nextError) => {
      error = nextError;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolveChild({ status, signal, stdout, stderr, error });
    });
  });
}

function jar() {
  return { cookie: "" };
}

function fetchJar(jarRef, origin) {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", origin);
    if (jarRef.cookie) headers.set("cookie", jarRef.cookie);
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) jarRef.cookie = setCookie.split(";")[0];
    return response;
  };
}

async function expectSdkError(operation, status, errorCode) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.status, status);
    assert.equal(error.payload?.error, errorCode);
    return;
  }
  assert.fail(`Expected SDK error ${status} ${errorCode}`);
}

function assertNoSecretKeys(value) {
  const stack = [{ path: "", value }];
  while (stack.length) {
    const item = stack.pop();
    if (!item || item.value == null) continue;
    if (Array.isArray(item.value)) {
      item.value.forEach((next, index) => stack.push({ path: `${item.path}[${index}]`, value: next }));
      continue;
    }
    if (typeof item.value === "object") {
      for (const [key, next] of Object.entries(item.value)) {
        assert.equal(/(^|_)(token|secret|cookie)$|device_token|pb_session|bearer/i.test(key), false, `secret-like key leaked at ${item.path}.${key}`);
        stack.push({ path: item.path ? `${item.path}.${key}` : key, value: next });
      }
    }
    if (typeof item.value === "string") {
      assert.equal(/Bearer\s+[A-Za-z0-9._~+/=-]+|pb_session=|device_token/i.test(item.value), false, `secret-like value leaked at ${item.path}`);
    }
  }
}

function statusSummary(status) {
  return {
    device_id: status.device_id,
    products: (status.authorized_products || []).map((product) => ({
      id: product.id,
      name: product.name,
      origin: product.origin,
      capabilities: product.capabilities,
      policy_version: product.policy?.version || null,
      policy_source_origin: product.policy?.source_origin || null,
      authorized_at: product.authorized_at,
      accounts: (product.accounts || []).map((account) => ({
        id: account.id,
        email: account.email,
        device_id: account.device_id,
        origin: account.origin,
        authorized_at: account.authorized_at,
      })),
    })),
  };
}

function redact(value) {
  const text = JSON.stringify(value, (key, item) => {
    if (/token|cookie|session|secret|bearer/i.test(key)) return "[redacted]";
    return item;
  });
  return JSON.parse(text);
}

function readIncoming(incoming) {
  return new Promise((resolveRead, reject) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => resolveRead(Buffer.concat(chunks)));
    incoming.on("error", reject);
  });
}

function incomingHeaders(raw) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw || {})) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value != null) headers.set(key, String(value));
  }
  return headers;
}

function childMessage(result) {
  return [
    `status=${result.status}`,
    result.signal ? `signal=${result.signal}` : "",
    result.error ? `error=${result.error.message}` : "",
    result.stderr ? `stderr=${result.stderr}` : "",
    result.stdout ? `stdout=${result.stdout}` : "",
  ].filter(Boolean).join("\n");
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
