import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const main = readFileSync(new URL("../../apps/desktop/src/main.rs", import.meta.url), "utf8");

const pollOnceStart = main.indexOf("fn poll_once(");
const pollOnceEnd = main.indexOf("fn connection_authorizes_product_active", pollOnceStart);
assert.ok(pollOnceStart > 0 && pollOnceEnd > pollOnceStart, "poll_once function not found");
const pollOnce = main.slice(pollOnceStart, pollOnceEnd);
assert.ok(pollOnce.includes("/v1/connectors/relay/envelopes"));
assert.ok(pollOnce.includes("route_and_ack_relay_envelope"));
assert.equal(pollOnce.includes("execute_and_ack"), false, "poll_once must not execute legacy jobs");

const adapterStart = main.indexOf("fn route_relay_envelope_to_adapter(");
const adapterEnd = main.indexOf("fn adapter_endpoint_for_product", adapterStart);
assert.ok(adapterStart > 0 && adapterEnd > adapterStart, "AdapterRouter function not found");
const adapterRouter = main.slice(adapterStart, adapterEnd);
assert.ok(adapterRouter.includes('"ciphertext"'));
assert.ok(adapterRouter.includes('"aad"'));
assert.ok(adapterRouter.includes('"nonce"'));
assert.equal(adapterRouter.includes("prompt"), false, "AdapterRouter must not parse product prompt");
assert.equal(adapterRouter.includes("syllo."), false, "AdapterRouter must not parse Syllo kinds");
assert.equal(adapterRouter.includes("codex."), false, "AdapterRouter must not parse Codex kinds");
assert.ok(adapterRouter.includes("response_envelope"), "AdapterRouter must forward opaque adapter response envelopes");
assert.ok(main.includes("fn post_connector_relay_envelope("), "Desktop must post adapter response envelopes through connector relay");

// The legacy in-process Syllo (and all other) vertical connectors were removed
// from Bridge Desktop core entirely. Syllo runs only as an external Product
// Adapter reached over the generic relay, so none of the connector/registry
// machinery may come back.
assert.equal(
  existsSync(new URL("../../apps/desktop/src/connector/syllo.rs", import.meta.url)),
  false,
  "Desktop core must not retain the Syllo vertical connector",
);
assert.equal(
  existsSync(new URL("../../apps/desktop/src/connector/codex.rs", import.meta.url)),
  false,
  "Desktop core must not retain the Codex vertical connector",
);
for (const banned of ["SylloConnector", "CodexConnector", "execution_registry", "declaration_registry", "ConnectorRegistry"]) {
  assert.equal(main.includes(banned), false, `Desktop core must not reference removed vertical symbol: ${banned}`);
}

const localStateStart = main.indexOf("fn local_state() -> Value");
const localStateEnd = main.indexOf("fn low_tier_capabilities", localStateStart);
assert.ok(localStateStart > 0 && localStateEnd > localStateStart, "local_state function not found");
const localState = main.slice(localStateStart, localStateEnd);
assert.equal(localState.includes('"panda-syllo"'), false, "local_state must not hard-code Syllo product identity");
assert.ok(localState.includes("local_state_for_products"), "Desktop must build local state from product context");
assert.ok(localState.includes("adapter_state_for_products"), "Desktop must expose product-scoped adapter state generically");

console.log("[adapter-syllo] pass");
