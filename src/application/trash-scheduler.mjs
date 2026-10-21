import { recordDiagnostic } from "../infrastructure/diagnostics/log.mjs";
export function createTrashScheduler({
  trash,
  purge,
  clock = { now: () => Date.now() },
  timers = { setInterval, clearInterval },
  diagnostics,
}) {
  let timer = null,
    inFlight = null,
    stopped = false;
  const empty = () => ({ completed: [], pending: [], failed: [] });
  const api = {
    start() {
      if (timer !== null) return;
      stopped = false;
      timer = timers.setInterval(() => {
        api.sweep().catch(() => {});
      }, 300000);
      timer?.unref?.();
    },
    sweep() {
      if (stopped) return Promise.resolve(empty());
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const pending = await purge.resumePending();
          if (pending.pending.length) return pending;
          const preview = await trash.preview({ expiredOnly: true });
          if (!preview.candidates.length) return empty();
          return await purge.execute(preview, { reason: "expired" });
        } catch (error) {
          await recordDiagnostic(
            diagnostics,
            {
              operation: "application.recovery",
              stage: "finished",
              phase: "cleanup",
              code:
                typeof error.code === "string" &&
                /^[A-Za-z0-9_-]{1,80}$/.test(error.code)
                  ? error.code
                  : "trash_cleanup_failed",
              outcome: "failed",
            },
            error,
          );
          if (
            [
              "workspace_operation_busy",
              "trash_preview_stale",
              "duplicate_preview_stale",
            ].includes(error.code)
          )
            return { ...empty(), deferred: true, code: error.code };
          throw error;
        }
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        timers.clearInterval(timer);
        timer = null;
      }
      await inFlight;
    },
  };
  return api;
}
