import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const binDir = resolve(backendDir, "bin");
export const devBinDir = resolve(backendDir, "target/debug");

export const IGNORE_DIRS = new Set([
  ".git",
  ".pandacode",
  ".burn",
  ".gradle",
  ".idea",
  ".swiftpm",
  ".build",
  "DerivedData",
  "node_modules",
  "target",
  "build",
  "dist",
  ".next",
  ".turbo",
  ".cache",
  "Pods",
  "evidence",
  "pandacode-result",
]);

export const MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "Package.swift",
  "project.yml",
  "xcodeproj",
];
