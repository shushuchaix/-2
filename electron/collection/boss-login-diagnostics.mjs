import { recordDiagnostic } from "../../src/infrastructure/diagnostics/log.mjs";
import { randomUUID } from "node:crypto";

const stages = new Map([
  ["getMpCode", "boss-qr-create"],
  ["scanByMp", "boss-qr-scan-wait"],
  ["scan", "boss-qr-scan-wait"],
  ["scanSecond", "boss-qr-scan-wait"],
  ["getSecondKey", "boss-qr-key"],
  ["getHeadImg", "boss-qr-avatar"],
  ["scanLogin", "boss-qr-confirm-wait"],
  ["loginConfirm", "boss-qr-confirm"],
  ["dispatcher", "boss-qr-login-submit"],
]);
function loginStage(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://www.zhipin.com") return;
    if (url.pathname === "/") return "boss-login-landing";
    if (url.pathname === "/web/common/403.html")
      return "boss-login-restricted-landing";
    if (/^\/web\/user\/?$/.test(url.pathname)) return "boss-login-page";
    const match = /^\/wapi\/zppassport\/(?:qrcode|captcha)\/([A-Za-z]+)$/.exec(
      url.pathname,
    );
    return match && stages.get(match[1]);
  } catch {}
}

const elapsed = (at) => Math.max(0, Math.round(performance.now() - at));
const status = (value) =>
  Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
export function classifyCollectionFailure(error) {
  const rawCode = typeof error === "string" ? error : error?.code;
  const code =
    typeof rawCode === "string" && rawCode.startsWith("ERR_")
      ? "net::" + rawCode
      : rawCode;
  if (
    [
      "net::ERR_TIMED_OUT",
      "net::ERR_CONNECTION_TIMED_OUT",
      "collection_browser_timeout",
    ].includes(code)
  )
    return "timeout";
  if (["net::ERR_ABORTED", "collection_cancelled", "ABORT_ERR"].includes(code))
    return "cancelled";
  if (
    [
      "net::ERR_BLOCKED_BY_CLIENT",
      "net::ERR_BLOCKED_BY_ADMINISTRATOR",
      "collection_route_forbidden",
    ].includes(code)
  )
    return "policy";
  if (
    [
      "source_budget_exhausted",
      "collection_login_budget_exhausted",
      "collection_browser_budget_exhausted",
      "collection_login_byte_limit",
    ].includes(code)
  )
    return "budget";
  if (
    typeof code === "string" &&
    /^net::ERR_(?:CONNECTION_[A-Z_]+|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|NETWORK_[A-Z_]+|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|CERT_[A-Z_]+|SSL_[A-Z_]+)$/.test(
      code,
    )
  )
    return "network";
  return "unknown";
}

export function classifyBossBusinessResult(parsed, result, observed = {}) {
  if (parsed.status === "risk_blocked") return "business_risk";
  if (parsed.status === "login_required") return "auth";
  if (parsed.status === "rate_limited") return "rate_limited";
  if (parsed.status === "success") return "success";
  const category = classifyCollectionFailure(result.code);
  if (category !== "unknown") return category;
  if (observed.resultCategory && observed.resultCategory !== "response")
    return observed.resultCategory;
  return status(result.status) ? "unknown" : "response_unobserved";
}

// Fixed categories only: unknown paths, query keys and all values stay private.
function navigationStage(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://www.zhipin.com")
      return "boss-login-external-destination";
    if (url.pathname === "/") {
      if (url.search) return "boss-login-landing-query";
      if (url.hash) return "boss-login-landing-fragment";
    }
    if (/^\/web\/geek\/guide\/?$/.test(url.pathname))
      return "boss-login-profile-setup";
    if (/^\/web\/chat\/recommend\/?$/.test(url.pathname))
      return "boss-login-chat-landing";
    if (url.pathname === "/web/boss/complete/index")
      return "boss-login-employer-setup";
    if (url.pathname === "/web/boss/complete/job")
      return "boss-login-employer-job-setup";
    return loginStage(value) || "boss-login-route";
  } catch {
    return "boss-login-invalid-destination";
  }
}

