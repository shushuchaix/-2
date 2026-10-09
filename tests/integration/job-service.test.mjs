import test from "node:test";
import assert from "node:assert/strict";
import { tempRepository } from "../helpers/repository.mjs";
import { job, AT } from "../helpers/fixtures.mjs";
import { createJobService } from "../../src/application/job-service.mjs";
import { createImportService } from "../../src/application/import-service.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { profile, target, namedTargetInput } from "../helpers/fixtures.mjs";
import { jobFactHash } from "../../src/domain/job-facts.mjs";
import { filters as httpFilters } from "../../src/server/validation.mjs";
import { createExportService } from "../../src/application/export-service.mjs";

test("independent classifications include unevaluated, unknown, all and unassigned consistently in HTTP and exports", async (t) => {
  const repository = await tempRepository(t),
    s = createJobService({ repository }),
    ws = createWorkspaceService({ repository });
  const p = await ws.saveProfile({ profile: profile() }),
    v = await ws.saveTarget(
      namedTargetInput({ ...target(), profileRevisionId: p.revisionId }),
    );
  const recommendations = [
    "high",
    "consider",
    "low",
    "insufficient",
    "not_recommended",
  ];
  for (let i = 0; i < 7; i++) {
    const r = job({
      sourceRecordId: String(i),
      url: "https://jobs.example.com/" + i,
      kind: i === 6 ? "company_campaign" : "job",
      detailStatus: "complete",
      deadlineAt: "2029-01-01",
      applyUrl: "https://jobs.example.com/apply",
      applicationVerification: {
        status: 200,
        formVerified: true,
        checkedAt: new Date(repository.clock.now()).toISOString(),
      },
    });
    const saved = await s.ingestRecords({
      runId: "r" + i,
      targetRevisionId: i === 5 ? undefined : v.revisionId,
      records: [r],
      observedAt: AT,
    });
    if (i < 5)
      await s.saveEvaluations([
        {
          evaluationId: "enum" + i,
          jobId: saved.jobIds[0],
          observationId: saved.observationIds[0],
          factContentHash: jobFactHash(r),
          profileRevisionId: p.revisionId,
          targetRevisionId: v.revisionId,
          recommendation: recommendations[i],
          qualification: {
            status: i < 3 ? "pass" : i === 4 ? "fail" : "unknown",
          },
          score: 80 - i,
          createdAt: AT,
        },
      ]);
  }
  assert.equal(
    (
      await s.queryJobs({
        kind: "all",
        recommendation: "all",
        qualification: "all",
        applicationStatus: "all",
        duplicateStatus: "all",
      })
    ).total,
    7,
  );
  for (const recommendation of recommendations)
    assert.equal(
      (
        await s.queryJobs({
          targetRevisionId: v.revisionId,
          kind: "job",
          recommendation,
        })
      ).total,
      1,
    );
  assert.equal(
    (
      await s.queryJobs({
        targetRevisionId: "unassigned",
        recommendation: "unevaluated",
        qualification: "unknown",
      })
    ).total,
    1,
  );
  assert.equal(
    (
      await s.queryJobs({
        targetRevisionId: v.revisionId,
        kind: "company_campaign",
        recommendation: "unevaluated",
      })
    ).total,
    1,
  );
  const parsed = httpFilters(
    new URLSearchParams({
      targetRevisionId: "all",
      kind: "all",
      applicationStatus: "new",
      duplicateStatus: "normal",
    }),
  );
  assert.equal(parsed.applicationStatus, "new");
  assert.equal(parsed.duplicateStatus, "normal");
  const exported = await createExportService({ repository }).export({
    filters: { targetRevisionId: "unassigned", recommendation: "unevaluated" },
  });
  assert.equal(JSON.parse(exported.body).length, 1);
});
test("three identical no-link manual imports are idempotent with traceable observations", async (t) => {
  const repository = await tempRepository(t),
    jobService = createJobService({ repository });
  const importer = createImportService({
    repository,
    jobService,
    request: () => {
      throw Error("Network forbidden");
    },
  });
  const input = {
    title: "合成消防岗位",
    text: "合成单位招聘消防安全工程师，负责机场消防设施维护与安全巡检，要求本科消防工程专业，持有相关消防职业资格。",
  };
  for (let i = 0; i < 3; i++) await importer.import(input);
  const w = await repository.read();
  assert.equal(Object.keys(w.jobs).length, 1);
  assert.equal(Object.keys(w.observations).length, 3);
});
test("recollection retains application history and empty note clears", async (t) => {
  const repository = await tempRepository(t),
    s = createJobService({ repository });
  const { jobIds } = await s.ingestRecords({
    runId: "r1",
    records: [job()],
    observedAt: AT,
  });
  const id = jobIds[0];
  await s.updateApplication(id, { status: "applied", note: "已投递" });
  await s.ingestRecords({ runId: "r1", records: [job()], observedAt: AT });
  assert.equal((await s.getJob(id)).observations.length, 1);
  assert.equal((await s.getJob(id)).application.status, "applied");
  await s.updateApplication(id, { status: "interviewing" });
  assert.equal((await s.getJob(id)).application.note, "已投递");
  await s.updateApplication(id, { note: "" });
  assert.equal((await s.getJob(id)).application.note, "");
  assert.equal((await s.getJob(id)).application.events.length, 3);
  await assert.rejects(
    s.updateApplication(id, { status: "bad" }),
    (e) => e.status === 400 && !!e.fieldErrors.status,
  );
  await assert.rejects(
    s.updateApplication(id, { followUpAt: "bad" }),
    (e) => e.status === 400 && !!e.fieldErrors.followUpAt,
  );
});
test("different trusted IDs never collapse through the content replay path", async (t) => {
  const repository = await tempRepository(t),
    service = createJobService({ repository });
  const result = await service.ingestRecords({
    runId: "authority-conflict",
    records: [
      job({ sourceRecordId: "1" }),
      job({ sourceRecordId: "2" }),
      job({ sourceRecordId: "3" }),
    ],
  });
  assert.equal(new Set(result.jobIds).size, 3);
});
test("conflicting identities retain both records and manual links never merge them", async (t) => {
  const repository = await tempRepository(t),
    s = createJobService({ repository });
  const records = [
    job({ sourceRecordId: null, cities: ["北京"] }),
    job({ sourceRecordId: null, cities: ["上海"] }),
  ];
  const { jobIds } = await s.ingestRecords({
    runId: "r1",
    records,
    observedAt: AT,
  });
  assert.equal(new Set(jobIds).size, 2);
  await s.linkJobs(...jobIds);
  assert.equal((await s.getJob(jobIds[0])).relatedJobs.length, 1);
  await s.unlinkJobs(...jobIds);
  assert.equal((await s.getJob(jobIds[0])).relatedJobs.length, 0);
  assert.equal((await s.queryJobs({ cities: ["上海"] })).total, 1);
  await s.saveEvaluations([
    {
      evaluationId: "e1",
      jobId: jobIds[0],
      targetRevisionId: "t@1",
      status: "rule",
      score: 99,
    },
  ]);
  assert.equal((await s.getJob(jobIds[0])).application.status, "new");
});
test("absence needs repeated complete coverage of the same scope", async (t) => {
  const repository = await tempRepository(t),
    s = createJobService({ repository });
  const { jobIds } = await s.ingestRecords({
    runId: "r1",
    records: [job()],
    observedAt: AT,
  });
  const c = {
    sourceId: "synthetic",
    siteId: "synthetic-1",
    queries: ["Java"],
    cities: ["北京"],
    status: "complete",
    truncated: false,
    finishedAt: AT,
  };
  await s.finalizeCoverage({ runId: "r1", coverage: [c] });
  await s.finalizeCoverage({
    runId: "r2",
    coverage: [{ ...c, status: "error" }],
  });
  assert.equal((await s.getJob(jobIds[0])).job.lifecycle, "observed");
  await s.finalizeCoverage({ runId: "r2", coverage: [c] });
  await s.finalizeCoverage({ runId: "r3", coverage: [c] });
  assert.equal((await s.getJob(jobIds[0])).job.lifecycle, "notRecentlySeen");
});
