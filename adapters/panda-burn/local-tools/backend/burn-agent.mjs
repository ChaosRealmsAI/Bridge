#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccountCommands } from "./burn-agent-accounts.mjs";
import { stableHash } from "./burn-store-lib.mjs";

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const burnCli = path.join(backendDir, "burn");
const accountCommands = createAccountCommands({
  cleanText,
  coded,
  activeProfileCandidates,
  compareProfiles,
  discoverProfiles,
  envForDiscoveredProfile,
  execJson,
  homeDir,
  maskHome,
  normalizeOptionalSource,
  parsedErrorCode,
  publicProfile,
  readJson,
  required,
  walkJsonl,
  which,
});

async function main() {
  const { args, options } = parse(process.argv.slice(2));
  const command = args[0] || "";
  if (!command || command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(usage());
    return;
  }
  if (command === "profile" || command === "profiles") {
    const sub = args[1] || "discover";
    if (sub === "discover" || sub === "list") return print(await discoverProfiles(options));
    if (sub === "status") return print(await profileStatus(required(options.profileId || options["profile-id"], "profile-id"), options));
    if (sub === "resolve") return print(await resolveProfile(options));
    throw coded("burn_agent_usage", `unknown profile command: ${sub}`);
  }
  if (command === "account" || command === "accounts") {
    const sub = args[1] || "list";
    if (sub === "list" || sub === "availability") return print(await accountCommands.accountList(options));
    if (sub === "get") return print(await accountCommands.accountGet(options));
    if (sub === "active") return print(await accountCommands.accountActive(options));
    throw coded("burn_agent_usage", `unknown account command: ${sub}`);
  }
  if (command === "login") {
    const sub = args[1] || "diagnostics";
    if (sub === "diagnostics" || sub === "diagnostic") return print(await accountCommands.loginDiagnostics(options));
    throw coded("burn_agent_usage", `unknown login command: ${sub}`);
  }
  if (command === "capabilities" || command === "capability") {
    return print(await accountCommands.capabilities(options));
  }
  if (command === "usage") {
    const sub = args[1] || "summary";
    if (sub === "summary") return print(await accountCommands.usageSummary(options));
    if (sub === "list" || sub === "status") return print(await accountCommands.quotaList(options));
    if (sub === "probe") return print(await accountCommands.quotaProbe(options));
    throw coded("burn_agent_usage", `unknown usage command: ${sub}`);
  }
  if (command === "claude") {
    const sub = args[1] || "quota-cache";
    if (sub === "statusline-ingest") {
      const result = await accountCommands.claudeStatuslineIngest(await readStdin(), options);
      if (options.json) return print(result);
      process.stdout.write(`${result.statusline_text}\n`);
      return;
    }
    if (sub === "quota-cache") return print(await accountCommands.claudeStatuslineCache(options));
    if (sub === "quota-refresh") return print(await accountCommands.claudeQuotaRefresh(options));
    throw coded("burn_agent_usage", `unknown claude command: ${sub}`);
  }
  if (command === "quota") {
    const sub = args[1] || "list";
    if (sub === "list" || sub === "status") return print(await accountCommands.quotaList(options));
    if (sub === "probe") return print(await accountCommands.quotaProbe(options));
    throw coded("burn_agent_usage", `unknown quota command: ${sub}`);
  }
  if (command === "health" || command === "monitor") {
    const sub = args[1] || "scan";
    if (sub === "scan" || sub === "status") return print(await accountCommands.healthScan(options));
    throw coded("burn_agent_usage", `unknown health command: ${sub}`);
  }
  if (command === "source" || command === "sources") {
    return passThrough(args, options);
  }
  if (command === "sessions" || command === "session" || command === "turn") {
    required(options.source, "source");
    return passThrough(["source", command, ...args.slice(1)], options);
  }
  throw coded("burn_agent_usage", `unknown agent command: ${command}`);
}

