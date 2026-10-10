// Templates only: identifiers, search terms, credentials and arbitrary paths never survive.
const fixedV2 = new Set([
  "/diagnostics/logs",
  "/diagnostics/logs/export",
  "/profiles/import-preview",
  "/profiles",
  "/targets",
  "/runs",
  "/collections",
  "/jobs",
  "/jobs/evaluations",
  "/applications/unresolved",
  "/sources",
  "/sources/sites",
  "/settings",
  "/imports",
  "/exports",
  "/workspace/backup",
  "/workspace/restore",
]);
const fixedV1 = new Set([
  "/api/session",
  "/api/health",
  "/api/login",
  "/api/logout",
  "/api/upload",
  "/api/analyze",
  "/api/runs",
  "/api/tracking/summary",
  "/api/tracking/jobs",
]);
const patternsV2 = [
  [
    /^\/collections\/[^/]+\/(pause|resume|cancel|limits)$/,
    (m) => "/collections/:id/" + m[1],
  ],
  [/^\/collections\/[^/]+$/, "/collections/:id"],
  [/^\/profiles\/[^/]+\/revisions\/[^/]+$/, "/profiles/:id/revisions/:id"],
  [/^\/profiles\/[^/]+\/revisions$/, "/profiles/:id/revisions"],
  [/^\/targets\/[^/]+$/, "/targets/:id"],
  [/^\/runs\/[^/]+\/(events|cancel)$/, (m) => "/runs/:id/" + m[1]],
  [/^\/runs\/[^/]+$/, "/runs/:id"],
  [
    /^\/jobs\/[^/]+\/(evaluations|application|links|verify)$/,
    (m) => "/jobs/:id/" + m[1],
  ],
  [/^\/jobs\/[^/]+$/, "/jobs/:id"],
  [/^\/applications\/[^/]+$/, "/applications/:id"],
  [/^\/sources\/sites\/[^/]+$/, "/sources/sites/:id"],
  [
    /^\/sources\/[^/]+\/(probe|settings|service)$/,
    (m) => "/sources/:id/" + m[1],
  ],
];
export function safeApiRoute(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value.startsWith("/api/") ||
    /[\\\u0000-\u001f]/.test(value)
  )
    return "/api/:unknown";
  const pathname = value.split(/[?#]/, 1)[0];
  if (pathname.startsWith("/api/v2/")) {
    const route = pathname.slice(7);
    if (fixedV2.has(route)) return "/api/v2" + route;
    for (const [pattern, replacement] of patternsV2) {
      const match = route.match(pattern);
      if (match)
        return (
          "/api/v2" +
          (typeof replacement === "function" ? replacement(match) : replacement)
        );
    }
  }
  if (fixedV1.has(pathname)) return pathname;
  if (/^\/api\/runs\/[^/]+\/export$/.test(pathname))
    return "/api/runs/:id/export";
  if (/^\/api\/runs\/[^/]+$/.test(pathname)) return "/api/runs/:id";
  if (/^\/api\/tracking\/jobs\/[^/]+$/.test(pathname))
    return "/api/tracking/jobs/:id";
  return "/api/:unknown";
}
