# Panda Bridge Product Integration

This guide is for products that want to call a user's authorized Panda Bridge
Desktop without handling local device secrets.

## Integration Contract

A product integrates with Bridge as:

```text
registered product_id + official origin + user browser session + Bridge SDK
```

The product never receives a Desktop `device_token` and never consumes a connect
intent from browser code. The native Desktop app claims the intent after the
user approves the request.

## Product Setup

1. Register a stable `product_id`, official origin, display name, and capability
   list in Bridge Cloud.
2. Use the same `product_id` in the SDK client.
3. Host browser code only from the official origin.
4. Point product UI at the Desktop deep link returned by `connect.createIntent`.

Current registered product IDs are `panda-chat`, `panda-dev`, and `panda-spec`.

## User Route

```text
User installs Panda Bridge Desktop
Product creates connect intent
Product opens panda-bridge://connect?... deep link
Desktop shows product, account, origin, capabilities, and local policy
User clicks Allow
Desktop stores the local authorization record
Product preflight becomes ready
Product creates jobs and reads events/results
```

The Desktop local record must remain visible to the user. It includes product,
account, device id, source origin, capabilities, policy summary, and authorized
time. It must not expose device tokens, session cookies, product secrets, or
private credential storage.

## SDK Flow

```js
import { createBridgeClient } from "@panda-bridge/sdk";

const bridge = createBridgeClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "panda-chat",
});

await bridge.auth.password(email, password);

const intent = await bridge.connect.createIntent({
  deviceName: "User Mac",
});

// Show intent.deep_link to the user. Do not call connect.claim from browser UI.

const devices = await bridge.devices.list();
const device = devices.items.find((item) => item.status === "online");

const preflight = await bridge.preflight({ deviceId: device?.id });
if (!preflight.ready) {
  renderBridgeSetupState(preflight.issues, preflight.actions);
  return;
}

const created = await bridge.codex.chat({
  deviceId: device.id,
  prompt: "Reply OK",
  requestKey: crypto.randomUUID(),
  tokenBudget: 20000,
  timeoutMs: 240000,
});

for await (const event of bridge.jobs.stream(created.job.id, {
  deviceId: device.id,
  timeoutMs: 300000,
})) {
  renderJobEvent(event);
}

const final = await bridge.jobs.get(created.job.id);
renderReply(final.job.result.reply);
```

## Error Handling

Use `preflight()` before creating user-visible work. It returns structured
issues and actions.

| Code | Meaning | Product action |
| --- | --- | --- |
| `not_authenticated` | No Bridge user session | Ask the user to sign in |
| `no_online_devices` | No online Desktop device | Ask the user to open Desktop |
| `product_not_authorized` | This product is not authorized on the device | Show the connect deep link |
| `device_offline` | Device exists but is offline | Ask the user to wake/open Desktop |
| `scope_insufficient` | Job kind is outside product capability | Fix product registration or use an allowed kind |
| `desktop_claim_required` | Browser tried to claim a native intent | Remove browser claim code |

SDK request errors expose `error.status` and `error.payload` for stable UI
branching.

## Multiple Products

Each product has its own authorization record. The same account can authorize
`panda-chat` and `panda-dev` on the same Desktop device. Revoking `panda-chat`
must not remove `panda-dev`, the underlying device, or another account's
authorization.

Products must always pass their own `productId` to the SDK client and must not
reuse another product's deep link, authorization, or job.

## AI Verification

Automated verifiers should use the Desktop CLI contract in
[`desktop-ai-cli.md`](desktop-ai-cli.md). The CLI can start the installed app,
open deep links, take PNG screenshots, trigger click-equivalent allow/revoke/refresh
actions through a one-time token, read redacted Desktop status, run explicit
test-only headless authorization, poll jobs, revoke product authorization, and
write evidence without reading private credential files. Screenshot capture is a
Desktop built-in interface: `/v1/screenshot` returns a `builtin_app_png` rendered
by the Desktop process, not by an external capture tool.
