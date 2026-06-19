import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, sep } from "node:path";
import { env } from "node:process";

import { binDir, devBinDir } from "./constants.mjs";

export async function safeRealpath(path) {
  try {
    return await realpath(resolve(path));
  } catch {
    return "";
  }
}

export async function safeStat(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export async function safeReaddir(path) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export async function safeReaddirWithTypes(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function isInside(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

export function displayPath(path) {
  const home = env.HOME || "";
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function bin(name) {
  for (const dir of [binDir, devBinDir]) {
    const local = resolve(dir, name);
    if (existsSync(local)) return local;
  }
  return name;
}

export function exec(command, args, options) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) return rejectExec(new Error(stderr.trim() || error.message));
      resolveExec(stdout);
    });
  });
}

export async function git(project, args) {
  return exec("git", args, { cwd: project, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
}
