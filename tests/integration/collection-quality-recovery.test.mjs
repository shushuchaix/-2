import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { job } from "../helpers/fixtures.mjs";
import { assessRecruitmentEvidence } from "../../src/domain/recruitment-evidence.mjs";
import { contentKey } from "../../src/sources/content-queue.mjs";
import {
  collectionPartId,
  putCollectionPart,
} from "../../src/application/collection-row-access.mjs";

// Queue rows are private persisted parts; the public activity head omits them.
const pendingBodies = (f, ref) =>
  f.repository.queryRows(
    {
      collection: "contentBodies",
      ownerPackageId: ref.scope.packageId,
      where: {
        parentId: ref.activityId,
        path: "collectionProgress.pendingBodies",
      },
      limit: 200,
    },
    { scope: ref.scope },
  );

test("automatic application verification resolves long-term opening without checking expired or conflicting jobs", async (t) => {
  const records = [
    {
      sourceRecordId: "long-term",
      longTermRecruiting: true,
      description:
        "长期招聘消防工程人员，本科，岗位负责消防安全检查和设施维护。",
    },
    {
      sourceRecordId: "undated",
      description:
        "招聘消防工程人员，本科，岗位负责消防安全检查和设施维护，无其他时间说明。",
    },
    { sourceRecordId: "expired", deadlineAt: "2020-01-01" },
    {
      sourceRecordId: "expired-body",
      description:
        "招聘消防工程人员，本科，负责消防安全检查和设施维护。报名截止时间：2020年1月1日。",
    },
    {
      sourceRecordId: "conflict-body",
      deadlineAt: "2030-01-01",
      description:
        "招聘消防工程人员，本科，负责消防安全检查和设施维护。报名截止时间：2020年1月1日。",
    },
    { sourceRecordId: "historical", title: "消防工程招聘拟聘用人员公示" },
    {
      sourceRecordId: "conflict",
      evidenceConflicts: [
        { field: "deadlineAt", code: "visible_structured_conflict" },
      ],
    },
  ].map((fields) =>
    job({
      ...fields,
      title: fields.title || "消防工程岗位 " + fields.sourceRecordId,
      url: "https://jobs.example.com/" + fields.sourceRecordId,
      applyUrl: "https://jobs.example.com/apply/" + fields.sourceRecordId,
      detailStatus: "complete",
    }),
  );
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => ({ records, hasMore: false }),
  });
  const urls = [];
  const f = await collectionFixture(t, {
    providers: [provider],
    transport: async (url) => {
      urls.push(url);
      return { status: 200, text: "<form><button>提交申请</button></form>" };
    },
  });
  const started = await f.service.start({
    scope: f.scope,
    options: { mode: "rules" },
  });
  await f.service.wait({ scope: f.scope, activityId: started.activityId });
  assert.deepEqual(urls, [
    "https://jobs.example.com/apply/long-term",
    "https://jobs.example.com/apply/undated",
  ]);
  const observations = Object.values((await f.repository.read()).observations);
  const evidence = (id) =>
    assessRecruitmentEvidence({
      record: observations.find((o) => o.fields.sourceRecordId === id).fields,
      now: f.clock.now(),
    });
  assert.equal(evidence("long-term").openingStatus, "open");
  assert.equal(evidence("long-term").applicationStatus, "available");
  assert.equal(evidence("undated").openingStatus, "unknown");
  assert.equal(evidence("expired").openingStatus, "expired");
  assert.equal(evidence("expired-body").openingStatus, "expired");
  assert.equal(evidence("conflict-body").conflicts.length, 1);
  assert.equal(evidence("historical").openingStatus, "historical");
  assert.equal(evidence("conflict").openingStatus, "unknown");
});

test("non-retryable detail failure is not queued or repeated during continuation", async (t) => {
  let details = 0;
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => ({
      records: [job({ description: null })],
      hasMore: false,
    }),
    detail: async () => {
      details++;
      throw Object.assign(Error("Public detail contains only a title"), {
        code: "detail_insufficient",
        retryable: false,
      });
    },
  });
  const f = await collectionFixture(t, { providers: [provider] });
  const started = await f.service.start({ scope: f.scope });
  const ref = { scope: f.scope, activityId: started.activityId };
  await f.service.wait(ref);
  assert.equal((await pendingBodies(f, ref)).rows.length, 0);
  assert.equal(details, 1);
  const run = (await f.repository.read()).runs[started.sliceRunId];
  assert.ok(run.issues.some((issue) => issue.code === "detail_insufficient"));
  assert.equal(
    (await f.service.get(ref)).collectionProgress.status,
    "completed",
  );
});

