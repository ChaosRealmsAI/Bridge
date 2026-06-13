# Panda Bridge Desktop Control CLI

The Desktop binary exposes automation surfaces for CI, AI verifiers, and local
debugging. These surfaces validate Bridge as a relay/jump host; they do not turn
Desktop core into a Claude, Codex, shell, fs, data, or product runtime.

Desktop core responsibilities are narrow:

- Claim connect intents after user approval or explicit verifier flags.
- Hold local connector credentials.
- Poll Bridge Cloud for opaque relay envelopes.
- POST each envelope to the configured Product Adapter.
- POST the Adapter's opaque `response_envelope` back to Bridge Cloud.
- Ack delivered envelopes.

Product behavior belongs in a Product Adapter.

## Running From Source

```bash
cargo run --quiet --manifest-path apps/desktop/Cargo.toml -- headless-status
```

When using an installed binary, replace the `cargo run ... --` prefix with the
binary path.

For isolated tests:

```bash
export PANDA_BRIDGE_DESKTOP_STATE=/tmp/panda-bridge-desktop.json
export PANDA_BRIDGE_SKIP_KEYCHAIN=1
```

`PANDA_BRIDGE_DESKTOP_STATE` keeps test state out of the user's normal Desktop
credential store.

## Headless Commands

### `headless-status`

Reads redacted Desktop status.

```bash
cargo run --quiet --manifest-path apps/desktop/Cargo.toml -- headless-status
```

Success writes JSON to stdout and exits `0`. The JSON includes `device_id`,
`device_name`, `authorized_products`, `worker_running`, `realtime_connected`,
and relay capability information.

The output must not include `device_token`, session cookies, product secrets,
raw key material, private credential file contents, or product plaintext.

### `headless-connect`

Claims a connect intent in automation. This command intentionally requires an
explicit test flag because it bypasses the visible Allow button.

```bash
PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT=1 \
cargo run --quiet --manifest-path apps/desktop/Cargo.toml -- \
  headless-connect \
  --api http://127.0.0.1:8787 \
  --intent <connect-intent-token> \
  --device-name "Verifier Mac"
```

Without `PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT=1`, the command exits non-zero and
prints a stable error to stderr. Browser code must not use this path.

### `headless-poll`

Polls Bridge Cloud for queued relay envelopes and forwards each opaque envelope
to the configured Product Adapter.

```bash
PANDA_BRIDGE_ADAPTER_OTHERLINE_URL=http://127.0.0.1:4567/v1/relay-envelope \
cargo run --quiet --manifest-path apps/desktop/Cargo.toml -- headless-poll
```

Success returns JSON with `ok`, `count`, and per-connection poll results. If the
Adapter returns `{ "response_envelope": { ... } }`, Desktop posts that response
envelope back to `/v1/connectors/relay/envelopes` and then acks the original
delivery.

Desktop must not decrypt ciphertext, inspect Adapter plaintext, execute shell
commands, or synthesize product responses.

### `headless-revoke-authorization`

Revokes a product authorization from local Desktop state and Bridge Cloud.

```bash
cargo run --quiet --manifest-path apps/desktop/Cargo.toml -- \
  headless-revoke-authorization \
  --product-id otherline \
  --account-id <bridge-account-id> \
  --device-id <device-id>
```

`--account-id` and `--device-id` narrow the revoke target. Omitting them revokes
matching local authorizations for that product.

## Adapter Routing

Desktop discovers local adapters through environment variables:

```bash
PANDA_BRIDGE_ADAPTER_<PRODUCT_ID>_URL=http://127.0.0.1:<port>/v1/relay-envelope
```

Examples:

```bash
PANDA_BRIDGE_ADAPTER_OTHERLINE_URL=http://127.0.0.1:4567/v1/relay-envelope
PANDA_BRIDGE_ADAPTER_PANDA_CHAT_URL=http://127.0.0.1:4568/v1/relay-envelope
```

The Product Adapter receives only the relay envelope fields:

```json
{
  "id": "env_...",
  "product_id": "otherline",
  "device_id": "dev_...",
  "channel_id": "chan_1",
  "direction": "product_to_device",
  "seq": 1,
  "request_key": "request-1",
  "ciphertext": "base64:...",
  "aad": "base64:...",
  "nonce": "base64:...",
  "algorithm": "AES-256-GCM",
  "sender_key_id": "product-key",
  "recipient_key_id": "adapter-key",
  "meta": { "adapter_id": "otherline-adapter" }
}
```

The Adapter can optionally return:

