#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const sdkOut = resolve("apps/web-chat/public/sdk");
mkdirSync(sdkOut, { recursive: true });
copyFileSync(resolve("packages/sdk/src/index.js"), resolve(sdkOut, "index.js"));
console.log("[build-web] copied SDK into apps/web-chat/public/sdk/index.js");
