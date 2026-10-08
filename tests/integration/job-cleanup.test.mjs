import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
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
import {
  contentHash,
  openWorkspaceRepository,
} from "../../src/infrastructure/storage/repository.mjs";
import { restoreBackup } from "../../src/infrastructure/storage/backup.mjs";
import { resolveJobId } from "../../src/domain/job-resolution.mjs";
const cleanup = async (repository) => {
  const { createJobCleanupService } = await import(
    "../../src/application/job-cleanup-service.mjs"
  );
  return createJobCleanupService({ repository });
};
async function fixture(t) {
  const repository = await tempRepository(t),
    ws = createWorkspaceService({ repository }),
    jobs = createJobService({ repository });
  const p = await ws.saveProfile({ profile: profile() }),
    a = await ws.saveTarget(
      namedTargetInput({ ...target(), profileRevisionId: p.revisionId }),
    ),
    b = await ws.saveTarget(namedTargetInput({ ...a }));
  const {
    jobIds: [id],
    observationIds: [oid],
  } = await jobs.ingestRecords({
    runId: "fixture",
    targetRevisionId: a.revisionId,
    records: [job()],
  });
  await jobs.updateApplication(id, {
    status: "applied",
    note: "保留合成人工记录",
  });
  await repository.mutateWorkspace((w) => {
    const base = w.jobs[id];
    w.jobs.copy1 = { ...structuredClone(base), jobId: "copy1" };
    w.jobs.copy2 = { ...structuredClone(base), jobId: "copy2" };
    w.observations.copyObservation = {
      ...structuredClone(w.observations[oid]),
      observationId: "copyObservation",
      jobId: "copy1",
    };
    w.targetMembers[a.revisionId].copy1 = {
      ...structuredClone(w.targetMembers[a.revisionId][id]),
      factRefs: [{ observationId: "copyObservation" }],
      currentObservationId: "copyObservation",
    };
    w.targetMembers[b.revisionId] = {
      copy2: structuredClone(w.targetMembers[a.revisionId][id]),
    };
    w.versionMetadata[b.revisionId].archivedAt = AT;
    w.versionMetadata[a.revisionId].enabled = false;
    w.evaluations.old = {
      evaluationId: "old",
      jobId: "copy1",
      jdHash: "historical",
      targetRevisionId: a.revisionId,
    };
    w.identityAliases["old-source"] = ["copy1", "copy2"];
  });
  return { repository, ws, jobs, id, a, b };
}
test("all-version cleanup preserves manual history, immutable evidence, and restoreable backup", async (t) => {
  const { repository, id, a, b } = await fixture(t),
    service = await cleanup(repository),
    before = await repository.read(),
    preview = await service.preview();
  assert.equal(preview.groups.length, 1);
  assert.equal(preview.counts.removedEntities, 2);
  assert.equal(preview.counts.collapsedVersionEntries, 1);
  assert.deepEqual(
    new Set(preview.groups[0].targetRevisionIds),
    new Set([a.revisionId, b.revisionId]),
  );
  assert.equal(preview.groups[0].keepJobId, id);
  const result = await service.apply({
      ...preview,
      selectedGroupIds: preview.groups.map((g) => g.groupId),
    }),
    after = await repository.read();
  assert.equal(result.counts.removedEntities, 2);
  assert.equal(result.counts.collapsedVersionEntries, 1);
  assert.ok(result.backupId);
  assert.deepEqual(after.applications[id], before.applications[id]);
  assert.deepEqual(after.observations, before.observations);
  assert.deepEqual(after.evaluations, before.evaluations);
  assert.equal(resolveJobId(after, "copy1"), id);
  assert.equal(resolveJobId(after, "old-source"), id);
  assert.equal(Object.keys(after.targetMembers[a.revisionId]).length, 1);
  await assert.rejects(
    service.apply({
      ...preview,
      selectedGroupIds: [preview.groups[0].groupId],
    }),
    (e) => e.code === "duplicate_plan_stale",
  );
  await restoreBackup({
    repository,
    archivePath: path.join(repository.dataDir, "backups", result.backupId),
  });
  const restored = await repository.read();
  for (const key of [
    "jobs",
    "applications",
    "observations",
    "evaluations",
    "targetMembers",
    "versionMetadata",
  ])
    assert.deepEqual(restored[key], before[key]);
});
test("two independent direct or indirect manual applications protect the entire group", async (t) => {
  const { repository, id } = await fixture(t);
  await repository.mutateWorkspace((w) => {
    w.applications.legacy = {
      jobId: "legacy",
      status: "applied",
      note: "第二份合成人工记录",
      events: [{ type: "manual" }],
      legacyJobIds: ["copy1", "copy2"],
    };
  });
  const preview = await (await cleanup(repository)).preview();
  assert.equal(preview.protectedGroups.length, 1);
  assert.equal(preview.counts.removedEntities, 0);
  assert.equal(preview.groups[0].protected, true);
  await assert.rejects(
    (await cleanup(repository)).apply({
      ...preview,
      selectedGroupIds: [preview.groups[0].groupId],
    }),
    (e) => e.code === "invalid_duplicate_selection",
  );
  assert.equal(Object.keys((await repository.read()).jobs).length, 3);
  assert.equal((await repository.read()).applications[id].status, "applied");
});
test("unassigned duplicates participate, shared entity membership and possible pairs are not deletions", async (t) => {
  const { repository, id, a } = await fixture(t);
  await repository.mutateWorkspace((w) => {
    delete w.jobs.copy1;
    delete w.jobs.copy2;
    delete w.observations.copyObservation;
    delete w.targetMembers[a.revisionId].copy1;
    w.targetMembers = {};
    w.jobs.other = { ...structuredClone(w.jobs[id]), jobId: "other" };
  });
  const preview = await (await cleanup(repository)).preview();
  assert.equal(preview.counts.removedEntities, 1);
  assert.equal(preview.counts.collapsedVersionEntries, 0);
  await repository.mutateWorkspace((w) => {
    for (const j of Object.values(w.jobs)) {
      j.canonical.sourceRecordIdKind = "hint";
      j.canonical.urlKind = "unknown";
      j.canonical.description = "点击详情";
    }
  });
  const weak = await (await cleanup(repository)).preview();
  assert.equal(weak.groups.length, 0);
  assert.equal(weak.possiblePairs.length, 1);
});
test("confirmed groups require pairwise evidence rather than transitive similarity", async () => {
  const { buildWorkspaceDuplicatePlan } = await import(
    "../../src/domain/job-duplicates.mjs"
  );
  const canonical = job(),
    records = {
      a: canonical,
      b: {
        ...canonical,
        sourceId: "other",
        identityScope: "other",
        sourceRecordId: "2",
      },
      c: { ...canonical, sourceRecordId: "3" },
    };
  const w = {
    revision: 1,
    jobs: Object.fromEntries(
      Object.entries(records).map(([jobId, canonical]) => [
        jobId,
        { jobId, canonical, firstSeen: AT },
      ]),
    ),
    applications: {},
    targetMembers: {},
    identityAliases: {},
    jobRedirects: {},
    observations: {},
    evaluations: {},
  };
  const preview = buildWorkspaceDuplicatePlan(w);
  assert.ok(preview.groups.every((g) => g.removeJobIds.length === 1));
  assert.equal(preview.counts.removedEntities, 1);
});
test("note changes, forged selections, backup failure and atomic commit failure never partially delete", async (t) => {
  const { repository, id } = await fixture(t),
    service = await cleanup(repository);
  let preview = await service.preview();
  await repository.mutateWorkspace((w) => {
    w.applications[id].note = "预览后修改";
  });
  await assert.rejects(
    service.apply({
      ...preview,
      selectedGroupIds: [preview.groups[0].groupId],
    }),
    (e) => e.code === "duplicate_plan_stale",
  );
  preview = await service.preview();
  await assert.rejects(
    service.apply({ ...preview, selectedGroupIds: ["forged"] }),
    (e) => e.code === "invalid_duplicate_selection",
  );
  await repository.mutateWorkspace((w) => {
    w.runs.missing = {
      runId: "missing",
      status: "completed",
      snapshotRef: { path: "runs-v2/missing.json", hash: "missing" },
    };
  });
  preview = await service.preview();
  await assert.rejects(
    service.apply({
      ...preview,
      selectedGroupIds: [preview.groups[0].groupId],
    }),
  );
  assert.equal(Object.keys((await repository.read()).jobs).length, 3);
  await repository.mutateWorkspace((w) => {
    delete w.runs.missing;
  });
  let failed = false;
  const faulty = await openWorkspaceRepository({
    dataDir: repository.dataDir,
    fsAdapter: {
      ...fs,
      rename: async (from, to) => {
        if (!failed && to.endsWith("workspace.v2.json")) {
          const body = JSON.parse(await fs.readFile(from, "utf8"));
          if (Object.keys(body.jobs).length === 1) {
            failed = true;
            throw Object.assign(Error("synthetic commit failure"), {
              code: "EIO",
            });
          }
        }
        return fs.rename(from, to);
      },
    },
  });
  const faultyService = await cleanup(faulty);
  preview = await faultyService.preview();
  const before = await repository.read();
  await assert.rejects(
    faultyService.apply({
      ...preview,
      selectedGroupIds: [preview.groups[0].groupId],
    }),
    /synthetic commit/,
  );
  const after = await repository.read();
  assert.equal(contentHash(after.jobs), contentHash(before.jobs));
  assert.deepEqual(after.operationLeases, {});
});
test("empty cleanup has exact zero deletion counts", async (t) => {
  const repository = await tempRepository(t),
    service = await cleanup(repository),
    preview = await service.preview();
  const result = await service.apply({ ...preview, selectedGroupIds: [] });
  assert.equal(result.counts.removedEntities, 0);
  assert.equal(Object.keys((await repository.read()).jobs).length, 0);
});
