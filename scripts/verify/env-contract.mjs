#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const prodPath = resolve(root, "apps/cloud-worker/wrangler.toml");
const testPath = resolve(root, "apps/cloud-worker/wrangler.test.toml");
const privateContractPath = "spec/L1/environment-contract.json";

if (!existsSync(resolve(root, privateContractPath))) {
  console.log(JSON.stringify({
    ok: true,
    check: "bridge-env-contract",
    skipped: "private_spec_missing",
  }, null, 2));
  process.exit(0);
}

const contract = readJson("spec/L1/environment-contract.json");
const company = JSON.parse(readFileSync(resolvePath(contract.companyResourceRef), "utf8"));
const products = readText("apps/cloud-worker/src/products.js");
const deletedSupabaseRef = ["jfoiiqg", "frdosiwmkkfsf"].join("");

assert.equal(contract.id, "l1.environment_contract");
assert.equal(contract.environments.production.storage, "durable_object", "Bridge production Spec storage must be durable_object");
assert.equal(contract.environments.production.durableObjectBinding, "BRIDGE_STORE", "Bridge production Spec durable object binding");
assert.equal(contract.environments.production.durableObjectStoreName, "bridge-production-store", "Bridge production Spec durable object store name");
assert.equal(contract.environments.test.storage, "durable_object", "Bridge test Spec storage must be durable_object");

compareCompany("production");
compareCompany("test");
assertIncludes(products, 'official_origin: "https://token-burn.com"', "built-in production Burn origin");
assertIncludes(products, 'web_url: "https://token-burn.com/authorize"', "built-in production Burn authorize URL");

if (existsSync(prodPath)) {
  const prod = readText("apps/cloud-worker/wrangler.toml");
  assertIncludes(prod, 'BRIDGE_ENV = "production"', "production env marker");
  assertIncludes(prod, 'BRIDGE_STORAGE_BACKEND = "durable"', "production durable storage backend");
  assertIncludes(prod, 'name = "BRIDGE_STORE"', "production durable storage binding");
  assertIncludes(prod, 'BRIDGE_STORE_NAME = "bridge-production-store"', "production durable store name");
  assertIncludes(prod, 'BRIDGE_PUBLIC_API_BASE = "https://api.bridge.chaos-realms.cc"', "production API base");
  assertIncludes(prod, 'BRIDGE_WEB_ORIGIN = "https://bridge.chaos-realms.cc"', "production web origin");
  assertIncludes(prod, '"BRIDGE_PANDA_BURN_DELEGATION_SECRET"', "production Burn delegation secret requirement");
  assertDoesNotInclude(prod, "api-bridge-test.chaos-realms.cc", "production config must not point to test API");
  assertDoesNotInclude(prod, "burn-test.chaos-realms.cc", "production config must not point to test Burn origin");
  assertDoesNotInclude(prod, deletedSupabaseRef, "production config must not point to deleted Supabase project");
  assertDoesNotInclude(prod, "SUPABASE_URL", "production Bridge storage must not rely on an unverified Supabase project");
}

if (existsSync(testPath)) {
  const test = readText("apps/cloud-worker/wrangler.test.toml");
  assertIncludes(test, 'BRIDGE_ENV = "test"', "test env marker");
  assertIncludes(test, 'BRIDGE_STORAGE_BACKEND = "durable"', "test storage isolation");
  assertIncludes(test, 'BRIDGE_PUBLIC_API_BASE = "https://api-bridge-test.chaos-realms.cc"', "test API base");
  assertIncludes(test, 'BRIDGE_WEB_ORIGIN = "https://bridge-test.chaos-realms.cc"', "test web origin");
  assertIncludes(test, "https://burn-test.chaos-realms.cc", "test Burn origin");
  assertIncludes(test, '"BRIDGE_PANDA_BURN_DELEGATION_SECRET"', "test Burn delegation secret requirement");
  assertDoesNotInclude(test, "https://token-burn.com", "Bridge test config must not authorize production Burn origin");
}

console.log(JSON.stringify({ ok: true, check: "bridge-env-contract" }, null, 2));

function compareCompany(envName) {
  const specEnv = contract.environments[envName];
  const companyEnv = company.environments[envName]?.bridge;
  assert.ok(specEnv, `Bridge Spec missing ${envName}`);
  assert.ok(companyEnv, `company matrix missing Bridge ${envName}`);
  assert.equal(specEnv.apiBase, companyEnv.apiBase, `${envName} Bridge apiBase mismatch`);
  assert.equal(specEnv.webOrigin, companyEnv.webOrigin, `${envName} Bridge webOrigin mismatch`);
  assert.equal(specEnv.assetsOrigin, companyEnv.assetsOrigin, `${envName} Bridge assetsOrigin mismatch`);
  assert.equal(specEnv.workerName, companyEnv.workerName, `${envName} Bridge workerName mismatch`);
  assert.equal(specEnv.wranglerConfig, companyEnv.wranglerConfig, `${envName} Bridge wranglerConfig mismatch`);
  assert.equal(specEnv.storage, companyEnv.storage, `${envName} Bridge storage mismatch`);
  if (envName === "production") {
    assert.equal(specEnv.durableObjectBinding, companyEnv.durableObjectBinding, "production Bridge durableObjectBinding mismatch");
    assert.equal(specEnv.durableObjectStoreName, companyEnv.durableObjectStoreName, "production Bridge durableObjectStoreName mismatch");
  }
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function readText(file) {
  return readFileSync(resolve(root, file), "utf8");
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

function assertIncludes(text, needle, label) {
  assert.ok(text.includes(needle), `${label} missing: ${needle}`);
}

function assertDoesNotInclude(text, needle, label) {
  assert.equal(text.includes(needle), false, `${label}: ${needle}`);
}
