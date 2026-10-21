import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tempRepository } from '../helpers/repository.mjs';
import { packageFixture } from '../helpers/package-fixture.mjs';
import { job } from '../helpers/fixtures.mjs';
import { migrateV1 } from '../../src/infrastructure/storage/migrate-v1.mjs';
import { upgradeWorkspace } from '../../src/infrastructure/storage/upgrade-workspace.mjs';
import { contentHash } from '../../src/infrastructure/storage/repository.mjs';
import { validateBackupArchive } from '../../src/infrastructure/storage/backup.mjs';

async function migrated(t) {
  const repository = await tempRepository(t);
  const a = job({ id: 'old-1', sourceRecordId: null, score: 70 });
  await fs.mkdir(path.join(repository.dataDir, 'runs'));
  await fs.writeFile(path.join(repository.dataDir, 'runs', 'old-run.json'), JSON.stringify({
    runId: 'old-run', jobs: [a, { ...a, cities: ['上海'], url: 'https://jobs.example.com/2' }],
    apiKey: 'SYNTHETIC-PRIVATE-KEY',
  }));
  await fs.writeFile(path.join(repository.dataDir, 'job-index.json'), JSON.stringify({
    version: 1, jobs: { 'old-1': { ...a, status: 'applied', note: '合成待确认记录' } },
  }));
  await migrateV1({ repository, dataDir: repository.dataDir });
  return repository;
}

test('legacy upgrade reads its backup snapshots through the held maintenance transaction', async t => {
  const repository = await migrated(t), before = await repository.read();
  const snapshotPath = path.join(repository.dataDir, 'runs-v2', 'old-run.json');
  const source = await fs.readFile(snapshotPath), snapshot = JSON.parse(source);
  let publicSnapshotReads = 0;
  const guarded = { ...repository, readRunSnapshot() {
    publicSnapshotReads++;
    throw Error('Upgrade must use the held maintenance transaction');
  } };
  const upgraded = await upgradeWorkspace({ repository: guarded });
  assert.equal(upgraded.changed, true);
  assert.equal(publicSnapshotReads, 0);
  const archive = validateBackupArchive(JSON.parse(await fs.readFile(path.join(repository.dataDir, 'backups', upgraded.backupId), 'utf8')));
  assert.deepEqual(archive.runSnapshots['old-run'], snapshot);
  assert.equal(archive.manifest.snapshots['old-run'], before.runs['old-run'].snapshotRef.hash);
  assert.equal(contentHash(snapshot), before.runs['old-run'].snapshotRef.hash);
  assert.deepEqual(archive.workspace.applications, before.applications);
  assert.deepEqual(archive.workspace.jobs, before.jobs);
  assert.equal(JSON.stringify(archive).includes('SYNTHETIC-PRIVATE-KEY'), false);
  const after = await repository.read();
  for (const key of ['jobs', 'observations', 'applications', 'runs', 'identityAliases'])
    assert.deepEqual(after[key], before[key], key + ' remains intact');
  assert.deepEqual(await fs.readFile(snapshotPath), source);
  assert.equal(Object.keys(after.jobs).length, 2);
  assert.equal(after.applications['legacy:old-1'].note, '合成待确认记录');
  assert.equal((await upgradeWorkspace({ repository: guarded })).changed, false);
});

test('legacy upgrade rejects a changed snapshot and leaves business facts unchanged', async t => {
  const repository = await migrated(t), before = await repository.read();
  const backups = await fs.readdir(path.join(repository.dataDir, 'backups'));
  const snapshotPath = path.join(repository.dataDir, 'runs-v2', 'old-run.json');
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  snapshot.legacyResult.jobs[0].title = '合成篡改标题';
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
  await assert.rejects(upgradeWorkspace({ repository }), /Snapshot hash mismatch/);
  const after = await repository.read();
  for (const key of Object.keys(before).filter(key => !['revision', 'operationLeases'].includes(key)))
    assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(after.operationLeases, {});
  assert.deepEqual(await fs.readdir(path.join(repository.dataDir, 'backups')), backups);
});

for (const invalid of ['owner mismatch', 'expired owner']) {
  test('upgrade held snapshot reader rejects schema3 ' + invalid, async t => {
    const f = await packageFixture(t), { a, b } = await f.twoTargets();
    const runId = 'owned-upgrade-run';
    await f.repository.withMaintenanceTransaction(async tx => {
      const w = tx.workspace;
      w.membershipVersion = 0;
      w.runs[runId] = { runId, recordId: randomUUID(), ownerPackageId: a.packageId, status: 'completed' };
      const snapshot = { recordId: randomUUID(), ownerPackageId: a.packageId, run: { ...w.runs[runId] }, jobs: [] };
      w.runs[runId].snapshotRef = await tx.writeSnapshot(runId, snapshot);
      await tx.commitWorkspace(w);
    });
    const filename = path.join(f.dataDir, 'runs-v2', runId + '.json');
    if (invalid === 'owner mismatch') {
      const snapshot = JSON.parse(await fs.readFile(filename, 'utf8'));
      snapshot.ownerPackageId = b.packageId;
      await fs.writeFile(filename, JSON.stringify(snapshot));
      await f.repository.mutateWorkspace(w => { w.runs[runId].snapshotRef.hash = contentHash(snapshot); });
    } else {
      await f.repository.mutateWorkspace(w => {
        w.packages[a.packageId].state = 'trashed';
        w.packages[a.packageId].archiveId = randomUUID();
        w.packages[a.packageId].archivedAt = '2026-10-01T00:00:00.000Z';
        w.packages[a.packageId].purgeAt = '2026-10-04T00:00:00.000Z';
      });
    }
    const before = await f.repository.read(), source = await fs.readFile(filename);
    const expected = invalid === 'owner mismatch' ? 'package_scope_mismatch' : 'package_expired';
    await assert.rejects(f.repository.readRunSnapshot(runId), { code: expected });
    await assert.rejects(upgradeWorkspace({ repository: f.repository }), { code: expected });
    const after = await f.repository.read();
    assert.deepEqual(after.runs, before.runs);
    assert.deepEqual(after.packages, before.packages);
    assert.equal(after.membershipVersion, 0);
    assert.deepEqual(after.operationLeases, {});
    assert.deepEqual(await fs.readFile(filename), source);
  });
}
