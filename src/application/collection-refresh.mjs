export function createCollectionRefresh({
  service,
  repository,
  clock = repository.clock,
  intervalMs = 60000,
  timers = globalThis,
}) {
  let timer = null,
    running = null,
    stopped = true;
  const refresh = {
    async tick() {
      if (running) return running;
      running = (async () => {
        const w = await repository.read(),
          results = [];
        for (const root of Object.values(w.runs).filter(
          (r) => r.collectionRole === "collection_root",
        )) {
          const p = root.collectionProgress,
            pkg = w.packages[root.ownerPackageId];
          if (
            pkg?.state !== "active" ||
            pkg.enabled === false ||
            !pkg.collectionSettings?.refreshEnabled ||
            !p.refreshReady ||
            p.manualPaused ||
            !["paused"].includes(p.status) ||
            p.activeSliceRunId
          )
            continue;
          if (
            !Object.values(p.units).some(
              (u) =>
                u.status !== "completed" &&
                u.status !== "waiting_for_auth" &&
                (!u.nextDueAt ||
                  Date.parse(u.nextDueAt) <= Number(clock.now())),
            ) &&
            !Object.values(p.pendingBodies || {}).some(
              (b) =>
                !b.riskBlocked &&
                b.status !== "waiting_for_auth" &&
                b.status !== "needs_review" &&
                (b.automaticAttempts || 0) < 3 &&
                b.record?.retryEligible !== false &&
                (!b.nextDueAt ||
                  Date.parse(b.nextDueAt) <= Number(clock.now())),
            )
          )
            continue;
          try {
            results.push(
              await service.resume({
                ref: {
                  activityId: root.runId,
                  scope: {
                    packageId: pkg.packageId,
                    targetRevisionId: pkg.versionId,
                  },
                },
                requestId: "refresh-" + root.runId + "-" + p.revision,
                automatic: true,
              }),
            );
          } catch (e) {
            results.push({
              activityId: root.runId,
              code: e.code || "collection_refresh_failed",
            });
          }
        }
        return results;
      })().finally(() => {
        running = null;
      });
      return running;
    },
    start() {
      if (!stopped) return;
      stopped = false;
      const loop = async () => {
        if (stopped) return;
        await refresh.tick().catch(() => {});
        if (!stopped) {
          timer = timers.setTimeout(loop, intervalMs);
          timer?.unref?.();
        }
      };
      timer = timers.setTimeout(loop, intervalMs);
      timer?.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      if (running) await running;
    },
  };
  return refresh;
}
