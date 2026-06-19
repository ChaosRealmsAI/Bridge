import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { env } from "node:process";
import { cleanText, projectName } from "./utils.mjs";

export async function resolveAuthorizedProject(value, fallbackRoot = "", authorizedRoots = []) {
  const raw = String(value || ".").trim() || ".";
  let project;
  try {
    project = await realpath(resolve(raw));
  } catch (error) {
    if (fallbackRoot && projectName(fallbackRoot).toLowerCase() === projectName(raw).toLowerCase()) {
      project = fallbackRoot;
    } else {
      throw error;
    }
  }
  const explicitRoots = await resolveAuthorizedRoots(authorizedRoots);
  const fallbackAllowedRoot = explicitRoots.length ? "" : await safeRealpath(fallbackRoot);
  const home = explicitRoots.length || fallbackAllowedRoot || !env.HOME ? "" : await safeRealpath(env.HOME);
  const allowedRoots = explicitRoots.length ? explicitRoots : fallbackAllowedRoot ? [fallbackAllowedRoot] : home ? [home] : [];
  if (allowedRoots.length && !isWithinAuthorizedRoots(project, allowedRoots)) {
    throw localPolicyDenied();
  }
  return project;
}

export async function safeRealpath(path) {
  try {
    return await realpath(resolve(path));
  } catch {
    return "";
  }
}

export function isWithinAuthorizedRoots(path, roots) {
  return roots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

export function authorizedProjectRoots(context) {
  const mirror = context.authorizationMirror || {};
  const roots = authorizationRootValues(mirror);
  if (!roots.length && activeAuthorizationMirrorRequiresLocalRoots(mirror)) {
    throw localPolicyDenied("authorization_roots_required");
  }
  return roots;
}

export function authorizationRootValues(mirror) {
  mirror = mirror || {};
  const policy = mirror.policy || {};
  const productAuthorization = mirror.product_authorization || mirror.productAuthorization || {};
  const policyProductAuthorization = policy.product_authorization || policy.productAuthorization || {};
  const sources = [
    productAuthorization.roots,
    productAuthorization.authorized_roots,
    productAuthorization.authorizedRoots,
    policyProductAuthorization.roots,
    policyProductAuthorization.authorized_roots,
    policyProductAuthorization.authorizedRoots,
    policy.authorized_root,
    policy.workspace_root,
    policy.roots,
    mirror.authorized_root,
    mirror.workspace_root,
    mirror.roots,
  ];
  return flattenRootValues(...sources);
}

export function activeAuthorizationMirrorRequiresLocalRoots(mirror) {
  if (!mirror || typeof mirror !== "object") return false;
  const status = cleanText(mirror.status || "");
  return status === "active" || status === "authorized";
}

function flattenRootValues(...values) {
  const roots = [];
  for (const value of values) {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    for (const item of list) {
      const root = rootPathFromPolicyEntry(item);
      if (root) roots.push(root);
    }
  }
  return roots;
}

export function rootPathFromPolicyEntry(item) {
  if (typeof item === "string") return cleanText(item);
  if (!item || typeof item !== "object") return "";
  return cleanText(
    item.path
    || item.real_path
    || item.realPath
    || item.local_path
    || item.localPath
    || item.root_path
    || item.rootPath
    || item.root,
  );
}

export async function resolveAuthorizedRoots(roots) {
  const resolved = [];
  for (const root of roots) {
    try {
      resolved.push(await realpath(resolve(root)));
    } catch {
      throw localPolicyDenied();
    }
  }
  return [...new Set(resolved)];
}

function localPolicyDenied(message = "local_policy_denied") {
  const error = new Error(message);
  error.code = "local_policy_denied";
  return error;
}
