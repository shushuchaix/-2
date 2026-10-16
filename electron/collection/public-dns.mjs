import { createDnsLookup } from "../../src/infrastructure/http/dns.mjs";
import { resolvePublicUrl } from "../../src/infrastructure/http/public-url.mjs";
import { randomUUID } from "node:crypto";

export function createCollectionPublicResolver({
  ledger,
  ref,
  token,
  operationLease,
  signal,
  diagnostics,
  mode = "auto",
  lookup,
  transport,
  clock,
}) {
  const lifetime = new AbortController(),
    pending = new Set();
  const failures = new Map();
  let lastFailureHost = null;
  const ownedSignal = signal
    ? AbortSignal.any([signal, lifetime.signal])
    : lifetime.signal;
  const dnsLookup = createDnsLookup({
    mode,
    lookup,
    transport,
    signal: ownedSignal,
    diagnostics,
    clock,
    diagnosticContext: { runId: token?.sliceRunId },
    budget: {
      claimRequest: (_kind, { bytesUpperBound }) =>
        ledger.reserve({
          ref,
          token,
          operationLease,
          reservationId: randomUUID(),
          kind: "dns",
          requestUpperBound: 1,
          bytesUpperBound,
        }),
      settleRequest: (reservation, { bytes }) =>
        ledger.settle({
          ref,
          operationLease,
          reservationId: reservation.reservationId,
          verifiedUsage: { requests: 1, bytes },
        }),
    },
  });
  // Assets in this owned window share a DNS lookup while it is in flight.
  // Keep this map local so sessions and their lifetime/budget never mix.
  const lookups = new Map();
  const sharedLookup = (host, options) => {
    if (lookups.has(host)) return lookups.get(host);
    const task = dnsLookup(host, options);
    lookups.set(host, task);
    task.finally(() => lookups.delete(host)).catch(() => {});
    return task;
  };
  const resolver = (value) => {
    const task = (async () => {
      let host;
      try {
        host = new URL(value).hostname;
      } catch {}
      try {
        ownedSignal.throwIfAborted();
        const result = await resolvePublicUrl(value, {
          dnsLookup: sharedLookup,
        });
        ownedSignal.throwIfAborted();
        failures.delete(host);
        if (lastFailureHost === host) lastFailureHost = null;
        return result;
      } catch (error) {
        const codes = [
          "request_timeout",
          "request_cancelled",
          "source_budget_exhausted",
          "collection_login_budget_exhausted",
          "public_dns_unavailable",
          "public_dns_resolution_failed",
          "public_dns_no_answer",
          "public_dns_non_public",
          "public_dns_invalid_response",
          "ENOTFOUND",
          "ETIMEDOUT",
          "ECONNRESET",
          "ECONNREFUSED",
          "ENETUNREACH",
          "EHOSTUNREACH",
          "EPIPE",
          "CERT_HAS_EXPIRED",
          "ERR_TLS_CERT_ALTNAME_INVALID",
        ];
        const lastFailure = {
          code: codes.includes(error?.code)
            ? error.code
            : "public_dns_unavailable",
          name: ["TimeoutError", "AbortError"].includes(error?.name)
            ? error.name
            : "Error",
        };
        if (host) {
          failures.set(host, lastFailure);
          lastFailureHost = host;
        }
        throw error;
      }
    })();
    pending.add(task);
    task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  };
  resolver.lastFailure = (value) => {
    let host = lastFailureHost;
    if (value !== undefined)
      try {
        host = new URL(value).hostname;
      } catch {
        return null;
      }
    const failure = failures.get(host);
    return failure ? { ...failure } : null;
  };
  resolver.close = async () => {
    lifetime.abort(
      Object.assign(Error("collection_cancelled"), {
        code: "collection_cancelled",
      }),
    );
    await Promise.allSettled([...pending]);
  };
  return resolver;
}