test("successful independent detail retry persists the recovered body despite inherited old retry flags", async (t) => {
  let details = 0;
  const description =
    "招聘消防设施维护工程师，本科应届生，负责防火巡查及消防设备保养。";
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => ({
      records: [job({ description: null })],
      hasMore: false,
    }),
    detail: async (record) => {
      details++;
      if (details === 1)
        throw Object.assign(Error("Temporary detail unavailable"), {
          code: "source_unavailable",
        });
      return { ...record, description, detailStatus: "complete" };
    },
  });
  const f = await collectionFixture(t, { providers: [provider] });
  const started = await f.service.start({ scope: f.scope });
  const ref = { scope: f.scope, activityId: started.activityId };
  await f.service.wait(ref);
  assert.equal((await pendingBodies(f, ref)).rows.length, 1);
  await f.reopen();
  await f.service.resume({ ref, requestId: "retry-recovered-body" });
  await f.service.wait(ref);
  const w = await f.repository.read();
  assert.ok(
    Object.values(w.observations).some(
      (o) => o.fields.description === description,
    ),
  );
  assert.equal((await pendingBodies(f, ref)).rows.length, 0);
  assert.equal(
    (await f.service.get(ref)).collectionProgress.status,
    "completed",
  );
  assert.equal(details, 2);
});

test("empty successful retry retains an insufficiency issue instead of silently clearing the task", async (t) => {
  let details = 0;
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => ({
      records: [job({ description: null })],
      hasMore: false,
    }),
    detail: async (record) => {
      if (++details === 1)
        throw Object.assign(Error("Temporary detail unavailable"), {
          code: "source_unavailable",
        });
      return { ...record, description: null, detailStatus: "complete" };
    },
  });
  const f = await collectionFixture(t, { providers: [provider] });
  const started = await f.service.start({ scope: f.scope });
  const ref = { scope: f.scope, activityId: started.activityId };
  await f.service.wait(ref);
  await f.reopen();
  const other = await f.service.prepare({ scope: f.otherScope });
  const otherRef = { scope: f.otherScope, activityId: other.activityId };
  const otherBefore = await f.service.get(otherRef);
  const continued = await f.service.resume({
    ref,
    requestId: "retry-empty-body",
  });
  await f.service.wait(ref);
  const w = await f.repository.read();
  assert.ok(
    w.runs[continued.sliceRunId].issues.some(
      (i) => i.code === "detail_insufficient",
    ),
  );
  assert.equal((await pendingBodies(f, ref)).rows.length, 0);
  assert.equal(
    (await f.service.get(ref)).collectionProgress.status,
    "completed",
  );
  assert.equal(details, 2);
  assert.equal(w.runs[continued.sliceRunId].issueCount, 1);
  await f.reopen();
  assert.ok(
    (await f.repository.read()).runs[continued.sliceRunId].issues.some(
      (issue) => issue.code === "detail_insufficient",
    ),
  );
  await assert.rejects(
    f.service.resume({ ref, requestId: "retry-terminal-body" }),
    {
      code: "collection_terminal",
    },
  );
  assert.equal(details, 2);
  assert.deepEqual(await f.service.get(otherRef), otherBefore);
});

