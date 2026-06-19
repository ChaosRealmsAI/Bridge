import { cleanText } from "./utils.mjs";

export function agentAccountArgs(type, input) {
  if (type === "burn.agent.accounts.list") return accountStatusArgs(["account", "list"], input, { profile: true });
  if (type === "burn.agent.accounts.get") {
    const args = ["agent", "account", "get", "--profile-id", required(input.profile_id || input.profileId, "profile_id")];
    addLiveMode(args, input);
    args.push("--json");
    return args;
  }
  if (type === "burn.agent.accounts.active") return accountStatusArgs(["account", "active"], input);
  if (type === "burn.agent.login.diagnostics") return accountStatusArgs(["login", "diagnostics"], input, { profile: true });
  if (type === "burn.agent.capabilities.get") {
    const source = cleanText(input.source);
    return source ? ["agent", "source", "capabilities", "--source", source, "--json"] : ["agent", "capabilities", "--json"];
  }
  if (type === "burn.agent.usage.summary") return usageSummaryArgs(input);
  if (type === "burn.agent.claude.quota.cache") return claudeQuotaCacheArgs(input);
  if (type === "burn.agent.claude.quota.refresh") return claudeQuotaRefreshArgs(input);
  if (type === "burn.agent.quota.list") return accountStatusArgs(["quota", "list"], input, { profile: true, quota: true });
  if (type === "burn.agent.quota.probe") {
    const args = ["agent", "quota", "probe", "--profile-id", required(input.profile_id || input.profileId, "profile_id")];
    addQuotaProbeMode(args, input);
    args.push("--json");
    return args;
  }
  if (type === "burn.agent.health.scan") return accountStatusArgs(["health", "scan"], input, { quota: true });
  return null;
}

function claudeQuotaCacheArgs(input) {
  const args = ["agent", "claude", "quota-cache"];
  const profileId = cleanText(input.profile_id || input.profileId);
  if (profileId) args.push("--profile-id", profileId);
  args.push("--json");
  return args;
}

function claudeQuotaRefreshArgs(input) {
  const args = ["agent", "claude", "quota-refresh"];
  const profileId = cleanText(input.profile_id || input.profileId);
  if (profileId) args.push("--profile-id", profileId);
  args.push("--json");
  return args;
}

function usageSummaryArgs(input) {
  const args = ["agent", "usage", "summary"];
  const source = cleanText(input.source);
  const profileId = cleanText(input.profile_id || input.profileId);
  const period = cleanText(input.period);
  if (source) args.push("--source", source);
  if (profileId) args.push("--profile-id", profileId);
  if (period) args.push("--period", period);
  if (input.quick === true) args.push("--quick");
  args.push("--json");
  return args;
}

function accountStatusArgs(parts, input, { profile = false, quota = false } = {}) {
  const args = ["agent", ...parts];
  const source = cleanText(input.source), profileId = cleanText(input.profile_id || input.profileId);
  if (source) args.push("--source", source);
  if (profile && profileId) args.push("--profile-id", profileId);
  if (quota) addQuotaProbeMode(args, input);
  else addLiveMode(args, input);
  return [...args, "--json"];
}

function addQuotaProbeMode(args, input) {
  addLiveMode(args, input);
  if (input.quick === true) args.push("--quick");
}

function addLiveMode(args, input) {
  if (input.live === true) args.push("--live");
  else if (input.live === false) args.push("--no-live");
  if (input.refresh_quota === true || input.refreshQuota === true) args.push("--refresh-quota");
}

function required(value, name) {
  const text = cleanText(value);
  if (!text) throw new Error(`missing_${name}`);
  return text;
}
