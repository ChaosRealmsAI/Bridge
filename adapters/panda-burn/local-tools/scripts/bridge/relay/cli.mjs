import { execFile, spawn } from "node:child_process";
import { env as processEnv } from "node:process";
import { createInterface } from "node:readline";
import { cleanText, parseJsonObject } from "./utils.mjs";

export function execCommand(command, args, options) {
  const execOptions = optionsWithCommonCliPath(options);
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, args, execOptions, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(stderr.trim() || error.message);
        wrapped.code = error.code;
        wrapped.signal = error.signal;
        wrapped.killed = error.killed;
        return rejectExec(wrapped);
      }
      resolveExec(stdout);
    });
  });
}

export function runCli(context, args, options) {
  context.cliExecutions?.push({
    at: new Date().toISOString(),
    args: args.slice(0, 4),
    cwd: options?.cwd || "",
  });
  return execCommand(context.cli, args, options);
}

export function runCliJsonStream(context, args, options, onProgress) {
  context.cliExecutions?.push({
    at: new Date().toISOString(),
    args: args.slice(0, 5),
    cwd: options?.cwd || "",
    stream: true,
  });
  return new Promise((resolveStream, rejectStream) => {
    const spawnOptions = optionsWithCommonCliPath(options);
    const child = spawn(context.cli, args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options?.onChild?.(child);
    let stderr = "";
    let finalData = null;
    let stdoutTail = "";
    let settled = false;
    let timedOut = false;
    let progressChain = Promise.resolve();
    const timeoutMs = Number(options?.timeout || 0);
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, "SIGTERM");
      }, timeoutMs)
      : null;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      stdoutTail = `${stdoutTail}${trimmed}\n`.slice(-8000);
      let value;
      try {
        value = JSON.parse(trimmed);
      } catch (error) {
        rejectOnce(new Error(`invalid JSONL from burn CLI: ${error.message}; line=${trimmed.slice(0, 400)}`));
        terminateProcessTree(child, "SIGTERM");
        return;
      }
      if (value?.type === "progress" || value?.schema === "burn.agent.turn.event.v1") {
        progressChain = progressChain.then(() => onProgress?.(value));
        return;
      }
      if (value?.type === "final" || value?.schema === "burn.agent.turn.final.v1") {
        finalData = value.data || {};
        return;
      }
      finalData = value;
    });

    child.on("error", rejectOnce);
    child.on("close", async (code, signal) => {
      if (timer) clearTimeout(timer);
      try {
        await progressChain;
      } catch (error) {
        rejectOnce(error);
        return;
      }
      if (settled) return;
      if (timedOut) {
        const error = new Error(stderr.trim() || "burn chat timed out");
        error.code = "ETIMEDOUT";
        error.signal = signal;
        error.killed = true;
        rejectOnce(error);
        return;
      }
      if (options?.wasInterrupted?.()) {
        const error = new Error("agent turn interrupted");
        error.code = "EINTERRUPTED";
        error.signal = signal || "SIGTERM";
        error.killed = true;
        rejectOnce(error);
        return;
      }
      if (code !== 0) {
        const error = new Error(stderr.trim() || stdoutTail.trim() || `burn CLI exited with ${code}`);
        error.code = code;
        error.signal = signal;
        rejectOnce(error);
        return;
      }
      if (!finalData || typeof finalData !== "object") {
        rejectOnce(new Error(stdoutTail.trim() || "burn CLI stream did not emit final JSON"));
        return;
      }
      settled = true;
      resolveStream(finalData);
    });

    function rejectOnce(error) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rejectStream(error);
    }
  });
}

export function optionsWithCommonCliPath(options = {}) {
  const suppliedEnv = options?.env && typeof options.env === "object" ? options.env : {};
  const pathSeed = Object.prototype.hasOwnProperty.call(suppliedEnv, "PATH")
    ? suppliedEnv.PATH
    : processEnv.PATH;
  const inputEnv = { ...processEnv, ...suppliedEnv };
  return {
    ...options,
    env: {
      ...inputEnv,
      PATH: pathWithCommonCliDirs(pathSeed),
    },
  };
}

export function pathWithCommonCliDirs(pathValue) {
  const parts = String(pathValue || "").split(":").filter(Boolean);
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"]) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(":");
}

export function terminateProcessTree(child, signal = "SIGTERM") {
  if (!child || !child.pid) return false;
  let signaled = false;
  try {
    process.kill(-child.pid, signal);
    signaled = true;
  } catch {
    try {
      child.kill(signal);
      signaled = true;
    } catch {
      signaled = false;
    }
  }
  return signaled;
}

export function parseCliError(error, fallbackCode) {
  const raw = cleanText(error?.message || error);
  if (error?.code === "EINTERRUPTED") {
    return {
      code: "chat_interrupted",
      causeCode: cleanText(error?.signal || error?.code || ""),
      message: "agent turn interrupted",
    };
  }
  if (error?.code === "ETIMEDOUT" || error?.killed === true) {
    return {
      code: "chat_timeout",
      causeCode: cleanText(error?.code || error?.signal || ""),
      message: raw.slice(0, 800) || "burn chat timed out",
    };
  }
  const parsed = parseJsonObject(raw);
  if (parsed) {
    const code = cleanText(parsed.code || parsed.error || fallbackCode) || fallbackCode;
    return {
      code,
      causeCode: cleanText(parsed.cause_code || parsed.causeCode || parsed.error || ""),
      message: cleanText(parsed.message || parsed.detail || parsed.error || raw).slice(0, 800),
    };
  }
  return {
    code: fallbackCode,
    causeCode: "",
    message: raw.slice(0, 800),
  };
}