async function discoverProfiles(options = {}) {
  const [codexCli, claudeCli] = await Promise.all([which("codex"), which("claude")]);
  const [codex, claude] = await Promise.all([
    discoverCodex({ ...options, cli: codexCli }),
    discoverClaude({ ...options, cli: claudeCli }),
  ]);
  const profiles = [...codex, ...claude].sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    schema: "burn.agent.profiles.v1",
    generated_at: new Date().toISOString(),
    counts: {
      codex: profiles.filter((item) => item.source === "codex").length,
      codex_usable: profiles.filter((item) => item.source === "codex" && item.usable).length,
      claude: profiles.filter((item) => item.source === "claude").length,
      claude_usable: profiles.filter((item) => item.source === "claude" && item.usable).length,
    },
    runtimes: {
      codex: { command: "codex", available: Boolean(codexCli), path: codexCli ? maskHome(codexCli) : "" },
      claude: { command: "claude", available: Boolean(claudeCli), path: claudeCli ? maskHome(claudeCli) : "" },
    },
    profiles,
  };
}

async function profileStatus(profileId, options = {}) {
  const discovered = await discoverProfiles({ ...options, quick: true });
  const profile = discovered.profiles.find((item) => item.id === profileId);
  if (!profile) throw coded("profile_not_found", `profile not found: ${profileId}`);
  const runtime = discovered.runtimes[profile.source] || {};
  const status = {
    ok: true,
    schema: "burn.agent.profile-status.v1",
    profile,
    runtime,
    usable: Boolean(profile.usable && runtime.available),
    checks: [
      { id: "profile_dir_exists", ok: Boolean(profile.path && existsSync(profile.path)) },
      { id: "runtime_available", ok: Boolean(runtime.available) },
      { id: "auth_hint_present", ok: Boolean(profile.auth_hint_present) },
      { id: "history_store_present", ok: Boolean(profile.history.session_count || profile.history.store_paths.length) },
    ],
  };
  if (options.deep) {
    status.version_probe = await versionProbe(profile.source);
  }
  return status;
}

async function resolveProfile(options = {}) {
  const source = normalizeSource(required(options.source, "source"));
  const project = required(options.project || options.projectPath || options.cwd || process.cwd(), "project");
  const sessionId = cleanText(options.sessionId || options["session-id"] || options.session_id || options.id);
  const operation = cleanText(options.operation || options.op || (sessionId ? "continue" : "create")).toLowerCase();
  const discovered = await discoverProfiles(options);
  const sourceProfiles = discovered.profiles.filter((profile) => profile.source === source);
  const base = {
    schema: "burn.agent.profile-resolve.v1",
    source,
    operation,
    project,
    project_display: maskHome(project),
    session_id: sessionId,
    generated_at: new Date().toISOString(),
  };
  if (sessionId && ["continue", "show", "resume", "status"].includes(operation)) {
    const candidates = sourceProfiles
      .filter((profile) => profile.usable)
      .sort(compareProfiles);
    if (!candidates.length) {
      return {
        ...base,
        ok: false,
        code: "profile_unavailable",
        message: `no usable ${source} profiles found`,
        candidates: sourceProfiles.map((profile) => candidateSummary(profile)),
      };
    }
    return resolveExactProfile(base, candidates, options);
  }
  const availabilityRows = await accountCommands.accountAvailabilityRows(sourceProfiles, {
    ...options,
    live: accountCommands.wantsLiveAvailability(options),
  });
  const candidates = availabilityRows
    .filter((row) => row.availability.can_start_new_turn)
    .map((row) => ({
      ...sourceProfiles.find((profile) => profile.id === row.profile.id),
      availability: row.availability,
      account: row.account,
    }))
    .filter((profile) => profile.id)
    .sort(compareProfiles);
  if (!candidates.length) {
    return {
      ...base,
      ok: false,
      code: "profile_unavailable",
      message: `no launchable ${source} accounts found`,
      counts: accountCommands.accountAvailabilityCounts(availabilityRows, sourceProfiles),
      candidates: availabilityRows.map((row) => candidateSummary(row.profile, { availability: row.availability, account: row.account })),
    };
  }
  return resolveCreateProfile(base, candidates, options);
}