/** Observe transport stages, never QR payloads, response bodies or login success. */
export function createBossLoginDiagnostics({
  diagnostics,
  webContentsId,
  counts,
  onBudgetExhausted,
  onNavigationDenied,
  operation,
  manual = true,
  activityId,
}) {
  const requests = new Map(),
    redirectParents = new Map(),
    writes = new Set(),
    denied = new Set();
  let closed = false,
    operationRequest;
  const owned = (details) => !closed && details.webContentsId === webContentsId;
  const matchesOperation = (details) => {
    if (!operation || details.method !== operation.method) return false;
    try {
      const url = new URL(details.url),
        expected = new URL(operation.url);
      return (
        url.origin === expected.origin && url.pathname === expected.pathname
      );
    } catch {
      return false;
    }
  };
  function write(event) {
    let observedCounts;
    try {
      observedCounts = counts?.();
    } catch {}
    const pending = recordDiagnostic(diagnostics, {
      operation: "network.request",
      sourceId: "boss",
      siteId: "boss",
      endpointKind: "request",
      activityId,
      ...event,
      counts: observedCounts,
    });
    writes.add(pending);
    pending.finally(() => writes.delete(pending)).catch(() => {});
    return pending;
  }
  function unobserved(request, limited = false) {
    write({
      phase: "cleanup",
      outcome: "partial",
      code: limited
        ? "collection_request_tracking_limited"
        : "collection_response_unobserved",
      resultCategory: "response_unobserved",
      requestId: request.requestId,
      parentRequestId: request.parentRequestId,
      method: request.method,
      requestPurpose: request.purpose,
      endpointKind: request.endpointKind,
      parser: { version: request.stage },
      durationMs: elapsed(request.at),
      ...(request.httpStatus ? { httpStatus: request.httpStatus } : {}),
    });
    request.resultCategory = "response_unobserved";
    request.durationMs = elapsed(request.at);
  }
  function finish(details, failed, redirect = false) {
    if (!owned(details)) return;
    const request = requests.get(details.id);
    if (!request) return;
    requests.delete(details.id);
    request.httpStatus = status(details.statusCode) || request.httpStatus;
    request.resultCategory = failed
      ? classifyCollectionFailure(details.error)
      : request.httpStatus
        ? "response"
        : "response_unobserved";
    request.durationMs = elapsed(request.at);
    if (redirect) {
      if (redirectParents.size >= 64)
        redirectParents.delete(redirectParents.keys().next().value);
      redirectParents.set(details.id, request.requestId);
    } else redirectParents.delete(details.id);
    write({
      phase: failed ? "transport" : redirect ? "redirect" : "response",
      outcome: failed ? "failed" : request.httpStatus ? "completed" : "partial",
      resultCategory: request.resultCategory,
      requestId: request.requestId,
      parentRequestId: request.parentRequestId,
      requestPurpose: request.purpose,
      endpointKind: request.endpointKind,
      code: failed
        ? request.resultCategory === "timeout"
          ? "collection_browser_timeout"
          : request.resultCategory === "cancelled"
            ? "collection_cancelled"
            : manual
              ? "collection_login_transport_failed"
              : "collection_browser_transport_failed"
        : !request.httpStatus
          ? "collection_response_unobserved"
          : manual
            ? "collection_login_request_complete"
            : "collection_browser_request_complete",
      method: request.method,
      parser: { version: request.stage },
      durationMs: request.durationMs,
      ...(request.httpStatus ? { httpStatus: request.httpStatus } : {}),
    });
  }
  return {
    started(details, { ownedOperation = false } = {}) {
      if (!owned(details)) return;
      const matching = ownedOperation && matchesOperation(details);
      const stage = matching
        ? operation.kind === "boss.search"
          ? "boss-search"
          : "boss-detail"
        : loginStage(details.url) ||
          (manual ? "boss-login-resource" : "boss-page-resource");
      const method = ["GET", "POST", "HEAD"].includes(details.method)
        ? details.method
        : "GET";
      if (typeof details.id !== "number" && typeof details.id !== "string")
        return;
      // The policy allows at most 60 requests. Keep this observer bounded even
      // when a platform never sends a corresponding completion callback.
      if (requests.has(details.id)) unobserved(requests.get(details.id));
      else if (requests.size >= 64) {
        const [key, oldest] = requests.entries().next().value;
        requests.delete(key);
        unobserved(oldest, true);
      }
      const request = {
        stage,
        method,
        at: performance.now(),
        requestId: "q-" + randomUUID(),
        parentRequestId: redirectParents.get(details.id),
        nativeId: details.id,
        endpointKind: matching
          ? operation.kind === "boss.search"
            ? "list"
            : "detail"
          : "request",
        purpose: matching
          ? operation.kind === "boss.search"
            ? "list"
            : "detail"
          : /^boss-qr-(?:scan|confirm)-wait$/.test(stage)
            ? "login_poll"
            : loginStage(details.url)
              ? "login"
              : ["mainFrame", "subFrame"].includes(details.resourceType)
                ? "document"
                : ["script", "stylesheet", "font", "image"].includes(
                      details.resourceType,
                    )
                  ? "asset"
                  : "other",
      };
      requests.set(details.id, request);
      redirectParents.delete(details.id);
      if (
        matching ||
        (request.parentRequestId && operationRequest?.nativeId === details.id)
      )
        operationRequest = request;
      write({
        phase: "started",
        parser: { version: stage },
        method,
        requestPurpose: request.purpose,
        endpointKind: request.endpointKind,
        requestId: request.requestId,
        parentRequestId: request.parentRequestId,
      });
    },
    headers(details) {
      if (!owned(details)) return;
      const request = requests.get(details.id);
      if (request)
        request.httpStatus = status(details.statusCode) || request.httpStatus;
    },
    completed: (details) => finish(details, false),
    redirected: (details) => finish(details, false, true),
    failed: (details) => finish(details, true),
    operationMetadata() {
      return operationRequest
        ? {
            requestId: operationRequest.requestId,
            requestPurpose: operationRequest.purpose,
            ...(operationRequest.parentRequestId
              ? { parentRequestId: operationRequest.parentRequestId }
              : {}),
            ...(operationRequest.resultCategory
              ? { resultCategory: operationRequest.resultCategory }
              : {}),
            durationMs:
              operationRequest.durationMs ?? elapsed(operationRequest.at),
          }
        : {};
    },
    denied(details, code, phase = "validation") {
      if (!owned(details)) return;
      const stage =
        phase === "redirect"
          ? navigationStage(details.url)
          : loginStage(details.url) || "boss-login-route";
      const budget = [
        "collection_login_budget_exhausted",
        "collection_login_byte_limit",
      ].includes(code);
      const key = budget ? code : code + ":" + phase + ":" + stage;
      if (denied.has(key)) return;
      denied.add(key);
      if (budget) {
        try {
          onBudgetExhausted?.(code);
        } catch {}
        phase = "budget";
      }
      if (phase === "redirect") {
        try {
          Promise.resolve(onNavigationDenied?.(stage)).catch(() => {});
        } catch {}
      }
      const request = requests.get(details.id);
      write({
        phase,
        outcome: "failed",
        code,
        parser: { version: stage },
        requestPurpose: request?.purpose || "other",
        resultCategory: budget ? "budget" : classifyCollectionFailure(code),
        ...(request ? { requestId: request.requestId } : {}),
      });
    },
    async close() {
      if (closed) return;
      for (const request of requests.values()) unobserved(request);
      closed = true;
      requests.clear();
      redirectParents.clear();
      await Promise.allSettled([...writes]);
    },
  };
}
