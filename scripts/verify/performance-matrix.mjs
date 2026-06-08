#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const runs = boundedInteger(process.env.PANDA_BRIDGE_PERFORMANCE_RUNS, 5, 5, 20);
const evidenceDir = resolve("spec/verification/evidence/performance-matrix");
const realCodex = process.env.PANDA_BRIDGE_REAL_CODEX === "1";

mkdirSync(evidenceDir, { recursive: true });

const results = [];
for (let index = 1; index <= runs; index += 1) {
  console.log(`[performance-matrix] run ${index}/${runs}`);
  const runLabel = String(index).padStart(2, "0");
  const accountEvidenceDir = resolve(evidenceDir, `account-run-${runLabel}`);
  const startedAt = Date.now();
  const result = spawnSync("node", ["scripts/verify/account-password-e2e.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      PANDA_BRIDGE_SKIP_MOBILE: "1",
      PANDA_BRIDGE_ACCOUNT_EVIDENCE_DIR: accountEvidenceDir,
    },
  });
  const durationMs = Date.now() - startedAt;
  const summaryPath = resolve(accountEvidenceDir, "summary.json");
  const summary = existsSync(summaryPath)
    ? JSON.parse(readFileSync(summaryPath, "utf8"))
    : { ok: false, error: "missing account-password-e2e summary" };
  const runSummary = {
    run: index,
    ok: result.status === 0 && summary.ok === true,
    duration_ms: durationMs,
    account_summary: summary,
  };
  results.push(runSummary);
  writeFileSync(resolve(evidenceDir, `run-${runLabel}.json`), JSON.stringify(runSummary, null, 2) + "\n");
  if (existsSync(summaryPath)) copyFileSync(summaryPath, resolve(evidenceDir, `account-summary-${runLabel}.json`));
  const jobEventsPath = resolve(accountEvidenceDir, "job-events.json");
  if (existsSync(jobEventsPath)) copyFileSync(jobEventsPath, resolve(evidenceDir, `job-events-${runLabel}.json`));
}

const okResults = results.filter((item) => item.ok);
const metrics = summarize(okResults.map((item) => ({
  create_job_visible_ms: item.account_summary.create_job_visible_ms,
  remote_reply_ms: item.account_summary.remote_reply_ms,
  queued_to_claimed_ms: item.account_summary.timing?.queued_to_claimed_ms,
  claimed_to_started_ms: item.account_summary.timing?.claimed_to_started_ms,
  started_to_first_delta_ms: item.account_summary.timing?.started_to_first_delta_ms,
  first_delta_to_completed_ms: item.account_summary.timing?.first_delta_to_completed_ms,
  total_job_ms: item.account_summary.timing?.total_job_ms,
  bridge_overhead_to_started_ms: sumFinite(
    item.account_summary.create_job_visible_ms,
    item.account_summary.timing?.queued_to_claimed_ms,
    item.account_summary.timing?.claimed_to_started_ms,
  ),
  progress_event_count: item.account_summary.stream_metrics?.progress_event_count,
  max_progress_gap_ms: item.account_summary.stream_metrics?.max_progress_gap_ms,
  text_delta_count: item.account_summary.stream_metrics?.text_delta_count,
  text_delta_chars: item.account_summary.stream_metrics?.text_delta_chars,
  first_to_last_delta_ms: item.account_summary.stream_metrics?.first_to_last_delta_ms,
  text_delta_gap_p50_ms: item.account_summary.stream_metrics?.text_delta_gap_p50_ms,
  text_delta_gap_p95_ms: item.account_summary.stream_metrics?.text_delta_gap_p95_ms,
  text_delta_gap_max_ms: item.account_summary.stream_metrics?.text_delta_gap_max_ms,
})));
const summary = {
  ok: results.every((item) => item.ok),
  runs,
  passed: okResults.length,
  failed: results.length - okResults.length,
  real_codex: realCodex,
  metrics,
  results: results.map((item) => ({
    run: item.run,
    ok: item.ok,
    duration_ms: item.duration_ms,
    error: item.account_summary.error || null,
    create_job_visible_ms: item.account_summary.create_job_visible_ms || null,
    remote_reply_ms: item.account_summary.remote_reply_ms || null,
    timing: item.account_summary.timing || null,
    stream_metrics: item.account_summary.stream_metrics || null,
    job_event_types: item.account_summary.job_event_types || null,
    job_event_count: item.account_summary.job_event_count || null,
    job_id: item.account_summary.job_id || null,
    device_id: item.account_summary.device_id || null,
    checked_at: item.account_summary.checked_at || null,
  })),
  evidence_dir: evidenceDir,
  checked_at: new Date().toISOString(),
};

writeFileSync(resolve(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));

if (!summary.ok) process.exit(1);

function summarize(rows) {
  const keys = [
    "create_job_visible_ms",
    "remote_reply_ms",
    "queued_to_claimed_ms",
    "claimed_to_started_ms",
    "started_to_first_delta_ms",
    "first_delta_to_completed_ms",
    "total_job_ms",
    "bridge_overhead_to_started_ms",
    "progress_event_count",
    "max_progress_gap_ms",
    "text_delta_count",
    "text_delta_chars",
    "first_to_last_delta_ms",
    "text_delta_gap_p50_ms",
    "text_delta_gap_p95_ms",
    "text_delta_gap_max_ms",
  ];
  const out = {};
  for (const key of keys) {
    const values = rows.map((row) => Number(row[key])).filter(Number.isFinite).sort((a, b) => a - b);
    out[key] = values.length
      ? {
          min: values[0],
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          max: values[values.length - 1],
        }
      : null;
  }
  return out;
}

function sumFinite(...values) {
  if (values.some((value) => !Number.isFinite(Number(value)))) return null;
  return values.reduce((sum, value) => sum + Number(value), 0);
}

function percentile(sorted, value) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1);
  return sorted[index];
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}
