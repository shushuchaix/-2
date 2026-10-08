import test from "node:test";
import assert from "node:assert/strict";
import { contentHash } from "../../src/infrastructure/storage/repository.mjs";
import { tempRepository } from "../helpers/repository.mjs";
import {
  job,
  profile,
  target,
  namedTargetInput,
} from "../helpers/fixtures.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { createJobService } from "../../src/application/job-service.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
test("fact hashes ignore runtime IDs and preserve exact business text", async () => {
  const { jobFactHash } = await import("../../src/domain/job-facts.mjs");
  assert.match(jobFactHash(job()), /^job-fact-v1:/);
  assert.equal(
    jobFactHash(job()),
    jobFactHash(
      job({
        jobId: "old",
        sourceRecordId: "other",
        retrievedAt: "later",
        url: "https://example.com/other",
      }),
    ),
  );
  assert.notEqual(jobFactHash(job()), jobFactHash(job({ degree: "硕士" })));
  assert.notEqual(
    jobFactHash(job()),
    jobFactHash(job({ description: job().description + " " })),
  );
});
test("legacy evaluation basis validates original IDs and three historical hash formats", async () => {
  const { resolveEvaluationFactBasis, jobFactHash } = await import(
    "../../src/domain/job-facts.mjs"
  );
  const fields = job(),
    w = {
      jobs: { kept: {} },
      jobRedirects: { old: { toJobId: "kept" } },
      identityAliases: {},
      observations: { o: { observationId: "o", jobId: "old", record: fields } },
    };
  for (const hash of [
    contentHash({ ...fields, jobId: "old", retrievedAt: undefined }),
    contentHash({ ...fields, retrievedAt: undefined }),
    contentHash(fields.description),
  ]) {
    const e = { jobId: "old", jdHash: hash };
    assert.equal(
      resolveEvaluationFactBasis(w, e).factContentHash,
      jobFactHash(fields),
    );
    assert.equal(e.jdHash, hash);
  }
  assert.equal(
    resolveEvaluationFactBasis(w, { jobId: "old", jdHash: "unverifiable" })
      .status,
    "historical",
  );
});
test("version facts constrain evaluation, caches, and latest score projection", async (t) => {
  const repository = await tempRepository(t),
    ws = createWorkspaceService({ repository }),
    jobs = createJobService({ repository }),
    cache = new Map(),
    service = createEvaluationService({ repository, cache });
  const p = await ws.saveProfile({ profile: profile() }),
    a = await ws.saveTarget(
      namedTargetInput({ ...target(), profileRevisionId: p.revisionId }),
    );
  const {
    jobIds: [id],
  } = await jobs.ingestRecords({
    runId: "import-a",
    targetRevisionId: a.revisionId,
    records: [job()],
    observedAt: "2026-10-05T00:00:00.000Z",
  });
  const first = await service.evaluate({
    jobIds: [id],
    profileRevisionId: p.revisionId,
    targetRevisionId: a.revisionId,
  });
  const original = structuredClone(first.evaluations[0]);
  assert.ok(original.observationId);
  assert.match(original.factContentHash, /^job-fact-v1:/);
  await jobs.ingestRecords({
    runId: "import-new",
    targetRevisionId: a.revisionId,
    records: [
      job({
        description:
          "新的职责和资格，负责机场设备维护工作，要求本科相关工程专业并具备消防安全培训经验。",
      }),
    ],
    observedAt: "2026-10-07T00:00:00.000Z",
  });
  assert.equal(
    (await jobs.queryJobs({ targetRevisionId: a.revisionId })).items[0]
      .evaluation,
    null,
  );
  const second = await service.evaluate({
    jobIds: [id],
    profileRevisionId: p.revisionId,
    targetRevisionId: a.revisionId,
  });
  assert.notEqual(second.evaluations[0].evaluationId, original.evaluationId);
  const current = second.evaluations[0];
  await repository.mutateWorkspace((w) => {
    const j = w.jobs[id];
    delete w.jobs[id];
    w.jobs.kept = { ...j, jobId: "kept" };
    w.jobRedirects = { [id]: { toJobId: "kept", operationId: "synthetic" } };
    w.targetMembers[a.revisionId].kept = w.targetMembers[a.revisionId][id];
    delete w.targetMembers[a.revisionId][id];
  });
  const replay = await service.evaluate({
    jobIds: [id, "kept"],
    profileRevisionId: p.revisionId,
    targetRevisionId: a.revisionId,
  });
  assert.equal(replay.evaluations.length, 1);
  assert.equal(replay.evaluations[0].jobId, "kept");
  assert.equal(replay.evaluations[0].evaluationId, current.evaluationId);
  assert.deepEqual(
    (await repository.read()).evaluations[original.evaluationId],
    original,
  );
  assert.equal(cache.get(current.cacheKey).jobId, id);
});
