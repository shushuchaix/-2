import { createDiagnosticsLog } from "./log.mjs";

// Bind process identity once; callers cannot accidentally label a backend write
// as a main write. The existing logger still owns sanitization and retention.
export function createHostDiagnostics(options) {
  const sink = createDiagnosticsLog(options);
  const identity = {
    ...(["main", "backend", "web", "cli", "worker"].includes(
      options.runtime?.hostRole,
    )
      ? { hostRole: options.runtime.hostRole }
      : {}),
    ...(/^[a-f0-9]{40}$/.test(options.runtime?.buildId || "")
      ? { buildId: options.runtime.buildId }
      : {}),
  };
  return {
    ...sink,
    record: (event, error) => sink.record({ ...event, ...identity }, error),
    recordFatal: (event, error) =>
      sink.recordFatal({ ...event, ...identity }, error),
  };
}
