import { action, opt, phone, publicDescriptor } from "./builders.mjs";
import { agentAccountActions } from "./agent-account-actions.mjs";
import { required } from "./validation.mjs";

const desktopActions = [
  action("agent.profile.discover", "desktop", "read", "Discover local Codex and Claude Code profiles", {
    description: "List local Codex/Claude Code profile directories, usability hints, and history store summaries without exposing credential values.",
    required: [],
    properties: {},
    examples: [{}],
    side_effects: "none",
    toCli: () => ["agent", "profile", "discover", "--json"],
  }),
  action("agent.profile.status", "desktop", "read", "Read one local agent profile status", {
    description: "Check one Codex/Claude Code profile by profile_id, including runtime availability and history-store presence.",
    required: ["profile_id"],
    properties: { profile_id: "string", deep: "boolean?" },
    examples: [{ profile_id: "codex:default" }],
    side_effects: "none",
    toCli: (input) => {
      const args = ["agent", "profile", "status", "--profile-id", required(input, "profile_id"), "--json"];
      if (input.deep === true) args.splice(args.length - 1, 0, "--deep");
      return args;
    },
  }),
  action("agent.profile.resolve", "desktop", "read", "Resolve the best agent profile for a source/session", {
    description: "Resolve which local Codex/Claude Code profile should handle a new or resumed session. Resume/show requires exact session ownership.",
    required: ["source"],
    properties: { source: "codex|claude", project: "string?", operation: "create|continue|show?", session_id: "string?", profile_id: "string?" },
    examples: [{ source: "codex", project: ".", operation: "create" }, { source: "claude", project: ".", operation: "continue", session_id: "abc" }],
    side_effects: "none",
    toCli: (input, project) => {
      const args = ["agent", "profile", "resolve", "--source", required(input, "source"), "--project", input.project || project, "--json"];
      opt(args, "--operation", input.operation);
      opt(args, "--session-id", input.session_id || input.sessionId);
      opt(args, "--preferred-profile-id", input.profile_id || input.profileId);
      return args;
    },
  }),
  action("agent.accounts.list", "desktop", "read", "List local agent account launch availability", {
    description: "Return discovered Codex/Claude Code profiles with live account-auth launchability, deduped account counts, and safe masked identity fields.",
    required: [],
    properties: { source: "codex|claude?", profile_id: "string?", live: "boolean?" },
    examples: [{}, { source: "codex" }, { source: "claude", profile_id: "claude:default" }],
    side_effects: "none",
    toCli: (input) => {
      const args = ["agent", "account", "list"];
      opt(args, "--source", input.source);
      opt(args, "--profile-id", input.profile_id || input.profileId);
      if (input.live === true) args.push("--live");
      if (input.live === false) args.push("--no-live");
      args.push("--json");
      return args;
    },
  }),
  ...agentAccountActions,
  action("agent.quota.list", "desktop", "read", "List local agent accounts with quota and health", {
    description: "Return all discovered Codex/Claude Code accounts with safe quota status, front-end display fields, and anomaly signals. Codex live quota uses official app-server account/rateLimits/read; Claude quota stays local-only by default.",
    required: [],
    properties: { source: "codex|claude?", live: "boolean?", quick: "boolean?", profile_id: "string?" },
    examples: [{ live: true }, { source: "codex", live: true }, { source: "claude", quick: true }],
    side_effects: "none",
    toCli: (input) => {
      const args = ["agent", "quota", "list", "--json"];
      opt(args, "--source", input.source);
      opt(args, "--profile-id", input.profile_id || input.profileId);
      if (input.live === true) args.splice(args.length - 1, 0, "--live");
      if (input.live === false) args.splice(args.length - 1, 0, "--no-live");
      if (input.quick === true) args.splice(args.length - 1, 0, "--quick");
      return args;
    },
  }),
  action("agent.quota.probe", "desktop", "read", "Probe one local agent account quota", {
    description: "Return quota and health for a single discovered profile without starting a provider turn.",
    required: ["profile_id"],
    properties: { profile_id: "string", live: "boolean?", quick: "boolean?" },
    examples: [{ profile_id: "codex:default", live: true }],
    side_effects: "none",
    toCli: (input) => {
      const args = ["agent", "quota", "probe", "--profile-id", required(input, "profile_id"), "--json"];
      if (input.live === true) args.splice(args.length - 1, 0, "--live");
      if (input.live === false) args.splice(args.length - 1, 0, "--no-live");
      if (input.quick === true) args.splice(args.length - 1, 0, "--quick");
      return args;
    },
  }),
  action("agent.health.scan", "desktop", "read", "Scan local agent account anomalies", {
    description: "Return quota/auth/runtime/network/abnormal-stop incidents derived from local account probes and recent JSONL history.",
    required: [],
    properties: { source: "codex|claude?", live: "boolean?", quick: "boolean?" },
    examples: [{ live: true }, { source: "claude", quick: true }],
    side_effects: "none",
    toCli: (input) => {
      const args = ["agent", "health", "scan", "--json"];
      opt(args, "--source", input.source);
      if (input.live === true) args.splice(args.length - 1, 0, "--live");
      if (input.live === false) args.splice(args.length - 1, 0, "--no-live");
      if (input.quick === true) args.splice(args.length - 1, 0, "--quick");
      return args;
    },
  }),
  action("chat.send", "desktop", "agent", "Send a prompt to Codex or Claude", {
    description: "Call the local Burn chat driver. Claude uses the Burn tmux driver; Codex uses the Burn Codex app-server driver.",
    required: ["agent", "prompt"],
    properties: { agent: "claude|codex", prompt: "string", resume_session_id: "string?", resume: "string?", mode: "chat|plan?", model: "string?" },
    examples: [{ agent: "claude", prompt: "Summarize this project.", mode: "chat" }],
    side_effects: "starts or resumes a local AI session",
    toCli: (input, project) => {
      const args = ["chat", "--agent", required(input, "agent"), "--project", project, "--prompt", required(input, "prompt"), "--json"];
      opt(args, "--resume", input.resume_session_id || input.resume);
      opt(args, "--mode", input.mode);
      opt(args, "--model", input.model);
      return args;
    },
  }),
];

