import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { createJobCleanupService } from "../../src/application/job-cleanup-service.mjs";
import { job } from "../helpers/fixtures.mjs";
import { contentHash } from "../../src/infrastructure/storage/repository.mjs";
async function seedDuplicates(f, scope, count = 3) {
  const [id] = await f.ingest(scope, [job()]);
  await f.repository.mutateWorkspace((w) => {
    const original = w.jobs[id];
    for (let i = 1; i < count; i++) {
      const clone = structuredClone(original);
      clone.jobId = id + "-" + i;
      clone.recordId = randomUUID();
      w.jobs[clone.jobId] = clone;
      const obs = structuredClone(
        Object.values(w.observations).find((o) => o.jobId === id),
      );
      obs.jobId = clone.jobId;
      obs.recordId = randomUUID();
      obs.observationId += "-" + i;
      w.observations[obs.observationId] = obs;
      w.targetMembers[scope.targetRevisionId][clone.jobId] = {
        ...structuredClone(w.targetMembers[scope.targetRevisionId][id]),
        factRefs: [{ observationId: obs.observationId }],
        currentObservationId: obs.observationId,
      };
    }
  });
  return id;
}
test("complementary duplicate facts allocate a new private observation identity in the cleanup transaction", async (t) => {
  const f = await packageBusinessFixture(t),
    { a, b } = await f.twoTargets();
  const id = await seedDuplicates(f, a, 2);
  await f.ingest(b, [job()]);
  await f.repository.mutateWorkspace((w) => {
    const observations = Object.values(w.observations).filter(
      (o) => o.ownerPackageId === a.packageId,
    );
    for (const [i, o] of observations.entries()) {
      o.fields.sourceEvidence = [
        {
          evidenceId: "complement-" + i,
          field: i ? "title" : "degree",
          value: i ? o.fields.title : o.fields.degree,
          status: "verified",
          sourceExcerpt: i ? o.fields.title : o.fields.degree,
          confidence: 100,
        },
      ];
      const member = w.targetMembers[a.revisionId][o.jobId];
      member.factContentHash = null;
    }
  });
  const cleanup = createJobCleanupService({ repository: f.repository }),
    preview = await cleanup.preview({ allVersions: true });
  assert.equal(preview.groups.length, 1);
  await cleanup.apply({
    ...preview,
    selectedGroupIds: preview.groups.map((g) => g.groupId),
  });
  const w = await f.repository.read(),
    observations = Object.values(w.observations).filter(
      (o) => o.ownerPackageId === a.packageId,
    );
  assert.equal(observations.length, 3);
  assert.equal(new Set(observations.map((o) => o.recordId)).size, 3);
  const combined = observations.find(
    (o) => o.sourceKind === "combined_evidence",
  );
  assert.equal(combined.derivedFromObservationIds.length, 2);
  assert.equal(combined.fields.sourceEvidence.length, 2);
  assert.equal(combined.contentHash, contentHash(combined.fields));
  assert.equal(
    Object.values(w.jobs).filter((j) => j.ownerPackageId === b.packageId)
      .length,
    1,
  );
});
test("all-version cleanup merges only within each owner and preserves facts and redirects", async (t) => {
  const f = await packageBusinessFixture(t);
  const { a, b } = await f.twoTargets();
  const ja = await seedDuplicates(f, a);
  const [jb] = await f.ingest(b, [job()]);
  const cleanup = createJobCleanupService({ repository: f.repository });
  const p = await cleanup.preview({ allVersions: true });
  assert.equal(p.groups.length, 1);
  assert.equal(p.groups[0].packageId, a.packageId);
  const r = await cleanup.apply({
    ...p,
    selectedGroupIds: p.groups
      .filter((g) => !g.protected)
      .map((g) => g.groupId),
  });
  assert.equal(r.totals.removedEntities, 2);
  assert.equal(
    r.packages.find((x) => x.packageId === a.packageId).counts.removedEntities,
    2,
  );
  const w = await f.repository.read();
  assert.equal(
    Object.values(w.jobs).filter((j) => j.ownerPackageId === a.packageId)
      .length,
    1,
  );
  assert.equal(w.jobs[jb].ownerPackageId, b.packageId);
  assert.equal(
    Object.values(w.observations).filter(
      (o) => o.ownerPackageId === a.packageId,
    ).length,
    3,
  );
  assert.ok(
    Object.values(w.jobRedirects).every(
      (x) => x.ownerPackageId === a.packageId,
    ),
  );
  assert.equal((await f.jobs.getJob(ja + "-1", a)).observations.length, 3);
  await assert.rejects(() => f.jobs.getJob(ja + "-1", b), {
    code: "package_scope_mismatch",
  });
});
test("disabled and unexpired trash are included while expiry invalidates the exact preview", async (t) => {
  const f = await packageBusinessFixture(t);
  const { a, b } = await f.twoTargets();
  await seedDuplicates(f, a);
  await seedDuplicates(f, b);
  await f.repository.mutateWorkspace((w) => {
    w.packages[a.packageId].enabled = false;
    Object.assign(w.packages[b.packageId], {
      state: "trashed",
      archiveId: randomUUID(),
      archivedAt: "2026-10-09T00:00:00.000Z",
      purgeAt: "2026-10-12T00:00:00.000Z",
    });
  });
  const cleanup = createJobCleanupService({ repository: f.repository });
  const p = await cleanup.preview({ allVersions: true });
  assert.equal(p.groups.length, 2);
  assert.ok(p.groups.find((g) => g.packageId === b.packageId).archiveId);
  f.clock.advance(72 * 3600 * 1000);
  await assert.rejects(
    () =>
      cleanup.apply({ ...p, selectedGroupIds: p.groups.map((g) => g.groupId) }),
    { code: "duplicate_plan_stale" },
  );
  assert.equal((await cleanup.preview({ allVersions: true })).groups.length, 1);
});
test("multiple manual applications in a duplicate group remain protected", async (t) => {
  const f = await packageBusinessFixture(t);
  const { a } = await f.twoTargets();
  const id = await seedDuplicates(f, a, 2);
  await f.jobs.updateJobApplication(
    id,
    { status: "applied", note: "合成A" },
    a,
  );
  await f.jobs.updateJobApplication(
    id + "-1",
    { status: "interviewing", note: "合成B" },
    a,
  );
  const cleanup = createJobCleanupService({ repository: f.repository }),
    p = await cleanup.preview({ allVersions: true });
  assert.equal(p.groups[0].protected, true);
  await assert.rejects(
    () => cleanup.apply({ ...p, selectedGroupIds: [p.groups[0].groupId] }),
    { code: "invalid_duplicate_selection" },
  );
  assert.equal(Object.keys((await f.repository.read()).applications).length, 2);
});
