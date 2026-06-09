# Panda Bridge Desktop AI CLI

The Desktop binary exposes two automation surfaces for AI verifiers, CI, and
local automation:

- Headless commands for fast JSON checks.
- Installed-app verify-control for launching the real app, opening deep links,
  taking screenshots, and triggering click-equivalent actions.

The CLI is for validation and evidence collection. It does not replace the
normal user approval UI for end users.

## Running From Source

```bash
cargo run --quiet --manifest-path apps/desktop/Cargo.toml -- headless-status
```

When using an installed binary, replace the `cargo run ... --` prefix with the
binary path.

For isolated tests, set:

```bash
export PANDA_BRIDGE_DESKTOP_STATE=/tmp/panda-bridge-desktop.json
export PANDA_BRIDGE_FAKE_CODEX=1
```

`PANDA_BRIDGE_DESKTOP_STATE` keeps test state out of the user's normal Desktop
credential store. `PANDA_BRIDGE_FAKE_CODEX=1` makes local job execution
deterministic for verification.

## Headless Commands

### `headless-status`

Reads redacted Desktop status.

```bash
cargo run --quiet --manifest-path apps/desktop/Cargo.toml -- headless-status
```

Success writes JSON to stdout and exits `0`. The JSON includes `device_id`,
`device_name`, `authorized_products`, `worker_running`, `realtime_connected`,
and `codex_available`.

`authorized_products` includes product id, name, origin, capabilities,
`AUTH-SCOPE-v1` policy summary, authorization time, and account records.

The output must not include `device_token`, session cookies, product secrets, or
private credential file contents.

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

Polls Bridge Cloud for queued jobs and executes allowed work through the local
runtime.

```bash
cargo run --quiet --manifest-path apps/desktop/Cargo.toml -- headless-poll
```

Success returns JSON with `ok`, `count`, and per-connection poll results.

### `headless-revoke-authorization`

Revokes a product authorization from local Desktop state and Bridge Cloud.

```bash
cargo run --quiet --manifest-path apps/desktop/Cargo.toml -- \
  headless-revoke-authorization \
  --product-id panda-chat \
  --account-id <bridge-account-id> \
  --device-id <device-id>
```

`--account-id` and `--device-id` narrow the revoke target. Omitting them revokes
matching local authorizations for that product.

## Installed App Control Mode

When Panda Bridge Desktop is installed, an AI verifier can start the app with a
local one-time control server:

```bash
export PANDA_BRIDGE_VERIFY=1
export PANDA_BRIDGE_VERIFY_CONTROL_STATE=/tmp/panda-bridge-control.json
export PANDA_BRIDGE_DESKTOP_STATE=/tmp/panda-bridge-desktop.json
export PANDA_BRIDGE_FAKE_CODEX=1

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
app-owned `builtin_app_png` image from the current redacted app state and events:

```json
{
  "ok": true,
  "path": ".../desktop-...-builtin.png",
  "method": "builtin_app_png",
  "source": "desktop_builtin_renderer"
}
```

This keeps evidence deterministic and makes screenshot capture part of the app
contract itself. The verification script only calls this interface; it does not
implement screenshot capture.

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

Example allow action:

```bash
curl -sS "$CONTROL_BASE/v1/actions" \
  -H "x-panda-bridge-verify-token: $CONTROL_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "action": "click_allow_intent",
    "api": "http://127.0.0.1:8787",
    "intent": "<connect-intent-token>",
    "device_name": "Verifier Mac"
  }'
```

## Exit And Redaction Contract

- Success: exit code `0`, parseable JSON on stdout.
- Failure: non-zero exit code, stable text error on stderr.
- Verify-control success: HTTP `200`, parseable JSON.
- Verify-control failure: JSON error with non-success HTTP status.
- Verify-control requires `x-panda-bridge-verify-token`.
- Do not parse private credential files as the oracle.
- Do not log or expose `device_token`, `pb_session`, cookies, product secrets,
  bearer tokens, or raw local private paths.

## Evidence Pattern

A verifier should:

1. Create a connect intent through the SDK.
2. Start the installed app with `PANDA_BRIDGE_VERIFY=1` or use the headless
   commands for fast CI.
3. Use `open_deep_link` and screenshot/status to inspect the app route.
4. Use `click_allow_intent` or `headless-connect` with
   `PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT=1` in verifier-controlled tests.
5. Run `headless-status` or `GET /v1/status` and assert the
   product/account/policy record exists.
6. Create a job through the SDK.
7. Run `headless-poll` or `start_worker`.
8. Wait for final job status through the SDK.
9. Run `click_revoke_authorization` or `headless-revoke-authorization`.
10. Assert only the targeted product was removed.

The canonical repository check is:

```bash
npm run verify:productized-onboarding
npm run verify:desktop-ai-cli
```
