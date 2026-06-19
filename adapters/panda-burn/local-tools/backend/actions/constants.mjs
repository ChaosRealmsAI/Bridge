import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const backendDir = dirname(fileURLToPath(new URL("../burn-actions.mjs", import.meta.url)));
export const binDir = resolve(backendDir, "bin");
export const devBinDir = resolve(backendDir, "target/debug");
export const defaultCli = resolve(backendDir, "burn");
export const ACTION_VERSION = "burn-action-v1";
export const PHONE_ACTION_VERSION = "burn-phone-action-v1";
