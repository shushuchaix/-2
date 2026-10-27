import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { createCollectionRefresh } from "../../src/application/collection-refresh.mjs";

test("prepare persists one paused owned root without sending; resume spends its original allowance", async (t) => {
  const provider = createPagedProvider({
    id: "synthetic",
    name: "Synthetic",
    capabilities: {},
    listPage: async (_site, _query, _page, ctx) => {
      await ctx.request("https://jobs.example.org");
      return { records: [], hasMore: false };
    },
  });
  const f = await collectionFixture(t, {
    providers: [provider],
    limits: { maxRequests: 1 },
  });
  await f.repository.mutateWorkspace((w) => {
    w.packages[f.scope.packageId].collectionSettings = {
      sourceOverrides: {},
      sessionRefs: {},
      refreshEnabled: true,
    };
  });
  const prepared = await f.service.prepare({
    scope: f.scope,
    options: { mode: "rules", requestId: "prepare-once" },
  });
  const ref = { scope: f.scope, activityId: prepared.activityId };
  assert.equal(f.networkCalls, 0);
  let root = await f.service.get(ref);
  assert.equal(root.collectionProgress.status, "paused");
  assert.equal(root.collectionUsage.usedRequests, 0);
  assert.equal(root.collectionUsage.maxRequests, 1);
  assert.equal(
    root.profileSnapshot.revisionId,
    f.target.profileSnapshot.revisionId,
  );
  const refresh = createCollectionRefresh({
    service: f.service,
    repository: f.repository,
  });
  await refresh.tick();
  await f.service.wait(ref);
  assert.equal(
    f.networkCalls,
    0,
    "preparing a root must also deny background refresh",
  );
  await assert.rejects(f.service.get({ ...ref, scope: f.otherScope }), {
    code: "collection_scope",
  });
  await f.service.resume({ ref, requestId: "first-resume" });
  root = await f.service.wait(ref);
  assert.equal(f.networkCalls, 1);
  assert.equal(root.collectionUsage.usedRequests, 1);
  assert.equal(root.collectionProgress.status, "paused");
  assert.equal(root.collectionProgress.units["unit-0"].committedPages, 1);
  assert.ok(
    Date.parse(root.collectionProgress.units["unit-0"].nextDueAt) >
      f.clock.now(),
  );
  const replay = await f.service.prepare({
    scope: f.scope,
    options: { mode: "rules", requestId: "prepare-once" },
  });
  assert.equal(replay.activityId, ref.activityId);
  assert.equal((await f.service.get(ref)).collectionUsage.usedRequests, 1);
  const roots = Object.values((await f.repository.read()).runs).filter(
    (r) => r.collectionRole === "collection_root",
  );
  assert.equal(roots.length, 1);
});

test("prepare cannot mutate an unowned, disabled or invalid-mode target", async (t) => {
  const f = await collectionFixture(t);
  await assert.rejects(
    f.service.prepare({
      scope: { ...f.scope, targetRevisionId: f.otherScope.targetRevisionId },
    }),
  );
  await assert.rejects(
    f.service.prepare({ scope: f.scope, options: { mode: "invalid" } }),
    { code: "validation_failed" },
  );
  await f.repository.mutateWorkspace((w) => {
    w.packages[f.scope.packageId].enabled = false;
  });
  await assert.rejects(f.service.prepare({ scope: f.scope }), {
    code: "version_disabled",
  });
  assert.equal(Object.values((await f.repository.read()).runs).length, 0);
});

test("prepare replay rejects changed limits even when source and query plan hashes match", async (t) => {
  const limits = { maxRequests: 1, maxDetails: 1, maxCostCny: 0 };
  const f = await collectionFixture(t, { limits });
  const options = { mode: "rules", requestId: "stable-prepare" };
  const first = await f.service.prepare({ scope: f.scope, options });
  limits.maxRequests = 2;
  await assert.rejects(f.service.prepare({ scope: f.scope, options }), {
    code: "collection_prepare_replayed",
  });
  const root = await f.service.get({
    scope: f.scope,
    activityId: first.activityId,
  });
  assert.equal(root.collectionProgress.limits.maxRequests, 1);
  assert.equal(root.collectionUsage.usedRequests, 0);
  assert.equal(f.networkCalls, 0);
  assert.equal(
    Object.values((await f.repository.read()).runs).filter(
      (r) => r.collectionRole === "collection_root",
    ).length,
    1,
  );
});
