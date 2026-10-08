import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createEmptyWorkspace,
  assertWorkspace,
} from "../../src/domain/contracts.mjs";
import { tempRepository } from "../helpers/repository.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
import { openPackageControl } from "../../src/infrastructure/storage/package-control.mjs";
import { normalizeBackupOwnership } from "../../src/infrastructure/storage/package-migration.mjs";
import { bootstrapWorkspace } from "../../src/infrastructure/storage/bootstrap-workspace.mjs";
import { failOnce } from "../helpers/package-fixture.mjs";

export function legacyWorkspace() {
  const w = createEmptyWorkspace({ schemaVersion: 2 });
  w.profiles.p = [
    {
      profileId: "p",
      revisionId: "p@1",
      revision: 1,
      text: "合成简历",
      profile: { name: "合成候选人" },
      overrides: {},
      parserVersion: "synthetic",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  for (const id of ["a", "b"])
    w.targets[id] = [
      {
        targetId: id,
        revisionId: id + "@1",
        revision: 1,
        profileRevisionId: "p@1",
        roles: ["消防"],
        enabled: true,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ];
  const record = {
    sourceId: "synthetic",
    siteId: "synthetic-1",
    sourceRecordId: "one",
    identityScope: "synthetic-1",
    kind: "job",
    title: "消防岗位",
    company: "合成公司",
    cities: ["北京"],
    jobType: "social",
    url: "https://example.com/jobs/one",
    description: "合成岗位正文",
    evidence: [],
    parserVersion: "synthetic",
  };
  w.jobs.j = {
    jobId: "j",
    kind: "job",
    canonical: record,
    sourceRefs: [],
    identityAliases: ["old-alias"],
    firstSeen: "2026-01-03T00:00:00.000Z",
    lastSeen: "2026-01-03T00:00:00.000Z",
    targetFirstSeen: {},
    lifecycle: "observed",
    lifecycleEvidence: [],
    deadlinePassed: false,
    duplicateGroupIds: [],
  };
  for (const id of ["a", "b"]) {
    w.runs["r-" + id] = {
      runId: "r-" + id,
      targetSnapshot: structuredClone(w.targets[id][0]),
      status: "completed",
      stage: "finished",
      events: [{ seq: 1, type: "done", at: "2026-01-03T00:00:00.000Z" }],
      snapshotRef: null,
    };
    w.observations["o-" + id] = {
      observationId: "o-" + id,
      jobId: "j",
      runId: "r-" + id,
      record,
      observedAt: "2026-01-03T00:00:00.000Z",
    };
  }
  w.applications.j = {
    jobId: "j",
    status: "applied",
    note: "合成旧投递备注",
    resumeRevisionId: "p@1",
    events: [{ type: "note", note: "合成历史" }],
  };
  return w;
}
export async function seedLegacy(
  t,
  { workspace = legacyWorkspace(), failPhase } = {},
) {
  const repository = await tempRepository(t);
  await fs.writeFile(
    path.join(repository.dataDir, "workspace.v2.json"),
    JSON.stringify(workspace),
  );
  const adapter = failOnce(fs);
  if (failPhase) adapter.arm(failPhase);
  const repo = await openWorkspaceRepository({
    dataDir: repository.dataDir,
    fsAdapter: adapter,
  });
  return {
    repository: repo,
    dataDir: repo.dataDir,
    control: openPackageControl({ dataDir: repo.dataDir }),
    adapter,
  };
}
test("ambiguous application remains once in an unassigned package and posting facts stay isolated", () => {
  const n = normalizeBackupOwnership({
    workspace: legacyWorkspace(),
    snapshots: {},
    now: "2026-10-09T00:00:00.000Z",
  });
  assertWorkspace(n.workspace);
  const apps = Object.values(n.workspace.applications);
  assert.equal(apps.length, 1);
  assert.equal(
    n.workspace.packages[apps[0].ownerPackageId].kind,
    "legacy_unassigned",
  );
  assert.equal(apps[0].note, "合成旧投递备注");
  const targetOwners = Object.values(n.workspace.targets)
    .flat()
    .map((t) => t.ownerPackageId);
  for (const owner of targetOwners)
    assert.equal(
      Object.values(n.workspace.jobs).filter((j) => j.ownerPackageId === owner)
        .length,
      1,
    );
  assert.equal(
    new Set(Object.values(n.workspace.jobs).map((j) => j.recordId)).size,
    3,
  );
});
test("immutable identities ignore rename and enabled changes but reject changed revision contents", () => {
  const old = legacyWorkspace(),
    first = normalizeBackupOwnership({
      workspace: old,
      snapshots: {},
      now: "2026-10-09T00:00:00.000Z",
    });
  old.targets.a[0].enabled = false;
  old.targets.a[0].versionName = "改名";
  const second = normalizeBackupOwnership({
    workspace: old,
    snapshots: {},
    control: first.control,
    now: "2026-10-10T00:00:00.000Z",
  });
  assert.equal(
    first.workspace.targets.a[0].ownerPackageId,
    second.workspace.targets.a[0].ownerPackageId,
  );
  assert.equal(
    first.workspace.applications[Object.keys(first.workspace.applications)[0]]
      .recordId,
    Object.values(second.workspace.applications)[0].recordId,
  );
  old.profiles.p[0].text = "冲突正文";
  assert.throws(
    () =>
      normalizeBackupOwnership({
        workspace: old,
        snapshots: {},
        control: first.control,
        now: "2026-10-10T00:00:00.000Z",
      }),
    { code: "migration_identity_conflict" },
  );
});
test("target copies verified resume independently or becomes incomplete", () => {
  const old = legacyWorkspace();
  old.targets.b[0].profileRevisionId = "missing@1";
  const n = normalizeBackupOwnership({
    workspace: old,
    snapshots: {},
    now: "2026-10-09T00:00:00.000Z",
  });
  const a = n.workspace.targets.a[0],
    b = n.workspace.targets.b[0];
  assert.equal(a.profileSnapshot.text, "合成简历");
  assert.equal(a.profileSnapshot.ownerPackageId, a.ownerPackageId);
  assert.notEqual(
    a.profileSnapshot.recordId,
    n.workspace.profiles.p[0].recordId,
  );
  assert.equal(b.profileSnapshot, null);
  assert.equal(b.incomplete, true);
});
test("orphan and contradictory records are preserved in the unassigned package", () => {
  const old = legacyWorkspace();
  old.observations["o-a"].targetRevisionId = "b@1";
  old.observations.orphan = {
    observationId: "orphan",
    jobId: "missing",
    runId: "missing",
    record: { title: "合成孤立事实" },
  };
  old.evaluations.orphan = {
    evaluationId: "orphan",
    jobId: "missing",
    score: 51,
  };
  const n = normalizeBackupOwnership({
    workspace: old,
    now: "2026-10-09T00:00:00.000Z",
  });
  assert.equal(Object.values(n.workspace.observations).length, 3);
  assert.equal(Object.values(n.workspace.evaluations).length, 1);
  const conflicted = Object.values(n.workspace.observations).find(
    (o) => o.provenance?.legacyObservationId === "o-a",
  );
  assert.equal(
    n.workspace.packages[conflicted.ownerPackageId].kind,
    "legacy_unassigned",
  );
  assert.equal(conflicted.runId, null);
  assertWorkspace(n.workspace);
});
test("legacy manual associations retain one editable owner rather than being cloned into every target", () => {
  const old = legacyWorkspace();
  old.jobs.j2 = { ...structuredClone(old.jobs.j), jobId: "j2" };
  old.duplicateGroups.g = { groupId: "g", jobIds: ["j", "j2"], manual: true };
  const n = normalizeBackupOwnership({
    workspace: old,
    now: "2026-10-09T00:00:00.000Z",
  });
  const groups = Object.values(n.workspace.duplicateGroups);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].manual, true);
  assert.equal(
    n.workspace.packages[groups[0].ownerPackageId].kind,
    "legacy_unassigned",
  );
  assert.equal(groups[0].jobIds.length, 2);
  assertWorkspace(n.workspace);
});
test("legacy grace and invalid archive date are granted once across retry and backup normalization", () => {
  for (const archivedAt of ["2025-01-01T00:00:00.000Z", "无法确认"]) {
    const old = legacyWorkspace();
    old.versionMetadata = {
      "a@1": {
        kind: "target",
        versionName: "合成目标",
        nameKey: "合成目标",
        enabled: true,
        archivedAt,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    };
    const first = normalizeBackupOwnership({
      workspace: old,
      snapshots: {},
      now: "2026-10-09T00:00:00.000Z",
    });
    const retry = normalizeBackupOwnership({
      workspace: old,
      snapshots: {},
      control: first.control,
      now: "2026-10-10T00:00:00.000Z",
    });
    const id = first.workspace.targets.a[0].ownerPackageId;
    assert.equal(
      retry.workspace.packages[id].archiveId,
      first.workspace.packages[id].archiveId,
    );
    assert.equal(
      retry.workspace.packages[id].purgeAt,
      "2026-10-12T00:00:00.000Z",
    );
    assert.equal(
      retry.workspace.packages[id].archiveDateUnknown,
      archivedAt === "无法确认",
    );
  }
});
test("failed main migration commit retains legacy and prepared identities for restart", async (t) => {
  const f = await seedLegacy(t, { failPhase: "workspace_commit" }),
    raw = await fs.readFile(path.join(f.dataDir, "workspace.v2.json"), "utf8");
  await assert.rejects(
    bootstrapWorkspace({
      repository: f.repository,
      clock: { now: () => new Date("2026-10-09T00:00:00.000Z") },
    }),
  );
  assert.equal(
    await fs.readFile(path.join(f.dataDir, "workspace.v2.json"), "utf8"),
    raw,
  );
  const ids = (await f.control.read()).identityIndex;
  const repo = await openWorkspaceRepository({ dataDir: f.dataDir });
  await bootstrapWorkspace({
    repository: repo,
    clock: { now: () => new Date("2026-10-10T00:00:00.000Z") },
  });
  assert.deepEqual((await f.control.read()).identityIndex, ids);
  assert.equal((await repo.read()).schemaVersion, 3);
  const before = await repo.read();
  await bootstrapWorkspace({ repository: repo });
  assert.deepEqual(await repo.read(), before);
});
test("new installation becomes schema3 and missing legacy snapshots are reported without losing run history", async (t) => {
  const repo = await tempRepository(t);
  await bootstrapWorkspace({ repository: repo });
  assert.equal((await repo.read()).schemaVersion, 3);
  const old = legacyWorkspace();
  old.runs["r-a"].snapshotRef = { path: "runs-v2/r-a.json", hash: "missing" };
  const f = await seedLegacy(t, { workspace: old });
  const report = await bootstrapWorkspace({ repository: f.repository });
  assert.ok(report.warnings.includes("missing_legacy_snapshot"));
  assert.equal(Object.keys((await f.repository.read()).runs).length, 2);
});
test("post-commit legacy-file cleanup resumes on startup without another revision or identity allocation", async (t) => {
  const old = legacyWorkspace();
  old.runs["r-a"].snapshotRef = { path: "runs-v2/r-a.json", hash: "old" };
  const f = await seedLegacy(t, { workspace: old });
  await fs.mkdir(path.join(f.dataDir, "runs-v2"), { recursive: true });
  await fs.writeFile(
    path.join(f.dataDir, "runs-v2/r-a.json"),
    JSON.stringify({ run: old.runs["r-a"] }),
  );
  let removals = 0;
  await assert.rejects(
    bootstrapWorkspace({
      repository: f.repository,
      fsAdapter: {
        ...fs,
        async unlink(...args) {
          if (args[0] === path.join(f.dataDir, "runs-v2/r-a.json")) {
            removals++;
            throw Object.assign(Error("injected cleanup failure"), {
              code: "EACCES",
            });
          }
          return fs.unlink(...args);
        },
      },
    }),
    { code: "EACCES" },
  );
  assert.equal(removals, 1);
  const before = await f.repository.read();
  assert.equal(before.schemaVersion, 3);
  const identities = (await f.control.read()).identityIndex;
  await bootstrapWorkspace({ repository: f.repository });
  assert.deepEqual(await f.repository.read(), before);
  assert.deepEqual((await f.control.read()).identityIndex, identities);
  await assert.rejects(fs.stat(path.join(f.dataDir, "runs-v2/r-a.json")), {
    code: "ENOENT",
  });
  const run = Object.values(before.runs).find(
    (r) => r.provenance.legacyRunId === "r-a",
  );
  assert.equal(
    (await f.repository.readRunSnapshot(run.runId)).ownerPackageId,
    run.ownerPackageId,
  );
});
test("V1 is consumed only after schema3 commit and repeated startup preserves identities", async (t) => {
  const repo = await tempRepository(t);
  await fs.writeFile(
    path.join(repo.dataDir, "job-index.json"),
    JSON.stringify({
      version: 1,
      jobs: {
        one: {
          id: "one",
          title: "合成消防岗位",
          url: "https://example.com/jobs/one",
          note: "合成备注",
          status: "interested",
        },
      },
    }),
  );
  await bootstrapWorkspace({ repository: repo });
  const w = await repo.read();
  assert.equal(w.schemaVersion, 3);
  assert.equal(Object.values(w.applications)[0].note, "合成备注");
  await assert.rejects(fs.stat(path.join(repo.dataDir, "job-index.json")), {
    code: "ENOENT",
  });
  await bootstrapWorkspace({ repository: repo });
  assert.deepEqual(await repo.read(), w);
});
