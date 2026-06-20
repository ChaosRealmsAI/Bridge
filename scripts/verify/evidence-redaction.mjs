#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const workspaceRoot = resolve(root, "..");
const scanRoots = [
  "spec/L3/evidence/desktop-ui-smoke",
  "spec/L3/evidence/personal-selfhost-docker-pairing",
  "spec/L4/evidence/bridge-connectivity-selfhost-quality-umbrella",
  "spec/pandacode-workspace/runs/bridge-connectivity-selfhost-quality-umbrella-20260619T231014Z",
];

const textExtensions = new Set([
  ".html",
  ".json",
  ".md",
  ".txt",
  ".log",
  ".csv",
]);

const patterns = [
  {
    id: "raw-email-like",
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    allow: (value) => value === "[redacted-email]",
  },
  {
    id: "bridge-connect-token",
    regex: /\bpbi_[A-Za-z0-9._~-]+/g,
  },
  {
    id: "bridge-device-secret",
    regex: /\bpbd_[A-Za-z0-9._~-]+/g,
  },
  {
    id: "raw-user-home-path",
    regex: /\/Users\/[A-Za-z0-9._-]+(?:\/[^\s"'<>)`]*)?|\/home\/[A-Za-z0-9._-]+(?:\/[^\s"'<>)`]*)?|C:\\Users\\[A-Za-z0-9._-]+(?:\\[^\s"'<>)`]*)?/g,
  },
  {
    id: "contact-profile-url",
    regex: /https:\/\/(?:claudewang\.com|github\.com\/ChaosRealmsAI|x\.com\/WYuxuan60660)[^"'<\s)]*/gi,
  },
  {
    id: "private-non-loopback-ip",
    regex: /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?![\d.])/g,
  },
];

const findings = [];

for (const relRoot of scanRoots) {
  const absRoot = resolve(root, relRoot);
  if (!existsSync(absRoot)) continue;
  for (const file of walk(absRoot)) scanFile(file);
}

if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exit(1);
}

console.log("[evidence-redaction] pass");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* walk(path);
    } else if (stat.isFile() && shouldScan(path)) {
      yield path;
    }
  }
}

function shouldScan(path) {
  const lower = path.toLowerCase();
  for (const ext of textExtensions) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function scanFile(path) {
  const text = normalizeInternalPaths(readFileSync(path, "utf8"));
  const rel = path.slice(root.length + 1);
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      const value = match[0];
      if (pattern.allow && pattern.allow(value, rel)) continue;
      findings.push({
        id: pattern.id,
        path: rel,
        offset: match.index,
        sample: redactSample(value),
      });
      if (findings.length >= 50) return;
    }
  }
}

function normalizeInternalPaths(text) {
  return text.split(workspaceRoot).join("[workspace-root]");
}

function redactSample(value) {
  if (value.includes("@")) return "[raw-email-like]";
  if (value.startsWith("pbi_")) return "pbi_[redacted]";
  if (value.startsWith("pbd_")) return "pbd_[redacted]";
  if (value.includes("/Users/") || value.includes("/home/") || value.includes("C:\\Users\\")) return "[raw-home-path]";
  if (value.startsWith("https://")) return "[contact-url]";
  return value;
}
