import { guardDesktopSender } from "./credentials.mjs";
import {
  diagnosticError,
  recordDiagnostic,
} from "../src/infrastructure/diagnostics/log.mjs";
import { safeApiRoute } from "../public/js/diagnostic-rules.js";

const operations = new Set([
  "renderer.request",
  "renderer.stream",
  "renderer.failure",
]);
const codes = new Set([
  "network_error",
  "response_format_error",
  "event_format_error",
  "event_size_limit",
  "stream_disconnected",
  "system_error",
  "permission_denied",
  "request_failed",
  "renderer_error",
  "renderer_rejection",
  "page_load_failed",
]);

export function registerDiagnosticIpc({
  ipcMain,
  diagnostics,
  getWindow,
  getOrigin,
  clock = { now: Date.now },
}) {
  let windowStart = clock.now(),
    accepted = 0;
  ipcMain.handle(
    "diagnostics:report",
    guardDesktopSender({ getWindow, getOrigin }, async (report) => {
      if (!report || typeof report !== "object" || Array.isArray(report))
        return undefined;
      try {
        if (Buffer.byteLength(JSON.stringify(report)) > 8192) return undefined;
      } catch {
        return undefined;
      }
      if (!operations.has(report.operation)) return undefined;
      const now = clock.now();
      if (now - windowStart >= 60000) {
        windowStart = now;
        accepted = 0;
      }
      if (accepted >= 20) return undefined;
      accepted++;
      const event = {
        operation: report.operation,
        level: report.outcome === "retrying" ? "warn" : "error",
      };
      for (const key of [
        "requestId",
        "parentDiagnosticId",
        "runId",
        "phase",
        "outcome",
        "method",
        "durationMs",
        "httpStatus",
        "retryCount",
        "retryDelayMs",
      ])
        if (report[key] !== undefined) event[key] = report[key];
      if (report.route) event.route = safeApiRoute(report.route);
      if (codes.has(report.code)) event.code = report.code;
      const error =
        report.error && typeof report.error === "object"
          ? diagnosticError({
              name: report.error.name,
              stack: report.error.stack,
            })
          : undefined;
      const result = await recordDiagnostic(diagnostics, event, error);
      return result?.diagnosticId
        ? { diagnosticId: result.diagnosticId }
        : undefined;
    }),
  );
}

export function attachWindowDiagnostics({ window, diagnostics }) {
  const started = Date.now();
  window.webContents.on("did-fail-load", (_event, errorNumber) => {
    if (errorNumber === -3) return;
    void recordDiagnostic(diagnostics, {
      operation: "desktop.load",
      level: "error",
      phase: "load",
      outcome: "failed",
      code: "page_load_failed",
      errorNumber,
      durationMs: Date.now() - started,
    });
  });
  window.webContents.on("did-finish-load", () => {
    void recordDiagnostic(diagnostics, {
      operation: "desktop.load",
      phase: "load",
      outcome: "success",
      durationMs: Date.now() - started,
    });
  });
  window.webContents.on("preload-error", (_event, _preloadPath, error) => {
    void recordDiagnostic(
      diagnostics,
      {
        operation: "desktop.preload",
        phase: "load",
        outcome: "failed",
        code: "preload_failed",
      },
      error,
    );
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    const reasons = [
      "clean-exit",
      "abnormal-exit",
      "killed",
      "crashed",
      "oom",
      "launch-failed",
      "integrity-failure",
    ];
    void recordDiagnostic(diagnostics, {
      operation: "desktop.renderer",
      level: "error",
      phase: "render",
      outcome: "failed",
      code: reasons.includes(details.reason)
        ? "renderer_" + details.reason.replace(/-/g, "_")
        : "renderer_failed",
      exitCode: details.exitCode,
    });
  });
  window.on("unresponsive", () => {
    void recordDiagnostic(diagnostics, {
      operation: "desktop.renderer",
      level: "warn",
      phase: "render",
      outcome: "timeout",
      code: "renderer_unresponsive",
    });
  });
}
