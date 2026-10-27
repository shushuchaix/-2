import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { job } from "../helpers/fixtures.mjs";
import { collectionPartRows } from "./collection-contract-rows.mjs";
import { collectionPartId } from "../../src/application/collection-row-access.mjs";
import { createRowCollectionService } from "../../src/application/collection-row-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
test("root announcement queue processes more than five articles across slices and never resets budget", async (t) => {
  let calls = 0;
  const articles = Array.from({ length: 12 }, (_, i) =>
    job({
      siteId: "site-0",
      identityScope: "site-0",
      sourceRecordId: String(i),
      kind: "recruitment_notice",
      title: "单位招聘公告" + i,
      url: "https://jobs.example.com/notice/" + i,
      bodyStatus: "complete",
      intent: "employer_recruitment",
      description:
        "公司现招聘消防岗位" + i + "。消防岗位" + i + "：本科要求。".repeat(5),
    }),
  );
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => ({ records: articles, hasMore: false }),
  });
  const f = await collectionFixture(t, {
    providers: [provider],
    modelFactory: () => ({
      chatJson: async (_system, text) => {
        calls++;
        const title = text.match(/消防岗位\d+/)[0];
        return {
          isRecruiting: true,
          positions: [{ title, requirementsExcerpt: title }],
        };
      },
    }),
  });
  const start = await f.service.start({
      scope: f.scope,
      options: { mode: "ai" },
    }),
    ref = { scope: f.scope, activityId: start.activityId };
  await f.service.wait(ref);
  let root = await f.service.get(ref);
  assert.equal(calls, 10);
  assert.equal((await collectionPartRows(f.repository, ref, "contentArticles", "pendingArticles")).length, 2);
  await f.service.resume({ ref, requestId: "remaining" });
  await f.service.wait(ref);
  root = await f.service.get(ref);
  assert.equal(calls, 12);
  assert.equal(root.collectionProgress.status, "completed");
  assert.equal((await collectionPartRows(f.repository, ref, "articleCache", "articleCache")).length, 12);
  assert.equal((await f.ledger.snapshot(ref)).maxCostCny, 10);
});

for (const scenario of [
  { name: "all private queue types waiting for authentication", statuses: ["waiting_for_auth", "waiting_for_auth", "waiting_for_auth"], expected: "waiting_for_auth" },
  { name: "mixed private queue authentication and pending work", statuses: ["waiting_for_auth", "waiting_for_auth", "pending"], expected: "paused" },
  { name: "no private work despite another owner's authentication queue", statuses: [], expected: "completed", peer: true },
  { name: "mixed blocked unit states", statuses: [], unitStatuses: ["waiting_for_auth", "pending"], expected: "paused" },
  { name: "all risk blocked units awaiting authentication", statuses: [], unitStatuses: ["waiting_for_auth"], expected: "waiting_for_auth" },
]) {
  test("slice completion preserves " + scenario.name, async (t) => {
    const provider = createPagedProvider({
      id: "synthetic", name: "synthetic", capabilities: {},
      listPage: async () => ({ records: [job({ description: null, bodyStatus: "incomplete", retryEligible: true })], hasMore: false }),
      detail: async record => ({ ...record, bodyStatus: "challenge_required", retryEligible: true }),
    });
    const f = await collectionFixture(t, { providers: [provider] });
    if (scenario.peer) {
      const peer = await f.service.start({ scope: f.otherScope });
      await f.service.wait({ scope: f.otherScope, activityId: peer.activityId });
    }
    const started = await f.service.start({ scope: f.scope }), ref = { scope: f.scope, activityId: started.activityId };
    await f.service.wait(ref);
    const body = (await collectionPartRows(f.repository, ref, "contentBodies", "pendingBodies"))[0];
    const unit = (await collectionPartRows(f.repository, ref, "activityUnits", "units"))[0];
    const parts = [["contentBodies", "pendingBodies"], ["contentLinks", "pendingOfficialLinks"], ["contentArticles", "pendingArticles"]];
    const rows = scenario.statuses.map((status, index) => {
      const [collection, part] = parts[index];
      return { collection, id: collectionPartId(ref.activityId, "collectionProgress." + part, "auth-" + index), ownerPackageId: f.scope.packageId,
        runId: ref.activityId, targetRevisionId: f.scope.targetRevisionId,
        parent: { collection: "runs", id: ref.activityId, path: "collectionProgress." + part },
        value: { ...body.value, status, riskBlocked: true } };
    });
    for (const [index, status] of (scenario.unitStatuses || []).entries()) rows.push({
      collection: "activityUnits", id: collectionPartId(ref.activityId, "collectionProgress.units", "unit-" + index),
      ownerPackageId: f.scope.packageId, runId: ref.activityId, targetRevisionId: f.scope.targetRevisionId,
      parent: { collection: "runs", id: ref.activityId, path: "collectionProgress.units" },
      value: { ...unit.value, unitId: "unit-" + index, status, riskBlocked: true },
    });
    await f.repository.transaction({ select: [
      { collection: "contentBodies", ownerPackageId: f.scope.packageId, ids: [body.id] },
      ...rows.map(row => ({ collection: row.collection, ownerPackageId: f.scope.packageId, ids: [row.id] })),
    ] }, tx => {
      tx.deleteRow({ collection: "contentBodies", id: body.id });
      for (const row of rows) tx.putRow(row);
    }, { scope: f.scope });
    await f.service.resume({ ref, requestId: "finish-status" });
    await f.service.wait(ref);
    assert.equal((await f.service.get(ref)).collectionProgress.status, scenario.expected);
    for (const [index, status] of scenario.statuses.entries()) {
      const [collection, part] = parts[index], queued = await collectionPartRows(f.repository, ref, collection, part);
      assert.equal(queued.length, 1);
      assert.equal(queued[0].value.status, status);
      assert.equal(queued[0].value.riskBlocked, true, "finishing must retain risk restrictions");
    }
  });
}

