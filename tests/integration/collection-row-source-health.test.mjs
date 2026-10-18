import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
import { createSourceService } from "../../src/application/source-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { collectionPartId } from "../../src/application/collection-row-access.mjs";
import {
  prepareCollectionPageCommit,
  applyCollectionPageCommit,
  collectionWriteSelectors,
} from "../../src/application/collection-page-commit.mjs";
import { mergeSourceHealth } from "../../src/application/source-health.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { createCollectionService } from "../../src/application/collection-service.mjs";

const emptyResult = {
  jobIds: [],
  newForTarget: [],
  observationIds: [],
  duplicateRelations: [],
};
async function apply(repository, prepared) {
  return repository.transaction(
    {
      select: [
        ...collectionWriteSelectors(prepared.records),
        ...prepared.select,
      ],
    },
    (tx) => {
      applyCollectionPageCommit(tx, prepared);
      for (const row of prepared.records)
        row.remove ? tx.deleteRow(row) : tx.putRow(row);
    },
    { scope: prepared.ref.scope },
  );
}

test("conditional page consumers count 304 transport and preserve fact evidence through 72 hours", async (t) => {
  let parses = 0,
    transports = 0,
    evidenceAt;
  const requested = [];
  const provider = createPagedProvider({
    id: "synthetic",
    name: "fixture",
    capabilities: {},
    listPage: async (_site, _query, _page, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      parses++;
      return {
        records: [
          job({
            siteId: "site-0",
            retrievedAt: evidenceAt,
            description:
              "岗位职责：消防设施维护、安全检查、工程项目巡检与应急演练。任职要求：本科以上学历，整理工程维护记录，执行巡检操作流程。",
            detailStatus: "complete",
            applyUrl: "https://jobs.example.com/apply",
            applicationVerification: {
              status: 200,
              formVerified: true,
              checkedAt: evidenceAt,
            },
          }),
        ],
        hasMore: false,
      };
    },
  });
  const f = await collectionFixture(t);
  evidenceAt = new Date(f.clock.now()).toISOString();
  f.service = createCollectionService({
    repository: f.repository,
    operationGate: f.operationGate,
    ledger: f.ledger,
    registry: createSourceRegistry([provider]),
    planner: async () => ({
      units: [
        {
          unitId: "unit",
          sourceId: "synthetic",
          siteId: "site-0",
          queryIndex: 0,
          site: { siteId: "site-0" },
          query: { keyword: "fixture" },
        },
      ],
      hashes: {
        planHash: "p",
        catalogHash: "c",
        queryHash: "q",
        parserVersion: "fixture",
      },
    }),
    requestFactory:
      ({ budget }) =>
      async (url) => {
        requested.push(url);
        const claim = await budget.claimRequest("list"),
          response =
            ++transports === 1
              ? {
                  status: 200,
                  headers: { etag: '"page-one"' },
                  text: "public list",
                }
              : { status: 304, headers: {}, text: "" };
        await budget.settleRequest(claim, { bytes: 0 });
        return response;
      },
  });
  await f.repository.transaction(
    { select: [{ collection: "packages", ids: [f.scope.packageId] }] },
    (tx) => {
      const pkg = tx.getRow({ collection: "packages", id: f.scope.packageId });
      pkg.collectionSettings = {
        sourceOverrides: {},
        sessionRefs: {},
        refreshEnabled: true,
      };
      tx.putRow({ collection: "packages", id: pkg.packageId, value: pkg });
    },
    { scope: f.scope },
  );
  const started = await f.service.start({ scope: f.scope }),
    ref = { scope: f.scope, activityId: started.activityId };
  await f.service.wait(ref);
  f.clock.advance(71 * 3600000);
  await f.service.resume({ ref, requestId: "cached-one" });
  await f.service.wait(ref);
  let health = await f.repository.getRow({
    collection: "sourceHealth",
    id: "synthetic/site-0",
  });
  assert.equal(health.checkedAt, new Date(f.clock.now()).toISOString());
  assert.equal(health.evidenceCheckedAt, evidenceAt);
  assert.equal(health.lastAttemptAt, health.checkedAt);
  const due = Date.parse(
    (await f.service.get(ref)).collectionProgress.units.unit.nextDueAt,
  );
  f.clock.advance(Math.max(3600000 + 1, due - f.clock.now() + 1));
  await f.service.resume({ ref, requestId: "cached-two" });
  await f.service.wait(ref);
  const observations = await f.repository.queryRows(
    {
      collection: "observations",
      ownerPackageId: f.scope.packageId,
      limit: 20,
    },
    { scope: f.scope },
  );
  assert.ok(observations.rows.length);
  assert.ok(
    observations.rows.every((row) => row.value.observedAt === evidenceAt),
  );
  const ids = [...new Set(observations.rows.map((row) => row.value.jobId))];
  await createEvaluationService({ repository: f.repository }).evaluate({
    scope: f.scope,
    jobIds: ids,
    mode: "rules",
  });
  const snapshot = await f.service.listSnapshot({ scope: f.scope });
  assert.equal(snapshot.collections[0].quality.validNewUnique, 0);
  assert.equal(snapshot.collections[0].quality.applicationAvailable, 0);
  health = await f.repository.getRow({
    collection: "sourceHealth",
    id: "synthetic/site-0",
  });
  assert.equal(health.evidenceCheckedAt, evidenceAt);
  assert.equal(health.checkedAt, new Date(f.clock.now()).toISOString());
  assert.equal(health.capabilities.apply, "unverified");
  assert.equal(parses, 1);
  assert.equal(
    requested.filter((url) => url === "https://jobs.example.org/list").length,
    3,
  );
  assert.equal(
    requested.filter((url) => url === "https://jobs.example.com/apply").length,
    1,
  );
  assert.equal(transports, 4);
  assert.equal((await f.ledger.snapshot(ref)).knownPhysicalRequests, 4);
});

