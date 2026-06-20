#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const versionRef = process.env.BRIDGE_PERF_VERSION_REF || "bridge-connectivity-selfhost-quality-umbrella";
const runId = process.env.BRIDGE_PERF_RUN_ID || "20260619T231014Z";
const outDir = resolve(root, "spec/L4/evidence", versionRef, runId, "performance");
mkdirSync(outDir, { recursive: true });

const commandSamples = Number(process.env.BRIDGE_PERF_COMMAND_SAMPLES || "1");
const curlSamples = Number(process.env.BRIDGE_PERF_CURL_SAMPLES || "5");

const commands = [
  {
    id: "desktop-ui-smoke",
    command: "node",
    args: ["scripts/verify/desktop-ui-smoke.mjs"],
  },
  {
    id: "selfhost-profile",
    command: "node",
    args: ["scripts/verify/selfhost-profile.mjs"],
  },
  {
    id: "relay-backpressure",
    command: "node",
    args: ["scripts/verify/relay-backpressure.mjs"],
  },
];

const endpoints = [
  {
    id: "official-health",
    url: "https://api.bridge.chaos-realms.cc/v1/health",
  },
  {
    id: "official-diagnostics",
    url: "https://api.bridge.chaos-realms.cc/v1/diagnostics",
  },
  {
    id: "test-health",
    url: "https://api-bridge-test.chaos-realms.cc/v1/health",
  },
  {
    id: "test-diagnostics",
    url: "https://api-bridge-test.chaos-realms.cc/v1/diagnostics",
  },
];

const summary = {
  ok: true,
  checked_at: new Date().toISOString(),
  version_ref: versionRef,
  run_id: runId,
  sample_policy: {
    command_samples: commandSamples,
    curl_samples: curlSamples,
    percentile_min_samples: 20,
    percentile_rule: "p50/p95 are omitted unless a measurement group has at least 20 successful samples.",
  },
  commands: [],
  curl: [],
};

for (const item of commands) {
  const samples = [];
  for (let i = 0; i < commandSamples; i += 1) {
    samples.push(await runCommand(item.command, item.args, { id: item.id, sample: i + 1 }));
  }
  summary.commands.push({ id: item.id, samples, stats: stats(samples.filter((sample) => sample.ok).map((sample) => sample.duration_ms)) });
}

for (const item of endpoints) {
  const samples = [];
  for (let i = 0; i < curlSamples; i += 1) {
    samples.push(await runCurl(item.url, { id: item.id, sample: i + 1 }));
  }
  summary.curl.push({ id: item.id, url: item.url, samples, stats: stats(samples.filter((sample) => sample.ok).map((sample) => sample.total_ms)) });
}

summary.ok = summary.commands.every((item) => item.samples.every((sample) => sample.ok))
  && summary.curl.filter((item) => item.id.startsWith("test-")).every((item) => item.samples.every((sample) => sample.ok));

writeFileSync(resolve(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exit(1);

function runCommand(command, args, meta) {
  const started = performance.now();
  return new Promise((resolveSample) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code, signal) => {
      const durationMs = Math.round(performance.now() - started);
      const measurements = extractCommandMeasurements(meta.id, stdout);
      resolveSample({
        ...meta,
        ok: code === 0,
        code,
        signal,
        duration_ms: durationMs,
        ...(measurements ? { measurements } : {}),
        stdout_tail: sanitizeTail(stdout),
        stderr_tail: sanitizeTail(stderr),
      });
    });
  });
}

function extractCommandMeasurements(id, stdout) {
  const parsed = parseStdoutJson(stdout);
  if (!parsed || id !== "selfhost-profile") return null;
  const profile = parsed.profile || {};
  const total = safePositiveNumber(profile.probe_latency_ms);
  const health = safePositiveNumber(profile.health_latency_ms);
  const diagnostics = safePositiveNumber(profile.diagnostics_latency_ms);
  return {
    selected_profile_probe_latency_ms: total,
    selected_profile_health_latency_ms: health,
    selected_profile_diagnostics_latency_ms: diagnostics,
    selected_profile_probe_parallel_compatible: total != null && health != null && diagnostics != null
      ? total <= health + diagnostics
      : null,
  };
}

function parseStdoutJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function safePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

async function runCurl(url, meta) {
  const args = [
    "--noproxy",
    "*",
    "--max-time",
    "12",
    "-sS",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}",
    url,
  ];
  const result = await runCommand("curl", args, meta);
  const line = result.stdout_tail.join("\n").trim();
  const parts = line.split(/\s+/);
  const httpCode = parts[0] || "000";
  const values = parts.slice(1).map((value) => Math.round(Number(value) * 1000));
  return {
    ...meta,
    ok: httpCode.startsWith("2"),
    http_code: httpCode,
    lookup_ms: values[0] ?? null,
    connect_ms: values[1] ?? null,
    tls_ms: values[2] ?? null,
    start_transfer_ms: values[3] ?? null,
    total_ms: values[4] ?? result.duration_ms,
    stderr_tail: result.stderr_tail,
  };
}

function stats(values) {
  if (!values.length) return { count: 0, p50_ms: null, p95_ms: null, average_ms: null, min_ms: null, max_ms: null, percentiles_omitted_reason: "no successful samples" };
  const sorted = [...values].sort((a, b) => a - b);
  const average = Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length);
  const base = {
    count: sorted.length,
    average_ms: average,
    min_ms: sorted[0],
    max_ms: sorted[sorted.length - 1],
  };
  if (sorted.length < 20) {
    return { ...base, p50_ms: null, p95_ms: null, percentiles_omitted_reason: "sample_count_below_20" };
  }
  return { ...base, p50_ms: percentile(sorted, 0.5), p95_ms: percentile(sorted, 0.95) };
}

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function sanitizeTail(value) {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-8)
    .map((line) => line
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
      .replace(/\bpbi_[A-Za-z0-9._~-]+/g, "pbi_[redacted]")
      .replace(/\bpbd_[A-Za-z0-9._~-]+/g, "pbd_[redacted]")
      .replace(/\/Users\/[A-Za-z0-9._-]+/g, "[user-home]"));
}