for (const scenario of ["safe issue", "changed task", "rollback"])
  test(`a non-retryable body retry preserves ${scenario} guarantees`, async (t) => {
    let f,
      ref,
      calls = 0,
      injected = false;
    const diagnosticId = "d-11111111-1111-4111-8111-111111111111";
    const requestId = "q-22222222-2222-4222-8222-222222222222";
    const provider = createPagedProvider({
      id: "synthetic",
      name: "合成",
      capabilities: {},
      listPage: async () => ({
        records: [job({ description: null })],
        hasMore: false,
      }),
      detail: async (_record, ctx) => {
        if (++calls === 1)
          throw Object.assign(Error("temporary"), {
            code: "source_unavailable",
          });
        if (scenario === "changed task") {
          const row = (await pendingBodies(f, ref)).rows[0];
          await f.repository.transaction(
            {
              select: [
                {
                  collection: "contentBodies",
                  ownerPackageId: f.scope.packageId,
                  ids: [row.id],
                },
              ],
            },
            (tx) =>
              tx.putRow({
                collection: "contentBodies",
                id: row.id,
                value: {
                  ...row.value,
                  attempts: 9,
                  lastErrorCode: "newer-result",
                },
              }),
            { scope: f.scope, operationLease: ctx.operationLease },
          );
          injected = true;
        }
        throw Object.assign(
          Error("unsafe body https://secret.example/ token=secret"),
          {
            code: "detail_insufficient",
            retryable: false,
            diagnosticId,
            requestId,
            body: "private body",
            url: "https://secret.example/",
          },
        );
      },
    });
    f = await collectionFixture(t, { providers: [provider] });
    const started = await f.service.start({ scope: f.scope });
    ref = { scope: f.scope, activityId: started.activityId };
    await f.service.wait(ref);
    const queuedBefore = (await pendingBodies(f, ref)).rows;
    if (scenario === "rollback") {
      const transact = f.repository.transaction;
      f.repository.transaction = (selection, action, options) =>
        transact(
          selection,
          (tx) =>
            action({
              ...tx,
              deleteRow(row) {
                const result = tx.deleteRow(row);
                if (!injected && row.collection === "contentBodies") {
                  injected = true;
                  throw Object.assign(Error("synthetic post-delete failure"), {
                    code: "workspace_write_failed",
                    runFatal: true,
                  });
                }
                return result;
              },
            }),
          options,
        );
    }
    const continued = await f.service.resume({
      ref,
      requestId: "nonretryable-" + scenario.replaceAll(" ", "-"),
    });
    await f.service.wait(ref);
    const w = await f.repository.read();
    const issues = w.runs[continued.sliceRunId].issues;
    const queued = (await pendingBodies(f, ref)).rows;
    assert.equal(calls, 2);
    if (scenario === "safe issue") {
      assert.deepEqual(issues, [
        {
          code: "detail_insufficient",
          sourceId: "synthetic",
          siteId: "site-0",
          retryable: false,
          diagnosticId,
          requestId,
        },
      ]);
      assert.equal(w.runs[continued.sliceRunId].issueCount, 1);
      assert.equal(queued.length, 0);
    } else {
      assert.equal(injected, true);
      assert.equal(queued.length, 1);
      assert.equal(
        issues.some((issue) => issue.code === "detail_insufficient"),
        false,
      );
      if (scenario === "changed task") {
        assert.equal(queued[0].value.attempts, 9);
        assert.equal(queued[0].value.lastErrorCode, "newer-result");
      } else assert.deepEqual(queued, queuedBefore);
    }
  });

test("future body cooldowns do not starve an eligible eleventh pending detail", async (t) => {
  const attempted = [];
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: {},
    listPage: async () => ({ records: [], hasMore: false }),
    detail: async (record) => {
      attempted.push(record.sourceRecordId);
      return {
        ...record,
        description: "招聘消防工程师，本科应届生，负责消防设计和消防设施维护。",
        bodyStatus: "complete",
        retryEligible: false,
      };
    },
  });
  const f = await collectionFixture(t, { providers: [provider] });
  const started = await f.service.start({ scope: f.scope });
  const ref = { scope: f.scope, activityId: started.activityId };
  await f.service.wait(ref);
  const tasks = Array.from({ length: 11 }, (_, i) => {
    const record = job({
      sourceRecordId: String(i),
      url: "https://jobs.example.com/" + i,
      description: null,
      bodyStatus: "incomplete",
      retryEligible: true,
    });
    return {
      key: contentKey(record),
      value: {
        unitId: "unit-0",
        record,
        status: "pending",
        attempts: 0,
        nextDueAt: "2030-01-01T00:00:00.000Z",
        serverCooldownUntil: i < 10 ? "2030-01-01T00:00:00.000Z" : null,
      },
    };
  });
  await f.repository.transaction(
    {
      select: [
        {
          collection: "runs",
          ownerPackageId: f.scope.packageId,
          ids: [ref.activityId],
        },
        {
          collection: "contentBodies",
          ownerPackageId: f.scope.packageId,
          ids: tasks.map(({ key }) =>
            collectionPartId(
              ref.activityId,
              "collectionProgress.pendingBodies",
              key,
            ),
          ),
        },
      ],
    },
    (tx) => {
      const root = tx.getRow({ collection: "runs", id: ref.activityId });
      root.collectionProgress.status = "paused";
      tx.putRow({ collection: "runs", id: ref.activityId, value: root });
      for (const { key, value } of tasks)
        putCollectionPart(tx, {
          collection: "contentBodies",
          ref,
          path: "collectionProgress.pendingBodies",
          key,
          value,
        });
    },
    { scope: f.scope },
  );
  await f.service.resume({ ref, requestId: "eligible-body" });
  await f.service.wait(ref);
  assert.deepEqual(attempted, ["10"]);
  assert.equal((await pendingBodies(f, ref)).rows.length, 10);
  assert.ok(
    Object.values((await f.repository.read()).observations).some(
      (o) => o.fields.sourceRecordId === "10" && o.fields.description,
    ),
  );
});