test("cancel after finish counts aborts the terminal write before the queued drain changes the epoch", async (t) => {
  const provider = createPagedProvider({
    id: "synthetic", name: "synthetic", capabilities: {},
    listPage: async () => ({ records: [job({ description: "合成消防工程岗位负责消防设施检查、日常维护、隐患排查与设备运行保障，要求本科。", bodyStatus: "complete" })], hasMore: false }),
  });
  const f = await collectionFixture(t, { providers: [provider] });
  // Exercise the formal service directly so cancellation has already aborted
  // its controller; the compatibility facade dispatches through an async turn.
  f.service = createRowCollectionService({
    repository: f.repository, operationGate: f.operationGate, ledger: f.ledger,
    registry: createSourceRegistry([provider]),
    planner: async () => ({
      units: [{ unitId: "unit-0", sourceId: "synthetic", siteId: "site-0", queryIndex: 0, site: { siteId: "site-0", origin: "https://jobs.example.org" }, query: { keyword: "synthetic", pageLimit: 20 } }],
      hashes: { planHash: "p1", catalogHash: "c1", queryHash: "q1", parserVersion: "v1" },
      limits: { maxRequests: 400, maxDetails: 100, maxCostCny: 10 },
    }),
    requestFactory: () => async () => { throw Error("synthetic finish test makes no HTTP requests"); },
  });
  t.after(() => f.service.stop());
  const withWriteFence = f.repository.withWriteFence;
  let ref, cancelled, triggered = false, terminalWritesAfterCancel = 0;
  f.repository.withWriteFence = (action, options) => withWriteFence(fence => action(new Proxy({ ...fence }, {
    get(target, name) {
      if (name === "aggregateRows") return input => {
        const result = target.aggregateRows(input);
        if (!triggered && ref && input.collection === "activityUnits" && input.groupBy === "status" && input.where?.parentId === ref.activityId) {
          assert.equal(input.ownerPackageId, ref.scope.packageId);
          assert.equal(input.where.path, "collectionProgress.units");
          triggered = true;
          cancelled = f.service.cancel(ref);
        }
        return result;
      };
      if (name === "transaction") return (selection, callback) => target.transaction(selection, tx => callback(new Proxy({ ...tx }, {
        get(transaction, method) {
          if (method === "putRow") return input => {
            if (triggered && input.collection === "runs" && input.id === ref.activityId && input.value.collectionProgress.status === "completed") terminalWritesAfterCancel++;
            return transaction.putRow(input);
          };
          return transaction[method];
        },
      })));
      return target[name];
    },
  })), options);
  t.after(() => { f.repository.withWriteFence = withWriteFence; });
  const started = await f.service.start({ scope: f.scope });
  ref = { scope: f.scope, activityId: started.activityId };
  await f.service.wait(ref);
  await cancelled;
  assert.equal(triggered, true, "the cancellation must occur after reading finish counts");
  assert.equal(terminalWritesAfterCancel, 0);
  const root = await f.service.get(ref);
  assert.equal(root.collectionProgress.status, "cancelled");
  assert.equal(root.collectionProgress.activeSliceRunId, null);
});
test("completed list leaves failed body retryable across restart without repeating the list", async (t) => {
  let lists = 0,
    details = 0;
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => {
      lists++;
      return {
        records: [
          {
            ...job(),
            description: null,
            bodyStatus: "incomplete",
            retryEligible: true,
          },
        ],
        hasMore: false,
      };
    },
    detail: async (record) => {
      details++;
      return details === 1
        ? { ...record, bodyStatus: "challenge_required", retryEligible: true }
        : {
            ...record,
            description: "消防工程师招聘条件为本科应届生。".repeat(4),
            bodyStatus: "complete",
            retryEligible: false,
          };
    },
  });
  const f = await collectionFixture(t, { providers: [provider] });
  let start = await f.service.start({ scope: f.scope });
  const ref = { scope: f.scope, activityId: start.activityId };
  await f.service.wait(ref);
  let root = await f.service.get(ref);
  const pending = await collectionPartRows(f.repository, ref, "contentBodies", "pendingBodies"),
    units = await collectionPartRows(f.repository, ref, "activityUnits", "units");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].value.status, "waiting_for_auth");
  assert.equal(pending[0].value.record.bodyStatus, "challenge_required");
  assert.equal(units.length, 1);
  assert.equal(units[0].value.status, "completed");
  assert.equal(root.collectionProgress.status, "waiting_for_auth");
  assert.equal(units[0].value.seenIds.length, 0);
  await f.reopen();
  await f.service.resume({ ref, requestId: "retry-body" });
  await f.service.wait(ref);
  root = await f.service.get(ref);
  assert.equal(lists, 1);
  assert.equal(details, 2);
  assert.equal(
    root.collectionProgress.lastErrorCode,
    undefined,
    JSON.stringify(root.collectionProgress),
  );
  assert.equal(
    (await collectionPartRows(f.repository, ref, "contentBodies", "pendingBodies")).length,
    0,
    "completed retry must remove its private body queue record",
  );
  assert.equal(root.collectionProgress.status, "completed");
  assert.equal((await f.ledger.snapshot(ref)).maxCostCny, 10);
});
