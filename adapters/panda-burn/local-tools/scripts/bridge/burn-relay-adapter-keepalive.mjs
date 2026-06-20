#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { startBurnRelayAdapter } from "./burn-relay-adapter.mjs";
import { createRelayKeyState } from "./relay/crypto.mjs";

const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = Number(portArg?.slice("--port=".length) || process.env.PORT || 60448);
const keyStatePath = process.env.BURN_RELAY_KEY_STATE || join(homedir(), ".bridge", "burn-relay-key-panda-burn.json");
const relayKeyState = await loadOrCreateRelayKeyState(keyStatePath);

const adapter = await startBurnRelayAdapter({
  root: process.cwd(),
  port,
  relayKeyState,
});

console.log(JSON.stringify({
  ok: true,
  url: adapter.url,
  root: adapter.root,
  product_id: "panda-burn",
  key_id: adapter.relayKeyExchange.key_id,
  key_state_path: keyStatePath,
}));

const stop = async () => {
  await adapter.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1000);

async function loadOrCreateRelayKeyState(path) {
  const existing = await readJsonIfPresent(path);
  const state = await createRelayKeyState(existing || {});
  if (!existing) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state.state_jwk, null, 2), { mode: 0o600 });
  }
  return state;
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
