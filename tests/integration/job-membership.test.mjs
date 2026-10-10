import test from "node:test";
import assert from "node:assert/strict";
import { tempRepository } from "../helpers/repository.mjs";
import {
  job,
  profile,
  target,
  namedTargetInput,
  AT,
} from "../helpers/fixtures.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { createJobService } from "../../src/application/job-service.mjs";
test("version membership includes unevaluated jobs and selects its own observed facts", async (t) => {
  const repository = await tempRepository(t),
    ws = createWorkspaceService({ repository }),
    jobs = createJobService({ repository });
  const p = await ws.saveProfile({ profile: profile() });
  const a = await ws.saveTarget(
    namedTargetInput({ ...target(), profileRevisionId: p.revisionId }),
  );
  const b = await ws.saveTarget(namedTargetInput({ ...a }));
  const c = await ws.saveTarget(namedTargetInput({ ...a, targetId: "other" }));
  const {
    jobIds: [id],
  } = await jobs.ingestRecords({
    runId: "import-a",
    targetRevisionId: a.revisionId,
    records: [job()],
    observedAt: AT,
  });
  await jobs.ingestRecords({
    runId: "import-b",
    targetRevisionId: b.revisionId,
    records: [
      job({
        description:
          "更新职责，负责机场消防安全巡检，要求本科消防工程专业和相应工作经验。",
      }),
    ],
    observedAt: "2026-10-06T00:00:00.000Z",
  });
  assert.equal(
    (
      await jobs.queryJobs({
        targetId: a.targetId,
        targetRevisionId: a.revisionId,
      })
    ).total,
    1,
  );
  assert.equal(
    (await jobs.queryJobs({ targetRevisionId: c.revisionId })).total,
    0,
  );
  const { selectVersionJobFact } = await import(
    "../../src/domain/job-facts.mjs"
  );
  const w = await repository.read();
  assert.equal(
    selectVersionJobFact(w, { targetRevisionId: a.revisionId, jobId: id })
      .record.description,
    job().description,
  );
  assert.match(
    selectVersionJobFact(w, { targetRevisionId: b.revisionId, jobId: id })
      .record.description,
    /更新职责/,
  );
  const detail = await jobs.getJob(id, { targetRevisionId: a.revisionId });
  assert.equal(detail.fact.record.degree, "本科");
  await assert.rejects(
    jobs.queryJobs({ targetId: "other", targetRevisionId: a.revisionId }),
    (e) => e.status === 400,
  );
  await jobs.ingestRecords({
    runId: "unassigned",
    records: [job({ sourceRecordId: "else", title: "未归属岗位" })],
  });
  assert.equal(
    (await jobs.queryJobs({ targetRevisionId: "unassigned" })).total,
    1,
  );
});
test("backfill uses frozen runs or verifiable evaluations, never target-level hints", async (t) => {
  const repository = await tempRepository(t),
    ws = createWorkspaceService({ repository }),
    jobs = createJobService({ repository });
  const p = await ws.saveProfile({ profile: profile() }),
    a = await ws.saveTarget(
      namedTargetInput({ ...target(), profileRevisionId: p.revisionId }),
    );
  const {
    jobIds: [id],
    observationIds: [oid],
  } = await jobs.ingestRecords({ runId: "old-run", records: [job()] });
  await repository.mutateWorkspace((w) => {
    w.targetMembers = {};
    w.membershipVersion = 0;
    w.runs["old-run"] = {
      runId: "old-run",
      targetSnapshot: a,
      status: "completed",
    };
    w.observations[oid].record = w.observations[oid].fields;
    delete w.observations[oid].fields;
    w.jobs[id].targetFirstSeen[a.targetId] = AT;
  });
  const { backfillTargetMembers, selectVersionJobFact } = await import(
    "../../src/domain/job-facts.mjs"
  );
  const w = await repository.read();
  assert.equal(backfillTargetMembers(w).assigned, 1);
  assert.equal(
    selectVersionJobFact(w, { targetRevisionId: a.revisionId, jobId: id })
      .record.title,
    job().title,
  );
  delete w.runs["old-run"];
  w.targetMembers = {};
  w.membershipVersion = 0;
  assert.equal(backfillTargetMembers(w).assigned, 0);
  assert.equal(Object.keys(w.targetMembers).length, 0);
});
