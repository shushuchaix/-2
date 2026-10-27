import { createApiClient as createLegacyApiClient } from "../../../public/js/api.js";
import type { ApiClient, RequestOptions, ReadScope } from "./types";
function scopedPath(path: string, scope?: ReadScope): string {
  if (!scope) return path;
  const [route, search = ""] = path.split("?");
  const query = new URLSearchParams(search);
  for (const [key, value] of Object.entries(scope))
    query.set(key, String(value));
  return route + "?" + query;
}
function options(opts: RequestOptions = {}): RequestOptions {
  const { scope, ...rest } = opts;
  if (scope && rest.method && rest.method !== "GET")
    rest.body = { ...((rest.body as Record<string, unknown>) ?? {}), ...scope };
  return rest;
}
type ApiOptions = {
  fetchImpl?: typeof fetch;
  reportDiagnostic?: (event: Record<string, unknown>) => Promise<unknown>;
  now?: () => number;
  onAuthRequired?: () => void;
};
export function createApiClient(config: ApiOptions = {}): ApiClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const client = createLegacyApiClient({
    ...config,
    fetchImpl: (url: RequestInfo | URL, init?: RequestInit) =>
      fetchImpl(
        String(url) === "/api/v2/maintenance" ? "/api/maintenance" : url,
        init,
      ),
  } as unknown as Parameters<typeof createLegacyApiClient>[0]);
  return {
    request: <T>(path: string, opts?: RequestOptions) =>
      client.request(
        scopedPath(path, opts?.scope),
        options(opts),
      ) as Promise<T>,
    download: (path, opts) =>
      client.download(scopedPath(path, opts?.scope), options(opts)),
    async streamRun(runId, opts) {
      // The shared transport retains NDJSON cursors/retries and safe diagnostic reporting.
      const fetchImpl = config.fetchImpl ?? globalThis.fetch;
      const scoped = createLegacyApiClient({
        ...config,
        fetchImpl: (url: RequestInfo | URL, init?: RequestInit) =>
          fetchImpl(scopedPath(String(url), opts.scope), init),
      } as unknown as Parameters<typeof createLegacyApiClient>[0]);
      await scoped.streamRun(runId, opts);
    },
  };
}
