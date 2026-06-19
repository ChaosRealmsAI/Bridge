# burn-chat

Drive local Codex and Claude Code chats.

The public contract is one `burn-chat send` shape. Internally, Burn routes
each supported agent through a small Chat Driver registry: Codex uses the
`codex-app-server` driver, Claude uses the `claude-agent-sdk` driver, and future
sources must add their own driver plus registry entry instead of changing the
Relay or Android chat contract.

Codex is driven by Burn's own `codex app-server` stdio client. Claude Code is
driven by Burn's own local Node runner for the official Claude Agent SDK.
Bridge remains only a relay/jump host; it does not load Claude SDK code or
carry Claude credentials.

## CLI

```sh
burn-chat send \
  --agent <codex|claude> \
  --project <project-dir> \
  [--resume <session_id>] \
  --prompt "<text>" \
  [--model <model>] \
  [--mode <chat|plan>] \
  [--permission-mode <default|acceptEdits|bypassPermissions|plan|dontAsk|auto>] \
  [--sdk-options-json '{"maxTurns":1}'] \
  [--sdk-options-file path/to/options.json] \
  [--json]
```

`send` always emits JSON on success:

```json
{
  "ok": true,
  "agent": "codex",
  "reply": "...",
  "session_id": "...",
  "resumed": false,
  "display": { "version": "display.v1", "blocks": [] },
  "transcript_path": "..."
}
```

Failures exit non-zero and write JSON to stderr:

```json
{
  "ok": false,
  "error": "<stable_code>",
  "code": "<stable_code>",
  "message": "<human-readable error>",
  "cause_code": "<optional nested code>"
}
```

`error` and `code` both carry the stable machine code; `message` is the
human-readable error chain.

## Runtime calls

Codex is driven by Burn's own blocking client for `codex app-server` over
stdio:

```sh
codex app-server --listen stdio://
```

Burn sends `initialize`, `initialized`, `thread/start` or `thread/resume`,
then `turn/start`, and reads app-server notifications until `turn/completed`.
The returned `session_id` is the app-server `thread.id`, so resume uses that
same id through `thread/resume`.

Claude is driven by `backend/burn-chat/claude-agent-sdk-runner.mjs`, which
imports `@anthropic-ai/claude-agent-sdk` and streams SDK messages back to Rust
as JSONL. Install the runner dependency in this package before a real Claude
turn:

```sh
npm install --prefix backend/burn-chat
```

The Rust driver starts the local runner, sends one request JSON object over
stdin, and reads:

```json
{"type":"sdk_message","message":{"type":"assistant","message":{"role":"assistant","content":[]}}}
{"type":"burn_result","reply":"...","session_id":"..."}
```

SDK events are saved under:

```text
<project>/.burn/chat/claude-agent-sdk/events/<session_id>.jsonl
```

`--mode plan` maps to SDK `permissionMode:"plan"` unless
`--permission-mode` or `sdkOptions.permissionMode` overrides it. `--model` maps
to SDK `model`. `--resume <session_id>` maps to SDK `resume`.

Advanced Agent SDK options are passed through with `--sdk-options-json` or
`--sdk-options-file`. Burn only keeps session-routing fields under its own
control: `cwd`, `prompt`, and `resume` come from the project, prompt, and
session arguments instead of `sdkOptions`. Provider permission, tool, MCP,
settings, sandbox, executable, and bypass options are left as provider-native
SDK options so user configuration behaves like normal Claude Code usage. A
local operator can still set `BURN_CLAUDE_AGENT_SDK_CLI_PATH` as a default
Claude Code executable path when no SDK option overrides it.

Set `BURN_CLAUDE_AGENT_SDK_RUNNER` to a fake runner path for tests, and
`BURN_CLAUDE_TIMEOUT_MS` to adjust the blocking turn timeout.

## Reply extraction

Codex replies are read from app-server `item/completed` notifications where
`item.type == "agentMessage"`, preferring `phase == "final_answer"`. If a
server only emits `item/agentMessage/delta`, Burn joins the deltas as a
fallback.

Claude replies prefer SDK `result.result`, falling back to the latest assistant
text block. The saved SDK event JSONL is also used as `transcript_path` when the
SDK does not expose a native transcript path.

## Unified wrapper

The top-level `burn` dev wrapper can add:

```sh
chat) exec "$BIN/burn-chat" send "$@" ;;
```

`burn-chat` is a member of the backend workspace; build it with `cargo build
-p burn-chat`.
