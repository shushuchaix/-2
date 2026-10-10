import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { projectCollectionQuality } from "../../src/domain/collection-quality.mjs";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
import { RULE_VERSION } from "../../src/domain/ranking-policy.mjs";
import { CONDITIONS_PARSER_VERSION } from "../../src/domain/recruitment-evidence.mjs";
import {
  jobFactHash,
  selectVersionJobFact,
} from "../../src/domain/job-facts.mjs";
const now = Date.parse("2026-10-10T00:00:00Z");
const valid = (overrides = {}) =>
  job({
    detailStatus: "complete",
    deadlineAt: "2027-01-01",
    applyUrl: "https://jobs.example.com/apply",
    applicationVerification: {
      status: 200,
      formVerified: true,
      checkedAt: new Date(now).toISOString(),
    },
    ...overrides,
  });
function memory() {
  const w = {
    schemaVersion: 2,
    jobs: {},
    observations: {},
    targetMembers: {},
    evaluations: {},
  };
  function add(
    target,
    id,
    record,
    status = "pass",
    profile = "copy-" + target,
  ) {
    w.jobs[id] ||= { jobId: id, canonical: valid() };
    const observationId = target + "-" + id;
    w.observations[observationId] = {
      observationId,
      jobId: id,
      fields: record,
      observedAt: new Date(now).toISOString(),
    };
    (w.targetMembers[target] ||= {})[id] = { factRefs: [{ observationId }] };
    w.evaluations[observationId] = {
      evaluationId: observationId,
      jobId: id,
      targetRevisionId: target,
      profileRevisionId: profile,
      factContentHash: jobFactHash(record),
      qualification: { status },
      ruleVersion: RULE_VERSION,
      conditionsParserVersion: CONDITIONS_PARSER_VERSION,
      createdAt: new Date(now).toISOString(),
    };
  }
  return {
    w,
    add,
    root: (target, ids, usage = {}) => ({
      targetSnapshot: {
        revisionId: target,
        profileRevisionId: "original-profile",
      },
      profileSnapshot: { revisionId: "copy-" + target },
      collectionUsage: usage,
      collectionProgress: { newJobIds: ids },
    }),
  };
}
test("quality uses each version's facts and owned profile, counts overlap without a fake funnel", () => {
  const f = memory();
  f.add("A", "same", valid());
  f.add(
    "B",
    "same",
    valid({
      description: null,
      detailStatus: "pending",
      applicationVerification: null,
    }),
    "unknown",
  );
  f.add(
    "A",
    "expired",
    valid({
      deadlineAt: "2020-01-01",
      applicationVerification: { status: "invalid" },
    }),
    "unknown",
  );
  f.add(
    "A",
    "no-apply",
    valid({ applyUrl: null, applicationVerification: null }),
    "fail",
  );
  const before = structuredClone(f.w);
  const a = projectCollectionQuality(f.w, {
    root: f.root("A", ["same", "same", "expired", "no-apply"], {
      knownPhysicalRequests: 10,
      unknownRequestUpperBound: 2,
    }),
    now,
  });
  const b = projectCollectionQuality(f.w, { root: f.root("B", ["same"]), now });
  assert.equal(a.uniqueRecords, 3);
  assert.equal(a.bodyVerified, 3);
  assert.equal(a.open, 2);
  assert.equal(a.applicationAvailable, 1);
  assert.equal(a.qualificationPass, 1);
  assert.equal(a.qualificationUnknown, 1);
  assert.equal(a.qualificationFail, 1);
  assert.equal(a.historicalOrExpired, 1);
  assert.equal(a.validNewUnique, 1);
  assert.equal(a.knownRequests, 10);
  assert.equal(a.unknownRequestUpperBound, 2);
  assert.equal(a.validPer100KnownRequests, 10);
  assert.equal(b.bodyVerified, 0);
  assert.equal(b.validNewUnique, 0);
  assert.equal(b.validPer100KnownRequests, null);
  assert.deepEqual(f.w, before);
});
test("stale form and communication evidence cannot be a verified recommendation; nonmembers are excluded", () => {
  const f = memory();
  f.add(
    "A",
    "stale",
    valid({
      applicationVerification: {
        status: 200,
        formVerified: true,
        checkedAt: "2026-10-06T00:00:00Z",
      },
    }),
  );
  f.add(
    "A",
    "communication",
    valid({
      applyUrl: null,
      applicationVerification: null,
      platformEvidence: { communication: true, active: true },
    }),
  );
  f.add("B", "foreign", valid());
  const result = projectCollectionQuality(f.w, {
    root: f.root("A", ["stale", "communication", "foreign"]),
    now,
  });
  assert.equal(result.uniqueRecords, 2);
  assert.equal(result.applicationAvailable, 0);
  assert.equal(result.validNewUnique, 0);
  assert.equal(result.suspectedDuplicates, 0);
});
test("suspected duplicate count counts affected records once and stays inside the version", () => {
  const f = memory();
  f.add(
    "A",
    "one",
    valid({
      sourceRecordId: null,
      url: "https://a.example/jobs/1",
      major: ["消防工程"],
    }),
  );
  f.add(
    "A",
    "two",
    valid({
      sourceRecordId: null,
      url: "https://b.example/jobs/2",
      major: ["安全工程"],
    }),
  );
  f.add("B", "other", valid());
  const result = projectCollectionQuality(f.w, {
    root: f.root("A", ["one", "two"]),
    now,
  });
  assert.equal(result.suspectedDuplicates, 2);
});
test("a cleaned duplicate redirects to its surviving version member without losing quality", () => {
  const f = memory();
  f.add("A", "survivor", valid());
  f.w.jobRedirects = { retired: { toJobId: "survivor" } };
  const q = projectCollectionQuality(f.w, {
    root: f.root("A", ["retired", "survivor"]),
    now,
  });
  assert.equal(q.uniqueRecords, 1);
  const aliasOnly = projectCollectionQuality(f.w, {
    root: f.root("A", ["retired"]),
    now,
  });
  assert.equal(aliasOnly.validNewUnique, 1);
});
test("collection get uses the copied resume evaluation and exposes the same valid count", async (t) => {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  const result = await c.commit({
    pageKey: "page",
    records: [
      valid({
        applicationVerification: {
          status: 200,
          formVerified: true,
          checkedAt: new Date(f.clock.now()).toISOString(),
        },
      }),
    ],
    done: true,
  });
  await f.repository.mutateWorkspace(
    (w) => {
      const id = result.jobIds[0],
        fact = selectVersionJobFact(w, {
          jobId: id,
          targetRevisionId: f.scope.targetRevisionId,
        });
      const evaluationId = "e-" + randomUUID();
      w.evaluations[evaluationId] = {
        recordId: randomUUID(),
        ownerPackageId: f.scope.packageId,
        evaluationId,
        jobId: id,
        targetRevisionId: f.scope.targetRevisionId,
        profileRevisionId: f.target.profileSnapshot.revisionId,
        factContentHash: fact.factContentHash,
        ruleVersion: RULE_VERSION,
        conditionsParserVersion: CONDITIONS_PARSER_VERSION,
        qualification: { status: "pass" },
        createdAt: new Date(f.clock.now()).toISOString(),
      };
    },
    { operationLease: c.lease },
  );
  const root = await f.service.get(c.ref);
  assert.equal(root.quality.uniqueRecords, 1);
  assert.equal(root.quality.qualificationPass, 1);
  assert.equal(root.quality.validNewUnique, 1);
  assert.equal(
    root.collectionProgress.metrics.validNewUnique,
    root.quality.validNewUnique,
  );
  assert.equal(f.networkCalls, 0);
});
