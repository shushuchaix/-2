import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createCollectionRefresh } from "../../src/application/collection-refresh.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { job } from "../helpers/fixtures.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { createPurgeService } from "../../src/application/purge-service.mjs";
import fs from "node:fs/promises";
import path from "node:path";
test("pause_and_cancel_reject_late_results_and_restore_does_not_revive_cancel", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  await f.service.pause(c.ref);
  await assert.rejects(
    c.commit({ pageKey: "late", records: [], nextCursor: null, done: true }),
    { code: "collection_stale_epoch" },
  );
  await c.lease.release();
  const archive = await f.trash.archive({ packageId: f.scope.packageId });
  await f.trash.restore({
    packageId: f.scope.packageId,
    archiveId: archive.archiveId,
  });
  assert.equal(
    (await f.service.get(c.ref)).collectionProgress.status,
    "paused",
  );
  await f.service.cancel(c.ref);
  const cancelledArchive = await f.trash.archive({
    packageId: f.scope.packageId,
  });
  await f.trash.restore({
    packageId: f.scope.packageId,
    archiveId: cancelledArchive.archiveId,
  });
  assert.equal(
    (await f.service.get(c.ref)).collectionProgress.status,
    "cancelled",
  );
  await assert.rejects(
    f.service.resume({ ref: c.ref, requestId: "after-cancel" }),
    { code: "collection_terminal" },
  );
});
test("late_evaluation_cannot_write_after_activity_epoch_changes", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  const saved = await c.commit({
    pageKey: "one",
    records: [job()],
    nextCursor: { page: 2 },
    done: false,
  });
  await f.service.pause(c.ref);
  const evaluator = createEvaluationService({
    repository: f.repository,
    operationGate: f.operationGate,
  });
  await assert.rejects(
    evaluator.evaluate({
      scope: f.scope,
      jobIds: saved.jobIds,
      mode: "rules",
      runId: c.token.sliceRunId,
      operationLease: c.lease,
      collectionGuard: { ref: c.ref, token: c.token },
    }),
    { code: "collection_stale_epoch" },
  );
  assert.equal(Object.keys((await f.repository.read()).evaluations).length, 0);
  await c.lease.release();
});
test("restart_never_fetches_and_refresh_does_not_restart_manual_pause_or_create_roots", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  await f.service.pause(c.ref);
  await c.lease.release();
  await f.repository.mutateWorkspace((w) => {
    w.packages[f.scope.packageId].collectionSettings = {
      sourceOverrides: {},
      sessionRefs: {},
      refreshEnabled: true,
    };
  });
  await f.reopen();
  const before = Object.keys((await f.repository.read()).runs).length;
  const refresh = createCollectionRefresh({
    service: f.service,
    repository: f.repository,
    clock: f.clock,
  });
  await refresh.tick();
  assert.equal(f.networkCalls, 0);
  assert.equal(Object.keys((await f.repository.read()).runs).length, before);
  assert.equal(
    (await f.service.get(c.ref)).collectionProgress.status,
    "paused",
  );
  await refresh.stop();
});
test("enabled_refresh_waits_for_due_time_and_reuses_the_same_activity_budget", async (t) => {
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async (_s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return { records: [job()], hasMore: false };
    },
  });
  const f = await collectionFixture(t, { providers: [provider] });
  await f.repository.mutateWorkspace((w) => {
    w.packages[f.scope.packageId].collectionSettings = {
      sourceOverrides: {},
      sessionRefs: {},
      refreshEnabled: true,
    };
  });
  const start = await f.service.start({ scope: f.scope }),
    ref = { scope: f.scope, activityId: start.activityId };
  await f.service.wait(ref);
  assert.equal((await f.service.get(ref)).collectionProgress.status, "paused");
  const refresh = createCollectionRefresh({
    service: f.service,
    repository: f.repository,
    clock: f.clock,
  });
  await refresh.tick();
  assert.equal(f.networkCalls, 1);
  f.clock.advance(86400001);
  await refresh.tick();
  await f.service.wait(ref);
  assert.equal(f.networkCalls, 2);
  assert.equal((await f.ledger.snapshot(ref)).usedRequests, 2);
  assert.equal(
    Object.values((await f.repository.read()).runs).filter(
      (r) => r.collectionRole === "collection_root",
    ).length,
    1,
  );
  await refresh.stop();
});
test("permanent_purge_removes_activity_and_private_evidence_cache_even_when_cleanup_is_pending", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  await f.repository.mutateWorkspace(
    (w) => {
      w.packages[f.scope.packageId].collectionCache = {
        key: { parsedEvidence: { privateText: "synthetic-private-body" } },
      };
    },
    { operationLease: c.lease },
  );
  await f.service.pause(c.ref);
  await c.lease.release();
  await f.trash.archive({ packageId: f.scope.packageId });
  const purge = createPurgeService({
    repository: f.repository,
    trash: f.trash,
    fsAdapter: f.fsAdapter,
  });
  const deleteLease = await f.operationGate.acquire("permanent-delete", {
    packageIds: [f.scope.packageId],
  });
  const preview = await f.trash.preview({ packageIds: [f.scope.packageId] });
  await fs.writeFile(
    path.join(f.dataDir, "workspace.v2.previous.json"),
    JSON.stringify(await f.repository.read()),
  );
  f.armFailure("previous_commit");
  const result = await purge.execute(preview, { operationLease: deleteLease });
  await deleteLease.release();
  assert.deepEqual(result.pending, [f.scope.packageId]);
  const w = await f.repository.read();
  assert.equal(
    Object.values(w.runs).filter((r) => r.ownerPackageId === f.scope.packageId)
      .length,
    0,
  );
  assert.equal(JSON.stringify(w).includes("synthetic-private-body"), false);
  assert.equal(w.packages[f.scope.packageId].collectionCache, undefined);
  await purge.resumePending();
});
