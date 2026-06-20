#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBridgeClient } from "../../packages/sdk/src/index.js";

const VERSION = "v0-8-sdk-call-examples-relay-only";
const evidenceDir = resolve(process.env.BRIDGE_SDK_EXAMPLES_EVIDENCE_DIR || `spec/verification/evidence/${VERSION}`);
mkdirSync(evidenceDir, { recursive: true });

const calls = [];
let listCount = 0;
const fakeFetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ method, path: `${parsed.pathname}${parsed.search}`, body });

  if (method === "GET" && parsed.pathname === "/v1/diagnostics") {
    return ok({ ok: true, protocol: "bridge-relay-v1" });
  }
  if (method === "GET" && parsed.pathname === "/v1/products") {
    return ok({ items: [{ id: "bridge-demo", capabilities: { relay: ["relay.envelope", "relay.ack"] } }] });
  }
  if (method === "POST" && parsed.pathname === "/v1/connect-intents") {
    return ok({
      token: "pbi_fake_browser_intent",
      deep_link: "bridge://connect?intent=pbi_fake_browser_intent",
      connect_intent: { product_id: "bridge-demo", device_name: body.device_name },
    }, 201);
  }
  if (method === "POST" && parsed.pathname === "/v1/products/bridge-demo/relay/envelopes") {
    return ok({ envelope: { id: "env_request", direction: "product_to_device", seq: body.seq, channel_id: body.channel_id } }, 201);
  }
  if (method === "GET" && parsed.pathname === "/v1/products/bridge-demo/relay/envelopes") {
    listCount += 1;
    return ok({
      items: listCount >= 1
        ? [{ id: "env_response", direction: "device_to_product", seq: 2, channel_id: parsed.searchParams.get("channel_id") }]
        : [],
    });
  }
  if (method === "POST" && parsed.pathname === "/v1/products/bridge-demo/relay/envelopes/env_response/ack") {
    return ok({ envelope: { id: "env_response", status: "acked" } });
  }
  return ok({ ok: true });
};

const browserBridge = createBridgeClient({
  apiBase: "https://bridge.example.test",
  productId: "bridge-demo",
  fetch: fakeFetch,
});

assert.equal(Object.hasOwn(browserBridge, "codex"), false);
assert.equal(Object.hasOwn(browserBridge, "jobs"), false);
assert.equal(typeof browserBridge.diagnostics, "function");
assert.equal(typeof browserBridge.connect.createIntent, "function");
assert.equal(typeof browserBridge.relay.create, "function");
assert.equal(typeof browserBridge.relay.waitForResponse, "function");
assert.equal(typeof browserBridge.relay.createCall, "function");

await browserBridge.diagnostics();
await browserBridge.products.list();
const intent = await browserBridge.connect.createIntent({
  deviceName: "SDK Relay Example Desktop",
  policy: {
    version: "BRIDGE-RELAY-AUTH-v1",
    capabilities: ["relay.envelope", "relay.ack"],
  },
});
assert.match(intent.token, /^pbi_/);

const created = await browserBridge.relay.create({
  deviceId: "dev_example",
  channelId: "sdk-example-channel",
  seq: 1,
  requestKey: "sdk-example-request",
  ciphertext: "cHJvZHVjdC1vd25lZC1jaXBoZXJ0ZXh0",
  aad: "c2RrLWV4YW1wbGUtYWFk",
  nonce: "c2RrLWV4YW1wbGUtbm9uY2U",
  algorithm: "X25519-AES-GCM",
  senderKeyId: "product-key",
  recipientKeyId: "device-key",
});
assert.equal(created.envelope.direction, "product_to_device");

const waited = await browserBridge.relay.waitForResponse({
  deviceId: "dev_example",
  channelId: "sdk-example-channel",
  afterSeq: 1,
  timeoutMs: 1000,
  intervalMs: 100,
});
assert.equal(waited.envelope.direction, "device_to_product");
await waited.ack();

listCount = 0;
const call = await browserBridge.relay.createCall({
  deviceId: "dev_example",
  channelId: "sdk-example-call",
  seq: 1,
  requestKey: "sdk-example-call-request",
  payload: { type: "adapter-owned-demo" },
  relayKeyId: "device-key",
  session: {
    async encrypt({ aad }) {
      return {
        ciphertext: "ZW5jcnlwdGVkLWNhbGwtcGF5bG9hZA",
        aad,
        nonce: "Y2FsbC1ub25jZQ",
        algorithm: "X25519-AES-GCM",
        senderKeyId: "product-key",
        recipientKeyId: "device-key",
      };
    },
    async decrypt(envelope) {
      return { payload: { ok: true, envelopeId: envelope.id } };
    },
  },
  timeoutMs: 1000,
  intervalMs: 100,
});
assert.equal(call.payload.ok, true);
await call.ack();

for (const stale of ["co" + "dex.", "/jo" + "bs", "/queue/" + "summary", "create" + "Job", "job" + "Events"]) {
  assert.equal(JSON.stringify(calls).includes(stale), false, `browser SDK example called stale API: ${stale}`);
}

console.log("[sdk-call-examples] browser relay surface OK");
await import("../minimal-caller/run-local.mjs");

const summary = {
  ok: true,
  version: VERSION,
  browser_calls: calls.map(({ method, path }) => ({ method, path })),
  server_example: "examples/minimal-caller/run-local.mjs",
  stale_surface_absent: true,
};
writeFileSync(resolve(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

function ok(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}
