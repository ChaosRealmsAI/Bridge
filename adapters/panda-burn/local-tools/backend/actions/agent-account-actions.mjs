import { action, opt } from "./builders.mjs";
import { required } from "./validation.mjs";

export const agentAccountActions = [
  action("agent.accounts.get", "desktop", "read", "Get one local agent account launch availability row", {
    description: "Return one discovered Codex/Claude Code profile with the same safe account/profile/availability row shape as agent.accounts.list.",
    required: ["profile_id"],
    properties: { profile_id: "string", live: "boolean?", refresh_quota: "boolean?" },
    examples: [{ profile_id: "codex:default", live: true }],
    side_effects: "none",
    toCli: (input) => withLive(["agent", "account", "get", "--profile-id", required(input, "profile_id")], input),
  }),
  action("agent.accounts.active", "desktop", "read", "Read active local agent account candidates", {
    description: "Resolve bounded active Codex/Claude Code profile candidates from CODEX_HOME, CLAUDE_CONFIG_DIR, or provider defaults without scanning every local profile.",
    required: [],
    properties: { source: "codex|claude?", live: "boolean?", refresh_quota: "boolean?" },
    examples: [{}, { source: "codex", live: false }],
    side_effects: "none",
    toCli: (input) => {
      const args = ["agent", "account", "active"];
      opt(args, "--source", input.source);
      return withLive(args, input);
    },
  }),
  action("agent.login.diagnostics", "desktop", "read", "Read local agent account login diagnostics", {
    description: "Return per-profile login/startability diagnostics with safe public account/profile fields and suggested next actions.",
    required: [],
    properties: { source: "codex|claude?", profile_id: "string?", profileId: "string?", live: "boolean?", refresh_quota: "boolean?" },
    examples: [{ source: "claude" }, { profile_id: "codex:default", live: true }],
    side_effects: "none",
    toCli: (input) => {
      const args = ["agent", "login", "diagnostics"];
      opt(args, "--source", input.source);
      opt(args, "--profile-id", input.profile_id || input.profileId);
      return withLive(args, input);
    },
  }),
  action("agent.capabilities.get", "desktop", "read", "Read local agent account API capability matrix", {
    description: "Return provider/API capability booleans for profile inventory, active account, live auth, quota windows, diagnostics, and usage summary support.",
    required: [],
    properties: {},
    examples: [{}],
    side_effects: "none",
    toCli: () => ["agent", "capabilities", "--json"],
  }),
  action("agent.usage.summary", "desktop", "read", "Read local agent usage summary inventory", {
    description: "Return bounded metadata-only profile/session inventory with stable empty token and cost total fields for the future exact usage API.",
    required: [],
    properties: { source: "codex|claude?", profile_id: "string?", profileId: "string?", period: "day|week|month|all?", quick: "boolean?" },
    examples: [{ period: "day", quick: true }, { source: "codex", profile_id: "codex:default" }],
    side_effects: "none",
    toCli: (input) => {
      const args = ["agent", "usage", "summary"];
      opt(args, "--source", input.source);
      opt(args, "--profile-id", input.profile_id || input.profileId);
      opt(args, "--period", input.period);
      if (input.quick === true) args.push("--quick");
      args.push("--json");
      return args;
    },
  }),
  action("agent.claude.quota.cache", "desktop", "read", "Read Claude Code statusLine quota cache", {
    description: "Read the local per-profile Claude Code statusLine quota cache without starting Claude Code or spending tokens.",
    required: [],
    properties: { profile_id: "string?", profileId: "string?" },
    examples: [{ profile_id: "claude:default" }],
    side_effects: "none",
    toCli: (input) => withProfileJson(["agent", "claude", "quota-cache"], input),
  }),
  action("agent.claude.quota.refresh", "desktop", "read", "Plan an explicit Claude Code quota refresh", {
    description: "Return whether Claude quota is already cached or whether a user-confirmed real Claude Code response is required before refreshing statusLine quota.",
    required: [],
    properties: { profile_id: "string?", profileId: "string?" },
    examples: [{ profile_id: "claude:default" }],
    side_effects: "starts one minimal Claude Code turn to capture fresh statusLine quota",
    toCli: (input) => withProfileJson(["agent", "claude", "quota-refresh"], input),
  }),
];

function withLive(args, input) {
  if (input.live === true) args.push("--live");
  if (input.live === false) args.push("--no-live");
  if (input.refresh_quota === true || input.refreshQuota === true) args.push("--refresh-quota");
  args.push("--json");
  return args;
}

function withProfileJson(args, input) {
  opt(args, "--profile-id", input.profile_id || input.profileId);
  args.push("--json");
  return args;
}
