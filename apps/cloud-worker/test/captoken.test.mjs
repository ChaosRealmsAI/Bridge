import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeBoundaryFingerprint,
  issueCapToken,
  parseCompactJws,
  verifyCapTokenClaims,
  verifyCapTokenEnvelope,
  verifyCapTokenJws,
} from "../src/captoken.js";

const vectors = JSON.parse(readFileSync(new URL("../../../spec/captoken/vectors.json", import.meta.url), "utf8"));

function merge(base, patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = merge(result[key], value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

for (const testCase of vectors.claim_cases) {
  const claims = merge(vectors.base_claims, testCase.claims_patch);
  const context = merge(vectors.base_context, testCase.context_patch);
  const actual = await verifyCapTokenClaims(claims, context);
  assert.deepEqual(actual, testCase.expect, `claim vector ${testCase.name}`);
}

for (const testCase of vectors.envelope_cases) {
  const actual = await verifyCapTokenEnvelope(testCase.header, vectors.base_claims, vectors.base_context);
  assert.deepEqual(actual, testCase.expect, `envelope vector ${testCase.name}`);
}

for (const testCase of vectors.signature_cases) {
  const actual = await verifyCapTokenJws(testCase.token, vectors.base_context);
  assert.deepEqual(actual, testCase.expect, `signature vector ${testCase.name}`);
}

for (const testCase of vectors.boundary_cases) {
  const bnd = await computeBoundaryFingerprint(testCase.policy, testCase.job);
  assert.equal(bnd, testCase.expect.bnd, `boundary vector ${testCase.name}`);
}

const issued = await issueCapToken({
  BRIDGE_LOCAL_MEMORY: "1",
}, {
  authorization: { policy: vectors.base_context.authorization_policy, epoch: vectors.base_context.epoch },
  job: vectors.base_context.job,
  product: { id: vectors.base_context.job.product_id },
  userId: vectors.base_context.user_id,
  device: { id: vectors.base_context.device_id },
  nowSeconds: vectors.base_claims.nbf,
});
const parsed = parseCompactJws(issued.token);
assert.equal(parsed.header.alg, "EdDSA");
assert.equal(parsed.header.typ, "pbcap+jws");
assert.equal(parsed.header.kid, "pb-cap-test-2026q2");
assert.equal(parsed.claims.exp - parsed.claims.nbf, 300);
assert.equal(parsed.claims.eph, 7);
assert.equal(parsed.claims.rkh, vectors.base_claims.rkh);
assert.equal(parsed.claims.bnd, vectors.base_claims.bnd);
assert.deepEqual(await verifyCapTokenJws(issued.token, {
  ...vectors.base_context,
  now: vectors.base_claims.nbf + 1,
}), { verdict: "allow" });

const issuedRelay = await issueCapToken({
  BRIDGE_LOCAL_MEMORY: "1",
}, {
  authorization: {
    policy: {
      version: "AUTH-SCOPE-v2",
      product_id: "panda-chat",
      capabilities: ["relay.envelope"],
    },
    epoch: 1,
  },
  job: {
    id: "relay_token_ttl",
    product_id: "panda-chat",
    kind: "relay.envelope",
    workspace_ref: null,
    request_key: "rk_relay_ttl",
    policy: {},
    input: {},
  },
  product: { id: "panda-chat" },
  userId: vectors.base_context.user_id,
  device: { id: vectors.base_context.device_id },
  nowSeconds: vectors.base_claims.nbf,
});
const parsedRelay = parseCompactJws(issuedRelay.token);
assert.equal(parsedRelay.claims.exp - parsedRelay.claims.nbf, 300);
assert.equal(issuedRelay.danger, "low");

console.log("[captoken.test] pass");
