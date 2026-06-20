import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const OBSERVER_SOURCES_SCHEMA = "burn.agent.observer.sources.v1";
const OBSERVER_STATUS_SCHEMA = "burn.agent.observer.status.v1";
const OBSERVER_DELTAS_SCHEMA = "burn.agent.observer.deltas.v1";
const OBSERVER_WATCH_SCHEMA = "burn.agent.observer.watch.v1";
const OBSERVER_PERF_SCHEMA = "burn.agent.observer.perf.v1";
const ABNORMAL_LIST_SCHEMA = "burn.agent.abnormal.list.v1";
const ABNORMAL_STORE_SCHEMA = "burn.agent.abnormal.store.v1";
const STATE_SCHEMA = "burn.agent.observer.state.v1";

const DEFAULT_HISTORY_LIMIT = 1000;
const DEFAULT_MAX_FILES = 50000;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_STABILITY_MS = 30000;
const DEFAULT_NO_RESPONSE_MS = 130000;
const DEFAULT_DAEMON_INTERVAL_MS = 1000;
const TAIL_READ_MAX_BYTES = 65536;
const HOT_TRANSCRIPT_WINDOW_MS = 30 * 60 * 1000;
const DAEMON_HEARTBEAT_STALE_MS = 15000;

const PERFORMANCE_BUDGET = {
  provider_roots_max: 20,
  cataloged_sessions_max: 100000,
  hot_transcripts_max: 200,
  candidate_sessions_max: 10,
  candidate_poll_ms: 1000,
  hot_transcript_poll_ms: 2000,
  new_session_discovery_with_fs_events_ms: 5000,
  new_session_discovery_fallback_poll_ms: 35000,
  warm_mtime_sweep_ms: 60000,
  warm_sweep_max_paths_per_cycle: 2000,
  full_catalog_refresh_ms: 600000,
  tail_read_max_bytes_per_changed_file: TAIL_READ_MAX_BYTES,
  list_query_p95_ms: 200,
  steady_rss_mib: 150,
  startup_or_full_refresh_rss_mib: 250,
  additional_file_descriptors_max: 256,
  additional_fs_watch_registrations_max: 2048,
  network_calls_allowed: 0,
};

