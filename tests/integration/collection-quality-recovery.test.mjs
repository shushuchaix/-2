import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { job } from "../helpers/fixtures.mjs";
import { assessRecruitmentEvidence } from "../../src/domain/recruitment-evidence.mjs";
import { contentKey } from "../../src/sources/content-queue.mjs";

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
  assert.equal(
    Object.keys((await f.service.get(ref)).collectionProgress.pendingBodies)
      .length,
    0,
  );
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
  assert.equal(
    Object.keys((await f.service.get(ref)).collectionProgress.pendingBodies)
      .length,
    1,
  );
  await f.reopen();
  await f.service.resume({ ref, requestId: "retry-recovered-body" });
  await f.service.wait(ref);
  const w = await f.repository.read();
  assert.ok(
    Object.values(w.observations).some(
      (o) => o.fields.description === description,
    ),
  );
  assert.equal(
    Object.keys((await f.service.get(ref)).collectionProgress.pendingBodies)
      .length,
    0,
  );
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
  assert.equal(
    Object.keys((await f.service.get(ref)).collectionProgress.pendingBodies)
      .length,
    0,
  );
  assert.equal(
    (await f.service.get(ref)).collectionProgress.status,
    "completed",
  );
  assert.equal(details, 2);
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
  await f.repository.mutateWorkspace((w) => {
    const root = w.runs[ref.activityId];
    root.collectionProgress.status = "paused";
    for (let i = 0; i < 11; i++) {
      const record = job({
        sourceRecordId: String(i),
        url: "https://jobs.example.com/" + i,
        description: null,
        bodyStatus: "incomplete",
        retryEligible: true,
      });
      root.collectionProgress.pendingBodies[contentKey(record)] = {
        unitId: "unit-0",
        record,
        status: "pending",
        attempts: 0,
        nextDueAt: "2030-01-01T00:00:00.000Z",
        serverCooldownUntil: i < 10 ? "2030-01-01T00:00:00.000Z" : null,
      };
    }
  });
  await f.service.resume({ ref, requestId: "eligible-body" });
  await f.service.wait(ref);
  assert.deepEqual(attempted, ["10"]);
  assert.equal(
    Object.keys((await f.service.get(ref)).collectionProgress.pendingBodies)
      .length,
    10,
  );
  assert.ok(
    Object.values((await f.repository.read()).observations).some(
      (o) => o.fields.sourceRecordId === "10" && o.fields.description,
    ),
  );
});
