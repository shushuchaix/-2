import test from "node:test";
import assert from "node:assert/strict";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
import { createJobVerificationService } from "../../src/application/job-verification-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { jobFactHash } from "../../src/domain/job-facts.mjs";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
test("high AI score cannot recommend unknown qualification or missing current application evidence", async (t) => {
  const f = await packageBusinessFixture(t),
    { a } = await f.twoTargets(),
    scope = { packageId: a.packageId, targetRevisionId: a.revisionId },
    [id] = await f.ingest(scope, [
      job({
        degree: "本科",
        description: "本科，须持有一级注册消防工程师证书。",
        graduationYear: null,
      }),
    ]);
  const w = await f.repository.read(),
    target = Object.values(w.targets)
      .flat()
      .find((v) => v.revisionId === scope.targetRevisionId);
  const svc = createEvaluationService({
    repository: f.repository,
    operationGate: f.operationGate,
    modelFactory: () => ({
      available: true,
      chatJson: async () => ({
        results: [
          {
            jobId: id,
            score: 95,
            reasons: ["本科"],
            gaps: [],
            evidence: [{ excerpt: "本科" }],
          },
        ],
      }),
    }),
  });
  const result = await svc.evaluate({
    scope,
    jobIds: [id],
    profileRevisionId: target.profileRevisionId,
    targetRevisionId: target.revisionId,
    mode: "ai",
  });
  assert.equal(result.evaluations[0].score, 95);
  assert.equal(result.evaluations[0].recommended, false);
  assert.equal(result.evaluations[0].recommendation, "insufficient");
});
test("body and application verification writes an owned observation, and rejects results after pause", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit(),
    saved = await c.commit({
      pageKey: "one",
      records: [
        job({
          detailStatus: "complete",
          deadlineAt: "2029-01-01",
          applyUrl: "https://jobs.example.com/apply",
        }),
      ],
      done: false,
      nextCursor: { page: 2 },
    }),
    id = saved.jobIds[0];
  let pause = false,
    calls = 0;
  const service = createJobVerificationService({
    repository: f.repository,
    registry: createSourceRegistry([]),
    activityContext: async (ref, callback) =>
      callback({
        ref,
        token: c.token,
        operationLease: c.lease,
        collectionGuard: { ref, token: c.token },
        request: async () => {
          calls++;
          if (pause) await f.service.pause(c.ref);
          return {
            status: 200,
            text: "<form><button>提交申请</button></form>",
          };
        },
      }),
  });
  const result = await service.verifyJob({
    scope: f.scope,
    jobId: id,
    ref: c.ref,
  });
  assert.equal(calls, 1);
  assert.equal(result.recruitmentEvidence.applicationStatus, "available");
  const before = await f.repository.read(),
    observations = Object.values(before.observations);
  assert.ok(
    observations.some(
      (o) =>
        o.ownerPackageId === f.scope.packageId &&
        o.fields.applicationVerification?.formVerified,
    ),
  );
  pause = true;
  await assert.rejects(
    () => service.verifyJob({ scope: f.scope, jobId: id, ref: c.ref }),
    { code: "collection_stale_epoch" },
  );
  assert.equal(
    Object.keys((await f.repository.read()).observations).length,
    observations.length,
  );
  await c.lease.release();
});
test("verification validates ownership before any request and source fact hash tracks proof changes", async (t) => {
  const f = await packageBusinessFixture(t),
    { a, b } = await f.twoTargets(),
    scope = { packageId: a.packageId, targetRevisionId: a.revisionId },
    other = { packageId: b.packageId, targetRevisionId: b.revisionId },
    [id] = await f.ingest(scope, [job()]);
  let calls = 0;
  const service = createJobVerificationService({
    repository: f.repository,
    registry: createSourceRegistry([]),
    activityContext: async () => {
      calls++;
    },
  });
  await assert.rejects(
    () =>
      service.verifyJob({
        scope: other,
        jobId: id,
        ref: { scope: other, activityId: "x" },
      }),
    { code: "package_scope_mismatch" },
  );
  assert.equal(calls, 0);
  assert.notEqual(
    jobFactHash(job()),
    jobFactHash(
      job({ applicationVerification: { status: 403, formVerified: false } }),
    ),
  );
});