export function createObserverCommands(deps) {
  const {
    cleanText,
    coded,
    defaultBurnHome,
    discoverProfiles,
    homeDir,
    maskHome,
    stableHash,
    backendAgentPath = process.argv[1],
  } = deps;

  async function observerSources(options = {}) {
    const started = Date.now();
    const inventory = await buildInventory(options);
    await refreshSourceReadability(inventory.sources);
    return {
      ok: true,
      schema: OBSERVER_SOURCES_SCHEMA,
      generated_at: new Date().toISOString(),
      mode: "source_root_first",
      counts: sourceCounts(inventory.sources),
      source_root_account_model: sourceRootAccountModel(),
      performance_budget: publicPerformanceBudget(),
      sources: inventory.sources.map((source) => publicSource(source)),
      diagnostics: {
        elapsed_ms: Date.now() - started,
        home_display: maskHome(inventory.home),
        discovery: inventory.discovery,
      },
    };
  }

  async function observerStatus(options = {}) {
    const started = Date.now();
    const inventory = await buildInventory(options);
    await refreshSourceReadability(inventory.sources);
    const state = await readObserverState(options);
    const daemon = await readDaemonState(options);
    const stateFiles = Object.values(state.files || {});
    const latest = await readAbnormalLatest(options);
    const now = Date.now();
    const hot = stateFiles.filter((file) => now - Number(file.mtime_ms || 0) <= HOT_TRANSCRIPT_WINDOW_MS).length;
    const latestCandidates = array(latest?.candidates);
    const latestIncidents = array(latest?.incidents);
    const daemonAlive = daemonRunning(options, daemon);
    const running = Boolean(state.running && daemonAlive);
    return {
      ok: true,
      schema: OBSERVER_STATUS_SCHEMA,
      generated_at: new Date().toISOString(),
      mode: "local_poll_observer",
      running,
      watcher: {
        running,
        requested_running: Boolean(state.running),
        mode: running ? "daemon_polling" : state.running ? "requested_but_daemon_not_alive" : "stopped",
        daemon_pid: Number(daemon.pid || 0),
        daemon_alive: daemonAlive,
        daemon_instance_id: cleanText(daemon.instance_id),
        started_at: cleanText(state.started_at),
        last_scan_at: cleanText(state.last_scan_at),
        last_daemon_heartbeat_at: cleanText(daemon.last_heartbeat_at),
        last_iteration_at: cleanText(daemon.last_iteration_at),
        last_stop_at: cleanText(state.last_stop_at),
        state_path_display: observerStatePathDisplay(options),
        daemon_path_display: observerDaemonPathDisplay(options),
      },
      counts: {
        ...sourceCounts(inventory.sources),
        cataloged_sessions: stateFiles.length,
        hot_transcripts: hot,
        candidate_sessions: latestCandidates.length,
        incidents: latestIncidents.length,
      },
      degraded_resource_pressure: resourcePressure(inventory.sources, stateFiles, latestCandidates),
      source_root_account_model: sourceRootAccountModel(),
      performance_budget: publicPerformanceBudget(),
      diagnostics: {
        elapsed_ms: Date.now() - started,
        status_source: "observer_state_and_abnormal_latest",
        network_call_count: 0,
        rss_mib: rssMiB(),
      },
    };
  }

  async function observerDeltasList(options = {}) {
    const started = Date.now();
    const inventory = await buildInventory(options);
    const state = await readObserverState(options);
    const files = await scanSourceFiles(inventory, scanOptions(options));
    const deltas = computeDeltaEvents(files, state);
    const nextState = observerState({
      ...state,
      running: Boolean(state.running),
      last_scan_at: new Date().toISOString(),
      files: Object.fromEntries(files.map((file) => [file.transcript_hash, stateFileRow(file)])),
      sources: Object.fromEntries(inventory.sources.map((source) => [source.id, stateSourceRow(source)])),
    });
    if (!truthy(options.dryRun || options["dry-run"])) {
      await writeObserverState(options, nextState);
    }
    return deltaListResponse(options, inventory, files, deltas, {
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - started,
      committed: !truthy(options.dryRun || options["dry-run"]),
    });
  }

  function computeDeltaEvents(files, state) {
    const previousFiles = state.files && typeof state.files === "object" ? state.files : {};
    const deltas = [];
    for (const file of files) {
      const previous = previousFiles[file.transcript_hash];
      if (!previous) {
        deltas.push(deltaEvent("session_added", file, null));
        if (file.size_bytes > 0) deltas.push(deltaEvent("transcript_delta", file, null));
      } else if (previous.fingerprint !== file.fingerprint) {
        deltas.push(deltaEvent("transcript_delta", file, previous));
      }
    }
    return deltas;
  }

  function deltaListResponse(options, inventory, files, deltas, meta = {}) {
    return {
      ok: true,
      schema: OBSERVER_DELTAS_SCHEMA,
      generated_at: cleanText(meta.generated_at) || new Date().toISOString(),
      mode: "single_poll_delta",
      committed: Boolean(meta.committed),
      source_root_account_model: sourceRootAccountModel(),
      shared_stream_consumers: [
        "normal session push/history refresh",
        "active session tracker",
        "abnormal-session classifier",
      ],
      counts: {
        ...sourceCounts(inventory.sources),
        cataloged_sessions: files.length,
        deltas: deltas.length,
        session_added: deltas.filter((item) => item.kind === "session_added").length,
        transcript_delta: deltas.filter((item) => item.kind === "transcript_delta").length,
      },
      deltas,
      diagnostics: {
        elapsed_ms: Number(meta.elapsed_ms || 0),
        state_path_display: observerStatePathDisplay(options),
        network_call_count: 0,
        rss_mib: rssMiB(),
      },
    };
  }

  async function observerWatchStart(options = {}) {
    const state = await readObserverState(options);
    const daemon = await readDaemonState(options);
    if (state.running && daemonRunning(options, daemon)) {
      return watchResponse(options, true, "daemon_polling", {
        daemon_pid: Number(daemon.pid || 0),
        daemon_alive: true,
        daemon_instance_id: cleanText(daemon.instance_id),
        note: "observer daemon is already running",
      });
    }
    const next = observerState({
      ...state,
      running: true,
      started_at: state.started_at || new Date().toISOString(),
      last_scan_at: cleanText(state.last_scan_at),
      files: state.files || {},
      sources: state.sources || {},
    });
    await writeObserverState(options, next);
    const instanceId = randomUUID();
    const child = spawnObserverDaemon(options, instanceId);
    await writeDaemonState(options, {
      instance_id: instanceId,
      pid: child.pid || 0,
      status: "starting",
      started_at: new Date().toISOString(),
      interval_ms: daemonIntervalMs(options),
      backend_agent_path_hash: stableHash(path.resolve(backendAgentPath)),
      burn_home_hash: stableHash(observerBurnHome(options)),
    });
    return watchResponse(options, true, "daemon_starting", {
      daemon_pid: Number(child.pid || 0),
      daemon_alive: Boolean(child.pid),
      daemon_instance_id: instanceId,
      note: "observer daemon spawned; it owns shared JSONL deltas and abnormal classification while running",
    });
  }

  async function observerWatchStop(options = {}) {
    const state = await readObserverState(options);
    const daemon = await readDaemonState(options);
    const daemonWasAlive = daemonRunning(options, daemon) || daemonStarting(options, daemon);
    const safeToStop = daemonWasAlive && daemonProcessMatches(options, daemon) && Number(daemon.pid) !== process.pid;
    if (safeToStop) {
      try {
        process.kill(Number(daemon.pid), "SIGTERM");
      } catch {
        // The daemon may have exited between the liveness check and the stop request.
      }
    }
    const next = observerState({
      ...state,
      running: false,
      last_stop_at: new Date().toISOString(),
    });
    await writeObserverState(options, next);
    await writeDaemonState(options, {
      ...daemon,
      status: "stopped",
      stopped_at: new Date().toISOString(),
      stop_requested: true,
    });
    return watchResponse(options, false, "stopped", {
      daemon_pid: Number(daemon.pid || 0),
      daemon_alive_before_stop: daemonWasAlive,
      daemon_stop_signal_sent: safeToStop,
    });
  }

  async function observerPerf(options = {}) {
    const started = Date.now();
    const inventory = await buildInventory(options);
    const files = await scanSourceFiles(inventory, scanOptions(options));
    const now = Date.now();
    const hot = files.filter((file) => now - file.mtime_ms <= HOT_TRANSCRIPT_WINDOW_MS).length;
    return {
      ok: true,
      schema: OBSERVER_PERF_SCHEMA,
      generated_at: new Date().toISOString(),
      budget: publicPerformanceBudget(),
      sample: {
        provider_roots: inventory.sources.length,
        cataloged_sessions: files.length,
        hot_transcripts: hot,
        candidate_sessions: 0,
        max_rss_mib: rssMiB(),
        network_call_count: 0,
        scan_elapsed_ms: Date.now() - started,
        tail_read_max_bytes_per_changed_file: TAIL_READ_MAX_BYTES,
        event_store_mib: await eventStoreMiB(options),
      },
      degraded_resource_pressure: resourcePressure(inventory.sources, files, []),
      measurement_note: "Local single-sample contract metric; the daemon persists last iteration samples and keeps network calls at zero.",
    };
  }

  async function abnormalList(options = {}) {
    const latest = truthy(options.snapshot) ? await readAbnormalLatest(options) : null;
    if (latest) {
      return abnormalPublicSnapshot(options, latest, {
        mode: "local_jsonl_tail_classifier_snapshot",
        diagnostics: {
          elapsed_ms: 0,
          snapshot_source: "latest_store",
          tail_read_max_bytes: TAIL_READ_MAX_BYTES,
          network_call_count: 0,
          rss_mib: rssMiB(),
        },
      });
    }
    const started = Date.now();
    const inventory = await buildInventory(options);
    const files = await scanSourceFiles(inventory, scanOptions(options));
    const classified = await classifyAbnormalFiles(files, options, Date.now());
    return abnormalSnapshotFromClassified(options, inventory, files, classified, {
      generated_at: new Date().toISOString(),
      mode: "local_jsonl_tail_classifier",
      diagnostics: {
        elapsed_ms: Date.now() - started,
        tail_read_max_bytes: TAIL_READ_MAX_BYTES,
        network_call_count: 0,
        rss_mib: rssMiB(),
      },
    });
  }

  async function abnormalLiveSnapshot(options = {}) {
    const started = Date.now();
    const inventory = await buildInventory(options);
    const files = await scanSourceFiles(inventory, scanOptions(options));
    const classified = await classifyAbnormalFiles(files, options, Date.now());
    return abnormalSnapshotFromClassified(options, inventory, files, classified, {
      generated_at: new Date().toISOString(),
      mode: "local_jsonl_tail_classifier",
      diagnostics: {
        elapsed_ms: Date.now() - started,
        tail_read_max_bytes: TAIL_READ_MAX_BYTES,
        network_call_count: 0,
        rss_mib: rssMiB(),
      },
    });
  }

  function abnormalSnapshotFromClassified(options, inventory, files, classified, meta = {}) {
    return {
      ok: true,
      schema: ABNORMAL_LIST_SCHEMA,
      generated_at: cleanText(meta.generated_at) || new Date().toISOString(),
      mode: cleanText(meta.mode) || "local_jsonl_tail_classifier",
      source_root_account_model: sourceRootAccountModel(),
      confirmation: abnormalConfirmation(options),
      counts: {
        source_roots: inventory.sources.length,
        cataloged_sessions: files.length,
        candidates: classified.candidates.length,
        incidents: classified.incidents.length,
        suppressed_recovered: classified.suppressed.length,
      },
      incidents: classified.incidents,
      candidates: classified.candidates,
      suppressed: includeSuppressed(options) ? classified.suppressed : [],
      storage: abnormalStoragePublic(options),
      diagnostics: meta.diagnostics || {},
    };
  }

  function abnormalPublicSnapshot(options, latest, meta = {}) {
    return {
      ok: true,
      schema: ABNORMAL_LIST_SCHEMA,
      generated_at: cleanText(latest.generated_at) || new Date().toISOString(),
      mode: cleanText(meta.mode) || "local_jsonl_tail_classifier_snapshot",
      source_root_account_model: latest.source_root_account_model || sourceRootAccountModel(),
      confirmation: latest.confirmation || abnormalConfirmation(options),
      counts: latest.counts || {
        source_roots: 0,
        cataloged_sessions: 0,
        candidates: array(latest.candidates).length,
        incidents: array(latest.incidents).length,
        suppressed_recovered: array(latest.suppressed).length,
      },
      incidents: array(latest.incidents),
      candidates: array(latest.candidates),
      suppressed: includeSuppressed(options) ? array(latest.suppressed) : [],
      storage: abnormalStoragePublic(options),
      diagnostics: meta.diagnostics || {},
    };
  }

  function abnormalConfirmation(options = {}) {
    return {
      stability_window_ms: stabilityMs(options),
      no_response_window_ms: noResponseMs(options),
      rule: "A high-confidence provider error becomes an incident only if no later normal assistant reply appears and the file remains stable for the stability window. Stable nonterminal tails become suspected_stall candidates, not provider-error incidents.",
    };
  }

  async function abnormalScan(options = {}) {
    const snapshot = await abnormalLiveSnapshot(options);
    const store = await persistAbnormalSnapshot(options, snapshot);
    return {
      ...snapshot,
      mode: "local_jsonl_tail_classifier_committed",
      committed: true,
      storage: store,
    };
  }

  async function observerDaemonRun(options = {}) {
    const startedAt = new Date();
    const instanceId = cleanText(options.daemonInstanceId || options["daemon-instance-id"] || options.daemon_instance_id) || randomUUID();
    const deadline = daemonLeaseMs(options) > 0 ? Date.now() + daemonLeaseMs(options) : 0;
    const interval = daemonIntervalMs(options);
    let state = await readObserverState(options);
    state = observerState({
      ...state,
      running: true,
      started_at: state.started_at || startedAt.toISOString(),
    });
    await writeObserverState(options, state);
    await writeDaemonState(options, {
      instance_id: instanceId,
      pid: process.pid,
      status: "running",
      started_at: startedAt.toISOString(),
      last_heartbeat_at: startedAt.toISOString(),
      interval_ms: interval,
      backend_agent_path_hash: stableHash(path.resolve(backendAgentPath)),
      burn_home_hash: stableHash(observerBurnHome(options)),
    });
    let iterations = 0;
    let lastIteration = null;
    let exitReason = "stop_requested";
    while (true) {
      const latestState = await readObserverState(options);
      if (!latestState.running && iterations > 0) break;
      lastIteration = await observerPollIteration(options);
      iterations += 1;
      await writeDaemonState(options, {
        instance_id: instanceId,
        pid: process.pid,
        status: "running",
        started_at: startedAt.toISOString(),
        backend_agent_path_hash: stableHash(path.resolve(backendAgentPath)),
        burn_home_hash: stableHash(observerBurnHome(options)),
        interval_ms: interval,
        last_heartbeat_at: new Date().toISOString(),
        last_iteration_at: cleanText(lastIteration?.generated_at),
        last_iteration_elapsed_ms: Number(lastIteration?.elapsed_ms || 0),
        last_delta_count: Number(lastIteration?.deltas?.counts?.deltas || 0),
        last_incident_count: Number(lastIteration?.abnormal?.counts?.incidents || 0),
        last_candidate_count: Number(lastIteration?.abnormal?.counts?.candidates || 0),
      });
      if (truthy(options.once)) {
        exitReason = "once";
        break;
      }
      if (deadline && Date.now() >= deadline) {
        exitReason = "lease_expired";
        break;
      }
      await sleep(interval);
    }
    const finalState = await readObserverState(options);
    if (exitReason === "once" || exitReason === "lease_expired") {
      await writeObserverState(options, observerState({
        ...finalState,
        running: false,
        last_stop_at: new Date().toISOString(),
      }));
    }
    await writeDaemonState(options, {
      ...(await readDaemonState(options)),
      pid: process.pid,
      status: "stopped",
      stopped_at: new Date().toISOString(),
      exit_reason: exitReason,
      iterations,
    });
    return {
      ok: true,
      schema: OBSERVER_WATCH_SCHEMA,
      generated_at: new Date().toISOString(),
      running: false,
      mode: "daemon_run_complete",
      exit_reason: exitReason,
      iterations,
      interval_ms: interval,
      last_delta_count: Number(lastIteration?.deltas?.counts?.deltas || 0),
      last_incident_count: Number(lastIteration?.abnormal?.counts?.incidents || 0),
      last_candidate_count: Number(lastIteration?.abnormal?.counts?.candidates || 0),
      state_path_display: observerStatePathDisplay(options),
      daemon_path_display: observerDaemonPathDisplay(options),
      abnormal_store: abnormalStoragePublic(options),
    };
  }

  function observerStatePath(options = {}) {
    const explicit = cleanText(options.statePath || options["state-path"] || options.state_path);
    if (explicit) return path.resolve(explicit);
    return path.join(observerBurnHome(options), "data", "agent-observer", "state.json");
  }

  function observerStatePathDisplay(options = {}) {
    const file = observerStatePath(options);
    const burnHome = observerBurnHome(options);
    const relative = path.relative(burnHome, file);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return `<burn-home>/${relative.split(path.sep).join("/")}`;
    }
    return safePathDisplay(file, "observer-state");
  }

  function observerDaemonPath(options = {}) {
    return path.join(observerBurnHome(options), "data", "agent-observer", "daemon.json");
  }

  function observerDaemonPathDisplay(options = {}) {
    return burnHomeDisplay(options, observerDaemonPath(options));
  }

  function abnormalStoreDir(options = {}) {
    return path.join(observerBurnHome(options), "data", "agent-abnormal");
  }

  function abnormalLatestPath(options = {}) {
    return path.join(abnormalStoreDir(options), "latest.json");
  }

  function abnormalEventsPath(options = {}) {
    return path.join(abnormalStoreDir(options), "events.jsonl");
  }

  function abnormalStoragePublic(options = {}, extra = {}) {
    return {
      schema: ABNORMAL_STORE_SCHEMA,
      root_display: burnHomeDisplay(options, abnormalStoreDir(options)),
      latest_path_display: burnHomeDisplay(options, abnormalLatestPath(options)),
      events_path_display: burnHomeDisplay(options, abnormalEventsPath(options)),
      ...extra,
    };
  }

  function burnHomeDisplay(options, file) {
    const burnHome = observerBurnHome(options);
    const relative = path.relative(burnHome, file);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return `<burn-home>/${relative.split(path.sep).join("/")}`;
    }
    return safePathDisplay(file, "local-path");
  }

  function observerBurnHome(options = {}) {
    return path.resolve(cleanText(options.home || options.burnHome || options.burn_home) || defaultBurnHome());
  }

  async function observerPollIteration(options = {}) {
    const started = Date.now();
    const generatedAt = new Date().toISOString();
    const inventory = await buildInventory(options);
    const state = await readObserverState(options);
    const files = await scanSourceFiles(inventory, scanOptions(options));
    const deltas = computeDeltaEvents(files, state);
    const nextState = observerState({
      ...state,
      running: Boolean(state.running),
      last_scan_at: generatedAt,
      files: Object.fromEntries(files.map((file) => [file.transcript_hash, stateFileRow(file)])),
      sources: Object.fromEntries(inventory.sources.map((source) => [source.id, stateSourceRow(source)])),
    });
    await writeObserverState(options, nextState);
    const classified = await classifyAbnormalFiles(files, options, Date.now());
    const abnormal = abnormalSnapshotFromClassified(options, inventory, files, classified, {
      generated_at: generatedAt,
      mode: "local_jsonl_tail_classifier_committed",
      diagnostics: {
        elapsed_ms: Date.now() - started,
        tail_read_max_bytes: TAIL_READ_MAX_BYTES,
        network_call_count: 0,
        rss_mib: rssMiB(),
        scan_source: "shared_observer_poll_iteration",
      },
    });
    const storage = await persistAbnormalSnapshot(options, abnormal);
    return {
      generated_at: generatedAt,
      elapsed_ms: Date.now() - started,
      deltas: deltaListResponse(options, inventory, files, deltas, {
        generated_at: generatedAt,
        elapsed_ms: Date.now() - started,
        committed: true,
      }),
      abnormal: {
        ...abnormal,
        committed: true,
        storage,
      },
    };
  }

  async function buildInventory(options = {}) {
    const home = homeDir();
    const historyLimit = positiveNumber(options.historyLimit || options["history-limit"], DEFAULT_HISTORY_LIMIT);
    const discovered = await discoverProfiles({
      ...options,
      quick: true,
      historyLimit,
      "history-limit": historyLimit,
    });
    const profiles = Array.isArray(discovered?.profiles) ? discovered.profiles : [];
    const sources = await discoverSourceRoots(home, profiles, options);
    return {
      home,
      profiles,
      runtimes: discovered?.runtimes || {},
      sources,
      discovery: {
        profiles: profiles.length,
        runtimes: discovered?.runtimes || {},
      },
    };
  }

  async function discoverSourceRoots(home, profiles, options = {}) {
    const rows = [];
    const profileByPath = new Map();
    for (const profile of profiles) {
      if (profile.path) profileByPath.set(path.resolve(profile.path), profile);
    }
    const entries = await fs.readdir(home, { withFileTypes: true }).catch(() => []);
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(home, entry.name));

    const codexHomes = [
      cleanText(process.env.CODEX_HOME),
      path.join(home, ".codex"),
      ...dirs.filter((dir) => path.basename(dir).startsWith(".codex")),
    ].filter(Boolean);
    const claudeHomes = [
      cleanText(process.env.CLAUDE_CONFIG_DIR),
      path.join(home, ".claude"),
      ...dirs.filter((dir) => path.basename(dir).startsWith(".claude")),
    ].filter(Boolean);

    for (const dir of dedupePaths(codexHomes)) {
      addSourceRoot(rows, profileByPath, {
        source: "codex",
        source_kind: "codex_sessions",
        root: path.join(path.resolve(dir), "sessions"),
        owner_dir: path.resolve(dir),
        discovery_reason: dir === process.env.CODEX_HOME ? "CODEX_HOME" : "home_profile_scan",
      });
    }
    addSourceRoot(rows, profileByPath, {
      source: "codex",
      source_kind: "codexctl_sessions",
      root: path.join(home, ".codexctl"),
      owner_dir: path.join(home, ".codexctl"),
      discovery_reason: "codexctl_history_route",
    });
    for (const dir of dedupePaths(claudeHomes)) {
      addSourceRoot(rows, profileByPath, {
        source: "claude",
        source_kind: "claude_projects",
        root: path.join(path.resolve(dir), "projects"),
        owner_dir: path.resolve(dir),
        discovery_reason: dir === process.env.CLAUDE_CONFIG_DIR ? "CLAUDE_CONFIG_DIR" : "home_profile_scan",
      });
    }

    const sourceFilter = cleanText(options.source).toLowerCase();
    return rows
      .filter((row) => !sourceFilter || row.source === sourceFilter)
      .sort((a, b) => a.source.localeCompare(b.source) || a.root.localeCompare(b.root));
  }

  function addSourceRoot(rows, profileByPath, input) {
    const root = path.resolve(input.root);
    if (rows.some((row) => row.root === root)) return;
    const profile = profileByPath.get(path.resolve(input.owner_dir)) || null;
    const exists = existsSync(root);
    rows.push({
      id: `${input.source}:${input.source_kind}:${stableHash(root)}`,
      source: input.source,
      provider: input.source,
      source_kind: input.source_kind,
      root,
      root_display: safePathDisplay(root, "source-root"),
      root_hash: stableHash(root),
      owner_dir: path.resolve(input.owner_dir),
      exists,
      readable: false,
      watchable: false,
      profile,
      profile_id: cleanText(profile?.id),
      profile_label: cleanText(profile?.label),
      profile_usable: Boolean(profile?.usable),
      command_available: Boolean(profile?.command_available),
      auth_hint_present: Boolean(profile?.auth_hint_present),
      account_state: accountState(profile),
      discovery_reason: input.discovery_reason,
      monitoring_included: true,
      monitoring_reason: "source_root_coverage_not_account_filtered",
    });
  }

  async function scanSourceFiles(inventory, options = {}) {
    const files = [];
    for (const source of inventory.sources) {
      await refreshOneSourceReadability(source);
      if (!source.readable) continue;
      await walkJsonlFiles(source, source.root, files, options);
      if (files.length >= options.max_files) break;
    }
    files.sort((a, b) => b.mtime_ms - a.mtime_ms || a.transcript_display.localeCompare(b.transcript_display));
    return files;
  }

  async function walkJsonlFiles(source, dir, files, options, depth = 0) {
    if (files.length >= options.max_files || depth > options.max_depth) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= options.max_files) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkJsonlFiles(source, full, files, options, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isJsonlCandidate(source, full)) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      files.push(fileRow(source, full, stat));
    }
  }

  function fileRow(source, file, stat) {
    const transcriptHash = stableHash(path.resolve(file));
    return {
      source: source.source,
      provider: source.provider,
      source_kind: source.source_kind,
      source_root_id: source.id,
      source_root_display: source.root_display,
      source_root_hash: source.root_hash,
      profile_id: source.profile_id,
      profile_label: source.profile_label,
      account_state: source.account_state,
      transcript_path: path.resolve(file),
      transcript_display: safePathDisplay(file, "transcript"),
      transcript_hash: transcriptHash,
      session_id: sessionIdFromPath(file),
      project_display: projectDisplayForFile(source, file),
      mtime_ms: Math.floor(stat.mtimeMs),
      mtime: stat.mtime.toISOString(),
      size_bytes: stat.size,
      fingerprint: `${Math.floor(stat.mtimeMs)}:${stat.size}`,
    };
  }

  async function classifyAbnormalFiles(files, options = {}, now = Date.now()) {
    const candidates = [];
    const incidents = [];
    const suppressed = [];
    const stability = stabilityMs(options);
    const noResponse = noResponseMs(options);
    const limit = Math.max(1, Math.min(positiveNumber(options.classifyLimit || options["classify-limit"], 500), 5000));
    for (const file of files.slice(0, limit)) {
      const classification = await classifyFile(file, now, stability, noResponse);
      if (!classification) continue;
      if (classification.state === "suppressed_recovered") suppressed.push(classification);
      else if (classification.state === "incident") incidents.push(classification);
      else candidates.push(classification);
    }
    return { candidates, incidents, suppressed };
  }

  async function classifyFile(file, now, stability, noResponse) {
    const tail = await readTail(file.transcript_path, TAIL_READ_MAX_BYTES);
    const events = tailEvents(tail);
    if (!events.length) return null;
    let lastProblem = null;
    let lastNormalAssistantIndex = -1;
    let lastTailSignal = null;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const marker = errorMarker(event);
      if (marker) lastProblem = { index, marker, event };
      if (normalAssistant(event)) lastNormalAssistantIndex = index;
      const signal = nonterminalTailSignal(event);
      if (signal) lastTailSignal = { index, signal, event };
    }
    if (lastProblem) {
      if (lastNormalAssistantIndex > lastProblem.index) {
        return abnormalEvent(file, now, stability, lastProblem, "suppressed_recovered");
      }
      const stableFor = Math.max(0, now - file.mtime_ms);
      const state = stableFor >= stability && lastProblem.marker.confidence === "high"
        ? "incident"
        : stableFor >= stability
          ? "candidate_medium_confidence"
          : "candidate_pending";
      return abnormalEvent(file, now, stability, lastProblem, state);
    }
    if (!lastTailSignal || lastNormalAssistantIndex > lastTailSignal.index) return null;
    if (Math.max(0, now - file.mtime_ms) < noResponse) return null;
    return abnormalEvent(file, now, noResponse, {
      index: lastTailSignal.index,
      marker: marker("no_response_tail", "suspected_stall", "medium", "structure", "stable nonterminal tail without later assistant reply"),
      event: lastTailSignal.event,
    }, "suspected_stall", {
      severity: "warning",
      signal_kind: lastTailSignal.signal.kind,
      decision_rule: "stable_nonterminal_tail_without_later_normal_assistant",
    });
  }

  function abnormalEvent(file, now, stability, problem, state, extra = {}) {
    const stableFor = Math.max(0, now - file.mtime_ms);
    const marker = problem.marker;
    return {
      id: `abn_${stableHash(`${file.transcript_path}:${file.fingerprint}:${marker.id}`)}`,
      schema: "burn.agent.abnormal.incident.v1",
      state,
      severity: cleanText(extra.severity) || "error",
      source: file.source,
      provider: file.provider,
      source_kind: file.source_kind,
      source_root_display: file.source_root_display,
      source_root_hash: file.source_root_hash,
      profile_id: file.profile_id,
      profile_label: file.profile_label,
      account_state: file.account_state,
      session_id: file.session_id,
      project_display: file.project_display,
      transcript_path_display: file.transcript_display,
      transcript_hash: file.transcript_hash,
      transcript_mtime: file.mtime,
      transcript_size_bytes: file.size_bytes,
      stable_for_ms: stableFor,
      stability_window_ms: stability,
      signal_kind: cleanText(extra.signal_kind),
      marker: {
        id: marker.id,
        category: marker.category,
        confidence: marker.confidence,
        evidence_kind: marker.evidence_kind,
        text_preview: marker.preview ? `<evidence:${stableHash(marker.preview).slice(0, 16)}>` : "",
        evidence_hash: marker.preview ? stableHash(marker.preview) : "",
      },
      observed_at: new Date(now).toISOString(),
      decision_rule: cleanText(extra.decision_rule) || (state === "incident"
        ? "last_high_confidence_error_stable_no_later_normal_assistant"
        : state === "candidate_pending"
          ? "waiting_for_stability_window"
          : state === "candidate_medium_confidence"
            ? "medium_confidence_marker_not_promoted_to_incident"
            : "later_normal_assistant_reply_detected"),
      dedupe_key: stableHash(`${file.transcript_hash}:${marker.id}`),
    };
  }

  function errorMarker(event) {
    const text = cleanText(event.text || event.raw);
    const lowerType = cleanText(event.type).toLowerCase();
    if (!providerErrorEvidenceShape(event)) return null;
    if (/socket connection was closed unexpectedly/i.test(text)) {
      return marker("socket_connection_closed", "provider_transport_error", "high", "text", text);
    }
    if (/^api error:/i.test(text) || /\bapi error:\s+/i.test(text)) {
      return marker("api_error", "provider_runtime_error", "high", "text", text);
    }
    if (/\b(ECONNRESET|ETIMEDOUT|EPIPE)\b/i.test(text)) {
      return marker("transport_exception", "provider_transport_error", "medium", "text", text);
    }
    if (/\b(rate limit|too many requests|429)\b/i.test(text)) {
      return marker("rate_limited", "provider_rate_limit", "high", "text", text);
    }
    if (/\b(quota|usage limit|insufficient_quota|credit balance|billing)\b/i.test(text)) {
      return marker("quota_or_billing_block", "provider_quota_or_billing", "high", "text", text);
    }
    if (/\b(unauthorized|forbidden|authentication|invalid api key|login required|not logged in|401|403)\b/i.test(text)) {
      return marker("auth_block", "provider_auth_error", "high", "text", text);
    }
    if (/\b(overloaded|capacity|temporarily unavailable|service unavailable|503|529)\b/i.test(text)) {
      return marker("provider_overloaded", "provider_capacity_error", "high", "text", text);
    }
    if (/\b(model not found|unsupported model|invalid model|unknown model)\b/i.test(text)) {
      return marker("model_unavailable", "provider_model_error", "high", "text", text);
    }
    if (/\b(stream|connection)\b.*\b(closed|ended|terminated|aborted|reset)\b/i.test(text)) {
      return marker("stream_or_connection_closed", "provider_transport_error", "medium", "text", text);
    }
    if (event.has_error_object || lowerType === "error" || lowerType.endsWith("_error")) {
      return marker("provider_error_event", "provider_runtime_error", "high", "json", text || event.raw);
    }
    return null;
  }

  function marker(id, category, confidence, evidenceKind, preview) {
    return { id, category, confidence, evidence_kind: evidenceKind, preview };
  }

  function tailEvents(tail) {
    return tail
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-200)
      .map(eventFromLine)
      .filter(Boolean);
  }

  function eventFromLine(line) {
    let value = null;
    try {
      value = JSON.parse(line);
    } catch {
      return { type: "text", role: "", text: line, raw: line, has_error_object: /\berror\b/i.test(line) };
    }
    const text = textFromValue(value);
    const type = cleanText(value.payload?.type || value.message?.type || value.type || value.event);
    const role = cleanText(value.role || value.message?.role || roleFromType(type));
    return {
      type,
      role,
      text,
      raw: JSON.stringify(value).slice(0, 2000),
      has_error_object: hasErrorObject(value),
    };
  }

  function normalAssistant(event) {
    if (errorMarker(event)) return false;
    const role = cleanText(event.role).toLowerCase();
    const type = cleanText(event.type).toLowerCase();
    const text = cleanText(event.text);
    return Boolean(text) && (role === "assistant" || type === "assistant" || type === "agent_message");
  }

  function providerErrorEvidenceShape(event) {
    const role = cleanText(event.role).toLowerCase();
    const type = cleanText(event.type).toLowerCase();
    if (role === "user" || type === "user" || type === "user_message") return false;
    if ((role === "assistant" || type === "assistant" || type === "agent_message") && !event.has_error_object && !type.includes("error")) {
      return false;
    }
    return Boolean(
      event.has_error_object
      || role === "error"
      || type === "error"
      || type.endsWith("_error")
      || type.includes("error")
      || type === "event_msg"
      || type === "text"
      || (!role && !type),
    );
  }

  function nonterminalTailSignal(event) {
    if (errorMarker(event) || normalAssistant(event)) return null;
    const role = cleanText(event.role).toLowerCase();
    const type = cleanText(event.type).toLowerCase();
    if (["session_meta", "metadata", "conversation_metadata", "summary", "system_prompt"].includes(type)) return null;
    if (role === "user" || type === "user" || type === "user_message" || type.includes("user")) {
      return { kind: "user_input" };
    }
    if (type.includes("tool") || type.includes("function") || type.includes("progress") || type.includes("thinking") || type.includes("turn") || type.includes("event_msg") || type.includes("assistant")) {
      return { kind: "nonterminal_progress" };
    }
    return null;
  }

  function textFromValue(value) {
    const direct = firstText([
      value.text,
      value.message,
      value.error,
      value.error?.message,
      value.error?.code,
      value.payload?.message,
      value.payload?.error,
      value.payload?.error?.message,
      value.result?.message,
    ]);
    if (direct) return direct;
    const content = value.message?.content || value.content || value.payload?.content;
    if (Array.isArray(content)) {
      return content.map((item) => firstText([item?.text, item?.content, item?.message])).filter(Boolean).join("\n");
    }
    return "";
  }

  function hasErrorObject(value) {
    if (!value || typeof value !== "object") return false;
    if (value.error && typeof value.error === "object") return true;
    if (value.payload?.error && typeof value.payload.error === "object") return true;
    const type = cleanText(value.type || value.payload?.type).toLowerCase();
    return type === "error" || type.endsWith("_error");
  }

  function firstText(values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value;
      if (value && typeof value === "object") {
        const text = firstText([value.text, value.message, value.content, value.code]);
        if (text) return text;
      }
    }
    return "";
  }

  function roleFromType(type) {
    const normalized = cleanText(type).toLowerCase();
    if (normalized === "assistant" || normalized === "agent_message") return "assistant";
    if (normalized === "user") return "user";
    if (normalized === "error" || normalized.endsWith("_error")) return "error";
    return "";
  }

  async function readObserverState(options = {}) {
    const file = observerStatePath(options);
    if (!existsSync(file)) return observerState({});
    try {
      return observerState(JSON.parse(await fs.readFile(file, "utf8")));
    } catch {
      return observerState({});
    }
  }

  async function readDaemonState(options = {}) {
    const file = observerDaemonPath(options);
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  async function writeObserverState(options, state) {
    const file = observerStatePath(options);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    await fs.writeFile(tmp, `${JSON.stringify(observerState(state), null, 2)}\n`);
    await fs.rename(tmp, file);
  }

  async function writeDaemonState(options, daemon) {
    const file = observerDaemonPath(options);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    const body = {
      schema: "burn.agent.observer.daemon.v1",
      instance_id: cleanText(daemon.instance_id),
      pid: Number(daemon.pid || 0),
      status: cleanText(daemon.status),
      backend_agent_path_hash: cleanText(daemon.backend_agent_path_hash),
      burn_home_hash: cleanText(daemon.burn_home_hash),
      started_at: cleanText(daemon.started_at),
      stopped_at: cleanText(daemon.stopped_at),
      last_heartbeat_at: cleanText(daemon.last_heartbeat_at),
      last_iteration_at: cleanText(daemon.last_iteration_at),
      last_iteration_elapsed_ms: Number(daemon.last_iteration_elapsed_ms || 0),
      last_delta_count: Number(daemon.last_delta_count || 0),
      last_incident_count: Number(daemon.last_incident_count || 0),
      last_candidate_count: Number(daemon.last_candidate_count || 0),
      interval_ms: Number(daemon.interval_ms || 0),
      stop_requested: Boolean(daemon.stop_requested),
      exit_reason: cleanText(daemon.exit_reason),
      iterations: Number(daemon.iterations || 0),
    };
    await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`);
    await fs.rename(tmp, file);
  }

  function observerState(input) {
    return {
      schema: STATE_SCHEMA,
      running: Boolean(input.running),
      started_at: cleanText(input.started_at),
      last_scan_at: cleanText(input.last_scan_at),
      last_stop_at: cleanText(input.last_stop_at),
      sources: input.sources && typeof input.sources === "object" ? input.sources : {},
      files: input.files && typeof input.files === "object" ? input.files : {},
    };
  }

  function scanOptions(options = {}) {
    return {
      max_files: Math.max(1, Math.min(positiveNumber(options.maxFiles || options["max-files"] || options.max_files, DEFAULT_MAX_FILES), 250000)),
      max_depth: Math.max(1, Math.min(positiveNumber(options.maxDepth || options["max-depth"] || options.max_depth, DEFAULT_MAX_DEPTH), 20)),
    };
  }

  function stabilityMs(options = {}) {
    return Math.max(0, Math.min(positiveNumber(options.stabilityMs || options["stability-ms"] || options.stability_ms, DEFAULT_STABILITY_MS), 10 * 60 * 1000));
  }

  function noResponseMs(options = {}) {
    return Math.max(0, Math.min(positiveNumber(options.noResponseMs || options["no-response-ms"] || options.no_response_ms, DEFAULT_NO_RESPONSE_MS), 30 * 60 * 1000));
  }

  function daemonIntervalMs(options = {}) {
    return Math.max(250, Math.min(positiveNumber(options.intervalMs || options["interval-ms"] || options.interval_ms, DEFAULT_DAEMON_INTERVAL_MS), 60000));
  }

  function daemonLeaseMs(options = {}) {
    return Math.max(0, Math.min(positiveNumber(options.leaseMs || options["lease-ms"] || options.lease_ms, 0), 24 * 60 * 60 * 1000));
  }

  function includeSuppressed(options = {}) {
    return truthy(options.includeSuppressed || options["include-suppressed"] || options.include_suppressed);
  }

  function isJsonlCandidate(source, file) {
    if (!file.endsWith(".jsonl")) return false;
    if (source.source_kind === "codexctl_sessions") return pathComponents(file).includes("sessions");
    return true;
  }

  function stateFileRow(file) {
    return {
      source: file.source,
      source_kind: file.source_kind,
      profile_id: file.profile_id,
      session_id: file.session_id,
      transcript_display: file.transcript_display,
      transcript_hash: file.transcript_hash,
      mtime_ms: file.mtime_ms,
      size_bytes: file.size_bytes,
      fingerprint: file.fingerprint,
    };
  }

  function stateSourceRow(source) {
    return {
      source: source.source,
      source_kind: source.source_kind,
      source_root_display: source.root_display,
      source_root_hash: source.root_hash,
      profile_id: source.profile_id,
      exists: Boolean(source.exists),
      readable: Boolean(source.readable),
      watchable: Boolean(source.watchable),
      account_state: source.account_state,
    };
  }

  function deltaEvent(kind, file, previous) {
    return {
      schema: "burn.agent.observer.delta.v1",
      kind,
      source: file.source,
      provider: file.provider,
      source_kind: file.source_kind,
      source_root_display: file.source_root_display,
      source_root_hash: file.source_root_hash,
      profile_id: file.profile_id,
      account_state: file.account_state,
      project_display: file.project_display,
      session_id: file.session_id,
      transcript_path_display: file.transcript_display,
      transcript_hash: file.transcript_hash,
      mtime: file.mtime,
      mtime_ms: file.mtime_ms,
      size_bytes: file.size_bytes,
      previous_mtime_ms: Number(previous?.mtime_ms || 0),
      previous_size_bytes: Number(previous?.size_bytes || 0),
      fingerprint: file.fingerprint,
      consumers: [
        "normal session push/history refresh",
        "active session tracker",
        "abnormal-session classifier",
      ],
    };
  }

  function publicSource(source) {
    return {
      id: source.id,
      source: source.source,
      provider: source.provider,
      source_kind: source.source_kind,
      source_root_display: source.root_display,
      source_root_hash: source.root_hash,
      exists: Boolean(source.exists),
      readable: Boolean(source.readable),
      watchable: Boolean(source.watchable),
      profile_id: source.profile_id,
      profile_label: source.profile_label,
      profile_usable: Boolean(source.profile_usable),
      command_available: Boolean(source.command_available),
      auth_hint_present: Boolean(source.auth_hint_present),
      account_state: source.account_state,
      discovery_reason: source.discovery_reason,
      monitoring_included: Boolean(source.monitoring_included),
      monitoring_reason: source.monitoring_reason,
    };
  }

  function sourceCounts(sources) {
    return {
      source_roots: sources.length,
      codex: sources.filter((source) => source.source === "codex").length,
      claude: sources.filter((source) => source.source === "claude").length,
      existing: sources.filter((source) => source.exists).length,
      readable: sources.filter((source) => source.readable).length,
      watchable: sources.filter((source) => source.watchable).length,
      history_only_or_unknown: sources.filter((source) => source.account_state === "history_only_or_unknown").length,
      unavailable_accounts_included: sources.filter((source) => source.profile_id && !source.profile_usable).length,
    };
  }

  function sourceRootAccountModel() {
    return {
      coverage_rule: "All discovered official source roots/routes are monitored even when their associated account/profile is expired, logged out, quota-blocked, unknown, or not executable.",
      account_rule: "Account/profile state is diagnostic metadata; it is not a filter for monitoring coverage.",
      event_identity_fields: [
        "source",
        "source_kind",
        "source_root_hash",
        "profile_id",
        "account_state",
        "project_display",
        "session_id",
        "transcript_hash",
        "transcript_path_display",
        "mtime",
        "size_bytes",
      ],
    };
  }

  function resourcePressure(sources, files, candidates) {
    const rss = rssMiB();
    const pressure = [];
    if (sources.length > PERFORMANCE_BUDGET.provider_roots_max) pressure.push("provider_roots");
    if (files.length > PERFORMANCE_BUDGET.cataloged_sessions_max) pressure.push("cataloged_sessions");
    if (candidates.length > PERFORMANCE_BUDGET.candidate_sessions_max) pressure.push("candidate_sessions");
    if (rss > PERFORMANCE_BUDGET.startup_or_full_refresh_rss_mib) pressure.push("rss_mib");
    return {
      active: pressure.length > 0,
      reasons: pressure,
      last_budget_sample: {
        provider_roots: sources.length,
        cataloged_sessions: files.length,
        candidate_sessions: candidates.length,
        rss_mib: rss,
        network_call_count: 0,
      },
    };
  }

  function publicPerformanceBudget() {
    return { ...PERFORMANCE_BUDGET, steady_state_full_transcript_reread_allowed: false };
  }

  function accountState(profile) {
    if (!profile) return "history_only_or_unknown";
    if (profile.usable) return "usable";
    if (!profile.command_available) return "runtime_missing";
    if (!profile.auth_hint_present) return "auth_hint_missing";
    return "not_live_checked_or_blocked";
  }

  function projectDisplayForFile(source, file) {
    if (source.source === "claude") {
      const relative = path.relative(source.root, file);
      const first = relative.split(path.sep).filter(Boolean)[0] || "";
      return first ? safeProjectDisplay(decodeClaudeProjectName(first)) : "";
    }
    return "";
  }

  function decodeClaudeProjectName(value) {
    const text = cleanText(value);
    if (!text) return "";
    if (text.startsWith("-")) return text.replace(/-/g, "/");
    return text;
  }

  function safeProjectDisplay(value) {
    const text = cleanText(value);
    if (!text) return "";
    if (path.isAbsolute(text)) return `<project:${stableHash(path.resolve(text))}>`;
    return sanitizeExcerpt(text);
  }

  function sessionIdFromPath(file) {
    return path.basename(file, ".jsonl").replace(/^rollout-/, "") || stableHash(file);
  }

  async function isReadableDir(dir) {
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) return false;
      await fs.access(dir);
      return true;
    } catch {
      return false;
    }
  }

  async function refreshSourceReadability(sources) {
    for (const source of sources) await refreshOneSourceReadability(source);
  }

  async function refreshOneSourceReadability(source) {
    source.exists = existsSync(source.root);
    source.readable = await isReadableDir(source.root);
    source.watchable = source.exists && source.readable;
  }

  async function readTail(file, maxBytes) {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  }

  function sanitizeExcerpt(value) {
    const home = path.resolve(homeDir());
    return cleanText(value)
      .replaceAll(home, "~")
      .replaceAll(observerBurnHome({}), "<burn-home>")
      .replace(/\/(?:Users|private|var|tmp|home)\/[^\s"'<>]+/g, "<path>")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "***@***")
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "***token***")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
      .replace(/\b(?:ghp|github_pat|glpat|xox[baprs])-[A-Za-z0-9._-]{8,}\b/gi, "***token***")
      .replace(/\b(?:sk|ghp|github_pat|xox[baprs]|claude|codex)_[A-Za-z0-9._-]{12,}\b/gi, "***token***")
      .replace(/\b(token|api[_-]?key|authorization|cookie)\b\s*[:=]\s*["']?[^"',\s]{8,}/gi, "$1=***")
      .slice(0, 240);
  }

  function safePathDisplay(file, label = "path") {
    const resolved = path.resolve(file);
    const home = path.resolve(homeDir());
    const homeRelative = path.relative(home, resolved);
    if (homeRelative && !homeRelative.startsWith("..") && !path.isAbsolute(homeRelative)) {
      return `~/${homeRelative.split(path.sep).join("/")}`;
    }
    const burnHome = observerBurnHome({});
    const burnRelative = path.relative(burnHome, resolved);
    if (burnRelative && !burnRelative.startsWith("..") && !path.isAbsolute(burnRelative)) {
      return `<burn-home>/${burnRelative.split(path.sep).join("/")}`;
    }
    return `<${label}:${stableHash(resolved)}>`;
  }

  function spawnObserverDaemon(options = {}) {
    const args = [
      path.resolve(backendAgentPath),
      "observer",
      "daemon-run",
      "--interval-ms",
      String(daemonIntervalMs(options)),
    ];
    appendDaemonOption(args, "--source", options.source);
    appendDaemonOption(args, "--history-limit", options.historyLimit || options["history-limit"] || options.history_limit);
    appendDaemonOption(args, "--max-files", options.maxFiles || options["max-files"] || options.max_files);
    appendDaemonOption(args, "--max-depth", options.maxDepth || options["max-depth"] || options.max_depth);
    appendDaemonOption(args, "--stability-ms", options.stabilityMs || options["stability-ms"] || options.stability_ms);
    appendDaemonOption(args, "--no-response-ms", options.noResponseMs || options["no-response-ms"] || options.no_response_ms);
    appendDaemonOption(args, "--lease-ms", options.leaseMs || options["lease-ms"] || options.lease_ms);
    appendDaemonOption(args, "--classify-limit", options.classifyLimit || options["classify-limit"] || options.classify_limit);
    appendDaemonOption(args, "--state-path", options.statePath || options["state-path"] || options.state_path);
    args.push("--json");
    const env = {
      ...process.env,
      BURN_APP_HOME: observerBurnHome(options),
    };
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    return child;
  }

  function appendDaemonOption(args, flag, value) {
    const text = cleanText(value);
    if (!text) return;
    args.push(flag, text);
  }

  function watchResponse(options, running, mode, extra = {}) {
    return {
      ok: true,
      schema: OBSERVER_WATCH_SCHEMA,
      generated_at: new Date().toISOString(),
      running,
      mode,
      recommended_cadence_ms: {
        candidate_poll_ms: PERFORMANCE_BUDGET.candidate_poll_ms,
        hot_transcript_poll_ms: PERFORMANCE_BUDGET.hot_transcript_poll_ms,
        new_session_discovery_fallback_poll_ms: PERFORMANCE_BUDGET.new_session_discovery_fallback_poll_ms,
      },
      state_path_display: observerStatePathDisplay(options),
      daemon_path_display: observerDaemonPathDisplay(options),
      ...extra,
    };
  }

  async function persistAbnormalSnapshot(options, snapshot) {
    const dir = abnormalStoreDir(options);
    const latestPath = abnormalLatestPath(options);
    const eventsPath = abnormalEventsPath(options);
    await fs.mkdir(dir, { recursive: true });
    const previous = await readJsonFile(latestPath);
    const previousItems = new Map([
      ...array(previous?.incidents),
      ...array(previous?.candidates),
      ...array(previous?.suppressed),
    ].map((item) => [item.id, item.state]));
    const nextLatest = {
      schema: ABNORMAL_STORE_SCHEMA,
      generated_at: snapshot.generated_at,
      counts: snapshot.counts,
      incidents: snapshot.incidents,
      candidates: snapshot.candidates,
      suppressed: snapshot.suppressed || [],
      source_root_account_model: snapshot.source_root_account_model,
      confirmation: snapshot.confirmation,
    };
    await atomicWriteJson(latestPath, nextLatest);
    const lines = [];
    for (const item of [...snapshot.incidents, ...snapshot.candidates, ...(snapshot.suppressed || [])]) {
      if (previousItems.get(item.id) === item.state) continue;
      lines.push(JSON.stringify({
        schema: "burn.agent.abnormal.event.v1",
        generated_at: snapshot.generated_at,
        kind: item.state === "incident" ? "incident_confirmed" : item.state === "suppressed_recovered" ? "incident_suppressed_recovered" : "candidate_observed",
        item,
      }));
    }
    if (lines.length) await fs.appendFile(eventsPath, `${lines.join("\n")}\n`);
    return abnormalStoragePublic(options, {
      committed: true,
      appended_events: lines.length,
      latest_count: snapshot.incidents.length + snapshot.candidates.length,
      event_store_mib: await eventStoreMiB(options),
    });
  }

  async function readJsonFile(file) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }

  async function readAbnormalLatest(options = {}) {
    const latest = await readJsonFile(abnormalLatestPath(options));
    return latest && latest.schema === ABNORMAL_STORE_SCHEMA ? latest : null;
  }

  async function atomicWriteJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(tmp, file);
  }

  async function eventStoreMiB(options = {}) {
    const files = [abnormalLatestPath(options), abnormalEventsPath(options), observerStatePath(options), observerDaemonPath(options)];
    let bytes = 0;
    for (const file of files) {
      const stat = await fs.stat(file).catch(() => null);
      if (stat) bytes += stat.size;
    }
    return Math.round((bytes / 1024 / 1024) * 1000) / 1000;
  }

  function array(value) {
    return Array.isArray(value) ? value : [];
  }

  function pidAlive(pid) {
    const id = Number(pid || 0);
    if (!id) return false;
    try {
      process.kill(id, 0);
      return true;
    } catch {
      return false;
    }
  }

  function daemonRunning(options, daemon) {
    return Boolean(
      daemonProcessMatches(options, daemon)
      && daemon.status === "running"
      && heartbeatFresh(daemon.last_heartbeat_at, DAEMON_HEARTBEAT_STALE_MS),
    );
  }

  function daemonStarting(options, daemon) {
    return Boolean(
      daemonProcessMatches(options, daemon)
      && daemon.status === "starting"
      && heartbeatFresh(daemon.started_at, DAEMON_HEARTBEAT_STALE_MS),
    );
  }

  function daemonProcessMatches(options, daemon) {
    return Boolean(
      cleanText(daemon?.instance_id)
      && pidAlive(daemon.pid)
      && cleanText(daemon.backend_agent_path_hash) === stableHash(path.resolve(backendAgentPath))
      && cleanText(daemon.burn_home_hash) === stableHash(observerBurnHome(options)),
    );
  }

  function heartbeatFresh(value, staleMs) {
    const time = Date.parse(cleanText(value));
    return Number.isFinite(time) && Date.now() - time <= staleMs;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function rssMiB() {
    return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
  }

  function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
  }

  function dedupePaths(paths) {
    const seen = new Set();
    const out = [];
    for (const item of paths) {
      const resolved = path.resolve(item);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push(resolved);
    }
    return out;
  }

  function pathComponents(file) {
    return path.resolve(file).split(path.sep).filter(Boolean);
  }

  function truthy(value) {
    return value === true || value === "true" || value === "1" || value === 1;
  }

  return {
    abnormalList,
    abnormalScan,
    observerDaemonRun,
    observerDeltasList,
    observerPerf,
    observerSources,
    observerStatus,
    observerWatchStart,
    observerWatchStop,
  };
}
