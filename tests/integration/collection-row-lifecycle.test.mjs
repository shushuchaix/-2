import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { createCollectionService } from "../../src/application/collection-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

test("one-request activities rotate all four families by admitted physical requests", async (t) => {
  const f = await collectionFixture(t),
    actual = [],
    totals = {};
  const providers = Array.from({ length: 4 }, (_, index) =>
    createPagedProvider({
      id: "family-" + index,
      name: "fixture",
      capabilities: {},
      listPage: async (_site, _query, _page, ctx) => {
        await ctx.request("https://jobs.example.org/" + index);
        actual.push(index);
        return { records: [], hasMore: false };
      },
    }),
  );
  f.service = createCollectionService({
    repository: f.repository,
    operationGate: f.operationGate,
    ledger: f.ledger,
    registry: createSourceRegistry(providers),
    planner: async () => ({
      units: providers.map((provider, index) => ({
        unitId: "unit-" + index,
        sourceId: provider.id,
        siteId: "site-" + index,
        queryIndex: 0,
        site: { siteId: "site-" + index },
        query: { keyword: "fixture" },
      })),
      limits: { maxRequests: 1 },
      hashes: {
        planHash: "p",
        catalogHash: "c",
        queryHash: "q",
        parserVersion: "fixture",
      },
    }),
    requestFactory:
      ({ budget }) =>
      async () => {
        const claim = await budget.claimRequest("list");
        await budget.settleRequest(claim, { bytes: 0 });
        return { status: 200, headers: {}, text: "public list" };
      },
  });
  for (let index = 0; index < 4; index++) {
    const started = await f.service.start({ scope: f.scope }),
      ref = { scope: f.scope, activityId: started.activityId };
    await f.service.wait(ref);
    const usage = await f.ledger.snapshot(ref);
    assert.equal(usage.usedRequests, 1);
    assert.equal(usage.knownPhysicalRequests, 1);
    for (const item of Object.values(usage.bySource)) {
      const value = (totals[item.sourceId] ||= { charged: 0, known: 0 });
      value.charged += item.chargedRequests;
      value.known += item.knownPhysicalRequests;
    }
  }
  assert.deepEqual(actual, [0, 1, 2, 3]);
  assert.deepEqual(
    Object.values(totals),
    Array.from({ length: 4 }, () => ({ charged: 1, known: 1 })),
  );
});

