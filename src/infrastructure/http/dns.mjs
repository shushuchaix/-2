import dns from "node:dns/promises";
import { socketTransport } from "./transport.mjs";
import { isPublicAddress } from "./public-url.mjs";
import { createSourceBudget } from "./budget.mjs";
import { recordDiagnostic } from "../diagnostics/log.mjs";
// Auto only replaces proxy Fake-IP answers. All resulting addresses still pass the public guard.
export function createDnsLookup({
  mode = "auto",
  lookup = dns.lookup,
  transport = socketTransport,
  budget = createSourceBudget(),
  signal,
  clock = { now: Date.now },
  diagnostics,
  diagnosticContext,
} = {}) {
  if (!["auto", "system", "doh"].includes(mode))
    throw Error("Invalid DNS mode");
  const cache = new Map();
  return async function (host, options = {}) {
    const started = clock.now(),
      context = { ...diagnosticContext, ...options.diagnosticContext };
    const safe = {};
    for (const key of ["runId", "sourceId", "siteId", "requestId"])
      if (
        typeof context[key] === "string" &&
        /^[A-Za-z0-9_.@-]{1,160}$/.test(context[key])
      )
        safe[key] = context[key];
    for (const key of ["page", "pageLimit", "queryIndex"])
      if (Number.isSafeInteger(context[key]) && context[key] >= 0)
        safe[key] = context[key];
    safe.endpointKind = "dns";
    let resolver = mode === "doh" ? "doh" : "system";
    const emit = (metadata, error) =>
      void recordDiagnostic(
        diagnostics,
        {
          ...safe,
          operation: "network.dns",
          kind: "dns",
          phase: "dns",
          dnsResolver: resolver,
          durationMs: Math.max(0, Math.round(clock.now() - started)),
          ...metadata,
        },
        error,
      );
    try {
      signal?.throwIfAborted();
      if (mode !== "doh") {
        const system = await lookup(host, { all: true, verbatim: true });
        if (
          mode === "system" ||
          !system.length ||
          !system.every((a) => /^198\.(18|19)\./.test(a.address))
        ) {
          emit({ outcome: "success" });
          return system;
        }
        resolver = "fallback";
        emit({ outcome: "partial" });
      }
      const cached = cache.get(host);
      if (cached && cached.expires > clock.now()) {
        resolver = "cache";
        emit({ outcome: "cached", cacheHit: true });
        return structuredClone(cached.addresses);
      }
      resolver = "doh";
      const responses = await Promise.all(
        ["A", "AAAA"].map(async (type) => {
          signal?.throwIfAborted();
          budget.claimRequest("dns");
          const url = new URL("https://cloudflare-dns.com/dns-query");
          url.searchParams.set("name", host);
          url.searchParams.set("type", type);
          const combined = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000);
          const response = await transport({
            url,
            addresses: [{ address: "1.1.1.1", family: 4 }],
            headers: { accept: "application/dns-json" },
            signal: combined,
            maxBytes: 65536,
          });
          if (response.status !== 200) throw Error("Public DNS unavailable");
          const data = JSON.parse(response.text);
          if (data.Status !== 0) throw Error("Public DNS resolution failed");
          return data.Answer || [];
        }),
      );
      const answers = responses.flat().filter((a) => [1, 28].includes(a.type));
      if (!answers.length || answers.some((a) => !isPublicAddress(a.data)))
        throw Error("Non-public DNS address forbidden");
      const addresses = answers.map((a) => ({
        address: a.data,
        family: a.type === 1 ? 4 : 6,
      }));
      cache.set(host, {
        addresses,
        expires:
          clock.now() +
          Math.min(60000, ...answers.map((a) => (a.TTL || 30) * 1000)),
      });
      emit({ outcome: "success", cacheHit: false });
      return structuredClone(addresses);
    } catch (error) {
      const abortedBy = signal?.aborted
        ? "caller"
        : error?.name === "TimeoutError"
          ? "timeout"
          : undefined;
      const code =
        abortedBy === "caller"
          ? "request_cancelled"
          : abortedBy === "timeout"
            ? "request_timeout"
            : error?.code;
      emit(
        {
          outcome:
            abortedBy === "caller"
              ? "cancelled"
              : abortedBy === "timeout"
                ? "timeout"
                : "failed",
          ...(abortedBy ? { abortedBy } : {}),
          ...(typeof code === "string" && /^[A-Za-z0-9_.@-]{1,160}$/.test(code)
            ? { code }
            : {}),
          ...(error?.budgetKind ? { budgetKind: error.budgetKind } : {}),
        },
        abortedBy
          ? Object.assign(Error(code), {
              code,
              name: abortedBy === "timeout" ? "TimeoutError" : "AbortError",
            })
          : error,
      );
      throw error;
    }
  };
}
