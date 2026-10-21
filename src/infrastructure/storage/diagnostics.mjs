import { performance } from "node:perf_hooks";
import { recordDiagnostic } from "../diagnostics/log.mjs";

// These are logical row/JSON and prepared-operation counters, not SQLite scan
// counts or physical disk bytes. Timings retain the row-store phase boundaries.
const counters = {
  statements: "statements",
  prepares: "prepares",
  statementCacheHits: "statementCacheHits",
  rowsRead: "readRows",
  rowsWritten: "writeRows",
  decodedRows: "decodedRows",
  decodedBytes: "readBytes",
  metaRowsRead: "metaReadRows",
  metaDecodedBytes: "metaReadBytes",
  serializedRows: "serializedRows",
  serializedBytes: "writeBytes",
  transactions: "sqlTransactions",
  commits: "sqlCommits",
  rollbacks: "sqlRollbacks",
};
const phaseKeys = [
  "transactionReadMs",
  "transactionStageMs",
  "transactionWriteRowsMs",
  "transactionRefsMs",
  "transactionCommitMs",
  "maintenanceFlattenMs",
  "maintenanceBuildMs",
  "maintenanceWriteRowsMs",
  "maintenanceRefsMs",
  "maintenanceCommitMs",
];
const metricEntries = [
  ...Object.entries(counters),
  ...phaseKeys.map((key) => [key, key]),
];
const controlResources = new Set([
  "control/state.json",
  "control/initialized.json",
]);
const recoveryCodes = new Set(["EPERM", "EACCES", "EBUSY"]);
const elapsed = (start) => Math.max(0, performance.now() - start);
const milliseconds = (value) =>
  Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
const count = (value) => Number.isSafeInteger(value) && value >= 0;
function errorNumber(error) {
  for (
    let current = error, depth = 0;
    current && depth < 3;
    current = current.cause, depth++
  ) {
    if (Number.isSafeInteger(current.errcode)) return current.errcode;
    if (Number.isSafeInteger(current.errorNumber)) return current.errorNumber;
  }
  return undefined;
}

/** Called only at a real storage boundary; preserve the original error object. */
export function tagStorageError(error) {
  try {
    if (
      error &&
      (/^sqlite_/.test(String(error.code)) ||
        error.code === "ERR_SQLITE_ERROR" ||
        /^atomic\./.test(String(error.storageOperation)))
    )
      error.runFatal = true;
  } catch {}
  return error;
}

/** Fixed internal observer. No logger or filesystem work runs in a held fence. */
export function createStorageDiagnostics({ diagnostics, metrics } = {}) {
  const recoveries = new Map();
  const dispatch = (event, error) => {
    if (!diagnostics) return;
    // recordDiagnostic catches synchronous and asynchronous observer failures.
    // Deferral also prevents a synchronous observer from extending the lock.
    setImmediate(() => {
      void recordDiagnostic(diagnostics, event, error);
    });
  };
  const snapshot = () => {
    try {
      return metrics?.();
    } catch {
      return undefined;
    }
  };
  const flushControlRecoveries = () => {
    for (const event of recoveries.values()) dispatch(event);
    recoveries.clear();
  };
  return Object.freeze({
    // Atomic replacement invokes this only after the successful native rename.
    // Two resources x three codes bound this buffer even during maintenance.
    onControlRenameRecovery(event) {
      if (
        !diagnostics ||
        !controlResources.has(event?.resource) ||
        !recoveryCodes.has(event.code) ||
        !count(event.retryCount) ||
        event.retryCount < 1 ||
        event.retryCount > 6 ||
        !count(event.retryDelayMs)
      )
        return;
      const key = event.resource + ":" + event.code;
      const prior = recoveries.get(key);
      recoveries.set(key, {
        operation: "storage.recovered",
        resource: event.resource,
        level: "info",
        phase: "retry",
        outcome: "success",
        code: event.code,
        retryCount: Math.max(prior?.retryCount || 0, event.retryCount),
        retryDelayMs: Math.min(
          Number.MAX_SAFE_INTEGER,
          (prior?.retryDelayMs || 0) + event.retryDelayMs,
        ),
        recoveredWrites: Math.min(
          Number.MAX_SAFE_INTEGER,
          (prior?.recoveredWrites || 0) + 1,
        ),
      });
    },
    flushControlRecoveries,
    startFence() {
      const queuedAt = performance.now();
      const totals = Object.fromEntries(
        [...Object.values(counters), ...phaseKeys].map((key) => [key, 0]),
      );
      let acquiredAt,
        measuring = false,
        storeMs = 0,
        finished = false;
      return Object.freeze({
        acquired() {
          acquiredAt ??= performance.now();
        },
        // Only synchronous core/guard work belongs here. Never span an await:
        // unrelated WAL reads during a control write must not enter this fence.
        measure(action) {
          if (!diagnostics || measuring) return action();
          const before = snapshot(),
            started = performance.now();
          measuring = true;
          try {
            return action();
          } finally {
            storeMs += elapsed(started);
            measuring = false;
            const after = snapshot();
            try {
              if (before && after)
                for (const [source, target] of metricEntries) {
                  const delta = after[source] - before[source];
                  if (Number.isFinite(delta) && delta >= 0)
                    totals[target] += delta;
                }
            } catch {}
          }
        },
        // The owner calls finish only after awaiting inLock, including unlock.
        // It never waits for the observer and never replaces the action's error.
        finish(error) {
          if (finished) return;
          finished = true;
          try {
            flushControlRecoveries();
            const committed =
              totals.sqlCommits > 0 || error?.committed === true;
            const number = errorNumber(error);
            dispatch(
              {
                operation: "storage.transaction",
                resource: controlResources.has(error?.storageResource)
                  ? error.storageResource
                  : "workspace.sqlite",
                phase: "finished",
                ...(controlResources.has(error?.storageResource)
                  ? { failurePhase: "commit" }
                  : {}),
                outcome: error ? (committed ? "partial" : "failed") : "success",
                durationMs: milliseconds(elapsed(queuedAt)),
                queueMs: milliseconds(
                  (acquiredAt ?? performance.now()) - queuedAt,
                ),
                lockMs:
                  acquiredAt === undefined
                    ? 0
                    : milliseconds(elapsed(acquiredAt)),
                // Includes synchronous JavaScript validation/staging/callback work.
                storeMs: milliseconds(storeMs),
                ...Object.fromEntries(
                  Object.entries(totals).map(([key, value]) => [
                    key,
                    phaseKeys.includes(key) ? milliseconds(value) : value,
                  ]),
                ),
                committed,
                ...(error?.code ? { code: error.code } : {}),
                ...(number === undefined ? {} : { errorNumber: number }),
              },
              error,
            );
          } catch {}
        },
      });
    },
  });
}