async function resolveExactProfile(base, candidates, options) {
  const probes = await Promise.all(candidates.map(async (profile) => {
    const probe = await probeProfileSession(profile, base.source, base.project, base.session_id, options);
    return { profile, probe };
  }));
  const matches = probes.filter((item) => item.probe.ok).sort((a, b) => compareProbeMatch(a, b));
  if (!matches.length) {
    return {
      ...base,
      ok: false,
      code: "profile_match_not_found",
      message: `session was not found in any usable ${base.source} profile`,
      confidence: "none",
      reason: "session_not_found_in_usable_profiles",
      candidates: probes.map(({ profile, probe }) => candidateSummary(profile, { probe })),
    };
  }
  const selected = matches[0];
  return {
    ...base,
    ok: true,
    selected_profile_id: selected.profile.id,
    profile_id: selected.profile.id,
    profile: publicProfile(selected.profile),
    confidence: "exact",
    match: "exact",
    reason: matches.length > 1 ? "session_found_in_multiple_profiles" : "session_belongs_to_profile",
    candidates: probes.map(({ profile, probe }) => candidateSummary(profile, { probe, selected: profile.id === selected.profile.id })),
  };
}

async function resolveCreateProfile(base, candidates, options) {
  const preferred = cleanText(options.preferredProfileId || options["preferred-profile-id"] || options.profileId || options["profile-id"]);
  const scored = await Promise.all(candidates.map(async (profile) => {
    const probe = await probeProfileProjectSessions(profile, base.source, base.project, options);
    const historyCount = Number(profile.history?.session_count || 0);
    const projectCount = Number(probe.project_session_count || 0);
    let score = 0;
    if (preferred && profile.id === preferred) score += 1000;
    if (projectCount > 0) score += 500 + Math.min(projectCount, 50) + latestActivityScore(probe.latest_activity);
    if (profile.id === `${base.source}:default`) score += projectCount > 0 ? 5 : 30;
    if (historyCount > 0) score += Math.min(25, Math.ceil(Math.log10(historyCount + 1) * 10));
    if (profile.command_available) score += 10;
    if (profile.auth_hint_present) score += 10;
    return { profile, probe, score };
  }));
  scored.sort((a, b) => b.score - a.score || compareProfiles(a.profile, b.profile));
  const selected = scored[0];
  const reason = selected.probe.project_session_count > 0
    ? "project_history"
    : selected.profile.id === `${base.source}:default`
      ? "default_usable"
      : scored.length === 1
        ? "single_usable_profile"
        : "history_rich_profile";
  const confidence = selected.probe.project_session_count > 0 || preferred === selected.profile.id
    ? "high"
    : scored.length === 1 || selected.profile.id === `${base.source}:default`
      ? "medium"
      : "low";
  return {
    ...base,
    ok: true,
    selected_profile_id: selected.profile.id,
    profile_id: selected.profile.id,
    profile: publicProfile(selected.profile),
    confidence,
    match: "best",
    reason,
    candidates: scored.map((item) => candidateSummary(item.profile, {
      score: item.score,
      probe: item.probe,
      selected: item.profile.id === selected.profile.id,
    })),
  };
}

