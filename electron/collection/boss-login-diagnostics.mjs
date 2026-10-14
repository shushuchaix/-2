import { recordDiagnostic } from "../../src/infrastructure/diagnostics/log.mjs";

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
    if (/^\/web\/user\/?$/.test(url.pathname)) return "boss-login-page";
    const match = /^\/wapi\/zppassport\/(?:qrcode|captcha)\/([A-Za-z]+)$/.exec(
      url.pathname,
    );
    return match && stages.get(match[1]);
  } catch {}
}

/** Observe transport stages, never QR payloads, response bodies or login success. */
export function createBossLoginDiagnostics({
  diagnostics,
  webContentsId,
  counts,
  onBudgetExhausted,
}) {
  const requests = new Map(),
    writes = new Set(),
    denied = new Set();
  let closed = false;
  const owned = (details) => !closed && details.webContentsId === webContentsId;
  function write(event) {
    const pending = recordDiagnostic(diagnostics, {
      operation: "network.request",
      sourceId: "boss",
      siteId: "boss",
      endpointKind: "request",
      ...event,
      counts: counts(),
    });
    writes.add(pending);
    pending.finally(() => writes.delete(pending)).catch(() => {});
  }
  function finish(details, failed) {
    if (!owned(details)) return;
    const request = requests.get(details.id);
    if (!request) return;
    requests.delete(details.id);
    write({
      phase: failed ? "transport" : "response",
      outcome: failed ? "failed" : "completed",
      code: failed
        ? details.error === "net::ERR_TIMED_OUT"
          ? "collection_browser_timeout"
          : details.error === "net::ERR_ABORTED"
            ? "collection_cancelled"
            : "collection_login_transport_failed"
        : "collection_login_request_complete",
      method: request.method,
      parser: { version: request.stage },
      durationMs: Math.max(0, Date.now() - request.at),
      ...(!failed &&
      Number.isInteger(details.statusCode) &&
      details.statusCode >= 100 &&
      details.statusCode <= 599
        ? { httpStatus: details.statusCode }
        : {}),
    });
  }
  return {
    started(details) {
      if (!owned(details)) return;
      const stage = loginStage(details.url);
      if (!stage) return;
      const method = ["GET", "POST", "HEAD"].includes(details.method)
        ? details.method
        : "GET";
      if (typeof details.id === "number" || typeof details.id === "string")
        requests.set(details.id, { stage, method, at: Date.now() });
      write({ phase: "started", parser: { version: stage }, method });
    },
    completed: (details) => finish(details, false),
    failed: (details) => finish(details, true),
    denied(details, code, phase = "validation") {
      if (!owned(details)) return;
      const stage = loginStage(details.url) || "boss-login-route";
      const budget = [
        "collection_login_budget_exhausted",
        "collection_login_byte_limit",
      ].includes(code);
      const key = budget ? code : code + ":" + stage;
      if (denied.has(key)) return;
      denied.add(key);
      if (budget) {
        try {
          onBudgetExhausted?.(code);
        } catch {}
        phase = "budget";
      }
      write({ phase, outcome: "failed", code, parser: { version: stage } });
    },
    async close() {
      closed = true;
      requests.clear();
      await Promise.allSettled([...writes]);
    },
  };
}