```json
{
  "ok": true,
  "response_envelope": {
    "envelope_version": "relay-envelope-v1",
    "product_id": "otherline",
    "device_id": "dev_...",
    "channel_id": "chan_1",
    "direction": "device_to_product",
    "seq": 2,
    "request_key": "request-1:response",
    "ciphertext": "base64:...",
    "aad": "base64:...",
    "nonce": "base64:...",
    "algorithm": "AES-256-GCM",
    "sender_key_id": "adapter-key",
    "recipient_key_id": "product-key"
  }
}
```

Desktop forwards `response_envelope` unchanged. Bridge Cloud validates relay
shape and routing permissions, not business plaintext.

Adapters must make duplicate delivery idempotent. If Desktop successfully posts
the Adapter response but the original connector ack fails, the next poll may
deliver the same inbound envelope again. The Adapter must return the same
encrypted `response_envelope` for that inbound envelope id/request key and must
not re-run the local action.

## Installed App Control Mode

When Panda Bridge Desktop is installed, an AI verifier can start the app with a
local one-time control server:

```bash
export PANDA_BRIDGE_VERIFY=1
export PANDA_BRIDGE_VERIFY_CONTROL_STATE=/tmp/panda-bridge-control.json
export PANDA_BRIDGE_DESKTOP_STATE=/tmp/panda-bridge-desktop.json

"$HOME/Applications/Panda Bridge.app/Contents/MacOS/Panda Bridge"
```

The app writes a JSON control file:

```json
{
  "ok": true,
  "base_url": "http://127.0.0.1:49152",
  "token": "pbv_...",
  "pid": 12345
}
```

All control requests must include the one-time token:

```bash
CONTROL_BASE=$(jq -r .base_url /tmp/panda-bridge-control.json)
CONTROL_TOKEN=$(jq -r .token /tmp/panda-bridge-control.json)

curl -sS "$CONTROL_BASE/v1/status" \
  -H "x-panda-bridge-verify-token: $CONTROL_TOKEN"
```

### Control Reads

```text
GET /v1/status
GET /v1/events
GET /v1/snapshot
GET /v1/screenshot
```

`/v1/screenshot` is a Desktop built-in screenshot interface. Desktop renders an
app-owned `builtin_app_png` image from the current redacted app state and events.

### Control Actions

Post JSON to `/v1/actions`:

```bash
curl -sS "$CONTROL_BASE/v1/actions" \
  -H "x-panda-bridge-verify-token: $CONTROL_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"open_deep_link","url":"panda-bridge://connect?intent=...&api=..."}'
```

Stable action names:

| Action | Effect |
| --- | --- |
| `activate_app` | Bring the installed app forward when supported |
| `open_web` | Open the configured web URL |
| `open_deep_link` | Send a `panda-bridge://connect?...` URL into the app |
| `click_allow_intent` | Click-equivalent allow action for a known intent |
| `click_revoke_authorization` | Click-equivalent revoke action |
| `click_refresh_status` | Click-equivalent refresh/status action |
| `start_worker` | Start local worker loops |
| `stop_worker` | Stop local worker loops |
| `disconnect` | Clear local Desktop connection state |

`click_allow_intent` uses the same native claim path as the visible Allow
button. It is only for verifier-controlled sessions and must not be exposed to
browser product code.

## Canonical Relay Proof

The repository-level local-control proof is:

```bash
npm run verify:relay-local-control
npm run verify:relay-local-control:blackbox
```

It starts a local-memory Worker, creates a connect intent, claims it with
Desktop headless mode, sends encrypted relay envelopes, routes them to
`examples/relay-local-control`, and decrypts the returned response envelopes on
the product side.

The sample Adapter only supports:

- `pwd`
- `ls .`

This proves the relay can control the local computer through a Product Adapter.
It must not be expanded into a general shell runner inside Bridge core.

## Evidence Pattern

A verifier should:

1. Create a connect intent through the SDK.
2. Start the installed app with `PANDA_BRIDGE_VERIFY=1` or use headless commands
   for fast CI.
3. Use `open_deep_link` and screenshot/status to inspect the app route.
4. Use `click_allow_intent` or `headless-connect` with
   `PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT=1` in verifier-controlled tests.
5. Run `headless-status` or `GET /v1/status` and assert the product/account
   record exists.
6. Create an encrypted relay envelope through the SDK.
7. Run `headless-poll` or `start_worker`.
8. Wait for a `device_to_product` relay envelope through the SDK.
9. Decrypt the response on the product side.
10. Ack the response envelope and revoke authorization when needed.

Useful checks:

```bash
npm run verify:relay-local-control
npm run verify:relay-local-control:blackbox
npm run verify:desktop-ai-cli
```
