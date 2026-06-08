# SDK Call Examples

This module is the maintained Panda Bridge SDK calling example.

Run it from the repository root:

```bash
npm run verify:sdk-examples
```

The command starts a local memory Bridge fixture server, uses `createBridgeClient()`
as a product caller, and writes redacted evidence to:

```text
spec/verification/evidence/v6-sdk-call-examples-account-stability/
```

Covered SDK groups:

- `diagnostics()`
- `preflight()`
- `queue.summary()`
- `auth.session()`, `auth.password()`, `auth.guest()`, `auth.share()`, `auth.join()`, `auth.logout()`
- `devices.list()`, `devices.createPairingCode()`, `devices.revoke()`
- `connect.createIntent()`, `connect.intent()`, `connect.claim()`
- `products.list()`, `products.requestAuthorization()`, `products.authorization()`, `products.revokeAuthorization()`
- `codex.chat()`, `codex.run()`, `codex.rpc()`
- `jobs.create()`, `jobs.get()`, `jobs.events()`, `jobs.wait()`, `jobs.stream()`, `jobs.cancel()`

The product side uses the SDK. The local fixture executor uses public connector
API endpoints only to claim and complete jobs; it does not inspect internal
storage or require a real Desktop/Codex install.
