import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const syllo = readFileSync(new URL("../../apps/desktop/src/connector/syllo.rs", import.meta.url), "utf8");
assert.ok(syllo.includes("Legacy Syllo vertical adapter"));
const registryStart = main.indexOf("fn execution_registry(");
const registryEnd = main.indexOf("fn declaration_registry", registryStart);
const registry = main.slice(registryStart, registryEnd);
assert.ok(registry.includes("#[cfg(test)]"));
assert.ok(registry.includes("SylloConnector::new"));
assert.ok(registry.includes("#[cfg(not(test))]"));
assert.ok(registry.includes("Ok(ConnectorRegistry::new())"));

console.log("[adapter-syllo] pass");
