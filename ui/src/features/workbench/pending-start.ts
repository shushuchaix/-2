import type { ApiClient, Scope } from "../../lib/types";

type CreatedRun = Record<string, unknown>;
const pendingByClient = new WeakMap<
  ApiClient,
  Map<string, Promise<CreatedRun>>
>();

function scopeKey(scope: Scope) {
  return JSON.stringify([scope.packageId, scope.targetRevisionId]);
}

export function getPendingStart(api: ApiClient, scope: Scope) {
  return pendingByClient.get(api)?.get(scopeKey(scope));
}

export function startRunOnce(
  api: ApiClient,
  scope: Scope,
  body: { mode: "rules" | "ai"; userApiKey?: string },
) {
  let pending = pendingByClient.get(api);
  if (!pending) {
    pending = new Map();
    pendingByClient.set(api, pending);
  }
  const key = scopeKey(scope);
  const existing = pending.get(key);
  if (existing) return existing;

  // A committed mutation can outlive its page. Only the response promise is
  // registered here; temporary keys stay in the request and are never cached.
  let requested: Promise<CreatedRun>;
  try {
    requested = api.request<CreatedRun>("/runs", {
      method: "POST",
      scope,
      body,
    });
  } catch (error) {
    requested = Promise.reject(error);
  }
  const tracked = requested.finally(() => {
    if (pending.get(key) === tracked) pending.delete(key);
  });
  pending.set(key, tracked);
  return tracked;
}