async function passThrough(args, options) {
  const profileId = options.profileId || options["profile-id"];
  const env = profileId ? await envForProfile(profileId, options) : process.env;
  const forwarded = forwardedPassThroughArgs(args, options);
  const stdout = await execJson(burnCli, forwarded, {
    cwd: process.cwd(),
    env,
    timeout: Number(options.timeout || 240000),
    maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(stdout.trimEnd() ? `${stdout.trimEnd()}\n` : "");
}

async function envForProfile(profileId, options = {}) {
  const discovered = await discoverProfiles(options);
  const profile = discovered.profiles.find((item) => item.id === profileId);
  if (!profile) throw coded("profile_not_found", `profile not found: ${profileId}`);
  const env = { ...process.env, BURN_AGENT_PROFILE_ID: profile.id };
  if (profile.source === "codex" && profile.path) env.CODEX_HOME = profile.path;
  if (profile.source === "claude") {
    if (profile.path && profile.id !== "claude:default") env.CLAUDE_CONFIG_DIR = profile.path;
    else delete env.CLAUDE_CONFIG_DIR;
  }
  return env;
}

async function activeProfileCandidates(options = {}) {
  const source = normalizeOptionalSource(options.source);
  const profiles = [];
  if (!source || source === "codex") profiles.push(await activeCodexProfile(options));
  if (!source || source === "claude") profiles.push(await activeClaudeProfile(options));
  return profiles.filter(Boolean).sort(compareProfiles);
}

async function activeCodexProfile(options = {}) {
  const cli = await which("codex");
  const envPath = cleanText(process.env.CODEX_HOME);
  const defaultDir = path.join(homeDir(), ".codex");
  let dir = "";
  let activeReason = "";
  let activeEnvKeys = [];
  if (envPath && existsSync(path.resolve(envPath))) {
    dir = path.resolve(envPath);
    activeReason = "CODEX_HOME";
    activeEnvKeys = ["CODEX_HOME"];
  } else if (existsSync(defaultDir)) {
    dir = defaultDir;
    activeReason = envPath ? "CODEX_HOME_missing_default_home" : "default_home";
    activeEnvKeys = envPath ? ["CODEX_HOME", "HOME"] : ["HOME"];
  } else {
    dir = envPath ? path.resolve(envPath) : defaultDir;
    activeReason = envPath ? "CODEX_HOME_missing" : "default_home_missing";
    activeEnvKeys = envPath ? ["CODEX_HOME", "HOME"] : ["HOME"];
  }
  const authPath = path.join(dir, "auth.json");
  const auth = await readJson(authPath);
  const history = await historySummary(path.join(dir, "sessions"), activeHistoryOptions(options));
  const authHint = authHintPresent(auth) || existsSync(authPath);
  const identity = providerProfileIdentity("codex", dir, defaultDir, "Codex default", "Codex");
  return {
    id: identity.id,
    source: "codex",
    label: identity.label,
    path: dir,
    path_display: maskHome(dir),
    runtime: "codex-app-server",
    command: "codex",
    command_available: Boolean(cli),
    usable: Boolean(cli && authHint),
    auth_hint_present: authHint,
    history,
    store_paths: history.store_paths,
    env: { CODEX_HOME: dir },
    active_reason: activeReason,
    active_env_keys: activeEnvKeys,
  };
}

async function activeClaudeProfile(options = {}) {
  const cli = await which("claude");
  const envPath = cleanText(process.env.CLAUDE_CONFIG_DIR);
  const defaultDir = path.join(homeDir(), ".claude");
  let dir = "";
  let activeReason = "";
  let activeEnvKeys = [];
  if (envPath && existsSync(path.resolve(envPath))) {
    dir = path.resolve(envPath);
    activeReason = "CLAUDE_CONFIG_DIR";
    activeEnvKeys = ["CLAUDE_CONFIG_DIR"];
  } else {
    dir = defaultDir;
    activeReason = envPath ? "CLAUDE_CONFIG_DIR_missing_default_profile" : "default_profile";
    activeEnvKeys = envPath ? ["CLAUDE_CONFIG_DIR", "HOME"] : ["HOME"];
  }
  const identity = providerProfileIdentity("claude", dir, defaultDir, "Claude Code default", "Claude Code");
  const authFiles = [
    path.join(dir, ".credentials.json"),
    path.join(dir, "credentials.json"),
    path.join(dir, "settings.json"),
  ];
  const globalAuth = existsSync(path.join(homeDir(), ".claude.json"));
  const authHint = authFiles.some((file) => existsSync(file)) || (identity.isDefault && globalAuth);
  const history = await historySummary(path.join(dir, "projects"), activeHistoryOptions(options));
  return {
    id: identity.id,
    source: "claude",
    label: identity.label,
    path: dir,
    path_display: maskHome(dir),
    runtime: "claude-agent-sdk",
    command: "claude",
    command_available: Boolean(cli),
    usable: Boolean(cli && authHint),
    auth_hint_present: authHint,
    history,
    store_paths: history.store_paths,
    env: identity.isDefault ? {} : { CLAUDE_CONFIG_DIR: dir },
    active_reason: activeReason,
    active_env_keys: activeEnvKeys,
  };
}

function activeHistoryOptions(options = {}) {
  const historyLimit = options.historyLimit || options["history-limit"] || 300;
  return { ...options, quick: true, historyLimit, "history-limit": historyLimit };
}

async function discoverCodex(options = {}) {
  const defaultDir = path.join(homeDir(), ".codex");
  const dirs = await candidateDirs({
    explicit: process.env.CODEX_HOME,
    prefix: ".codex",
    defaultDir,
  });
  return Promise.all(dirs.map(async (dir) => {
    const authPath = path.join(dir, "auth.json");
    const auth = await readJson(authPath);
    const history = await historySummary(path.join(dir, "sessions"), options);
    const authHint = authHintPresent(auth) || existsSync(authPath);
    const identity = providerProfileIdentity("codex", dir, defaultDir, "Codex default", "Codex");
    return {
      id: identity.id,
      source: "codex",
      label: identity.label,
      path: dir,
      path_display: maskHome(dir),
      runtime: "codex-app-server",
      command: "codex",
      command_available: Boolean(options.cli),
      usable: Boolean(options.cli && authHint),
      auth_hint_present: authHint,
      history,
      store_paths: history.store_paths,
      env: { CODEX_HOME: dir },
    };
  }));
}

async function discoverClaude(options = {}) {
  const defaultDir = path.join(homeDir(), ".claude");
  const dirs = await candidateDirs({
    explicit: process.env.CLAUDE_CONFIG_DIR,
    prefix: ".claude",
    defaultDir,
  });
  const globalAuth = existsSync(path.join(homeDir(), ".claude.json"));
  return Promise.all(dirs.map(async (dir) => {
    const identity = providerProfileIdentity("claude", dir, defaultDir, "Claude Code default", "Claude Code");
    const authFiles = [
      path.join(dir, ".credentials.json"),
      path.join(dir, "credentials.json"),
      path.join(dir, "settings.json"),
    ];
    const authHint = authFiles.some((file) => existsSync(file)) || (identity.isDefault && globalAuth);
    const history = await historySummary(path.join(dir, "projects"), options);
    return {
      id: identity.id,
      source: "claude",
      label: identity.label,
      path: dir,
      path_display: maskHome(dir),
      runtime: "claude-agent-sdk",
      command: "claude",
      command_available: Boolean(options.cli),
      usable: Boolean(options.cli && authHint),
      auth_hint_present: authHint,
      history,
      store_paths: history.store_paths,
      env: identity.isDefault ? {} : { CLAUDE_CONFIG_DIR: dir },
    };
  }));
}

async function candidateDirs({ explicit, prefix, defaultDir }) {
  const seen = new Set();
  const dirs = [];
  function add(dir) {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    if (existsSync(resolved)) dirs.push(resolved);
  }
  add(explicit);
  add(defaultDir);
  const home = homeDir();
  const entries = await fs.readdir(home, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    add(path.join(home, entry.name));
  }
  return dirs;
}

function providerProfileIdentity(source, dir, defaultDir, defaultLabel, labelPrefix) {
  const resolved = path.resolve(dir);
  const defaultResolved = path.resolve(defaultDir);
  if (resolved === defaultResolved) return { id: `${source}:default`, label: defaultLabel, isDefault: true };
  const base = path.basename(resolved).replace(/^\./, "") || "profile";
  const parent = path.basename(path.dirname(resolved)).replace(/^\./, "");
  const suffixInput = safeId(base) === "default" && parent ? `${parent}-${base}` : base;
  return { id: `${source}:${safeId(suffixInput)}`, label: `${labelPrefix} ${base}`, isDefault: false };
}

async function historySummary(root, options = {}) {
  const files = [];
  const limit = Math.max(1, Math.min(Number(options.historyLimit || options["history-limit"] || (options.quick ? 300 : 10000)) || 10000, 10000));
  await walkJsonl(root, files, 0, limit);
  return {
    session_count: files.length,
    session_count_capped: files.length >= limit,
    store_paths: existsSync(root) ? [maskHome(root)] : [],
    sample_files: files.slice(0, 5).map(maskHome),
    store_hash: existsSync(root) ? stableHash(root) : "",
  };
}

async function walkJsonl(dir, files, depth, limit) {
  if (files.length >= limit || depth > 6) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(full, files, depth + 1, limit);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    if (files.length >= limit) return;
  }
}

async function which(command) {
  const pathEnv = process.env.PATH || "";
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${command}${suffix}`);
      try {
        await fs.access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return "";
}

async function versionProbe(source) {
  const command = source === "claude" ? "claude" : "codex";
  const cli = await which(command);
  if (!cli) return { ok: false, code: "runtime_missing" };
  try {
    const stdout = await execJson(cli, ["--version"], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return { ok: true, stdout: stdout.trim().slice(0, 500) };
  } catch (error) {
    return { ok: false, code: "version_probe_failed", message: String(error.message || error).slice(0, 500) };
  }
}

async function probeProfileSession(profile, source, project, sessionId, options = {}) {
  try {
    const stdout = await execJson(burnCli, [
      "source",
      "session",
      "show",
      "--source",
      source,
      "--project",
      project,
      "--session-id",
      sessionId,
      "--cursor",
      "0",
      "--limit",
      "1",
      "--json",
    ], {
      cwd: process.cwd(),
      env: envForDiscoveredProfile(profile),
      timeout: Number(options.resolveTimeout || options.timeout || 30000),
      maxBuffer: 8 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout);
    return {
      ok: Boolean(payload?.ok !== false),
      code: "ok",
      title: cleanText(payload?.summary?.title),
      last_activity: cleanText(payload?.summary?.last_activity),
      provider: cleanText(payload?.provider?.history_source || payload?.provider?.runtime),
    };
  } catch (error) {
    return {
      ok: false,
      code: parsedErrorCode(error),
      message: cleanText(error?.message || error).slice(0, 300),
    };
  }
}

async function probeProfileProjectSessions(profile, source, project, options = {}) {
  try {
    const stdout = await execJson(burnCli, [
      "source",
      "sessions",
      "list",
      "--source",
      source,
      "--project",
      project,
      "--limit",
      "20",
      "--json",
    ], {
      cwd: process.cwd(),
      env: envForDiscoveredProfile(profile),
      timeout: Number(options.resolveTimeout || options.timeout || 30000),
      maxBuffer: 8 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout);
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    return {
      ok: Boolean(payload?.ok !== false),
      code: "ok",
      project_session_count: sessions.length,
      latest_activity: cleanText(sessions[0]?.last_activity || sessions[0]?.updated_at),
    };
  } catch (error) {
    return {
      ok: false,
      code: parsedErrorCode(error),
      message: cleanText(error?.message || error).slice(0, 300),
      project_session_count: 0,
    };
  }
}

function execJson(command, args, options) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(stderr?.trim() || error.message);
        wrapped.code = "agent_command_failed";
        rejectExec(wrapped);
        return;
      }
      resolveExec(stdout);
    });
  });
}

function forwardedPassThroughArgs(args, options) {
  const out = stripProfileOptions(args);
  appendOption(out, "--source", options.source);
  appendOption(out, "--project", options.project || options.projectPath || options.cwd);
  appendOption(out, "--session-id", options.sessionId || options["session-id"] || options.session_id || options.id);
  appendOption(out, "--turn-id", options.turnId || options["turn-id"] || options.turn_id);
  appendOption(out, "--cursor", options.cursor);
  appendOption(out, "--limit", options.limit);
  appendOption(out, "--prompt", options.prompt);
  appendOption(out, "--model", options.model);
  appendOption(out, "--mode", options.mode);
  appendOption(out, "--resume", options.resume);
  appendOption(out, "--options-json", options.optionsJson || options["options-json"] || options.options_json);
  if (options.jsonStream || options["json-stream"] || options.json_stream) out.push("--json-stream");
  if (options.json) out.push("--json");
  return out;
}

function stripProfileOptions(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile-id" || arg === "--profileId") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--profile-id=") || arg.startsWith("--profileId=")) continue;
    out.push(arg);
  }
  return out;
}

function appendOption(args, flag, value) {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  if (!text) return;
  args.push(flag, text);
}

function envForDiscoveredProfile(profile) {
  const env = { ...process.env, BURN_AGENT_PROFILE_ID: profile.id };
  if (profile.source === "codex" && profile.path) env.CODEX_HOME = profile.path;
  if (profile.source === "claude") {
    if (profile.path && profile.id !== "claude:default") env.CLAUDE_CONFIG_DIR = profile.path;
    else delete env.CLAUDE_CONFIG_DIR;
  }
  return env;
}

function publicProfile(profile) {
  return {
    id: profile.id,
    source: profile.source,
    label: profile.label,
    path_display: profile.path_display,
    runtime: profile.runtime,
    command: profile.command,
    command_available: Boolean(profile.command_available),
    usable: Boolean(profile.usable),
    auth_hint_present: Boolean(profile.auth_hint_present),
    history: {
      session_count: Number(profile.history?.session_count || 0),
      session_count_capped: Boolean(profile.history?.session_count_capped),
      store_paths: Array.isArray(profile.history?.store_paths) ? profile.history.store_paths : [],
      store_hash: cleanText(profile.history?.store_hash),
    },
    store_paths: Array.isArray(profile.store_paths) ? profile.store_paths : [],
  };
}

function candidateSummary(profile, extra = {}) {
  const probe = extra.probe || {};
  const availability = extra.availability || profile.availability || null;
  const account = extra.account || profile.account || null;
  return {
    ...publicProfile(profile),
    selected: Boolean(extra.selected),
    score: Number(extra.score || 0),
    account: account ? {
      provider: cleanText(account.provider),
      display_name: cleanText(account.display_name),
      email_display: cleanText(account.email_display),
      account_hash: cleanText(account.account_hash),
      identity_known: Boolean(account.identity_known),
      identity_kind: cleanText(account.identity_kind),
      auth_method: cleanText(account.auth_method),
      api_provider: cleanText(account.api_provider),
      subscription_type: cleanText(account.subscription_type),
      plan_type: cleanText(account.plan_type),
      org_display: cleanText(account.org_display),
      org_hash: cleanText(account.org_hash),
    } : null,
    availability: availability ? {
      auth_status: cleanText(availability.auth_status),
      logged_in: availability.logged_in === null ? null : Boolean(availability.logged_in),
      can_start_new_turn: Boolean(availability.can_start_new_turn),
      needs_login: Boolean(availability.needs_login),
      code: cleanText(availability.code),
    } : null,
    probe: {
      ok: Boolean(probe.ok),
      code: cleanText(probe.code),
      project_session_count: Number(probe.project_session_count || 0),
      latest_activity: cleanText(probe.latest_activity || probe.last_activity),
      title: cleanText(probe.title),
    },
  };
}

function compareProfiles(a, b) {
  const sourceDefaultA = a.id === `${a.source}:default` ? 0 : 1;
  const sourceDefaultB = b.id === `${b.source}:default` ? 0 : 1;
  return sourceDefaultA - sourceDefaultB
    || Number(b.history?.session_count || 0) - Number(a.history?.session_count || 0)
    || a.id.localeCompare(b.id);
}

function compareProbeMatch(a, b) {
  return timeMs(b.probe.last_activity) - timeMs(a.probe.last_activity)
    || compareProfiles(a.profile, b.profile);
}

function latestActivityScore(value) {
  const time = timeMs(value);
  if (!time) return 0;
  const ageMs = Math.max(0, Date.now() - time);
  const dayMs = 24 * 60 * 60 * 1000;
  if (ageMs <= 60 * 60 * 1000) return 140;
  if (ageMs <= 6 * 60 * 60 * 1000) return 120;
  if (ageMs <= dayMs) return 90;
  if (ageMs <= 7 * dayMs) return 70;
  if (ageMs <= 30 * dayMs) return 40;
  return 10;
}

function timeMs(value) {
  const text = cleanText(value);
  if (!text) return 0;
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parsedErrorCode(error) {
  const raw = cleanText(error?.message || error);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return cleanText(parsed.code || parsed.error?.code || parsed.error || "probe_failed") || "probe_failed";
    } catch {
      // fall through
    }
  }
  if (/not found/i.test(raw)) return "session_not_found";
  if (/project/i.test(raw)) return "project_unavailable";
  return "probe_failed";
}

function parse(argv) {
  const args = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq >= 0 ? eq : undefined);
    const normalized = key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (["json", "deep", "json-stream", "quick", "live", "no-live", "force", "refresh-quota", "allow-token-spend", "confirm-token-spend"].includes(key)) {
      options[key] = true;
      options[normalized] = true;
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++index];
    if (value === undefined) throw coded("burn_agent_usage", `missing --${key} value`);
    options[key] = value;
    options[normalized] = value;
  }
  return { args, options };
}

function authHintPresent(value) {
  if (!value || typeof value !== "object") return false;
  const text = JSON.stringify(value).toLowerCase();
  return ["token", "api_key", "apikey", "account", "refresh"].some((marker) => text.includes(marker));
}

function normalizeSource(value) {
  const source = cleanText(value).toLowerCase();
  if (source !== "codex" && source !== "claude") throw coded("invalid_source", `invalid source: ${value}`);
  return source;
}

function normalizeOptionalSource(value) {
  const source = cleanText(value).toLowerCase();
  if (!source) return "";
  return normalizeSource(source);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function maskHome(value) {
  const resolved = path.resolve(value || "");
  const home = path.resolve(homeDir());
  if (resolved === home) return "~";
  if (resolved.startsWith(`${home}${path.sep}`)) return `~/${resolved.slice(home.length + 1)}`;
  return resolved;
}

function safeId(value) {
  return String(value || "default").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text) throw coded(`missing_${name.replace(/-/g, "_")}`, `${name} is required`);
  return text;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function usage() {
  return `Burn agent profile CLI

Usage:
  burn agent profile discover [--json]
  burn agent profile discover --quick [--json]
  burn agent profile status --profile-id codex:default [--deep] [--json]
  burn agent profile resolve --source codex --project P [--operation create|continue|show] [--session-id S] [--json]
  burn agent account list [--source codex|claude] [--profile-id codex:default] [--live|--no-live] [--json]
  burn agent account get --profile-id codex:default [--live|--no-live] [--json]
  burn agent account active [--source codex|claude] [--live|--no-live] [--refresh-quota] [--json]
  burn agent login diagnostics [--source codex|claude] [--profile-id codex:default] [--live|--no-live] [--json]
  burn agent claude statusline-ingest [--profile-id claude:default] [--json]
  burn agent claude quota-cache [--profile-id claude:default] [--json]
  burn agent claude quota-refresh [--profile-id claude:default] [--json]
  burn agent capabilities [--json]
  burn agent usage summary [--source codex|claude] [--profile-id codex:default] [--period day|week|month|all] [--quick] [--json]
  burn agent quota list [--source codex|claude] [--live|--quick|--no-live] [--json]
  burn agent quota probe --profile-id codex:default [--live|--quick|--no-live] [--json]
  burn agent health scan [--source codex|claude] [--live|--quick|--no-live] [--json]
  burn agent source ... --profile-id codex:default
  burn agent sessions list --source codex --profile-id codex:default --project P --json
`;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error), code: error?.code || "burn_agent_error" })}\n`);
  process.exit(1);
});