const phoneActions = [
  phone("ui.nav.tab", "Navigate the app-level bottom tab", { tab: "projects|tasks|monitor|me" }, { tab: "monitor" }),
  phone("ui.project.open", "Open a project by id, path, or name", { id: "string?", path: "string?", name: "string?" }, { name: "Burn" }),
  phone("ui.project.tab", "Switch the current project tab", { tab: "sessions|workspace" }, { tab: "workspace" }),
  phone("ui.chat.open", "Open a chat session by visible session metadata", { id: "string?", raw_id: "string?", title: "string?", preview: "string?", agent: "claude|codex?", project: "string?", project_name: "string?", project_path: "string?", running: "boolean?" }, { id: "session-id", agent: "codex", project: "/Users/me/project", project_name: "project" }),
  phone("ui.chat.prefill", "Write a draft into the current chat input without sending", { text: "string", mode: "replace|append?", session_id: "string", chat_session_id: "string?", raw_id: "string?", agent: "claude|codex?", source: "claude|codex?", project: "string?", project_path: "string?" }, { text: "Ask Codex to continue from the current context", mode: "replace", session_id: "session-id", source: "codex", project_path: "/Users/me/project" }, {
    interface_kind: "built_in_ai_tool",
    tool_surface: "flutter.safe_ui.chat_input",
    scope: "current_chat_session",
    confirmation: "writes_draft_only_never_sends",
    owned_by: "Burn App",
    side_effects: "writes draft text into the current Burn chat input only; never sends",
  }),
  phone("ui.chat.send", "Send the current chat draft after explicit user confirmation", { text: "string?", session_id: "string", chat_session_id: "string?", raw_id: "string?", agent: "claude|codex?", source: "claude|codex?", project: "string?", project_path: "string?" }, { session_id: "session-id", source: "codex", project_path: "/Users/me/project" }, {
    interface_kind: "built_in_ai_tool",
    tool_surface: "flutter.safe_ui.chat_input",
    scope: "current_chat_session",
    confirmation: "requires_explicit_user_send_intent",
    owned_by: "Burn App",
    confirm_required: true,
    side_effects: "sends the current Burn chat draft through ChatScreen agent-session create/continue",
  }),
  phone("ui.notifications.inject", "Inject a notification event into the Burn App", { status: "completion|failure|waiting_permission|completed|failed?", target_type: "project|session|task|issue|permission_request", target_id: "string", notification_id: "string?", project_id: "string", project_name: "string?", project_path: "string?", path: "string?", context_id: "string?", agent: "claude|codex?", raw_summary: "string?", summary: "string?", error_code: "string?", permission_request_id: "string?", secret_marker: "string?", path_marker: "string?", body_marker: "string?", secret_markers: "string[]?", path_markers: "string[]?", body_markers: "string[]?" }, { status: "waiting_permission", target_type: "permission_request", target_id: "perm-123", project_id: "burn", raw_summary: "Approve write-local action" }),
  phone("ui.notifications.source_emit", "Emit a NOTI-V0.2 unified notification source event", { source: "chat|agent|permission|task|issue|highlight|voice|billing|device|account|sync", target_id: "string", privacy_class: "public|summary|redacted|sensitive|private|metadata", status: "completion|failure|waiting_permission|security|sync_conflict|blocked|info|warning?", target_type: "project|session|task|issue|permission_request|highlight|voice_call|billing_record|device_status|account_security|sync_conflict?", source_event_id: "string?", notification_id: "string?", project_id: "string?", project_name: "string?", project_path: "string?", path: "string?", context_id: "string?", agent: "claude|codex?", raw_summary: "string?", summary: "string?", severity: "info|success|warning|error|critical?", error_code: "string?", permission_request_id: "string?", dedupe_key: "string?", collapse_key: "string?", badge_group: "unread|failed|permission_required|security|sync_conflict|none?", message_center: "boolean?", wake_user: "boolean?", action_required: "boolean?", account_id_hash: "string?", device_id: "string?", deliver_to_system: "boolean?", secret_marker: "string?", path_marker: "string?", body_marker: "string?", secret_markers: "string[]?", path_markers: "string[]?", body_markers: "string[]?" }, { source: "sync", target_id: "conflict-123", privacy_class: "summary", status: "sync_conflict", summary: "Project data conflict needs review" }),
  phone("ui.notifications.permission.set", "Set the App notification preference for V0.17 fallback verification", { enabled: "boolean" }, { enabled: false }),
  phone("ui.notifications.open", "Open a notification deep link by notification_id", { notification_id: "string", id: "string?", target_state: "current|stale|deleted|revoked|authorization_revoked|offline|device_offline|not_found?", open_project: "boolean?" }, { notification_id: "noti_completion_project_demo" }),
  phone("ui.notifications.manifest", "Export the V0.17 notification/status manifest bound to screenshots", { screenshot: "string", xml: "string", screenshot_path: "string?", xml_path: "string?", permission_state: "string?" }, { screenshot: "spec/evidence/v0-17/blackbox/notifications.png", xml: "spec/evidence/v0-17/blackbox/notifications.xml" }),
  phone("ui.notifications.delivery_manifest", "Export NOTI-V0.2 delivery policy manifest bound to screenshots", { screenshot: "string", xml: "string", screenshot_path: "string?", xml_path: "string?" }, { screenshot: "spec/evidence/noti-v0-2/blackbox/delivery.png", xml: "spec/evidence/noti-v0-2/blackbox/delivery.xml" }),
  phone("ui.notifications.badge_manifest", "Export NOTI-V0.2 red dot and badge manifest bound to screenshots", { screenshot: "string", xml: "string", screenshot_path: "string?", xml_path: "string?" }, { screenshot: "spec/evidence/noti-v0-2/blackbox/badge.png", xml: "spec/evidence/noti-v0-2/blackbox/badge.xml" }),
  phone("ui.notifications.center.manifest", "Export NOTI-V0.2 message center manifest bound to screenshots", { screenshot: "string", xml: "string", screenshot_path: "string?", xml_path: "string?" }, { screenshot: "spec/evidence/noti-v0-2/blackbox/center.png", xml: "spec/evidence/noti-v0-2/blackbox/center.xml" }),
  phone("ui.notifications.center.read", "Mark one or all NOTI-V0.2 message center items read or handled", { notification_id: "string?", id: "string?", all: "boolean?", handled: "boolean?" }, { all: true }),
  phone("ui.notifications.center.clear", "Clear low-priority NOTI-V0.2 message center history without hiding critical unresolved items", { notification_id: "string?", id: "string?", scope: "single|all|low_priority?" }, { scope: "low_priority" }),
  phone("ui.notifications.restart_manifest", "Export NOTI-V0.2 restart and dedupe manifest bound to screenshots", { screenshot: "string", xml: "string", screenshot_path: "string?", xml_path: "string?" }, { screenshot: "spec/evidence/noti-v0-2/blackbox/restart.png", xml: "spec/evidence/noti-v0-2/blackbox/restart.xml" }),
  phone("ui.notifications.rejected_manifest", "Export NOTI-V0.2 fail-closed rejected event manifest bound to screenshots", { screenshot: "string", xml: "string", screenshot_path: "string?", xml_path: "string?" }, { screenshot: "spec/evidence/noti-v0-2/blackbox/negative.png", xml: "spec/evidence/noti-v0-2/blackbox/negative.xml" }),
  phone("ui.voice.call.open", "Open voice call for the current chat", {}, {}),
  phone("ui.voice.call.inject_pcm", "Development verification action: stream a PCM fixture from the Burn App voice call through VoiceClient.sendAudio", {
    fixture_url: "string",
    session_id: "string",
    chat_session_id: "string?",
    raw_id: "string?",
    sample_rate: "number?",
    encoding: "pcm_s16le?",
    chunk_bytes: "number?",
    interval_ms: "number?",
    trailing_silence_chunks: "number?",
  }, { fixture_url: "http://10.0.2.2:8897/prefill.pcm", session_id: "chat-session", sample_rate: 16000, encoding: "pcm_s16le" }, {
    interface_kind: "debug_verification_action",
    scope: "current_voice_call_session",
    owned_by: "Burn App development build",
    side_effects: "debug-only stream from local PCM URL through the current voice call; no production AI tool exposure",
  }),
  phone("ui.voice.billing.open", "Open voice call billing", {}, {}),
  phone("ui.me.theme.set", "Set appearance preference", { theme: "auto|light|dark" }, { theme: "dark" }),
  phone("ui.me.language.set", "Set language preference", { language: "system|en|zh|ja|ko|es|fr|de|pt|ru" }, { language: "zh" }),
  phone("ui.me.default_agent.set", "Set default agent preference", { agent: "claude|codex" }, { agent: "claude" }),
  phone("ui.agent.profiles.refresh", "Refresh visible local Codex/Claude Code account quota and health in Me", {}, {}, {
    interface_kind: "built_in_ai_tool",
    tool_surface: "flutter.me.agent_accounts",
    scope: "current_bridge_device",
    confirmation: "read_only_refresh",
    owned_by: "Burn App",
    side_effects: "read-only relay scan of local agent profile quota/health metadata; no provider turn is started",
  }),
  phone("ui.me.notifications.set", "Set notification preference", { enabled: "boolean" }, { enabled: true }),
  phone("ui.bridge.disconnect", "Disconnect Bridge and return to local mode", {}, {}),
];

export const ACTIONS = Object.freeze([...desktopActions, ...phoneActions]);

export function listActions({ target } = {}) {
  return ACTIONS.filter((item) => !target || item.target === target).map(publicDescriptor);
}

export function getActionDescriptor(id) {
  return ACTIONS.find((item) => item.id === id) || null;
}

export function isPhoneActionAllowed(id) {
  return Boolean(getActionDescriptor(id)?.target === "phone");
}
