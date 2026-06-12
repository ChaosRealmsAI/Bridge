#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { BridgeError } from "@panda-bridge/sdk";
import { createNotesBridge, defaultApiBase } from "./bridge.mjs";
import { streamChat } from "./chat.mjs";
import { addNote, getNote, listNotes, rmNote } from "./notes.mjs";

const args = process.argv.slice(2);
const command = args.shift() || "help";

try {
  const jar = cookieJar();
  const bridge = createNotesBridge({ apiBase: option("api") || defaultApiBase(), fetch: jar.fetch });
  if (command === "login") await login(bridge.client, jar);
  else if (command === "authorize") await authorize(bridge);
  else if (command === "status") await status(bridge);
  else if (command === "chat") await withReady(bridge, (deviceId) => streamChat(bridge.client, deviceId, args.join(" ")));
  else if (command === "note") await note(bridge);
  else if (command === "fs") await fsCommand(bridge);
  else help();
} catch (error) {
  printError(error);
  process.exitCode = 1;
}

async function login(client, jar) {
  if (args[0] === "--guest") {
    const session = await client.auth.guest(args.slice(1).join(" ") || "Bridge Notes User");
    jar.save();
    console.log(`logged in as ${session.user.display_name || session.user.id}`);
    return;
  }
  const [email, password, ...nameParts] = args;
  if (!email || !password) throw new Error("usage: bridge-notes login <email> <password> [display name]");
  const session = await client.auth.password(email, password, nameParts.join(" "));
  jar.save();
  console.log(`logged in as ${session.user.email || session.user.id}`);
}

async function authorize(bridge) {
  const intent = await bridge.connect();
  console.log(`deep_link: ${intent.deep_link}`);
  console.log(`token: ${intent.token}`);
}

async function status(bridge) {
  const state = await bridge.client.state();
  const account = state.current_account;
  console.log(JSON.stringify({
    ready: state.ready,
    account: account?.account || null,
    authorization: account?.authorization?.status || "missing",
    connected: account?.connected === true,
    device_id: account?.current_device?.id || null,
  }, null, 2));
}

async function note(bridge) {
  const sub = args.shift();
  await withReady(bridge, async (deviceId) => {
    if (sub === "add") {
      const title = args.shift();
      const body = args.join(" ");
      if (!title || !body) throw new Error("usage: bridge-notes note add <title> <body>");
      const { note: item } = await addNote(bridge.client, deviceId, { title, body });
      console.log(`${item.id}\t${item.title}`);
    } else if (sub === "ls") {
      const items = await listNotes(bridge.client, deviceId);
      for (const item of items) console.log(`${item.id}\t${item.updated_at}\t${item.title}`);
    } else if (sub === "get") {
      const item = await getNote(bridge.client, deviceId, args[0]);
      if (!item) throw new Error("note not found");
      console.log(`${item.title}\n${item.body}`);
    } else if (sub === "rm") {
      console.log(JSON.stringify({ deleted: await rmNote(bridge.client, deviceId, args[0]) }));
    } else {
      throw new Error("usage: bridge-notes note add|ls|get|rm");
    }
  });
}

async function fsCommand(bridge) {
  const sub = args.shift();
  if (sub !== "pull" || !args[0]) throw new Error("usage: bridge-notes fs pull <absolute-path>");
  await withReady(bridge, async (deviceId) => {
    const created = await bridge.client.jobs.create({
      kind: "fs.read",
      deviceId,
      input: { path: args[0] },
      requestKey: `bridge-notes-fs-${Date.now()}`,
    });
    let text = "";
    for await (const event of bridge.client.jobs.stream(created.job.id, { deviceId, realtime: false, intervalMs: 500 })) {
      const data = event.payload?.data_base64;
      if (event.type === "chunk" && data) {
        const chunk = Buffer.from(data, "base64").toString("utf8");
        text += chunk;
        process.stdout.write(chunk);
      }
    }
    const final = await bridge.client.jobs.wait(created.job.id, { timeoutMs: 1000, intervalMs: 100 });
    if (final.status !== "succeeded") throw new Error(final.result?.reason || final.result?.error || "fs.read failed");
    if (!text.endsWith("\n")) process.stdout.write("\n");
  });
}

async function withReady(bridge, run) {
  const ready = await bridge.ready({ wait: true });
  if (!ready.ready) {
    const action = ready.action?.kind || "authorize";
    throw new Error(action === "resume_authorization"
      ? "authorization paused; run status and resume in Panda Bridge"
      : action === "wait_for_device"
        ? "desktop is authorized but offline; open Panda Bridge and wait for reconnect"
        : "not authorized; run bridge-notes authorize");
  }
  return run(ready.deviceId);
}

function cookieJar() {
  const file = process.env.BRIDGE_NOTES_SESSION || resolve(homedir(), ".panda-bridge", "bridge-notes-session.json");
  let cookie = "";
  try { cookie = JSON.parse(readFileSync(file, "utf8")).cookie || ""; } catch {}
  return {
    fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers || {});
      headers.set("origin", option("origin") || new URL(url).origin);
      if (cookie) headers.set("cookie", cookie);
      const response = await fetch(url, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return response;
    },
    save: () => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ cookie }, null, 2) + "\n");
    },
  };
}

function option(name) {
  const flag = `--${name}`;
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function printError(error) {
  if (error instanceof BridgeError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    console.error(error.message || String(error));
  }
}

function help() {
  console.log("usage: bridge-notes login|authorize|status|chat|note|fs");
}
