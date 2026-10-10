import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { createPurgeService } from "../../src/application/purge-service.mjs";
import {
  createBackup,
  validateBackupArchive,
} from "../../src/infrastructure/storage/backup.mjs";
import { contentHash } from "../../src/infrastructure/storage/repository.mjs";
import { tempRepository } from "../helpers/repository.mjs";
import { bootstrapWorkspace } from "../../src/infrastructure/storage/bootstrap-workspace.mjs";
import { createTrashService } from "../../src/application/trash-service.mjs";
async function fixture(t) {
  const f = await packageBusinessFixture(t);
  Object.assign(f, await f.twoTargets());
  const records = [
    {
      title: "合成消防员",
      company: "合成机场",
      url: "https://example.invalid/jobs/1",
      sourceId: "synthetic",
      description: "合成公开岗位",
    },
  ];
  f.aJobs = await f.ingest(f.a, records);
  f.bJobs = await f.ingest(f.b, records);
  await f.jobs.updateJobApplication(
    f.aJobs[0],
    {
      status: "applied",
      note: "ONLY-A-PRIVATE-NOTE",
      resumeRevisionId: f.a.profileSnapshot.revisionId,
    },
    f.a,
  );
  await f.repository.withMaintenanceTransaction(async (tx) => {
    const w = structuredClone(tx.workspace);
    for (const scope of [f.a, f.b]) {
      const run = Object.values(w.runs).find(
        (r) => r.ownerPackageId === scope.packageId,
      );
      const snapshot = {
        recordId: randomUUID(),
        ownerPackageId: scope.packageId,
        run: structuredClone(run),
        privateMarker: scope === f.a ? "ONLY-A-SNAPSHOT" : "ONLY-B-SNAPSHOT",
      };
      run.snapshotRef = await tx.writeSnapshot(run.runId, snapshot);
      const recordId = randomUUID();
      w.files[recordId] = {
        fileId: recordId,
        recordId,
        ownerPackageId: scope.packageId,
        runId: run.runId,
        snapshotRecordId: snapshot.recordId,
        path: run.snapshotRef.path,
        hash: run.snapshotRef.hash,
        kind: "run_snapshot",
      };
    }
    await tx.commitWorkspace(w);
  });
  f.backup = await createBackup({ repository: f.repository });
  const wire = () => {
    f.purge = createPurgeService({
      repository: f.repository,
      trash: f.trash,
      fsAdapter: f.fsAdapter,
    });
    f.trash.setPurgeService(f.purge);
  };
  wire();
  const reopen = f.reopen;
  f.reopen = async () => {
    await reopen();
    wire();
    return f;
  };
  await f.trash.archive({ packageId: f.a.packageId });
  return f;
}
test("permanent purge removes all package copies and preserves peer data", async (t) => {
  const f = await fixture(t),
    before = await f.repository.read(),
    peer = Object.values(before.jobs).find(
      (j) => j.ownerPackageId === f.b.packageId,
    );
  const r = await f.purge.execute(await f.trash.preview({ emptyAll: true }), {
    reason: "empty",
  });
  assert.deepEqual(r.completed, [f.a.packageId]);
  assert.deepEqual(r.pending, []);
  const w = await f.repository.read();
  assert.ok(!w.packages[f.a.packageId]);
  assert.deepEqual(w.jobs[peer.jobId], peer);
  const b = validateBackupArchive(
    JSON.parse(await fs.readFile(f.backup.path, "utf8")),
  );
  assert.ok(!b.workspace.packages[f.a.packageId]);
  assert.ok(b.workspace.packages[f.b.packageId]);
  for (const filename of [
    path.join(f.dataDir, "workspace.v2.json"),
    path.join(f.dataDir, "workspace.v2.previous.json"),
    f.backup.path,
  ]) {
    const s = await fs.readFile(filename, "utf8");
    assert.ok(!s.includes("ONLY-A-PRIVATE-NOTE"));
    assert.ok(!s.includes("ONLY-A-SNAPSHOT"));
  }
  for (const name of await fs.readdir(path.join(f.dataDir, "runs-v2")))
    assert.ok(
      !(
        await fs.readFile(path.join(f.dataDir, "runs-v2", name), "utf8")
      ).includes("ONLY-A-SNAPSHOT"),
    );
});
for (const phase of [
  "workspace_commit",
  "previous_commit",
  "file_cleanup",
  "backup_replace",
])
  test(`${phase} remains hidden pending and resumes after restart`, async (t) => {
    const f = await fixture(t),
      lease = await f.operationGate.acquire("permanent-delete", {
        packageIds: [f.a.packageId],
      }),
      preview = await f.trash.preview({ emptyAll: true });
    f.armFailure(phase);
    const r = await f.purge.execute(preview, {
      reason: "empty",
      operationLease: lease,
    });
    await lease.release();
    assert.equal(r.completed.length, 0);
    assert.deepEqual(r.pending, [f.a.packageId]);
    const w = await f.repository.read();
    assert.equal(w.packages[f.a.packageId].state, "purge_pending");
    assert.ok(
      !Object.values(w.jobs).some((j) => j.ownerPackageId === f.a.packageId),
    );
    await assert.rejects(f.trash.get(f.a.packageId));
    const rows = await f.trash.list();
    assert.ok(!JSON.stringify(rows).includes("fire"));
    const operationId = rows[0].operationId;
    await f.reopen();
    const retry = await f.purge.resumePending();
    assert.deepEqual(retry.completed, [f.a.packageId]);
    assert.equal((await f.purge.getStatus(operationId)).phase, "completed");
  });
