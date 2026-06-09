# @panda-bridge/sdk

Panda Bridge SDK lets an official SaaS product use a user's authorized desktop
Connector to run local Codex jobs through Bridge Cloud.

## Account-Level Model

The product does not pair every browser session separately. The user authorizes:

```text
Panda account + product_id + desktop device
```

After that, any web, mobile, or browser session logged into the same account can
see and use that authorized device. A different account cannot see or call it.

## Product IDs

Hosted Bridge only accepts official product IDs registered by Bridge Cloud.
Current product IDs are:

```text
panda-chat
panda-dev
panda-spec
```

Each product gets its own authorization record. Product capabilities may be
shown to the user and are enforced by Bridge Cloud for job kinds. For example,
`panda-chat` can create `codex.chat` and `codex.run` jobs, while a product
without `codex.rpc` receives `scope_insufficient` for RPC jobs.

Product ID is also the main source boundary. Bridge records the request
`source_origin` for connect intents, authorizations, and jobs, and Cloud only
accepts official origins. A product cannot borrow another product's
authorization.

## Basic Flow

```js
import { createBridgeClient } from "@panda-bridge/sdk";

const bridge = createBridgeClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "panda-chat",
});

const diagnostics = await bridge.diagnostics();
if (!diagnostics.ok) throw new Error("Panda Bridge is not ready");

await bridge.auth.password("user@example.com", "account-password");

const intent = await bridge.connect.createIntent({
  deviceName: "MacBook Pro",
});

// Show intent.deep_link to the user. Panda Bridge Desktop claims it after the
// user approves the desktop authorization view. Browser code must not call
// connect.claim; browser attempts receive desktop_claim_required.

const devices = await bridge.devices.list();
const device = devices.items.find((item) => item.status === "online");

const preflight = await bridge.preflight({ deviceId: device?.id });
if (!preflight.ready) {
  console.log(preflight.issues, preflight.actions);
  throw new Error("Panda Bridge is not ready for this product");
}

const created = await bridge.codex.chat({
  deviceId: device.id,
  prompt: "只回复 OK",
  requestKey: crypto.randomUUID(),
  policy: {
    token_budget: 20000,
    timeout_ms: 240000,
  },
});

for await (const event of bridge.jobs.stream(created.job.id, {
  deviceId: device.id,
  timeoutMs: 300000,
})) {
  if (event.type === "text_delta") {
    console.log(event.payload.delta);
  }
}

const final = await bridge.jobs.get(created.job.id);
console.log(final.job.result.reply);

const queueSummary = await bridge.queue.summary();
console.log(queueSummary.counts.active, queueSummary.devices[0]?.queue);
```

## Runnable Full-Surface Example

From the repository root, run:

```bash
npm run verify:sdk-examples
```

The example module lives at `examples/sdk-call-examples/`. It starts a local
memory Bridge fixture and exercises the current SDK helper surface end to end:
diagnostics, preflight, auth/session/share/join/logout, devices, connect intent,
product authorization, codex jobs, job status/events/wait/stream/cancel, and
queue summary. It also checks account isolation and writes redacted evidence
under `spec/verification/evidence/v6-sdk-call-examples-account-stability/`.

## Productized Onboarding Example

From the repository root, run:

```bash
npm run verify:productized-onboarding
```

This verification starts a local memory Bridge fixture, uses the SDK as a
product caller, operates Panda Bridge Desktop through the documented AI CLI,
checks the local authorization record, creates jobs, revokes one product, and
asserts another product remains authorized.

## Multi-Product Example

```js
const devBridge = createBridgeClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "panda-dev",
});

await devBridge.auth.password("user@example.com", "account-password");

const authorization = await devBridge.products.authorization(device.id);
if (!authorization.authorization) {
  await devBridge.connect.createIntent({ deviceName: "Developer Mac" });
  // Show the returned deep_link and wait for Desktop approval.
}

const rpc = await devBridge.codex.rpc({
  deviceId: device.id,
  calls: [{ method: "initialize" }],
});

await devBridge.jobs.cancel(rpc.job.id);
```

## Concurrency And Idempotency

Bridge supports high concurrent job submission at the API layer. Use
`requestKey` for user actions that may be retried; duplicate keys return the same
job instead of creating multiple local Codex jobs.

One desktop is still a constrained local machine. Treat it as a queue unless the
desktop execution policy explicitly says bounded parallel local Codex execution
is enabled.

Recommended product behavior:

- Use a unique `requestKey` per logical user action.
- Stream events with `jobs.stream()` and fall back to polling automatically.
- Use `queue.summary()` before or after job creation when the product needs
  account queue pressure, per-device queue state, limits, or completed-job
  timing aggregates.
- Use `preflight()` before creating jobs when the product needs one structured
  readiness result with diagnostics, session, devices, product authorization,
  queue context, issues, and next actions.
- Show queued/running/cancelled/failed states from job events, not only final
  text.
- Cancel jobs when the user navigates away from work that should not continue.
- Handle `device_offline`, `product_not_authorized`, `device_not_found`, and
  `too_many_login_attempts`.
- Handle `scope_insufficient` when the product creates a job kind outside its
  registered capabilities.
- Treat `desktop_claim_required` as a product implementation bug: browser UI
  tried to use a native-only Desktop claim route.
- Handle request safety errors such as `request_body_too_large`,
  `invalid_json`, and `invalid_content_type`; SDK errors include `status` and
  `payload`.

## Security Rules

- Browser code never receives desktop `device_token`.
- Browser code never consumes connect intents; Desktop native claim is required.
- Browser code never calls Codex app-server directly.
- Jobs require the session account to own the device.
- Jobs require active product authorization on that device.
- Job `kind` must be included in the product's registered capabilities.
- Job `policy`, `workspace_ref`, and payload are passed to Desktop, and Desktop
  rejects requests outside the visible local authorization scope.
- Unsupported product IDs are rejected by Bridge Cloud.
- Official source origins are enforced; unsupported origins are rejected or
  receive no credentialed CORS access.
- Duplicate `request_key` submissions are idempotent.
- Desktop revalidates local product authorization and install identity before
  executing.

## Product Documentation

- Product integration guide: `docs/product-integration.md`
- Desktop user guide: `docs/desktop-user-guide.md`
- AI-operable Desktop CLI: `docs/desktop-ai-cli.md`
