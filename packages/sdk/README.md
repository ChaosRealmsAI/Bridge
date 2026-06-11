# @panda-bridge/sdk

Panda Bridge SDK gives product callers one stable API for account-level
authorization, automatic desktop presence, local Codex jobs, and delegated
server calls.

## Browser Setup

```js
import { createBridgeClient } from "@panda-bridge/sdk";

const bridge = createBridgeClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "panda-chat",
});

const state = await bridge.state();
const account = state.accounts.find((item) =>
  item.authorization?.status === "active" && item.connected
);

if (!account) {
  const ready = await bridge.ensureReady({ wait: true, timeoutMs: 120000 });
  if (!ready.ready) throw new Error(ready.action?.reason || "bridge_not_ready");
}

const current = (await bridge.state()).current_account;
const deviceId = current.current_device.id;

const created = await bridge.codex.chat({
  deviceId,
  prompt: "只回复 OK",
  requestKey: crypto.randomUUID(),
  policy: { timeout_ms: 240000 },
});

for await (const event of bridge.jobs.stream(created.job.id, { deviceId })) {
  console.log(event);
}
```

`bridge.state()` returns the account-level v2 model:

```js
{
  install: { download_url, version, sha256, platform, open_url },
  accounts: [{
    account,
    authorization: { status: "active" }, // active | paused | revoked
    connected: true,
    current_device,
  }],
  ready: true,
  current_account,
}
```

Use `bridge.watchState({ intervalMs: 3000 })` when UI needs live readiness. It
polls every 3 seconds by default, pauses while `document.hidden`, and uses the
device realtime channel as an accelerator when available.

Authorization is account-level:

```js
await bridge.authorization.pause();
await bridge.authorization.resume();
await bridge.authorization.remove();
const authorizations = await bridge.authorization.list();
```

Desktop connection is automatic presence. The SDK does not expose a manual
connect or reconnect method. `ensureReady()` only checks that authorization is
active and a device is online; it never creates a new authorization intent.

Legacy `products.requestAuthorization()`, `products.authorization()`, and
`products.revokeAuthorization()` remain as compatibility aliases.

## Server Setup

```js
import { createBridgeServerClient } from "@panda-bridge/sdk/server";

const bridge = createBridgeServerClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "otherline",
  secret: process.env.PANDA_BRIDGE_DELEGATION_SECRET,
});

const state = await bridge.state({ userId: account.id });
await bridge.authorization.pause({ userId: account.id });
await bridge.authorization.resume({ userId: account.id });
await bridge.authorization.remove({ userId: account.id });
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

## Errors

Failed SDK requests throw `BridgeError` with `{ code, status, payload }`.

Stable exported codes include:

| Code | Typical handling |
|---|---|
| `authorization_paused` | Ask the user to resume authorization |
| `product_not_authorized` | Create or restore account authorization |
| `device_not_found` | Refresh account devices or reinstall Desktop |
| `product_delegation_signature_invalid` | Check secret, product id, and path including query |
| `product_delegation_body_hash_invalid` | Body changed after signing |
| `product_delegation_timestamp_invalid` | Check clock skew |
| `product_delegation_replay` | Retry with a fresh nonce |
| `local_policy_denied` | Desktop rejected local execution |
| `request_body_too_large` / `invalid_json` / `invalid_content_type` | Fix request serialization |

## Verification

From the repository root:

```bash
node --test packages/sdk/test/
npm run verify:sdk-examples
node scripts/verify/spec-traceability.mjs
```