test("failed control intent leaves bodies intact; empty sweeps do not take leases", async (t) => {
  const f = await fixture(t);
  f.armFailure("control_commit");
  await assert.rejects(
    f.purge.execute(await f.trash.preview({ emptyAll: true }), {
      reason: "empty",
    }),
  );
  assert.equal(
    (await f.repository.read()).packages[f.a.packageId].state,
    "trashed",
  );
  const before = await f.repository.read();
  const r = await f.purge.execute(
    await f.trash.preview({ expiredOnly: true }),
    { reason: "expired" },
  );
  assert.equal(r.completed.length, 0);
  assert.equal((await f.repository.read()).revision, before.revision);
});
test("modern rename reads durable name reservations and succeeds for an available name", async (t) => {
  const f = await fixture(t);
  const result = await f.workspaceService.updateVersion({
    kind: "target",
    parentId: f.b.targetId,
    revisionId: f.b.revisionId,
    packageId: f.b.packageId,
    versionName: "机场新版",
  });
  assert.equal(result.versionName, "机场新版");
});
test("corrupt managed backup prevents completion and reports anonymous safe error", async (t) => {
  const f = await fixture(t);
  const archive = JSON.parse(await fs.readFile(f.backup.path, "utf8"));
  archive.workspace.revision++;
  await fs.writeFile(f.backup.path, JSON.stringify(archive));
  const r = await f.purge.execute(await f.trash.preview({ emptyAll: true }), {
    reason: "empty",
  });
  assert.equal(r.completed.length, 0);
  assert.equal(r.pending.length, 1);
  assert.equal(r.failed[0].code, "backup_integrity_failed");
  assert.ok(!JSON.stringify(r).includes(f.dataDir));
});
test("a managed-directory junction never deletes the linked synthetic sentinel", async (t) => {
  const f = await fixture(t),
    runs = path.join(f.dataDir, "runs-v2"),
    original = path.join(f.dataDir, "runs-v2-original"),
    linked = path.join(f.dataDir, "sentinel-dir"),
    sentinel = path.join(linked, "sentinel.json");
  assert.ok(path.relative(f.dataDir, original) === "runs-v2-original");
  await fs.mkdir(linked);
  await fs.writeFile(sentinel, "sentinel");
  await fs.rename(runs, original);
  await fs.symlink(linked, runs, "junction");
  const r = await f.purge.execute(await f.trash.preview({ emptyAll: true }), {
    reason: "empty",
  });
  assert.equal(r.completed.length, 0);
  assert.equal(await fs.readFile(sentinel, "utf8"), "sentinel");
});
test("purge also sanitizes consumed V1 raw backups using durable legacy identities", async (t) => {
  const repository = await tempRepository(t),
    index = {
      version: 1,
      jobs: {
        old: {
          id: "old",
          title: "合成旧消防岗位",
          company: "合成机场",
          url: "https://example.invalid/legacy/1",
          source: "synthetic",
          status: "applied",
          note: "ONLY-V1-PRIVATE-NOTE",
        },
      },
    };
  await fs.writeFile(
    path.join(repository.dataDir, "job-index.json"),
    JSON.stringify(index),
  );
  await bootstrapWorkspace({ repository });
  const w = await repository.read(),
    legacy = Object.values(w.packages).find(
      (p) => p.kind === "legacy_unassigned",
    ),
    trash = createTrashService({ repository }),
    purge = createPurgeService({ repository, trash });
  trash.setPurgeService(purge);
  await trash.archive({ packageId: legacy.packageId });
  const result = await purge.execute(await trash.preview({ emptyAll: true }), {
    reason: "empty",
  });
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.completed, [legacy.packageId]);
  for (const name of await fs.readdir(
    path.join(repository.dataDir, "backups"),
  )) {
    assert.ok(name.endsWith(".json"));
    assert.ok(
      !(
        await fs.readFile(
          path.join(repository.dataDir, "backups", name),
          "utf8",
        )
      ).includes("ONLY-V1-PRIVATE-NOTE"),
    );
  }
});
