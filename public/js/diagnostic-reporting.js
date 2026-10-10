function safeException(error) {
  const names = [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "AbortError",
  ];
  const frames = String(error?.stack || "")
    .split("\n")
    .slice(1, 16)
    .flatMap((line) => {
      const match = line
        .replace(/\\/g, "/")
        .match(/(?:public\/js|src|electron)\/[A-Za-z0-9_./-]+:\d+:\d+/);
      return match ? ["at " + match[0]] : [];
    });
  return {
    name: names.includes(error?.name) ? error.name : "Error",
    ...(frames.length ? { stack: "\n" + frames.join("\n") } : {}),
  };
}

export function createDiagnosticReporter({
  desktopBridge = globalThis.desktopBridge,
} = {}) {
  return async (event) => {
    try {
      return await desktopBridge?.reportDiagnostic?.(event);
    } catch {
      return undefined;
    }
  };
}

export function installRendererDiagnostics({
  window = globalThis.window,
  reportDiagnostic,
}) {
  const report = (code, error) => {
    try {
      Promise.resolve(
        reportDiagnostic({
          operation: "renderer.failure",
          phase: "render",
          outcome: "failed",
          code,
          error: safeException(error),
        }),
      ).catch(() => {});
    } catch {
      /* An optional observer must not suppress the original browser error. */
    }
  };
  window.addEventListener("error", (event) =>
    report("renderer_error", event.error),
  );
  window.addEventListener("unhandledrejection", (event) =>
    report("renderer_rejection", event.reason),
  );
  return { reportPageFailure: (error) => report("page_load_failed", error) };
}
