#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function syncSdkPublicCopy() {
  const sdkOut = resolve(repoRoot, "apps/web-chat/public/sdk");
  mkdirSync(sdkOut, { recursive: true });
  copyFileSync(resolve(repoRoot, "packages/sdk/src/index.js"), resolve(sdkOut, "index.js"));
  console.log("[sync-sdk] copied packages/sdk/src/index.js to apps/web-chat/public/sdk/index.js");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncSdkPublicCopy();
}
