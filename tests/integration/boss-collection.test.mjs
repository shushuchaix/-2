import test from "node:test";
import assert from "node:assert/strict";
import { createBossProvider } from "../../src/sources/adapters/boss.mjs";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { registerCollectionIpc } from "../../electron/collection/ipc.mjs";

const site = { siteId: "boss", providerId: "boss" };
const rawJob = (id = "public-job") => ({
  encryptJobId: id,
  jobName: "消防工程师",
  brandName: "合成企业",
  securityId: "ephemeral-secret",
  lid: "private-lid",
});
function providerContext() {
  const operations = [];
  let details = 0;
  const context = {
    scope: { packageId: "A", targetRevisionId: "t@1" },
    ref: { activityId: "root" },
    token: { epoch: 1, sliceRunId: "slice" },
    sessionRefs: { boss: "session-A" },
    queries: [{ keyword: "消防", city: "北京", pageLimit: 2 }],
    clock: { now: () => Date.parse("2026-10-10T00:00:00Z") },
    budget: {
      claimDetail: async () => {
        details++;
      },
    },
    readService: {
      readBoss: async ({ operation }) => {
        operations.push(operation);
        return operation.kind === "boss.search"
          ? {
              status: 200,
              payload: {
                code: 0,
                zpData: {
                  jobList: [rawJob()],
                  hasMore: operation.parameters.page < 2,
                },
              },
            }
          : {
              status: 200,
              payload: {
                code: 0,
                zpData: {
                  jobCard: {
                    encryptJobId: "public-job",
                    postDescription:
                      "岗位职责：消防设施维护与检查。任职要求：消防工程相关专业，本科及以上学历。",
                  },
                },
              },
            };
      },
    },
  };
  return { context, operations, details: () => details };
}
test("Boss pages persist public identity only; a restarted detail rereads only its discovery page", async () => {
  const f = providerContext(),
    p = createBossProvider();
  const first = await p.collectPage({
    site,
    query: f.context.queries[0],
    context: f.context,
  });
  assert.deepEqual(first.nextCursor, { page: 2 });
  const second = await p.collectPage({
    site,
    query: f.context.queries[0],
    cursor: first.nextCursor,
    context: f.context,
  });
  assert.equal(second.done, true);
  assert.equal(second.records[0].discoveryPage, 2);
  assert.doesNotMatch(
    JSON.stringify(second),
    /ephemeral-secret|private-lid|securityId/,
  );
  await p.fetchDetail(second.records[0], f.context);
  assert.equal(f.operations.length, 3);
  const restarted = createBossProvider();
  await restarted.fetchDetail(second.records[0], {
    ...f.context,
    token: { epoch: 2, sliceRunId: "restart" },
  });
  assert.deepEqual(
    f.operations.slice(3).map((o) => [o.kind, o.parameters.page]),
    [
      ["boss.search", 2],
      ["boss.detail", undefined],
    ],
  );
  assert.equal(f.details(), 2);
});
test("missing Boss read reference does not sweep pages or use another version's memory", async () => {
  const f = providerContext(),
    p = createBossProvider();
  const page = await p.collectPage({
    site,
    query: f.context.queries[0],
    context: f.context,
  });
  f.context.readService.readBoss = async ({ operation }) => {
    f.operations.push(operation);
    return {
      status: 200,
      payload: { code: 0, zpData: { jobList: [], hasMore: true } },
    };
  };
  await assert.rejects(
    p.fetchDetail(page.records[0], {
      ...f.context,
      scope: { packageId: "B", targetRevisionId: "t@2" },
    }),
    { code: "read_ref_missing", retryable: false },
  );
  assert.equal(f.operations.length, 2);
  await assert.rejects(
    p.collectPage({
      site,
      query: { keyword: "消防", city: "未支持城市" },
      context: f.context,
    }),
    { code: "boss_city_unsupported" },
  );
});
test("paused diagnostic uses the original ledger, restores pause, and cannot revive a terminal root", async (t) => {
  const f = await collectionFixture(t);
  const c = await f.openCommit();
  await c.lease.release();
  await f.service.pause(c.ref);
  const before = await f.service.get(c.ref);
  await f.service.withDiagnosticContext(
    { ref: c.ref, requestId: "probe-1" },
    async (ctx) => {
      assert.equal(ctx.ref.activityId, c.ref.activityId);
      await ctx.request("https://jobs.example.org");
    },
  );
  const after = await f.service.get(c.ref);
  assert.equal(after.collectionProgress.status, "paused");
  assert.equal(after.collectionProgress.units.unit.committedPages, 0);
  assert.equal(
    after.collectionUsage.usedRequests,
    before.collectionUsage.usedRequests + 1,
  );
  await assert.rejects(
    f.service.withDiagnosticContext(
      { ref: c.ref, requestId: "probe-1" },
      async () => {},
    ),
    { code: "collection_diagnostic_replayed" },
  );
  await f.service.cancel(c.ref);
  await assert.rejects(
    f.service.withDiagnosticContext(
      { ref: c.ref, requestId: "probe-2" },
      async () => {},
    ),
    { code: "collection_terminal" },
  );
});
test("cancelling a paused diagnostic drains its callback and does not restore the paused root", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  await c.lease.release();
  await f.service.pause(c.ref);
  let started;
  const ready = new Promise((r) => {
    started = r;
  });
  const pending = f.service.withDiagnosticContext(
    { ref: c.ref, requestId: "cancel-probe" },
    async (ctx) => {
      started();
      await new Promise((_, reject) =>
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), {
          once: true,
        }),
      );
    },
  );
  const rejection = assert.rejects(pending, { code: "collection_stale_epoch" });
  await ready;
  await f.service.cancel(c.ref);
  await rejection;
  assert.equal(
    (await f.service.get(c.ref)).collectionProgress.status,
    "cancelled",
  );
});
test("Boss risk blocks all Boss units and pending bodies while other providers continue", async (t) => {
  let bossCalls = 0,
    otherCalls = 0;
  const risk = createPagedProvider({
    id: "boss",
    name: "Boss",
    capabilities: {},
    listPage: async () => {
      bossCalls++;
      throw Object.assign(Error("risk"), {
        code: "boss_account_risk",
        retryable: false,
      });
    },
  });
  const other = createPagedProvider({
    id: "other",
    name: "other",
    capabilities: {},
    listPage: async () => {
      otherCalls++;
      return { records: [], hasMore: false };
    },
  });
  const f = await collectionFixture(t, { providers: [risk, other] });
  const first = await f.service.start({ scope: f.scope });
  const ref = { scope: f.scope, activityId: first.activityId };
  await f.service.wait(ref);
  assert.equal(otherCalls, 1);
  let root = await f.service.get(ref);
  assert.equal(
    root.collectionProgress.units["unit-0"].status,
    "waiting_for_auth",
  );
  assert.equal(root.collectionProgress.units["unit-0"].riskBlocked, true);
  await f.service.resume({ ref, automatic: true, requestId: "automatic" });
  assert.equal(bossCalls, 1);
  await f.service.resume({ ref, requestId: "manual" });
  await f.service.wait(ref);
  root = await f.service.get(ref);
  assert.equal(root.collectionProgress.units["unit-0"].riskBlocked, true);
  assert.equal(bossCalls, 1);
});
test("Boss committed pages survive restart and later pages retain the root's consumed allowance", async (t) => {
  const provider = createBossProvider();
  const f = await collectionFixture(t, {
    providers: [provider],
    limits: { maxPagesPerQuery: 1 },
  });
  await f.repository.mutateWorkspace((w) => {
    w.packages[f.scope.packageId].collectionSettings = {
      sourceOverrides: {},
      refreshEnabled: false,
      sessionRefs: { boss: "session-A" },
    };
  });
  const readService = {
    readBoss: async (ctx) => {
      await ctx.budget.claimRequest(
        ctx.operation.kind === "boss.search" ? "list" : "detail",
      );
      const page = ctx.operation.parameters.page;
      return ctx.operation.kind === "boss.search"
        ? {
            status: 200,
            payload: {
              code: 0,
              zpData: {
                jobList: [
                  { ...rawJob("page-" + page), securityId: "ref-" + page },
                ],
                hasMore: page === 1,
              },
            },
          }
        : {
            status: 200,
            payload: {
              code: 0,
              zpData: {
                jobCard: {
                  encryptJobId:
                    "page-" +
                    ctx.operation.parameters.securityId.split("-").pop(),
                  postDescription:
                    "岗位职责：消防设施维护与检查。任职要求：消防工程相关专业，本科及以上学历。",
                },
              },
            },
          };
    },
  };
  f.service.setReadService(readService);
  const start = await f.service.start({ scope: f.scope }),
    ref = { scope: f.scope, activityId: start.activityId };
  await f.service.wait(ref);
  const first = await f.service.get(ref);
  assert.equal(first.collectionProgress.units["unit-0"].committedPages, 1);
  assert.equal(first.collectionUsage.usedRequests, 2);
  await f.reopen();
  f.service.setReadService(readService);
  const restored = await f.service.get(ref);
  assert.equal(restored.collectionUsage.usedRequests, 2);
  await f.service.adjustLimits({
    ref,
    limits: { maxPagesPerQuery: 2 },
    expectedRevision: restored.collectionProgress.revision,
  });
  await f.service.resume({ ref, requestId: "second-page" });
  await f.service.wait(ref);
  const last = await f.service.get(ref),
    w = await f.repository.read();
  assert.equal(last.collectionProgress.units["unit-0"].committedPages, 2);
  assert.equal(last.collectionUsage.usedRequests, 4);
  assert.equal(Object.keys(w.jobs).length, 2);
  assert.doesNotMatch(
    JSON.stringify(last.collectionProgress.units["unit-0"].cursor),
    /securityId|lid/,
  );
});
test("a paused zero-budget diagnostic fails before any transport", async (t) => {
  const f = await collectionFixture(t, { limits: { maxRequests: 0 } }),
    c = await f.openCommit();
  await c.lease.release();
  await f.service.pause(c.ref);
  await assert.rejects(
    f.service.withDiagnosticContext(
      { ref: c.ref, requestId: "empty-budget" },
      (ctx) => ctx.request("https://jobs.example.org"),
    ),
    { code: "source_budget_exhausted" },
  );
  assert.equal(f.networkCalls, 0);
  const root = await f.service.get(c.ref);
  assert.equal(root.collectionProgress.status, "paused");
  const child = (await f.repository.read()).runs[
    root.collectionProgress.diagnosticRequests["empty-budget"].sliceRunId
  ];
  assert.equal(child.status, "failed");
});
test("clearing login also invalidates its owned source proof without removing another version", async (t) => {
  const f = await collectionFixture(t);
  await f.repository.mutateWorkspace((w) => {
    for (const scope of [f.scope, f.otherScope])
      w.packages[scope.packageId].collectionSettings = {
        sourceOverrides: {},
        refreshEnabled: false,
        sessionRefs: { boss: "session-" + scope.packageId },
        sourceVerification: {
          "boss/boss": { sourceId: "boss", siteId: "boss", status: "ready" },
        },
      };
  });
  const handlers = new Map(),
    mainFrame = { url: "http://127.0.0.1:31000/" },
    sender = { mainFrame };
  registerCollectionIpc({
    ipcMain: { handle: (k, fn) => handlers.set(k, fn) },
    getWindow: () => ({ webContents: sender }),
    getOrigin: () => mainFrame.url,
    browser: { clearSession: async () => ({ status: "clean" }) },
    context: { repository: f.repository },
  });
  await handlers.get("collection:clear")(
    { sender, senderFrame: mainFrame },
    { scope: f.scope, sessionRef: "session-" + f.scope.packageId },
  );
  const w = await f.repository.read();
  assert.equal(
    w.packages[f.scope.packageId].collectionSettings.sessionRefs.boss,
    undefined,
  );
  assert.equal(
    w.packages[f.scope.packageId].collectionSettings.sourceVerification[
      "boss/boss"
    ],
    undefined,
  );
  assert.equal(
    w.packages[f.otherScope.packageId].collectionSettings.sourceVerification[
      "boss/boss"
    ].status,
    "ready",
  );
});
