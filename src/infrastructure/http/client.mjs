import { socketTransport } from "./transport.mjs";
import { randomUUID } from "node:crypto";
import { recordDiagnostic } from "../diagnostics/log.mjs";
import { createDnsLookup } from "./dns.mjs";
export { socketTransport } from "./transport.mjs";
import { resolvePublicUrl, validatePublicUrl } from "./public-url.mjs";
import { createSourceBudget } from "./budget.mjs";
import {
  sharedScheduler,
  sharedSocialScheduler,
  isSocialOrigin,
  cancellableSleep,
  abortError,
} from "./scheduler.mjs";
import { createResponseCache } from "./cache.mjs";

const elapsed = (clock, start) => Math.max(0, Math.round(clock.now() - start));
const responseSize = (response) =>
  response.bytes instanceof Uint8Array
    ? response.bytes.byteLength
    : Buffer.byteLength(response.text || "");
const token = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.@-]{1,160}$/.test(value);
function requestContext(defaults, overrides) {
  const context = { ...defaults, ...overrides },
    safe = {};
  for (const key of ["runId", "sourceId", "siteId"])
    if (token(context[key])) safe[key] = context[key];
  for (const key of ["page", "pageLimit", "queryIndex"])
    if (Number.isSafeInteger(context[key]) && context[key] >= 0)
      safe[key] = context[key];
  if (
    ["request", "list", "detail", "search", "dns", "import", "model"].includes(
      context.endpointKind,
    )
  )
    safe.endpointKind = context.endpointKind;
  return safe;
}
function parserMetadata(response) {
  const mime = String(response.headers?.["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const format =
    mime === "application/json" || mime.endsWith("+json")
      ? "json"
      : ["text/html", "application/xhtml+xml"].includes(mime)
        ? "html"
        : mime === "application/pdf"
          ? "pdf"
          : mime ===
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ? "docx"
            : mime.startsWith("text/")
              ? "text"
              : undefined;
  return format ? { parser: { format } } : {};
}
function annotate(error, requestId, phase) {
  if (error && (typeof error === "object" || typeof error === "function")) {
    try {
      error.requestId = requestId;
      error.phase = phase;
    } catch {
      /* Frozen caller errors retain their original behavior. */
    }
  }
  return error;
}
function failureMetadata(error, signal) {
  if (signal?.aborted)
    return {
      outcome: "cancelled",
      abortedBy: "caller",
      code: "request_cancelled",
    };
  if (error?.name === "TimeoutError" || error?.code === "ETIMEDOUT")
    return {
      outcome: "timeout",
      abortedBy: "timeout",
      code: error?.code === "ETIMEDOUT" ? "ETIMEDOUT" : "request_timeout",
    };
  return {
    outcome: "failed",
    ...(token(error?.code) ? { code: error.code } : {}),
  };
}
function diagnosticFailure(error, metadata, requestId, phase) {
  // A caller's signal.reason may carry arbitrary application data. Never send it
  // to an observer; cancellation diagnostics have only a fixed reason and code.
  return metadata.abortedBy
    ? Object.assign(Error(metadata.code), {
        name: metadata.abortedBy === "timeout" ? "TimeoutError" : "AbortError",
        code: metadata.code,
        requestId,
        phase,
      })
    : error;
}

function abortable(promise, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener("abort", abort));
  });
}
export function createRequestClient({
  scheduler = sharedScheduler,
  budget = createSourceBudget(),
  transport = socketTransport,
  dnsLookup,
  cache = createResponseCache(),
  clock = { now: Date.now, sleep: cancellableSleep },
  signal: defaultSignal,
  dnsMode = "auto",
  maxBytes = 4 * 1024 * 1024,
  diagnostics,
  diagnosticContext,
} = {}) {
  dnsLookup ||= createDnsLookup({
    mode: dnsMode,
    budget,
    signal: defaultSignal,
    diagnostics,
    diagnosticContext,
  });
  return async function request(value, options = {}) {
    const started = clock.now(),
      requestId = "q-" + randomUUID();
    const context = requestContext(
      diagnosticContext,
      options.diagnosticContext,
    );
    const maxRetries =
      options.maxRetries === undefined ? 2 : options.maxRetries;
    const timeoutMs = options.timeoutMs ?? 15000;
    const kind = [
      "request",
      "list",
      "detail",
      "search",
      "dns",
      "redirect",
      "retry",
    ].includes(options.kind)
      ? options.kind
      : "request";
    let signal,
      phase = "validation",
      retries = 0,
      redirects = 0,
      attempt = 0;
    let queueMs = 0,
      dnsMs = 0,
      transportMs = 0,
      terminalMetadata = {};
    const emit = (event, error) => {
      // Log writes run outside the scheduler and transport timing. Sink failures
      // are swallowed by recordDiagnostic, including rejected asynchronous sinks.
      void recordDiagnostic(
        diagnostics,
        {
          ...context,
          requestId,
          kind,
          ...(Number.isSafeInteger(maxRetries) &&
          maxRetries >= 0 &&
          maxRetries <= 2
            ? { maxRetries }
            : {}),
          ...(Number.isSafeInteger(timeoutMs) && timeoutMs >= 0
            ? { timeoutMs }
            : {}),
          ...event,
        },
        error,
      );
    };
    const retry = async (delay, response, error) => {
      retries++;
      phase = "retry";
      emit({
        operation: "network.retry",
        phase,
        outcome: "retrying",
        attempt,
        retryCount: retries,
        retryDelayMs: delay,
        ...(response ? { httpStatus: response.status } : {}),
        ...(token(error?.code) ? { code: error.code } : {}),
      });
      await clock.sleep(delay, signal);
    };
    try {
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 2)
        throw Error("Invalid retry limit");
      const responseType = options.responseType ?? "text";
      const byteLimit = options.maxBytes ?? maxBytes;
      if (!["text", "bytes"].includes(responseType))
        throw Error("Invalid response type");
      if (
        !Number.isSafeInteger(byteLimit) ||
        byteLimit < 1 ||
        byteLimit > 20 * 1024 * 1024
      )
        throw Error("Invalid response size limit");
      signal =
        options.signal && defaultSignal
          ? AbortSignal.any([options.signal, defaultSignal])
          : options.signal || defaultSignal;
      signal?.throwIfAborted();
      let url = validatePublicUrl(value);
      for (const key of Object.keys(options.headers || {}))
        if (["host", ":authority"].includes(key.toLowerCase()))
          throw Error("Host override forbidden");
      const cacheKey = options.cacheKey
        ? JSON.stringify([
            url.href,
            options.method || "GET",
            responseType,
            byteLimit,
            options.cacheKey,
          ])
        : null;
      const cached = cacheKey && cache.get(cacheKey);
      if (cached) {
        terminalMetadata = {
          outcome: "cached",
          cacheHit: true,
          httpStatus: cached.status,
          responseBytes: responseSize(cached),
          ...parserMetadata(cached),
        };
        emit({
          operation: "network.cache",
          phase: "cache",
          ...terminalMetadata,
        });
        return { ...cached, requestId };
      }
      let method = options.method || "GET",
        body = options.body,
        headers = { ...options.headers };
      for (;;) {
        phase = "queue";
        signal?.throwIfAborted();
        attempt++;
        const attemptStarted = clock.now();
        let attemptQueueMs = 0,
          attemptDnsMs = 0,
          attemptTransportMs = 0,
          entered = false,
          response;
        const attemptScheduler =
          scheduler === sharedScheduler && isSocialOrigin(url.href)
            ? sharedSocialScheduler
            : scheduler;
        try {
          response = await attemptScheduler.run(
            url.origin,
            async () => {
              entered = true;
              attemptQueueMs = elapsed(clock, attemptStarted);
              queueMs += attemptQueueMs;
              signal?.throwIfAborted();
              const timed = AbortSignal.timeout(timeoutMs);
              const combined = signal
                ? AbortSignal.any([signal, timed])
                : timed;
              phase = "dns";
              const dnsStarted = clock.now();
              let resolved;
              try {
                resolved = await abortable(
                  resolvePublicUrl(url, {
                    dnsLookup: (host, lookupOptions) =>
                      dnsLookup(host, {
                        ...lookupOptions,
                        signal: combined,
                        diagnosticContext: {
                          ...context,
                          requestId,
                          endpointKind: "dns",
                        },
                      }),
                  }),
                  combined,
                );
                combined.throwIfAborted();
              } finally {
                attemptDnsMs = elapsed(clock, dnsStarted);
                dnsMs += attemptDnsMs;
              }
              phase = "budget";
              const requestReservation = await budget.claimRequest(
                redirects
                  ? "redirect"
                  : retries
                    ? "retry"
                    : options.kind || "request",
                { bytesUpperBound: byteLimit },
              );
              phase = "transport";
              const transportStarted = clock.now();
              let result;
              try {
                result = await abortable(
                  transport({
                    ...resolved,
                    method,
                    headers,
                    body,
                    signal: combined,
                    maxBytes: byteLimit,
                    responseType,
                  }),
                  combined,
                );
              } finally {
                attemptTransportMs = elapsed(clock, transportStarted);
                transportMs += attemptTransportMs;
              }
              phase = "response";
              if (responseSize(result) > byteLimit)
                throw Object.assign(Error("Response size limit exceeded"), {
                  code: "response_size_exceeded",
                });
              if (
                responseType === "bytes" &&
                !(result.bytes instanceof Uint8Array)
              )
                throw Object.assign(Error("Binary response missing"), {
                  code: "response_bytes_missing",
                });
              await budget.settleRequest?.(requestReservation, {
                bytes: responseSize(result),
              });
              return {
                ...result,
                url: result.url || url.href,
                requestId,
                headers: Object.fromEntries(
                  Object.entries(result.headers || {}).map(([k, v]) => [
                    k.toLowerCase(),
                    String(v),
                  ]),
                ),
              };
            },
            { signal, minIntervalMs: options.minIntervalMs || 0 },
          );
          emit({
            operation: "network.attempt",
            phase: "response",
            outcome: response.status >= 400 ? "failed" : "success",
            attempt,
            retryCount: retries,
            redirectCount: redirects,
            httpStatus: response.status,
            queueMs: attemptQueueMs,
            dnsMs: attemptDnsMs,
            transportMs: attemptTransportMs,
            durationMs: elapsed(clock, attemptStarted),
            responseBytes: responseSize(response),
            ...parserMetadata(response),
          });
          attemptScheduler.recordOutcome?.(url.origin, {
            status: response.status,
            durationMs: attemptTransportMs,
          });
        } catch (error) {
          if (!entered) {
            attemptQueueMs = elapsed(clock, attemptStarted);
            queueMs += attemptQueueMs;
          }
          const metadata = failureMetadata(error, signal);
          annotate(error, requestId, phase);
          emit(
            {
              operation: "network.attempt",
              phase,
              ...metadata,
              attempt,
              retryCount: retries,
              redirectCount: redirects,
              queueMs: attemptQueueMs,
              dnsMs: attemptDnsMs,
              transportMs: attemptTransportMs,
              durationMs: elapsed(clock, attemptStarted),
              ...(error?.budgetKind ? { budgetKind: error.budgetKind } : {}),
            },
            diagnosticFailure(error, metadata, requestId, phase),
          );
          if (signal?.aborted) throw abortError(signal);
          if (phase === "transport")
            attemptScheduler.recordOutcome?.(url.origin, {
              status: 503,
              durationMs: attemptTransportMs,
            });
          if (
            retries < maxRetries &&
            ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(
              error.code,
            )
          ) {
            await retry(400 * 2 ** retries, null, error);
            continue;
          }
          throw error;
        }
        if (
          [301, 302, 303, 307, 308].includes(response.status) &&
          response.headers.location
        ) {
          phase = "redirect";
          if (++redirects > 3) throw Error("Redirect limit exceeded");
          const next = validatePublicUrl(
            new URL(response.headers.location, url).href,
          );
          if (next.origin !== url.origin) {
            if (body !== undefined && [307, 308].includes(response.status))
              throw Error("Cross-origin body redirect forbidden");
            headers = Object.fromEntries(
              Object.entries(headers).filter(
                ([k]) =>
                  ![
                    "authorization",
                    "cookie",
                    "proxy-authorization",
                    "x-api-key",
                  ].includes(k.toLowerCase()),
              ),
            );
          }
          if (
            response.status === 303 ||
            ([301, 302].includes(response.status) && method === "POST")
          ) {
            method = "GET";
            body = undefined;
          }
          emit({
            operation: "network.redirect",
            phase,
            outcome: "success",
            attempt,
            redirectCount: redirects,
            httpStatus: response.status,
          });
          url = next;
          continue;
        }
        // Server cooldown applies even when this call forbids immediate retries.
        if (response.status === 429 || response.status >= 500) {
          const ra = response.headers["retry-after"];
          const delay = ra
            ? Number.isFinite(Number(ra))
              ? Number(ra) * 1000
              : Date.parse(ra) - clock.now()
            : response.status === 429
              ? 600000
              : null;
          if (delay !== null && Number.isFinite(delay))
            response.nextDueAt = new Date(
              Number(clock.now()) + Math.max(0, delay),
            ).toISOString();
        }
        if (
          (response.status === 429 || response.status >= 500) &&
          retries < maxRetries
        ) {
          const ra = response.headers["retry-after"];
          const delay = ra
            ? Number.isFinite(Number(ra))
              ? Number(ra) * 1000
              : Date.parse(ra) - clock.now()
            : 400 * 2 ** retries;
          const wait = Math.max(0, Number.isFinite(delay) ? delay : 400);
          if (wait > 60000)
            throw Object.assign(Error("Source retry deferred"), {
              code: "source_retry_deferred",
              retryAfterMs: wait,
              nextDueAt: new Date(Number(clock.now()) + wait).toISOString(),
            });
          await retry(wait, response);
          continue;
        }
        if (cacheKey && response.status === 200) cache.set(cacheKey, response);
        terminalMetadata = {
          outcome: response.status >= 400 ? "failed" : "success",
          cacheHit: false,
          httpStatus: response.status,
          responseBytes: responseSize(response),
          ...parserMetadata(response),
        };
        return response;
      }
    } catch (error) {
      const metadata = failureMetadata(error, signal);
      annotate(error, requestId, phase);
      terminalMetadata = {
        ...metadata,
        failurePhase: phase,
        ...(error?.budgetKind ? { budgetKind: error.budgetKind } : {}),
      };
      emit(
        {
          operation: "network.request",
          phase: "finished",
          ...terminalMetadata,
          attempt,
          retryCount: retries,
          redirectCount: redirects,
          queueMs,
          dnsMs,
          transportMs,
          durationMs: elapsed(clock, started),
        },
        diagnosticFailure(error, metadata, requestId, phase),
      );
      throw error;
    } finally {
      if (!terminalMetadata.failurePhase)
        emit({
          operation: "network.request",
          phase: "finished",
          ...terminalMetadata,
          attempt,
          retryCount: retries,
          redirectCount: redirects,
          queueMs,
          dnsMs,
          transportMs,
          durationMs: elapsed(clock, started),
        });
    }
  };
}
