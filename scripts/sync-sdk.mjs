#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function syncSdkPublicCopy() {
  const sdkOut = resolve("apps/web-chat/public/sdk");
  mkdirSync(sdkOut, { recursive: true });
  copyFileSync(resolve("packages/sdk/src/index.js"), resolve(sdkOut, "index.js"));
  console.log("[sync-sdk] copied packages/sdk/src/index.js to apps/web-chat/public/sdk/index.js");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncSdkPublicCopy();
}
