// Byte-level interop proof for the relay-key bootstrap handshake:
//
//   Dart SDK  (BridgeRelayKeyBootstrap.wrapRelayKeyForDesktop, pure-Dart P-256)
//        |  wrap a known 32-byte relayKey under a JS-generated desktop public key
//        v
//   JS adapter-sdk (importBridgeRelayKeyBootstrap, WebCrypto ECDH + A256GCM)
//        |  unwrap
//        v
//   assert: recovered 32 bytes === the original 32 bytes
//
// This is the production handshake's bytes-on-the-wire contract. If the Dart
// wrap and the desktop/JS unwrap agree here, a real device can hand the desktop
// a relay key the desktop can actually open.
//
// The Dart side runs out-of-process (dart run tool/wrap_relay_key.dart) because
// the wrap math lives in the Dart SDK; this test drives it and unwraps in Node.
//
// Run: node --test packages/adapter-sdk/test/relay_key_bootstrap_interop.test.mjs
//   (skips itself with a clear note if the `dart` toolchain is unavailable.)
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createBridgeRelayKeyState, importBridgeRelayKeyBootstrap } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const flutterSdkDir = resolve(here, "../../native/flutter");

function dartAvailable() {
  const probe = spawnSync("dart", ["--version"], { encoding: "utf8" });
  return probe.status === 0 || /Dart SDK version/.test(String(probe.stderr || probe.stdout));
}

function wrapWithDart(request) {
  const out = execFileSync("dart", ["run", "tool/wrap_relay_key.dart"], {
    cwd: flutterSdkDir,
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  // dart run may prepend build noise on first run; take the trailing JSON object.
  const start = out.indexOf("{");
  return JSON.parse(out.slice(start));
}

const PRODUCT_ID = "acme-chat";
const DEVICE_ID = "dev_1";
const AUTHORIZATION_ID = "auth_1";
const AUTHORIZATION_EPOCH = 3;

test("Dart-wrapped relay key unwraps byte-for-byte in the JS adapter-sdk", async (t) => {
  if (!dartAvailable()) {
    t.skip("dart toolchain not available — cannot run the Dart wrap side");
    return;
  }

  // 1) JS side ("desktop"): generate the relay-key exchange (P-256 public JWK).
  const relayKeyState = await createBridgeRelayKeyState();
  const exchange = relayKeyState.exchange;
  assert.equal(exchange.algorithm, "ECDH-P256+A256GCM");
  assert.equal(exchange.public_jwk.kty, "EC");
  assert.equal(exchange.public_jwk.crv, "P-256");

  // 2) A known 32-byte relay key (deterministic so the assertion is exact).
  const relayKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) relayKey[i] = (i * 7 + 11) & 0xff;
  const relayKeyB64 = Buffer.from(relayKey).toString("base64");

  // 3) Dart side ("app/phone"): wrap the relay key under the desktop public key.
  const wrapped = wrapWithDart({
    product_id: PRODUCT_ID,
    device_id: DEVICE_ID,
    authorization_id: AUTHORIZATION_ID,
    authorization_epoch: AUTHORIZATION_EPOCH,
    relay_key_b64: relayKeyB64,
    exchange: { key_id: exchange.key_id, public_jwk: exchange.public_jwk },
  });

  console.log("[dart wrap] app_public_jwk.x =", wrapped.app_public_jwk.x);
  console.log("[dart wrap] app_public_jwk.y =", wrapped.app_public_jwk.y);
  console.log("[dart wrap] nonce_b64        =", wrapped.nonce_b64);
  console.log("[dart wrap] ciphertext_b64   =", wrapped.ciphertext_b64);
  console.log("[dart wrap] aad_b64          =", wrapped.aad_b64);
  console.log("[dart wrap] aad_text         =", wrapped.aad_text);

  // The AAD the Dart side built must equal the canonical bootstrap AAD.
  const expectedAadText =
    `bridge-relay-key-bootstrap-v1|${PRODUCT_ID}|${DEVICE_ID}|${AUTHORIZATION_ID}|${AUTHORIZATION_EPOCH}|${exchange.key_id}`;
  assert.equal(wrapped.aad_text, expectedAadText, "Dart bootstrap AAD must match the canonical text");
  assert.equal(Buffer.from(wrapped.aad_b64, "base64").toString("utf8"), expectedAadText);

  // 4) JS side ("desktop"): unwrap with the private key from step 1.
  const bootstrap = {
    status: "ready",
    product_id: PRODUCT_ID,
    device_id: DEVICE_ID,
    authorization_id: AUTHORIZATION_ID,
    authorization_epoch: AUTHORIZATION_EPOCH,
    key_id: exchange.key_id,
    algorithm: "ECDH-P256+A256GCM",
    wrapped_key: wrapped,
  };
  const imported = await importBridgeRelayKeyBootstrap(bootstrap, relayKeyState.keyPair.privateKey);

  // 5) Byte-for-byte equality of the recovered relay key.
  assert.equal(imported.keyBytes.length, 32);
  assert.deepEqual(Buffer.from(imported.keyBytes), Buffer.from(relayKey));
  console.log("[js unwrap] recovered relayKey b64 =", Buffer.from(imported.keyBytes).toString("base64"));
  console.log("[js unwrap] original  relayKey b64 =", relayKeyB64);
  console.log("INTEROP OK: Dart wrap -> JS unwrap recovered the exact 32-byte relay key.");

  // Sanity: a tampered ciphertext must NOT unwrap (GCM tag protects integrity).
  const tampered = JSON.parse(JSON.stringify(bootstrap));
  const ct = Buffer.from(tampered.wrapped_key.ciphertext_b64, "base64");
  ct[0] ^= 0x01;
  tampered.wrapped_key.ciphertext_b64 = ct.toString("base64");
  await assert.rejects(
    () => importBridgeRelayKeyBootstrap(tampered, relayKeyState.keyPair.privateKey),
    "tampered ciphertext must fail GCM verification",
  );
});

test("multiple independent wraps each unwrap correctly (fresh ephemeral keys)", async (t) => {
  if (!dartAvailable()) {
    t.skip("dart toolchain not available");
    return;
  }
  const relayKeyState = await createBridgeRelayKeyState();
  for (let round = 0; round < 3; round++) {
    const relayKey = webcrypto.getRandomValues(new Uint8Array(32));
    const relayKeyB64 = Buffer.from(relayKey).toString("base64");
    const wrapped = wrapWithDart({
      product_id: PRODUCT_ID,
      device_id: DEVICE_ID,
      authorization_id: AUTHORIZATION_ID,
      authorization_epoch: AUTHORIZATION_EPOCH,
      relay_key_b64: relayKeyB64,
      exchange: { key_id: relayKeyState.exchange.key_id, public_jwk: relayKeyState.exchange.public_jwk },
    });
    const imported = await importBridgeRelayKeyBootstrap({
      status: "ready",
      product_id: PRODUCT_ID,
      device_id: DEVICE_ID,
      authorization_id: AUTHORIZATION_ID,
      authorization_epoch: AUTHORIZATION_EPOCH,
      key_id: relayKeyState.exchange.key_id,
      algorithm: "ECDH-P256+A256GCM",
      wrapped_key: wrapped,
    }, relayKeyState.keyPair.privateKey);
    assert.deepEqual(Buffer.from(imported.keyBytes), Buffer.from(relayKey), `round ${round} mismatch`);
  }
  console.log("INTEROP OK: 3/3 independent random relay keys round-tripped Dart->JS.");
});
