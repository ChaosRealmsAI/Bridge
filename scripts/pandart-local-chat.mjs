#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import worker from "../apps/cloud-worker/src/index.js";

const args = parseArgs(process.argv.slice(2));
const host = args.host || process.env.HOST || "0.0.0.0";
const preferredPort = Number(args.port || process.env.PORT || 8788);
const domain = args.domain || process.env.PANDART_DOMAIN || "pandart.cc";
const root = resolve("apps/web-chat/public");
const evidenceFile = resolve("spec/verification/evidence/v7-pandart-mobile-local-chat/server-address.json");
const maxPortAttempts = Number(args.maxPortAttempts || 24);
const pendingBackground = new Set();

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
]);

const server = createServer(async (request, response) => {
  try {
    await handle(request, response);
  } catch (error) {
    console.error("[pandart:local] request failed", error?.stack || error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    }
    response.end(JSON.stringify({ error: "pandart_local_server_error" }));
  }
});

const port = await listenWithFallback(server, host, preferredPort, maxPortAttempts);
const address = addressPayload(port);
writeAddressEvidence(address);
printStartup(address);

async function handle(request, response) {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);
  if (requestUrl.pathname === "/__pandart/health") {
    sendJson(response, {
      ok: true,
      product: "Pandart",
      domain,
      mode: "local-memory",
      host,
      port,
      urls: address.urls,
      api_base: requestUrl.origin,
      worker_api: `${requestUrl.origin}/v1`,
      notes: address.notes,
      background_tasks: pendingBackground.size,
      checked_at: new Date().toISOString(),
    });
    return;
  }

  if (requestUrl.pathname.startsWith("/v1/")) {
    await handleWorker(request, response, requestUrl);
    return;
  }

  await handleStatic(requestUrl, response);
}

async function handleWorker(incoming, outgoing, requestUrl) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  if (!headers.get("origin") && !["GET", "HEAD", "OPTIONS"].includes(incoming.method || "GET")) {
    headers.set("origin", requestUrl.origin);
  }

  const init = {
    method: incoming.method,
    headers,
  };
  if (!["GET", "HEAD"].includes(incoming.method || "GET")) {
    init.body = Readable.toWeb(incoming);
    init.duplex = "half";
  }

  const env = localWorkerEnv(requestUrl.origin);
  const workerRequest = new Request(requestUrl.href, init);
  const workerResponse = await worker.fetch(workerRequest, env, localExecutionContext());
  outgoing.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers.entries()));
  if (!workerResponse.body || incoming.method === "HEAD") {
    outgoing.end();
    return;
  }
  Readable.fromWeb(workerResponse.body).pipe(outgoing);
}

async function handleStatic(requestUrl, response) {
  const pathname = requestUrl.pathname === "/" ? "/index.html" : decodeURIComponent(requestUrl.pathname);
  const candidate = resolve(join(root, pathname));
  const sdkFallback = requestUrl.pathname === "/sdk/index.js" ? resolve("packages/sdk/src/index.js") : "";
  const file = candidate.startsWith(root) && existsSync(candidate) ? candidate : sdkFallback;
  if (!file || !existsSync(file)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": types.get(extname(file)) || "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(response);
}

function localWorkerEnv(origin) {
  return {
    BRIDGE_ENV: "pandart-local",
    BRIDGE_LOCAL_MEMORY: "1",
    BRIDGE_WEB_ORIGIN: origin,
    BRIDGE_ALLOWED_ORIGINS: [
      origin,
      "http://127.0.0.1",
      "http://localhost",
      `http://${domain}`,
      `https://${domain}`,
      `https://www.${domain}`,
    ].join(","),
    BRIDGE_PUBLIC_API_BASE: origin,
    BRIDGE_DESKTOP_PROTOCOL: "panda-bridge",
    SESSION_COOKIE_NAME: "pb_session",
    PANDART_DOMAIN: domain,
  };
}

function localExecutionContext() {
  return {
    waitUntil(promise) {
      const guarded = Promise.resolve(promise).catch((error) => {
        console.error("[pandart:local] background task failed", error?.stack || error);
      });
      pendingBackground.add(guarded);
      guarded.finally(() => pendingBackground.delete(guarded));
    },
  };
}

function addressPayload(selectedPort) {
  const lan = lanAddresses().map((ip) => `http://${ip}:${selectedPort}`);
  const local = [
    `http://127.0.0.1:${selectedPort}`,
    `http://localhost:${selectedPort}`,
  ];
  return {
    product: "Pandart",
    domain,
    selected_port: selectedPort,
    bind_host: host,
    urls: {
      local,
      phone_lan: lan,
      health: `http://127.0.0.1:${selectedPort}/__pandart/health`,
      domain_ready: `http://${domain}:${selectedPort}`,
    },
    notes: [
      "phone_lan URLs require the phone and this Mac to be on the same reachable network",
      "domain_ready requires DNS, hosts, or a tunnel to point pandart.cc at this machine",
      "local API runs in Bridge local-memory mode and does not require production credentials",
    ],
    generated_at: new Date().toISOString(),
  };
}

function writeAddressEvidence(payload) {
  mkdirSync(resolve("spec/verification/evidence/v7-pandart-mobile-local-chat"), { recursive: true });
  writeFileSync(evidenceFile, JSON.stringify(payload, null, 2) + "\n");
}

function printStartup(payload) {
  console.log("[pandart:local] Pandart local chat is running");
  console.log(`[pandart:local] local: ${payload.urls.local[0]}`);
  for (const item of payload.urls.phone_lan) console.log(`[pandart:local] phone: ${item}`);
  if (!payload.urls.phone_lan.length) console.log("[pandart:local] phone: no LAN IPv4 detected");
  console.log(`[pandart:local] health: ${payload.urls.health}`);
  console.log(`[pandart:local] domain-ready: ${payload.urls.domain_ready} (requires DNS/hosts/tunnel)`);
  console.log(`[pandart:local] evidence: ${evidenceFile}`);
}

function listenWithFallback(nextServer, nextHost, startPort, attempts) {
  return new Promise((resolveListen, rejectListen) => {
    let attempt = 0;
    const tryListen = () => {
      const nextPort = startPort + attempt;
      const onError = (error) => {
        nextServer.off("listening", onListening);
        if (error.code === "EADDRINUSE" && attempt + 1 < attempts) {
          attempt += 1;
          tryListen();
          return;
        }
        rejectListen(error);
      };
      const onListening = () => {
        nextServer.off("error", onError);
        resolveListen(nextPort);
      };
      nextServer.once("error", onError);
      nextServer.once("listening", onListening);
      nextServer.listen(nextPort, nextHost);
    };
    tryListen();
  });
}

function lanAddresses() {
  const addresses = [];
  for (const items of Object.values(networkInterfaces())) {
    for (const item of items || []) {
      if (item.family !== "IPv4" || item.internal) continue;
      if (item.address.startsWith("169.254.")) continue;
      addresses.push(item.address);
    }
  }
  return [...new Set(addresses)].sort();
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2) + "\n");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
