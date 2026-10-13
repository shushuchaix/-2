import { createDnsLookup } from "../../src/infrastructure/http/dns.mjs";
import { resolvePublicUrl } from "../../src/infrastructure/http/public-url.mjs";
import { randomUUID } from "node:crypto";

export function createCollectionPublicResolver({
  ledger, ref, token, operationLease, signal, diagnostics, mode = "auto",
  lookup, transport, clock,
}) {
  const lifetime = new AbortController(), pending = new Set();
  const ownedSignal = signal
    ? AbortSignal.any([signal, lifetime.signal])
    : lifetime.signal;
  const dnsLookup = createDnsLookup({
    mode, lookup, transport, signal: ownedSignal, diagnostics, clock,
    diagnosticContext: { runId: token?.sliceRunId },
    budget: {
      claimRequest: (_kind, { bytesUpperBound }) => ledger.reserve({
        ref, token, operationLease, reservationId: randomUUID(), kind: "dns",
        requestUpperBound: 1, bytesUpperBound,
      }),
      settleRequest: (reservation, { bytes }) => ledger.settle({
        ref, operationLease, reservationId: reservation.reservationId,
        verifiedUsage: { requests: 1, bytes },
      }),
    },
  });
  const resolver = value => {
    const task = (async () => {
      ownedSignal.throwIfAborted();
      const result = await resolvePublicUrl(value, { dnsLookup });
      ownedSignal.throwIfAborted();
      return result;
    })();
    pending.add(task);
    task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  };
  resolver.close = async () => {
    lifetime.abort(Object.assign(Error("collection_cancelled"), { code: "collection_cancelled" }));
    await Promise.allSettled([...pending]);
  };
  return resolver;
}
