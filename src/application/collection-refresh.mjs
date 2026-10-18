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
        if (
          repository.getMeta &&
          (await repository.getMeta("schemaVersion")) === 3
        )
          return tickRows();
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
  async function tickRows() {
    const results = [];
    let packageCursor;
    do {
      const packages = await repository.queryRows({
        collection: "packages",
        where: { kind: "target", status: "active" },
        limit: 200,
        ...(packageCursor ? { afterId: packageCursor } : {}),
      });
      for (const { value: metadata } of packages.rows) {
        const pkg = await repository.getRow(
          { collection: "packages", id: metadata.packageId },
          {
            scope: {
              packageId: metadata.packageId,
              targetRevisionId: metadata.versionId,
            },
          },
        );
        if (!pkg.enabled || !pkg.collectionSettings?.refreshEnabled) continue;
        const scope = {
          packageId: pkg.packageId,
          targetRevisionId: pkg.versionId,
        };
        let rootCursor;
        do {
          const roots = await repository.queryRows(
            {
              collection: "runs",
              ownerPackageId: pkg.packageId,
              where: { kind: "collection_root", status: "paused" },
              limit: 200,
              ...(rootCursor ? { afterId: rootCursor } : {}),
            },
            { scope },
          );
          for (const { value: root } of roots.rows) {
            const p = root.collectionProgress;
            if (
              !p.refreshReady ||
              p.manualPaused ||
              p.activeSliceRunId ||
              p.draining ||
              p.stopIntent
            )
              continue;
            const view = await repository.readView(
              {
                select: [
                  {
                    collection: "activityUnits",
                    ownerPackageId: pkg.packageId,
                    where: {
                      parentId: root.runId,
                      status: { in: ["pending", "page_limited"] },
                      nextDueAt: null,
                    },
                    limit: 1,
                  },
                  {
                    collection: "activityUnits",
                    ownerPackageId: pkg.packageId,
                    where: {
                      parentId: root.runId,
                      status: { in: ["pending", "page_limited"] },
                      nextDueAt: { lte: new Date(clock.now()).toISOString() },
                    },
                    limit: 1,
                  },
                  {
                    collection: "contentBodies",
                    ownerPackageId: pkg.packageId,
                    where: {
                      parentId: root.runId,
                      status: "pending",
                      nextDueAt: { lte: new Date(clock.now()).toISOString() },
                    },
                    limit: 10,
                  },
                ],
              },
              { scope },
            );
            if (
              !Object.keys(view.rows.activityUnits || {}).length &&
              !Object.values(view.rows.contentBodies || {}).some(
                (body) =>
                  !body.riskBlocked &&
                  (body.automaticAttempts || 0) < 3 &&
                  body.record?.retryEligible !== false,
              )
            )
              continue;
            try {
              results.push(
                await service.resume({
                  ref: { activityId: root.runId, scope },
                  requestId: "refresh-" + root.runId + "-" + p.revision,
                  automatic: true,
                }),
              );
            } catch (error) {
              results.push({
                activityId: root.runId,
                code: error.code || "collection_refresh_failed",
              });
            }
          }
          rootCursor = roots.hasMore ? roots.nextCursor : null;
        } while (rootCursor);
      }
      packageCursor = packages.hasMore ? packages.nextCursor : null;
    } while (packageCursor);
    return results;
  }
  return refresh;
}
