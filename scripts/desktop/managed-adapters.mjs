import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const bridgeManagedAdapterNodePackages = [
  { name: "@bridge/protocol", source: "packages/protocol" },
  { name: "@bridge/sdk", source: "packages/sdk" },
  { name: "@bridge/adapter-sdk", source: "packages/adapter-sdk" },
];

export function managedAdapterSources(sourceRoot) {
  const resolvedRoot = resolve(sourceRoot);
  if (existsSync(resolve(resolvedRoot, "adapter.manifest.json"))) {
    return [managedAdapterSource(resolvedRoot)];
  }
  return readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(resolvedRoot, entry.name))
    .filter((sourceDir) => existsSync(resolve(sourceDir, "adapter.manifest.json")))
    .map(managedAdapterSource);
}

export function managedAdapterSource(sourceDir) {
  const manifestPath = resolve(sourceDir, "adapter.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const productId = String(manifest.product_id || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(productId)) {
    throw new Error(`managed adapter manifest has invalid product_id: ${manifestPath}`);
  }
  return { sourceDir, productId, manifestPath, manifest };
}

export function prepareManagedAdapterSources(sourceRoot) {
  if (process.env.BRIDGE_SKIP_MANAGED_ADAPTER_PREPARE === "1") return [];
  const prepared = [];
  for (const adapter of managedAdapterSources(sourceRoot)) {
    const pkgPath = resolve(adapter.sourceDir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (!pkg.scripts?.["build:local-tools"]) continue;
    const result = spawnSync("npm", ["--prefix", adapter.sourceDir, "run", "build:local-tools"], {
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) {
      throw new Error(`managed adapter prepare failed for ${adapter.productId}`);
    }
    prepared.push(adapter.productId);
  }
  return prepared;
}

export function copyBridgeManagedAdapterNodeModules(targetRoot, options = {}) {
  const packageRoot = resolve(options.packageRoot || ".");
  const copied = [];
  for (const item of bridgeManagedAdapterNodePackages) {
    const source = resolve(packageRoot, item.source);
    if (!existsSync(source)) {
      throw new Error(`managed adapter dependency package not found: ${source}`);
    }
    const target = managedAdapterPackageTarget(targetRoot, item.name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, {
      recursive: true,
      force: true,
      filter: (sourcePath) => {
        const name = basename(sourcePath);
        return name !== "node_modules" && name !== "test";
      },
    });
    copied.push({ name: item.name, source, target });
  }
  copyAdapterRuntimeDependencies(targetRoot, packageRoot, copied);
  return copied;
}

function copyAdapterRuntimeDependencies(targetRoot, packageRoot, copied) {
  const adaptersDir = resolve(targetRoot, "adapters");
  if (!existsSync(adaptersDir)) return;
  const seen = new Set(copied.map((item) => item.name));
  for (const adapter of managedAdapterSources(adaptersDir)) {
    const pkgPath = resolve(adapter.sourceDir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const name of Object.keys(pkg.dependencies || {})) {
      copyDependencyTree(name, { packageRoot, targetRoot, copied, seen, required: true });
    }
  }
}

function copyDependencyTree(name, context) {
  if (!name || name.startsWith("@bridge/") || context.seen.has(name)) return;
  const source = managedAdapterPackageTarget(context.packageRoot, name);
  if (!existsSync(source)) {
    if (context.required) throw new Error(`managed adapter runtime dependency not installed: ${name}`);
    return;
  }
  const target = managedAdapterPackageTarget(context.targetRoot, name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (sourcePath) => basename(sourcePath) !== "node_modules" && basename(sourcePath) !== "test",
  });
  context.seen.add(name);
  context.copied.push({ name, source, target, adapterRuntimeDependency: true });
  const pkgPath = resolve(source, "package.json");
  if (!existsSync(pkgPath)) return;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  for (const dep of Object.keys(pkg.dependencies || {})) {
    copyDependencyTree(dep, { ...context, required: true });
  }
  for (const dep of Object.keys(pkg.peerDependencies || {})) {
    copyDependencyTree(dep, { ...context, required: false });
  }
  for (const dep of Object.keys(pkg.optionalDependencies || {})) {
    copyDependencyTree(dep, { ...context, required: false });
  }
}

function managedAdapterPackageTarget(targetRoot, packageName) {
  const parts = packageName.split("/");
  return resolve(targetRoot, "node_modules", ...parts);
}