test("pause returns accepted while transport drains, cancel upgrades it, and the shutdown gate is permanent", async (t) => {
  const entered = deferred(),
    response = deferred();
  let observedSignal;
  const provider = createPagedProvider({
    id: "synthetic",
    name: "fixture",
    capabilities: {},
    listPage: async (_s, _q, _p, ctx) => {
      observedSignal = ctx.signal;
      entered.resolve();
      await ctx.request("https://jobs.example.org/list");
      return { records: [], hasMore: false };
    },
  });
  const f = await collectionFixture(t, {
    providers: [provider],
    transport: () => response.promise,
  });
  try {
    const started = await f.service.start({ scope: f.scope }),
      ref = { scope: f.scope, activityId: started.activityId };
    await entered.promise;
    await delay(5);
    let authority;
    await f.service.withActivityContext(ref, (ctx) => {
      authority = ctx;
      return f.ledger.reserveBatch({
        ref,
        token: ctx.token,
        operationLease: ctx.operationLease,
        reservations: [
          {
            reservationId: "drain-browser",
            kind: "browser",
            requestUpperBound: 1,
          },
        ],
      });
    });
    f.repository.metrics({ reset: true });
    const before = performance.now(),
      paused = await f.service.pause(ref);
    const pauseElapsedMs = performance.now() - before;
    assert.ok(
      pauseElapsedMs < 300,
      `pause took ${pauseElapsedMs.toFixed(3)}ms; expected < 300ms`,
    );
    assert.equal(observedSignal.aborted, true);
    assert.equal(paused.accepted, true);
    assert.equal(paused.draining, true);
    assert.equal(paused.collectionProgress.status, "collecting");
    assert.equal(paused.collectionProgress.stopIntent, "pause");
    const cancelled = await f.service.cancel(ref);
    assert.equal(cancelled.collectionProgress.stopIntent, "cancel");
    assert.equal(cancelled.draining, true);
    await assert.rejects(
      f.ledger.reserve({
        ref,
        token: authority.token,
        operationLease: authority.operationLease,
        reservationId: "late-request",
        kind: "list",
        requestUpperBound: 1,
      }),
      { code: "collection_stale_epoch" },
    );
    const settled = await f.ledger.settleBatch({
      ref,
      token: authority.token,
      operationLease: authority.operationLease,
      draining: true,
      settlements: [
        { reservationId: "drain-browser", verifiedUsage: { requests: 1 } },
      ],
    });
    assert.equal(settled.snapshot.knownPhysicalRequests, 1);
    await assert.rejects(
      f.service.resume({ ref, requestId: "still-draining" }),
      {
        code: "collection_draining",
      },
    );
    response.resolve({ status: 200, headers: {}, text: "{}" });
    const final = await f.service.wait(ref);
    assert.equal(final.collectionProgress.status, "cancelled");
    assert.equal(final.collectionProgress.draining, false);
    assert.equal(final.collectionProgress.activeSliceRunId, null);
    const leases = await f.repository.queryRows({
      collection: "operationLeases",
      limit: 200,
    });
    assert.equal(leases.rows.length, 0);
    const metrics = f.repository.metrics();
    assert.equal(metrics.maintenanceReads, 0);
    assert.equal(metrics.maintenanceMutations, 0);
    assert.equal(metrics.maintenanceExports, 0);
    await f.service.stop();
    await assert.rejects(f.service.start({ scope: f.scope }), {
      code: "collection_stopping",
    });
    await assert.rejects(f.service.resume({ ref, requestId: "after-stop" }), {
      code: "collection_stopping",
    });
  } finally {
    // Release transport even when an earlier assertion fails, before fixture
    // cleanup awaits stop/drain. Resolving a settled deferred is harmless.
    response.resolve({ status: 200, headers: {}, text: "{}" });
  }
});

test("collection summaries count over 200 units and distinguish identical site names in different families", async (t) => {
  const f = await collectionFixture(t, {
    planner: (_input, plan) => ({
      ...plan,
      units: Array.from({ length: 250 }, (_, index) => ({
        unitId: "unit-" + index,
        sourceId: index < 125 ? "family-a" : "family-b",
        siteId: "same-site",
        queryIndex: index,
        query: { keyword: "fixture" },
      })),
    }),
  });
  const prepared = await f.service.prepare({ scope: f.scope }),
    ref = { scope: f.scope, activityId: prepared.activityId };
  f.repository.metrics({ reset: true });
  const full = await f.service.listSnapshot({ scope: f.scope });
  assert.equal(full.collections.length, 1);
  assert.equal(full.collections[0].collectionProgress.units, undefined);
  assert.deepEqual(full.collections[0].collectionProgress.unitSummary, {
    totalUnits: 250,
    pendingUnits: 250,
    plannedSites: 2,
    actualSites: 0,
  });
  const detail = await f.service.get(ref);
  assert.equal(Object.keys(detail.collectionProgress.units).length, 200);
  assert.equal(detail.collectionProgress.unitPage.hasMore, true);
  assert.ok(detail.collectionProgress.unitPage.nextCursor);
  const unchanged = await f.service.listSnapshot({
    scope: f.scope,
    afterSeq: full.cursor,
  });
  assert.deepEqual(unchanged, {
    cursor: full.cursor,
    changed: false,
    collections: [],
  });
  const metrics = f.repository.metrics();
  assert.equal(metrics.maintenanceReads, 0);
  assert.equal(metrics.maintenanceExports, 0);
  assert.equal(metrics.rowsWritten, 0);
  await f.service.stop();
});
