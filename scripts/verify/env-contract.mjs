#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const prodPath = resolve(root, "apps/cloud-worker/wrangler.toml");
const testPath = resolve(root, "apps/cloud-worker/wrangler.test.toml");
const deletedSupabaseRef = ["jfoiiqg", "frdosiwmkkfsf"].join("");

if (existsSync(prodPath)) {
  const prod = readFileSync(prodPath, "utf8");
  assertIncludes(prod, 'BRIDGE_ENV = "production"', "production env marker");
  assertIncludes(prod, 'BRIDGE_STORAGE_BACKEND = "durable"', "production durable storage backend");
  assertIncludes(prod, 'name = "BRIDGE_STORE"', "production durable storage binding");
  assertIncludes(prod, 'BRIDGE_STORE_NAME = "bridge-production-store"', "production durable store name");
  assertIncludes(prod, 'BRIDGE_PUBLIC_API_BASE = "https://api.bridge.chaos-realms.cc"', "production API base");
  assertIncludes(prod, 'BRIDGE_WEB_ORIGIN = "https://bridge.chaos-realms.cc"', "production web origin");
  assertDoesNotInclude(prod, "api-bridge-test.chaos-realms.cc", "production config must not point to test API");
  assertDoesNotInclude(prod, "burn-test.chaos-realms.cc", "production config must not point to test Burn origin");
  assertDoesNotInclude(prod, deletedSupabaseRef, "production config must not point to deleted Supabase project");
  assertDoesNotInclude(prod, "SUPABASE_URL", "production Bridge storage must not rely on an unverified Supabase project");
}

if (existsSync(testPath)) {
  const test = readFileSync(testPath, "utf8");
  assertIncludes(test, 'BRIDGE_ENV = "test"', "test env marker");
  assertIncludes(test, 'BRIDGE_STORAGE_BACKEND = "durable"', "test storage isolation");
  assertIncludes(test, 'BRIDGE_PUBLIC_API_BASE = "https://api-bridge-test.chaos-realms.cc"', "test API base");
  assertIncludes(test, 'BRIDGE_WEB_ORIGIN = "https://bridge-test.chaos-realms.cc"', "test web origin");
  assertIncludes(test, "https://burn-test.chaos-realms.cc", "test Burn origin");
  assertDoesNotInclude(test, "https://token-burn.com", "Bridge test config must not authorize production Burn origin");
}

console.log(JSON.stringify({ ok: true, check: "bridge-env-contract" }, null, 2));

function assertIncludes(text, needle, label) {
  assert.ok(text.includes(needle), `${label} missing: ${needle}`);
}

function assertDoesNotInclude(text, needle, label) {
  assert.equal(text.includes(needle), false, `${label}: ${needle}`);
}