test("source GET reads persisted scoped configuration and never reconstructs observation history", async (t) => {
  const f = await collectionFixture(t),
    provider = fakeProvider({ id: "synthetic" }),
    boss = fakeProvider({ id: "boss" }),
    registry = createSourceRegistry([provider, boss]);
  await f.repository.transaction(
    {
      select: [
        { collection: "sourceHealth", ids: ["synthetic/site"] },
        { collection: "packages", ids: [f.scope.packageId] },
      ],
    },
    (tx) => {
      tx.putRow({
        collection: "sourceHealth",
        id: "synthetic/site",
        value: {
          sourceId: "synthetic",
          siteId: "site",
          status: "ready",
          checkedAt: new Date(f.clock.now()).toISOString(),
        },
      });
      const pkg = tx.getRow({ collection: "packages", id: f.scope.packageId });
      pkg.collectionSettings = {
        sourceOverrides: { synthetic: { enabled: false } },
        sessionRefs: { boss: "fixture-session" },
        refreshEnabled: false,
        sourceVerification: {
          "boss/boss": {
            sourceId: "boss",
            siteId: "boss",
            status: "restricted",
            checkedAt: new Date(f.clock.now()).toISOString(),
          },
        },
      };
      tx.putRow({ collection: "packages", id: pkg.packageId, value: pkg });
    },
    { scope: f.scope },
  );
  const service = createSourceService({
    repository: f.repository,
    registry,
    requestFactory: () => {
      throw Error("No network");
    },
  });
  f.repository.metrics({ reset: true });
  const global = await service.listSources(),
    scoped = await service.listScopedSources({ scope: f.scope }),
    other = await service.listScopedSources({ scope: f.otherScope });
  assert.deepEqual(
    global.find((source) => source.sourceId === "boss").health,
    [],
  );
  assert.equal(
    scoped.find((source) => source.sourceId === "boss").health[0].status,
    "restricted",
  );
  assert.deepEqual(
    other.find((source) => source.sourceId === "boss").health,
    [],
  );
  assert.equal(
    scoped.find((source) => source.sourceId === "synthetic").config.enabled,
    false,
  );
  const metrics = f.repository.metrics();
  assert.equal(metrics.maintenanceReads, 0);
  assert.equal(metrics.maintenanceExports, 0);
  assert.equal(metrics.rowsWritten, 0);
  assert.ok(metrics.decodedRows < 50);
  await f.service.stop();
});

test("page apply rejects a changed content task and does not overwrite a newer public health result", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit(),
    record = job({ retryEligible: true, bodyStatus: "incomplete" });
  const prepared = await prepareCollectionPageCommit(f.repository, {
    ref: c.ref,
    token: c.token,
    unitId: "unit",
    page: {
      pageKey: "task-race",
      records: [record],
      nextCursor: { page: 2 },
      done: false,
    },
    ingestResult: emptyResult,
  });
  const task = prepared.records.find(
    (row) => row.collection === "contentBodies",
  );
  await f.repository.transaction(
    { select: collectionWriteSelectors([task]) },
    (tx) => tx.putRow({ ...task, value: { ...task.value, attempts: 9 } }),
    { scope: f.scope },
  );
  await assert.rejects(apply(f.repository, prepared), {
    code: "collection_queue_conflict",
  });
  assert.equal(
    (
      await f.repository.getRow(
        {
          collection: "contentBodies",
          ownerPackageId: f.scope.packageId,
          id: task.id,
        },
        { scope: f.scope },
      )
    ).attempts,
    9,
  );
  const old = await prepareCollectionPageCommit(f.repository, {
    ref: c.ref,
    token: c.token,
    unitId: "unit",
    page: {
      pageKey: "old-health",
      records: [],
      issues: [{ code: "request_timeout" }],
      nextCursor: null,
      done: true,
    },
    ingestResult: emptyResult,
    now: f.clock.now(),
  });
  f.clock.advance(1000);
  const newer = mergeSourceHealth(
    null,
    {
      sourceId: "synthetic",
      siteId: "s",
      status: "ready",
      sampleCount: 1,
      capabilities: { list: "verified", body: "verified" },
    },
    f.clock.now(),
  );
  await f.repository.transaction(
    { select: [{ collection: "sourceHealth", ids: ["synthetic/s"] }] },
    (tx) =>
      tx.putRow({
        collection: "sourceHealth",
        id: "synthetic/s",
        value: newer,
      }),
    { scope: f.otherScope },
  );
  await apply(f.repository, old);
  const health = await f.repository.getRow({
    collection: "sourceHealth",
    id: "synthetic/s",
  });
  assert.equal(health.status, "ready");
  assert.equal(health.checkedAt, newer.checkedAt);
  const before = await f.repository.getRow(
    {
      collection: "activityUnits",
      id: collectionPartId(
        c.ref.activityId,
        "collectionProgress.units",
        "unit",
      ),
      ownerPackageId: f.scope.packageId,
    },
    { scope: f.scope },
  );
  assert.equal(before.committedPages, 1);
  await f.service.pause(c.ref);
});
