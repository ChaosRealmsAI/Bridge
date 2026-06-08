#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import worker from "../../apps/cloud-worker/src/index.js";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

const VERSION = "v11-multi-source-account-authorization";
const evidenceDir = resolve("spec/verification/evidence", VERSION);
mkdirSync(evidenceDir, { recursive: true });

const env = {
  BRIDGE_LOCAL_MEMORY: "1",
  BRIDGE_WEB_ORIGIN: "http://chat.local.test",
  BRIDGE_ALLOWED_ORIGINS: "http://chat.local.test http://dev.local.test http://127.0.0.1",
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
    outgoing.end(JSON.stringify({ error: "multi_source_proxy_error", message: error.message || String(error) }));
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const apiBase = `http://127.0.0.1:${server.address().port}`;
const temp = mkdtempSync(resolve(tmpdir(), "panda-bridge-multi-authz-"));
const statePath = resolve(temp, "desktop.json");
const deviceName = "Multi Source Account Device";
const password = "PandaMultiAuthz-2026-0608!";
const suffix = Date.now();
const accountAEmail = `v11-a-${suffix}@pandart.cc`;
const accountBEmail = `v11-b-${suffix}@pandart.cc`;

try {
  const jarA = jar();
  const jarB = jar();
  const aChat = createBridgeClient({ apiBase, productId: "panda-chat", fetch: fetchJar(jarA, "http://chat.local.test") });
  const aDev = createBridgeClient({ apiBase, productId: "panda-dev", fetch: fetchJar(jarA, "http://dev.local.test") });
  const bChat = createBridgeClient({ apiBase, productId: "panda-chat", fetch: fetchJar(jarB, "http://chat.local.test") });

  const sessionA = await aChat.auth.password(accountAEmail, password, "V11 Account A");
  assert.equal(sessionA.authenticated, true);
  const sessionB = await bChat.auth.password(accountBEmail, password, "V11 Account B");
  assert.equal(sessionB.authenticated, true);

  const aChatIntent = await aChat.connect.createIntent({ deviceName });
  const aChatClaim = await desktopJson(["headless-connect", "--api", apiBase, "--intent", aChatIntent.token, "--device-name", deviceName]);
  assert.equal(aChatClaim.account_id, sessionA.user.id);

  const deviceA = await visibleDevice(aChat, deviceName);
  assert.equal(aChatClaim.device_id, deviceA.id);

  const aDevIntent = await aDev.connect.createIntent({ deviceName });
  const aDevClaim = await desktopJson(["headless-connect", "--api", apiBase, "--intent", aDevIntent.token, "--device-name", deviceName]);
  assert.equal(aDevClaim.account_id, sessionA.user.id);
  assert.equal(aDevClaim.device_id, deviceA.id, "same account/source expansion should reuse account A device");

  const bChatIntent = await bChat.connect.createIntent({ deviceName });
  const bChatClaim = await desktopJson(["headless-connect", "--api", apiBase, "--intent", bChatIntent.token, "--device-name", deviceName]);
  assert.equal(bChatClaim.account_id, sessionB.user.id);

  const deviceB = await visibleDevice(bChat, deviceName);
  assert.notEqual(deviceB.id, deviceA.id, "different accounts must keep separate device tokens");

  const statusAfterClaims = await desktopJson(["headless-status"]);
  assertProductAccount(statusAfterClaims, "panda-chat", sessionA.user.id);
  assertProductAccount(statusAfterClaims, "panda-chat", sessionB.user.id);
  assertProductAccount(statusAfterClaims, "panda-dev", sessionA.user.id);

  await assertReady(aChat, deviceA.id, true, "account A panda-chat should be ready");
  await assertReady(aDev, deviceA.id, true, "account A panda-dev should be ready");
  await assertReady(bChat, deviceB.id, true, "account B panda-chat should be ready");

  const firstChatA = await chatAndPoll(aChat, deviceA.id, "v11 account A chat before revoke", "a-chat-before");
  const firstDevA = await chatAndPoll(aDev, deviceA.id, "v11 account A dev before revoke", "a-dev-before");
  const firstChatB = await chatAndPoll(bChat, deviceB.id, "v11 account B chat before revoke", "b-chat-before");

  const revokeAChat = await desktopJson([
    "headless-revoke-authorization",
    "--product-id",
    "panda-chat",
    "--account-id",
    sessionA.user.id,
    "--device-id",
    deviceA.id,
  ]);
  assert.equal(revokeAChat.ok, true);
  assert.equal(revokeAChat.remote_revoke_ok, true);

  const statusAfterARevoke = await desktopJson(["headless-status"]);
  assertMissingProductAccount(statusAfterARevoke, "panda-chat", sessionA.user.id);
  assertProductAccount(statusAfterARevoke, "panda-chat", sessionB.user.id);
  assertProductAccount(statusAfterARevoke, "panda-dev", sessionA.user.id);
  await assertReady(aChat, deviceA.id, false, "account A panda-chat should be blocked after revoke");
  await expectSdkError(
    () => aChat.codex.chat({
      deviceId: deviceA.id,
      prompt: "v11 account A chat must fail after revoke",
      requestKey: `v11-a-chat-after-revoke-${suffix}`,
      tokenBudget: 1000,
      timeoutMs: 60000,
    }),
    403,
    "product_not_authorized",
  );

  const secondDevA = await chatAndPoll(aDev, deviceA.id, "v11 account A dev survives chat revoke", "a-dev-after-a-chat-revoke");
  const secondChatB = await chatAndPoll(bChat, deviceB.id, "v11 account B chat survives account A revoke", "b-chat-after-a-revoke");

  const pollAfterARevoke = await desktopJson(["headless-poll"]);
  assert.equal(pollAfterARevoke.ok, true);
  const statusAfterARevokeHeartbeat = await desktopJson(["headless-status"]);
  assertMissingProductAccount(statusAfterARevokeHeartbeat, "panda-chat", sessionA.user.id);

  const revokeBChat = await desktopJson([
    "headless-revoke-authorization",
    "--product-id",
    "panda-chat",
    "--account-id",
    sessionB.user.id,
    "--device-id",
    deviceB.id,
  ]);
  assert.equal(revokeBChat.ok, true);
  assert.equal(revokeBChat.remote_revoke_ok, true);

  const statusAfterBRevoke = await desktopJson(["headless-status"]);
  assertMissingProductAccount(statusAfterBRevoke, "panda-chat", sessionA.user.id);
  assertMissingProductAccount(statusAfterBRevoke, "panda-chat", sessionB.user.id);
  assertProductAccount(statusAfterBRevoke, "panda-dev", sessionA.user.id);
  await assertReady(bChat, deviceB.id, false, "account B panda-chat should be blocked after revoke");
  await expectSdkError(
    () => bChat.codex.chat({
      deviceId: deviceB.id,
      prompt: "v11 account B chat must fail after revoke",
      requestKey: `v11-b-chat-after-revoke-${suffix}`,
      tokenBudget: 1000,
      timeoutMs: 60000,
    }),
    403,
    "product_not_authorized",
  );

  const finalDevA = await chatAndPoll(aDev, deviceA.id, "v11 account A dev survives both chat revokes", "a-dev-after-b-chat-revoke");

  const summary = redact({
    ok: true,
    version: VERSION,
    api_base: apiBase,
    state_path: statePath,
    accounts: {
      a: { id: sessionA.user.id, email: accountAEmail, device_id: deviceA.id },
      b: { id: sessionB.user.id, email: accountBEmail, device_id: deviceB.id },
    },
    claims: {
      account_a_chat: { device_id: aChatClaim.device_id, products: productIds(aChatClaim.authorized_products) },
      account_a_dev: { device_id: aDevClaim.device_id, products: productIds(aDevClaim.authorized_products) },
      account_b_chat: { device_id: bChatClaim.device_id, products: productIds(bChatClaim.authorized_products) },
    },
    initial_status: statusSummary(statusAfterClaims),
    initial_chats: [firstChatA, firstDevA, firstChatB],
    after_account_a_chat_revoke: {
      revoke: revokeSummary(revokeAChat),
      status: statusSummary(statusAfterARevoke),
      account_a_chat_blocked: true,
      account_a_dev_survived: secondDevA.status === "succeeded",
      account_b_chat_survived: secondChatB.status === "succeeded",
      heartbeat_did_not_reauthorize: !hasProductAccount(statusAfterARevokeHeartbeat, "panda-chat", sessionA.user.id),
      poll_count: pollAfterARevoke.count,
    },
    after_account_b_chat_revoke: {
      revoke: revokeSummary(revokeBChat),
      status: statusSummary(statusAfterBRevoke),
      account_b_chat_blocked: true,
      account_a_dev_survived: finalDevA.status === "succeeded",
    },
    locked_regression: "npm run verify:multi-source-authorization",
    source_access: "Desktop headless operation surface plus SDK-as-user sessions; no storage or implementation state was used as the oracle.",
    checked_at: new Date().toISOString(),
  });
  writeFileSync(resolve(evidenceDir, "multi-source-authorization.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function chatAndPoll(client, deviceId, prompt, key) {
  const created = await client.codex.chat({
    deviceId,
    prompt,
    requestKey: `v11-${key}-${suffix}`,
    tokenBudget: 1000,
    timeoutMs: 60000,
  });
  assert.equal(created.job.status, "queued");
  const poll = await desktopJson(["headless-poll"]);
  assert.equal(poll.ok, true);
  assert.ok(poll.count >= 1, `expected at least one job to be polled for ${key}`);
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

function assertProductAccount(status, productId, accountId) {
  assert.equal(hasProductAccount(status, productId, accountId), true, `${productId} missing account ${accountId}`);
}

function assertMissingProductAccount(status, productId, accountId) {
  assert.equal(hasProductAccount(status, productId, accountId), false, `${productId} unexpectedly contains account ${accountId}`);
}

function hasProductAccount(status, productId, accountId) {
  const product = (status.authorized_products || []).find((item) => item.id === productId);
  return Boolean(product?.accounts?.some((account) => account.id === accountId));
}

async function visibleDevice(client, name) {
  const devices = await client.devices.list();
  const device = devices.items.find((item) => item.device_name === name && item.status === "online");
  assert.ok(device, `device ${name} was not visible`);
  return device;
}

async function desktopJson(args) {
  const result = await runDesktop(args);
  assert.equal(result.status, 0, childMessage(result));
  return JSON.parse(result.stdout);
}

function runDesktop(args) {
  return new Promise((resolveChild) => {
    const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "apps/desktop/Cargo.toml", "--", ...args], {
      env: {
        ...process.env,
        PANDA_BRIDGE_DESKTOP_STATE: statePath,
        PANDA_BRIDGE_FAKE_CODEX: "1",
      },
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

function productIds(products) {
  return (products || []).map((item) => item.id);
}

function statusSummary(status) {
  return {
    device_id: status.device_id,
    account_id: status.account_id,
    products: (status.authorized_products || []).map((product) => ({
      id: product.id,
      accounts: (product.accounts || []).map((account) => ({
        id: account.id,
        email: account.email,
        device_id: account.device_id,
      })),
    })),
  };
}

function revokeSummary(payload) {
  return {
    ok: payload.ok,
    remote_revoke_ok: payload.remote_revoke_ok,
    product_id: payload.product_id,
    account_id: payload.account_id,
    device_id: payload.device_id,
    cancelled_jobs: payload.cancelled_jobs,
    revoked: (payload.revoked || []).map((item) => ({
      remote_revoke_ok: item.remote_revoke_ok,
      account_id: item.account_id,
      device_id: item.device_id,
      authorization_status: item.authorization?.status || null,
      cancelled_jobs: item.cancelled_jobs,
    })),
  };
}

function redact(value) {
  const text = JSON.stringify(value, (key, item) => {
    if (/token|cookie|session/i.test(key)) return "[redacted]";
    return item;
  });
  return JSON.parse(text);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
