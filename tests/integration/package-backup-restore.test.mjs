import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { seedUnassignedClosure } from "../helpers/legacy-business-fixture.mjs";
import { createPurgeService } from "../../src/application/purge-service.mjs";
import {
  createBackup,
  restoreBackup,
} from "../../src/infrastructure/storage/backup.mjs";
async function fixture(t) {
  const f = await packageBusinessFixture(t);
  Object.assign(f, await f.twoTargets());
  f.purge = createPurgeService({
    repository: f.repository,
    trash: f.trash,
    fsAdapter: f.fsAdapter,
  });
  f.trash.setPurgeService(f.purge);
  f.restore = (archivePath) =>
    restoreBackup({
      repository: f.repository,
      archivePath,
      trashService: f.trash,
      purgeService: f.purge,
      fsAdapter: f.fsAdapter,
    });
  return f;
}
test("backup cannot reactivate an unexpired local archive or renew its deadline", async (t) => {
  const f = await fixture(t),
    backup = await createBackup({ repository: f.repository }),
    p = await f.trash.archive({ packageId: f.a.packageId });
  f.clock.advance(1000);
  await f.restore(backup.path);
  let w = await f.repository.read();
  assert.equal(w.packages[p.packageId].state, "trashed");
  assert.equal(w.packages[p.packageId].archiveId, p.archiveId);
  assert.equal(w.packages[p.packageId].purgeAt, p.purgeAt);
  await f.restore(backup.path);
  w = await f.repository.read();
  assert.equal(w.packages[p.packageId].purgeAt, p.purgeAt);
});
test("restore registers and finishes expired local purge before loading old active bodies", async (t) => {
  const f = await fixture(t),
    backup = await createBackup({ repository: f.repository });
  await f.trash.archive({ packageId: f.a.packageId });
  f.clock.advance(72 * 3600000);
  await f.restore(backup.path);
  assert.ok(!(await f.repository.read()).packages[f.a.packageId]);
  assert.equal(
    (await f.control.read()).deletionLedger[f.a.packageId].phase,
    "purged",
  );
  assert.ok((await f.repository.read()).packages[f.b.packageId]);
});
test("transferred then deleted stable records cannot reappear from older unassigned backup", async (t) => {
  const f = await fixture(t),
    seed = await seedUnassignedClosure(f),
    backup = await createBackup({ repository: f.repository });
  const preview = await f.assignment.preview({
    recordId: seed.recordId,
    destination: f.a,
  });
  await f.assignment.move({
    recordId: seed.recordId,
    destination: f.a,
    ...preview,
  });
  await f.trash.archive({ packageId: f.a.packageId });
  await f.purge.execute(await f.trash.preview({ emptyAll: true }), {
    reason: "empty",
  });
  await f.restore(backup.path);
  const w = await f.repository.read();
  assert.ok(!w.jobs[seed.jobId]);
  assert.ok(
    !Object.values(w.applications).some((a) => a.recordId === seed.recordId),
  );
});
test("hash validation precedes snapshots, cleanup or changes to control", async (t) => {
  const f = await fixture(t),
    backup = await createBackup({ repository: f.repository }),
    before = await f.control.read(),
    w = await f.repository.read();
  const archive = JSON.parse(await fs.readFile(backup.path, "utf8"));
  archive.workspace.revision++;
  await fs.writeFile(backup.path, JSON.stringify(archive));
  await assert.rejects(f.restore(backup.path));
  assert.deepEqual(await f.control.read(), before);
  assert.deepEqual((await f.repository.read()).packages, w.packages);
  assert.deepEqual(
    await fs.readdir(path.join(f.dataDir, "runs-v2")).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    }),
    [],
  );
});
test("an older backup does not roll back version counters or remove occupied trash names", async (t) => {
  const f = await fixture(t),
    backup = await createBackup({ repository: f.repository });
  await f.trash.archive({ packageId: f.a.packageId });
  const high = structuredClone((await f.control.read()).versionHighWater);
  await f.restore(backup.path);
  assert.deepEqual((await f.control.read()).versionHighWater, high);
  await assert.rejects(
    f.workspaceService.saveTarget({
      ...f.a,
      versionName: "fire",
      submissionId: "another",
    }),
    (e) => e.code === "version_name_conflict",
  );
});
test("deleting old unassigned package preserves records already transferred into a target", async (t) => {
  const f = await fixture(t),
    seed = await seedUnassignedClosure(f, { managedSnapshot: true }),
    backup = await createBackup({ repository: f.repository }),
    external = path.join(f.dataDir, "external.json");
  await fs.copyFile(backup.path, external);
  const preview = await f.assignment.preview({
    recordId: seed.recordId,
    destination: f.a,
  });
  await f.assignment.move({
    recordId: seed.recordId,
    destination: f.a,
    ...preview,
  });
  await f.trash.archive({ packageId: seed.packageId });
  const result = await f.purge.execute(
    await f.trash.preview({ emptyAll: true }),
    { reason: "empty" },
  );
  assert.equal(result.pending.length, 0);
  await f.restore(external);
  const w = await f.repository.read();
  assert.equal(w.jobs[seed.jobId].ownerPackageId, f.a.packageId);
  assert.equal(w.applications[seed.applicationId].recordId, seed.recordId);
  const snap = await f.repository.readRunSnapshot(seed.runId);
  assert.equal(snap.ownerPackageId, f.a.packageId);
  assert.equal(snap.jobs[0].jobId, seed.jobId);
  assert.equal(snap.applications[0].note, "合成历史投递");
});
test("restoring a clean managed snapshot to a fresh workspace writes only validated identities", async (t) => {
  const f = await fixture(t),
    seed = await seedUnassignedClosure(f, { managedSnapshot: true }),
    backup = await createBackup({ repository: f.repository }),
    fresh = await packageBusinessFixture(t);
  await restoreBackup({
    repository: fresh.repository,
    archivePath: backup.path,
  });
  assert.equal(
    (await fresh.repository.readRunSnapshot(seed.runId)).ownerPackageId,
    seed.packageId,
  );
});
