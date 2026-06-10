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

Each product gets its own authorization record. Product capabilities are shown
to the user and recorded in the authorization scope. Current hosted products
expose the full Bridge runtime surface: `codex.chat`, `codex.run`, `codex.rpc`,
and `saas.custom.run`. If a future product is registered with a narrower
capability list, unsupported job kinds receive `scope_insufficient`.

Product ID is also the main source boundary. Bridge records the request
`source_origin` for connect intents, authorizations, and jobs, and Cloud only
accepts official origins. A product cannot borrow another product's
authorization. Local/test environments that need non-official origins must use
the per-product `BRIDGE_PRODUCT_ALLOWED_ORIGINS` mapping; the global Origin
allowlist is not a cross-product permission grant.

## Basic Flow

```js
import { bridgeFullAccessPolicy, createBridgeClient } from "@panda-bridge/sdk";

const bridge = createBridgeClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "panda-chat",
});

const diagnostics = await bridge.diagnostics();
if (!diagnostics.ok) throw new Error("Panda Bridge is not ready");

await bridge.auth.password("user@example.com", "account-password");

const intent = await bridge.connect.createIntent({
  deviceName: "MacBook Pro",
  permissions: bridgeFullAccessPolicy(),
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
    cwd: "/Users/me/any/project",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    developerInstructions: "Follow this product's workflow.",
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

## Desktop Install Metadata

Product UIs should read Bridge desktop install/open targets from the SDK, not
hardcode package URLs inside each product.

```js
import { bridgeDesktopInstallTarget } from "@panda-bridge/sdk";

const install = bridgeDesktopInstallTarget({ channel: "test" });

renderDownloadLink(install.downloadUrl);
renderOpenLink(install.openUrl);
```

Use `channel: "production"` for `assets.bridge.otherline.cc` and
`channel: "test"` for `assets-bridge.test.example`. A product may pass
`assetBaseUrl` or `downloadUrl` only as a deployment override; the package name,
scheme, default path, and hash are owned by Bridge SDK.

## Productized Onboarding Example

From the repository root, run:

```bash
npm run verify:productized-onboarding
```

This verification starts a local memory Bridge fixture, uses the SDK as a
product caller, operates Panda Bridge Desktop through the documented AI CLI,
checks the local authorization record, creates jobs, revokes one product, and
asserts another product remains authorized.

## Caller-Defined Permission Scope

`connect.createIntent()` defaults to full-access Bridge scope. The caller can
override it with `permissions` or `policy`; Desktop shows the requested
`AUTH-SCOPE-v1` scope before the user clicks Allow and stores the approved
grant locally.

```js
const full = await bridge.connect.createIntent({
  deviceName: "MacBook Pro",
});

const custom = await bridge.connect.createIntent({
  deviceName: "MacBook Pro",
  permissions: {
    capabilities: ["codex.chat", "codex.run"],
    workspace_roots: [{ id: "project", path_display: "Selected project" }],
    sandbox_floor: "workspace-write",
    approval_policy_floor: "on-request",
    allow_approval_never: false,
    allow_developer_instructions: false,
  },
});
```

Use the default full-access scope when the product should not be constrained by
workspace directories. A narrower `workspace_roots` grant is a named local
workspace contract; jobs should pass the matching `workspace_ref`, and
Desktop/connector local configuration must map that ref to a real local path.
If a job sends a `cwd` outside the approved local grant, Desktop returns
`local_policy_denied`.

Bridge derives authorization display text from normalized scope fields. Caller
`display` copy cannot hide `All local files`, `danger-full-access`,
`approval_policy_floor: "never"`, or developer instructions. Unsupported
capability names return `invalid_authorization_policy`; an explicit empty
`capabilities: []` grant denies every job kind.

For full-access verification from the repository root, run:

```bash
npm run verify:bridge-full-access-policy
```

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
- Handle `scope_insufficient` only if the product is registered with a narrower
  capability list than the job kind it creates.
- Handle `product_origin_mismatch` when a request comes from an Origin that is
  allowed globally but not registered for that product ID.
- Handle `invalid_authorization_policy` when a connect-intent scope includes
  unsupported capability names or malformed fields.
- Handle `authorization_scope_denied` when Bridge Cloud pre-denies a job that
  obviously exceeds the user-approved local authorization scope.
- Handle job results with `error: "local_policy_denied"` when Desktop rejects a
  request outside the user-approved local authorization scope.
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
- Product routes require the request Origin to match that product's registered
  or explicit test origins.
- `connect.createIntent()` carries caller-defined permission scope. Bridge does
  not hardcode a smaller workspace, sandbox, approval, or instruction boundary
  for the caller.
- Job `policy`, `workspace_ref`, and payload are passed to Desktop. Desktop
  rejects only requests outside the user-approved local authorization scope.
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
