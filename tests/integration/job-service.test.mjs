import test from "node:test";
import assert from "node:assert/strict";
import { tempRepository } from "../helpers/repository.mjs";
import { job, AT } from "../helpers/fixtures.mjs";
import { createJobService } from "../../src/application/job-service.mjs";
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
  await assert.rejects(s.updateApplication(id, { status: "bad" }), /status/i);
  await assert.rejects(s.updateApplication(id, { followUpAt: "bad" }), /date/i);
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
