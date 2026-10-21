import type { ReadScope } from "../lib/types";
export const pages = [
  "workbench",
  "jobs",
  "applications",
  "profiles",
  "targets",
  "sources",
  "logs",
  "trash",
  "settings",
] as const;
export type Page = (typeof pages)[number];
export type RouteState = {
  page: Page;
  selection: ReadScope | null;
  filters: Record<string, string>;
};
export function parseRoute(hash: string): RouteState {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  const packageId = params.get("packageId"),
    targetRevisionId = params.get("targetRevisionId");
  const selection: ReadScope | null =
    params.get("allTargets") === "true"
      ? { allTargets: true }
      : packageId && targetRevisionId
        ? { packageId, targetRevisionId }
        : null;
  for (const key of ["packageId", "targetRevisionId", "allTargets"])
    params.delete(key);
  return {
    page: pages.includes(path as Page) ? (path as Page) : "workbench",
    selection,
    filters: Object.fromEntries(params),
  };
}
export function buildHash(route: RouteState): string {
  const params = new URLSearchParams(route.filters);
  if (route.selection)
    for (const [key, value] of Object.entries(route.selection))
      params.set(key, String(value));
  return "#/" + route.page + (params.size ? "?" + params : "");
}
