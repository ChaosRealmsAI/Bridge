# @panda-bridge/sdk

Panda Bridge SDK gives product callers one stable API for Bridge readiness,
authorization, local Codex jobs, and delegated server calls.

## 5 Minute Browser Setup

```js
import { createBridgeClient } from "@panda-bridge/sdk";

const bridge = createBridgeClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "panda-chat",
});

const state = await bridge.state();
if (state.bridge_state !== "ready") {
  await bridge.ensureReady({
    openDeepLink: (deepLink) => {
      window.location.href = deepLink;
    },
  });
}

const ready = await bridge.state();
const device = ready.devices.find((item) => item.current && item.online);

const created = await bridge.codex.chat({
  deviceId: device.id,
  prompt: "只回复 OK",
  requestKey: crypto.randomUUID(),
  policy: { timeout_ms: 240000 },
});

for await (const event of bridge.jobs.stream(created.job.id, { deviceId: device.id })) {
  console.log(event);
}
```

Use `bridge.watchState({ intervalMs: 3000 })` when UI needs live readiness.
It polls as the durable path and uses the existing device realtime channel as an
accelerator when a current/online device is present.

`bridge.install()` returns desktop install metadata owned by the SDK:

```js
const install = bridge.install();
// { downloadUrl, version, sha256, openUrl, platform }
```

Legacy helpers remain supported: `preflight`, `connect.createIntent`,
`bridgeDesktopStatusModel`, `bridgeDelegatedAccountStatusModel`,
`bridgeDelegatedConnectIntentStatusModel`, `bridgeDesktopInstallTarget`, and job
helpers keep their existing call signatures.

## 5 Minute Server Setup

```js
import { createBridgeServerClient } from "@panda-bridge/sdk/server";

const bridge = createBridgeServerClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "otherline",
  secret: process.env.PANDA_BRIDGE_DELEGATION_SECRET,
});

const state = await bridge.state({ userId: account.id });
const intent = await bridge.createConnectIntent({
  userId: account.id,
  deviceName: "Panda Bridge Desktop",
  account: { display_name: account.name },
  policy: {
    version: "AUTH-SCOPE-v1",
    capabilities: ["codex.chat"],
    workspace_roots: [{ id: "default", path_display: "Default workspace" }],
    sandbox_floor: "workspace-write",
    approval_policy_floor: "on-request",
  },
});
```

The server client signs every delegated request internally with:

```text
METHOD
path-with-query
productId
userId
deviceId
timestamp
nonce
bodySha256
```

Callers provide only business inputs. `timestamp`, `nonce`, and `bodySha256`
are automatic. The implementation uses WebCrypto and `fetch` only.

## BRIDGE-STATE-v1

`bridge.state()` and server `state()` return the contract state shape:

| State | Meaning | Primary action |
|---|---|---|
| `no_session` | No valid browser session | `login` |
| `no_device` | Account has no non-revoked desktop device | `download` |
| `authorization_pending` | A reusable connect intent is waiting for Desktop confirmation | `confirm_on_desktop` |
| `authorized_offline` | Product is authorized, but authorized devices are offline | `open_desktop` |
| `not_authorized` | Device exists, but product has no active authorization | `authorize` |
| `ready` | Active authorization and selected device is online | none |

Important behavior: `authorized_offline` is not `not_authorized`.
`ensureReady()` never creates a new authorization intent for
`authorized_offline`; it returns the `open_desktop` action.

## Error Surface

Failed SDK requests throw `BridgeError`:

```js
try {
  await bridge.codex.chat({ deviceId, prompt: "hello" });
} catch (error) {
  if (error.name === "BridgeError") {
    console.log(error.code, error.status, error.payload);
  }
}
```

Stable exported codes include:

| Code | Typical handling |
|---|---|
| `product_delegation_unauthorized` | Server delegation signature or required headers are missing |
| `product_delegation_signature_invalid` | Check secret, product id, and path including query |
| `product_delegation_body_hash_invalid` | Body changed after signing |
| `product_delegation_timestamp_invalid` | Check clock skew |
| `product_delegation_replay` | Retry with a fresh nonce |
| `authorization_scope_denied` | Re-authorize with a broader `AUTH-SCOPE-v1` scope or send a narrower job |
| `local_policy_denied` | Desktop rejected local execution outside the approved scope |
| `install_id_required` | Desktop claim must send install identity |
| `already_authorized` | Treat as ready; no intent is required |
| `product_not_authorized` | Create or restore product authorization |
| `device_offline` | Ask the user to open Panda Bridge Desktop |
| `device_not_found` | Refresh account devices or reconnect Desktop |
| `desktop_claim_required` | Browser attempted a native-only claim route |
| `invalid_authorization_policy` | Fix malformed or unsupported requested scope |
| `product_origin_mismatch` | Use the registered origin for this product |
| `request_body_too_large` / `invalid_json` / `invalid_content_type` | Fix request serialization |

## Verification

From the repository root:

```bash
node --test packages/sdk/test/
npm run verify:sdk-examples
node scripts/verify/spec-traceability.mjs
```
