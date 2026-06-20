import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { doctorBurnStore, initBurnStore, statusBurnStore } from "./burn-store-lib.mjs";
import { publicStoreData } from "../scripts/bridge/relay/burn-store-runner.mjs";

test("store status exposes Flutter-ready identity and diagnostics fields", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "burn-store-shape-"));
  try {
    const initialized = await initBurnStore({ home, accountId: "account-fixture", deviceId: "device-fixture" });
    assert.equal(initialized.store_ready, true);
    assert.equal(initialized.initialized, true);
    assert.equal(initialized.storage_scope, "device_app_home");
    assert.ok(initialized.store_id.startsWith("burn_store_"));
    assert.ok(initialized.account_hash);
    assert.ok(initialized.device_hash);
    assert.equal(initialized.diagnostics.ready_reason, "ready");
    assert.equal(initialized.diagnostics.required_dirs_present, true);

    const status = await statusBurnStore({ home });
    assert.equal(status.store_ready, true);
    assert.equal(status.initialized, false);
    assert.equal(status.store_id, initialized.store_id);
    assert.equal(status.response_schema, "burn.store.status.v1");
    assert.deepEqual(status.diagnostics.missing_required_dirs, []);

    const relayStatus = publicStoreData(status);
    assert.equal(relayStatus.schema, "burn.store.status.v1");
    assert.equal(relayStatus.response_schema, "burn.store.status.v1");
    assert.equal(relayStatus.store_schema, "burn.store.v1");

    const doctor = await doctorBurnStore({ home });
    assert.equal(doctor.ok, true);
    assert.equal(doctor.store_ready, true);
    assert.ok(doctor.checks.some((item) => item.id === "schema_current" && item.ok));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
