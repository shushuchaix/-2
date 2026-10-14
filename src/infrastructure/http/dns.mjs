import dns from "node:dns/promises";
import { isIP } from "node:net";
import { socketTransport } from "./transport.mjs";
import { isPublicAddress } from "./public-url.mjs";
import { createSourceBudget } from "./budget.mjs";
import { recordDiagnostic } from "../diagnostics/log.mjs";
const publicDnsError = (code) => Object.assign(Error(code), { code });
const transientConnectionCodes = new Set([
  "request_timeout",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
]);
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
    const requestSignal =
      signal && options.signal
        ? AbortSignal.any([signal, options.signal])
        : options.signal || signal;
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
      requestSignal?.throwIfAborted();
      if (mode !== "doh") {
        const system = await lookup(host, { all: true, verbatim: true });
        requestSignal?.throwIfAborted();
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
      const families = new AbortController();
      const familySignal = requestSignal
        ? AbortSignal.any([requestSignal, families.signal])
        : families.signal;
      const queries = ["A", "AAAA"].map(async (type) => {
        const url = new URL("https://cloudflare-dns.com/dns-query");
        url.searchParams.set("name", host);
        url.searchParams.set("type", type);
        let response, reservation;
        // Both fixed endpoints belong to the same HTTPS resolver. Fail over
        // only connection faults; never DNS refusal, certificates or budgets.
        for (const [attempt, address] of ["1.1.1.1", "1.0.0.1"].entries()) {
          familySignal.throwIfAborted();
          reservation = await budget.claimRequest("dns", {
            bytesUpperBound: 65536,
          });
          familySignal.throwIfAborted();
          const timeout = AbortSignal.timeout(5000);
          const combined = AbortSignal.any([familySignal, timeout]);
          try {
            response = await transport({
              url,
              addresses: [{ address, family: 4 }],
              headers: { accept: "application/dns-json" },
              signal: combined,
              maxBytes: 65536,
            });
            combined.throwIfAborted();
            break;
          } catch (error) {
            familySignal.throwIfAborted();
            // Node's HTTPS transport wraps signal timeouts in ABORT_ERR.
            const timedOut =
              (timeout.aborted &&
                (error?.code === "ABORT_ERR" ||
                  error?.name === "AbortError")) ||
              error?.name === "TimeoutError" ||
              error?.cause?.name === "TimeoutError";
            const classified = timedOut
              ? Object.assign(Error("request_timeout"), {
                  name: "TimeoutError",
                  code: "request_timeout",
                })
              : error;
            if (
              attempt !== 0 ||
              !transientConnectionCodes.has(classified?.code)
            )
              throw classified;
            emit({ outcome: "retrying", retryCount: 1, code: classified.code });
          }
        }
        await budget.settleRequest?.(reservation, {
          bytes:
            response.wireByteLength ??
            response.bytes?.byteLength ??
            Buffer.byteLength(response.text || ""),
        });
        if (response.status !== 200)
          throw publicDnsError("public_dns_unavailable");
        let data;
        try {
          data = JSON.parse(response.text);
        } catch {
          throw publicDnsError("public_dns_invalid_response");
        }
        if (
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          !Number.isSafeInteger(data.Status) ||
          data.Status < 0
        )
          throw publicDnsError("public_dns_invalid_response");
        if (data.Status !== 0)
          throw publicDnsError("public_dns_resolution_failed");
        if (
          Object.hasOwn(data, "Answer") &&
          (!Array.isArray(data.Answer) ||
            data.Answer.some(
              (answer) =>
                !answer ||
                typeof answer !== "object" ||
                Array.isArray(answer) ||
                !Number.isSafeInteger(answer.type) ||
                answer.type < 0 ||
                typeof answer.data !== "string" ||
                ([1, 28].includes(answer.type) &&
                  isIP(answer.data) !== (answer.type === 1 ? 4 : 6)),
            ))
        )
          throw publicDnsError("public_dns_invalid_response");
        if (
          (data.Answer || []).some(
            (a) => [1, 28].includes(a.type) && !isPublicAddress(a.data),
          )
        )
          throw publicDnsError("public_dns_non_public");
        return data.Answer || [];
      });
      let responses;
      try {
        responses = await Promise.all(queries);
      } catch (error) {
        // A rejection must not leave the other family sending or settling
        // after the owning collection releases its operation lease.
        families.abort(error);
        await Promise.allSettled(queries);
        throw error;
      }
      const answers = responses.flat().filter((a) => [1, 28].includes(a.type));
      if (!answers.length) throw publicDnsError("public_dns_no_answer");
      if (answers.some((a) => !isPublicAddress(a.data)))
        throw publicDnsError("public_dns_non_public");
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
      const abortedBy = requestSignal?.aborted
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
