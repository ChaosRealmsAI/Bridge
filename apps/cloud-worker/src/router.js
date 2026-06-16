export function requestPath(request, normalizePath = defaultNormalizePath) {
  const url = new URL(request.url);
  return {
    url,
    path: normalizePath(url.pathname),
    method: String(request.method || "GET").toUpperCase(),
  };
}

function defaultNormalizePath(pathname) {
  return String(pathname || "/").replace(/\/+$/, "") || "/";
}
