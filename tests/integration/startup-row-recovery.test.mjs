import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { packageFixture } from '../helpers/package-fixture.mjs';
import { recoverWorkspace } from '../../src/infrastructure/storage/recovery.mjs';
import { createWorkspaceOperationGate } from '../../src/application/workspace-operations.mjs';
import { createCollectionRoot } from '../../src/domain/collection.mjs';
import { createPurgeService } from '../../src/application/purge-service.mjs';

async function fixture(t) {
  const f = await packageFixture(t), targets = await f.twoTargets();
  f.scope = { packageId: targets.a.packageId, targetRevisionId: targets.a.revisionId };
  f.otherScope = { packageId: targets.b.packageId, targetRevisionId: targets.b.revisionId };
  f.target = targets.a; return f;
}
async function putRun(f, id, values = {}) {
  const run = { runId: id, recordId: randomUUID(), ownerPackageId: f.scope.packageId, targetRevisionId: f.scope.targetRevisionId, status: 'completed', ...values };
  await f.repository.transaction({ select: [{ collection: 'runs', ownerPackageId: f.scope.packageId, ids: [id] }] }, tx => tx.putRow({ collection: 'runs', id, ownerPackageId: f.scope.packageId, value: run }));
  return run;
}
function noMaintenance(repository) {
  const metrics = repository.metrics();
  for (const key of ['maintenanceReads', 'maintenanceExports', 'maintenanceMutations', 'maintenanceImports']) assert.equal(metrics[key], 0, key + ' must stay zero during formal startup recovery');
  return metrics;
}
async function ownedSnapshot(f, id) {
  const run = await putRun(f, id, { mode: 'rules' });
  const gate = createWorkspaceOperationGate({ repository: f.repository });
  const ref = await gate.withOperation('import', { scope: f.scope }, operationLease => f.repository.writeOwnedRunSnapshot(id, { run, jobs: [], evaluations: [], events: [] }, { scope: f.scope, operationLease }));
  await f.repository.transaction({ select: [{ collection: 'runs', ownerPackageId: f.scope.packageId, ids: [id] }] }, tx => {
    const current = tx.getRow({ collection: 'runs', id, ownerPackageId: f.scope.packageId });
    tx.putRow({ collection: 'runs', id, ownerPackageId: f.scope.packageId, value: { ...current, snapshotRef: ref } });
  });
  return ref;
}
async function trashMetadata(f) {
  const at = new Date(f.clock.now()), purgeAt = new Date(+at + 72 * 3600_000).toISOString();
  await f.repository.transaction({ select: [{ collection: 'packages', ids: [f.scope.packageId] }] }, tx => {
    const current = tx.getRow({ collection: 'packages', id: f.scope.packageId });
    tx.putRow({ collection: 'packages', id: f.scope.packageId, value: { ...current, state: 'trashed', enabled: false, archiveId: randomUUID(), archivedAt: at.toISOString(), purgeAt } });
  });
}

test('formal recovery interrupts only dead run heads including collection roots and never rebuilds the workspace', async t => {
  const f = await fixture(t);
  const dead = await putRun(f, 'dead-run', { status: 'running', ownerPid: 0, retained: { unknown: 'preserve' } });
  const live = await putRun(f, 'live-run', { status: 'running', ownerPid: process.pid });
  const root = createCollectionRoot({ runId: 'collection-root', scope: f.scope, targetSnapshot: f.target, now: f.clock.now() });
  root.ownerPid = 0;
  root.collectionProgress.pendingBodies = { saved: { status: 'pending', original: 'preserve-body-queue' } };
  root.collectionProgress.ledger.reservations = { unknown: { reservationId: 'unknown', status: 'uncertain', requestUpperBound: 3, bytesUpperBound: 100 } };
  await f.repository.mutateWorkspace(workspace => { workspace.runs[root.runId] = root; });
  const before = await f.repository.read(); f.repository.metrics({ reset: true });
  const result = await recoverWorkspace(f.repository);
  assert.deepEqual(result.interruptedRunIds, ['dead-run']);
  noMaintenance(f.repository);
  const rootHead = (await f.repository.queryRecoveryRunHeads({ runId: root.runId })).rows[0];
  assert.equal(rootHead.collectionRole, 'collection_root');
  for (const field of ['collectionProgress', 'profileSnapshot', 'targetSnapshot', 'events', 'jobs']) assert.equal(Object.hasOwn(rootHead, field), false);
  const after = await f.repository.read();
  assert.deepEqual(after.runs['live-run'], live);
  assert.deepEqual(after.runs['dead-run'], { ...dead, status: 'interrupted', stage: 'interrupted', finishedAt: new Date(f.clock.now()).toISOString() });
  assert.deepEqual(after.runs[root.runId].collectionProgress, before.runs[root.runId].collectionProgress);
  for (const key of ['jobs', 'observations', 'evaluations', 'sourceHealth', 'settings']) assert.deepEqual(after[key], before[key]);
  f.repository.metrics({ reset: true }); const revision = await f.repository.getMeta('revision');
  assert.deepEqual((await recoverWorkspace(f.repository)).interruptedRunIds, []);
  assert.equal(await f.repository.getMeta('revision'), revision); noMaintenance(f.repository);
});

test('snapshot recovery checks registered owner, stable identity, canonical path and hash without whole-workspace reads', async t => {
  const f = await fixture(t); await ownedSnapshot(f, 'snapshot-run');
  f.repository.metrics({ reset: true });
  assert.deepEqual((await recoverWorkspace(f.repository)).issues, []); noMaintenance(f.repository);
  const filename = path.join(f.dataDir, 'runs-v2', 'snapshot-run.json');
  const snapshot = JSON.parse(await fs.readFile(filename, 'utf8'));
  snapshot.ownerPackageId = f.otherScope.packageId;
  await fs.writeFile(filename, JSON.stringify(snapshot)); f.repository.metrics({ reset: true });
  const result = await recoverWorkspace(f.repository);
  assert.ok(result.issues.some(issue => issue.code === 'invalid_snapshot' && issue.runId === 'snapshot-run'));
  noMaintenance(f.repository);
  snapshot.ownerPackageId = f.scope.packageId; snapshot.jobs = [{ changedBody: true }];
  await fs.writeFile(filename, JSON.stringify(snapshot)); f.repository.metrics({ reset: true });
  assert.ok((await recoverWorkspace(f.repository)).issues.some(issue => issue.code === 'invalid_snapshot')); noMaintenance(f.repository);
  await f.repository.transaction({ select: [{ collection: 'runs', ownerPackageId: f.scope.packageId, ids: ['snapshot-run'] }] }, tx => {
    const run = tx.getRow({ collection: 'runs', ownerPackageId: f.scope.packageId, id: 'snapshot-run' });
    tx.putRow({ collection: 'runs', ownerPackageId: f.scope.packageId, id: 'snapshot-run', value: { ...run, snapshotRef: { ...run.snapshotRef, path: '../outside.json' } } });
  });
  f.repository.metrics({ reset: true });
  assert.ok((await recoverWorkspace(f.repository)).issues.some(issue => issue.code === 'invalid_snapshot')); noMaintenance(f.repository);
});

test('unexpired trash keeps snapshot checks; expired trash exposes only explicit deferred metadata and performs no body read or write', async t => {
  const f = await fixture(t); await ownedSnapshot(f, 'trash-run'); await trashMetadata(f);
  await fs.unlink(path.join(f.dataDir, 'runs-v2', 'trash-run.json'));
  f.repository.metrics({ reset: true });
  const checked = await recoverWorkspace(f.repository);
  assert.ok(checked.issues.some(issue => issue.code === 'missing_snapshot' && issue.runId === 'trash-run')); noMaintenance(f.repository);
  f.clock.advance(72 * 3600_000);
  let bodyReads = 0; const originalReadFile = fs.readFile;
  fs.readFile = async function (filename, ...args) { if (String(filename).includes('runs-v2')) bodyReads++; return originalReadFile.call(this, filename, ...args); };
  try {
    const revision = await f.repository.getMeta('revision'); f.repository.metrics({ reset: true });
    const deferred = await recoverWorkspace(f.repository);
    assert.ok(deferred.deferredChecks.some(item => item.runId === 'trash-run' && item.reason === 'package_expired'));
    assert.equal(bodyReads, 0); assert.deepEqual(deferred.issues, []);
    assert.equal(await f.repository.getMeta('revision'), revision);
    assert.equal(f.repository.metrics().rowsWritten, 0); noMaintenance(f.repository);
  } finally { fs.readFile = originalReadFile; }
});

test('owner takeover between candidate scan and write fence is rechecked and never interrupted', async t => {
  const f = await fixture(t); await putRun(f, 'takeover', { status: 'running', ownerPid: 0 });
  let calls = 0;
  const repository = { ...f.repository, async withWriteFence(action, options) {
    if (++calls === 2) await f.repository.transaction({ select: [{ collection: 'runs', ownerPackageId: f.scope.packageId, ids: ['takeover'] }] }, tx => {
      const run = tx.getRow({ collection: 'runs', id: 'takeover', ownerPackageId: f.scope.packageId });
      tx.putRow({ collection: 'runs', id: 'takeover', ownerPackageId: f.scope.packageId, value: { ...run, ownerPid: process.pid } });
    });
    return f.repository.withWriteFence(action, options);
  } };
  f.repository.metrics({ reset: true }); const result = await recoverWorkspace(repository);
  assert.deepEqual(result.interruptedRunIds, []);
  const current = await f.repository.getRow({ collection: 'runs', ownerPackageId: f.scope.packageId, id: 'takeover' });
  assert.equal(current.status, 'running'); assert.equal(current.ownerPid, process.pid); noMaintenance(f.repository);
});

test('old recovery UUID and ordinal survive; historical issues and orphan diagnostics are idempotent', async t => {
  const f = await fixture(t); await putRun(f, 'missing', { mode: 'rules' });
  const oldId = randomUUID();
  await f.repository.transaction({ select: [{ collection: 'recoveryRecords', ownerPackageId: f.scope.packageId, ids: ['old-record'] }] }, tx => {
    tx.putRow({ collection: 'recoveryRecords', id: 'old-record', ownerPackageId: f.scope.packageId, ordinal: 7, value: { code: 'missing_snapshot', runId: 'missing', ownerPackageId: f.scope.packageId, recordId: oldId } });
  });
  f.repository.metrics({ reset: true }); const revision = await f.repository.getMeta('revision');
  const repeated = await recoverWorkspace(f.repository); assert.equal(repeated.issues.length, 1);
  assert.equal(await f.repository.getMeta('revision'), revision); noMaintenance(f.repository);
  await fs.mkdir(path.join(f.dataDir, 'runs-v2'), { recursive: true });
  await fs.writeFile(path.join(f.dataDir, 'runs-v2', 'orphan.json'), '{"doNotRead":true}');
  f.repository.metrics({ reset: true });
  const first = await recoverWorkspace(f.repository); assert.deepEqual(first.orphanSnapshots, ['orphan']); noMaintenance(f.repository);
  const old = await f.repository.getRecord({ collection: 'recoveryRecords', id: 'old-record', ownerPackageId: f.scope.packageId });
  assert.equal(old.value.recordId, oldId); assert.equal(old.indexes.ordinal, 7);
  const records = await f.repository.queryRows({ collection: 'recoveryRecords', where: { runId: 'orphan' }, limit: 2 });
  assert.equal(records.rows.length, 1); assert.equal(records.rows[0].indexes.ordinal, 8); assert.equal(records.rows[0].indexes.ownerPackageId, null);
  const currentRevision = await f.repository.getMeta('revision'); f.repository.metrics({ reset: true });
  await recoverWorkspace(f.repository); assert.equal(await f.repository.getMeta('revision'), currentRevision); noMaintenance(f.repository);
});

test('only an ownerless orphan diagnostic may name an absent run; private and other diagnostic references keep their foreign keys', async t => {
  const f = await fixture(t);
  for (const [id, code, ownerPackageId] of [['owned-orphan', 'orphan_snapshot', f.scope.packageId], ['other-code', 'invalid_snapshot', null]]) {
    await assert.rejects(f.repository.transaction({ select: [{ collection: 'recoveryRecords', ids: [id], ...(ownerPackageId ? { ownerPackageId } : {}) }] }, tx => {
      tx.putRow({ collection: 'recoveryRecords', id, ordinal: 0, ...(ownerPackageId ? { ownerPackageId } : {}), value: { code, runId: 'absent-run', ...(ownerPackageId ? { ownerPackageId, recordId: randomUUID() } : {}) } });
    }), { code: 'sqlite_constraint' });
  }
  await assert.rejects(f.repository.transaction({ select: [{ collection: 'recoveryRecords', ids: ['fake-ownerless'] }] }, tx => {
    tx.putRow({ collection: 'recoveryRecords', id: 'fake-ownerless', ownerPackageId: null, ordinal: 0, value: { code: 'orphan_snapshot', runId: 'absent-run', ownerPackageId: f.scope.packageId, recordId: randomUUID() } });
  }), { code: 'sqlite_constraint' });
  await putRun(f, 'registered');
  await f.repository.transaction({ select: [{ collection: 'recoveryRecords', ids: ['registered-reference'], ownerPackageId: f.scope.packageId }] }, tx => {
    tx.putRow({ collection: 'recoveryRecords', id: 'registered-reference', ownerPackageId: f.scope.packageId, ordinal: 0, value: { code: 'invalid_snapshot', runId: 'registered', ownerPackageId: f.scope.packageId, recordId: randomUUID() } });
  });
  await assert.rejects(f.repository.transaction({ select: [{ collection: 'runs', ids: ['registered'], ownerPackageId: f.scope.packageId }] }, tx => {
    tx.deleteRow({ collection: 'runs', id: 'registered', ownerPackageId: f.scope.packageId });
  }), { code: 'sqlite_constraint' });
});

test('formal purge between head and first snapshot prepare refreshes the absent head instead of failing startup', async t => {
  const f = await fixture(t); await ownedSnapshot(f, 'purged-during-prepare');
  const purge = createPurgeService({ repository: f.repository, trash: f.trash }); f.trash.setPurgeService(purge);
  let arrived = false, purged;
  const repository = { ...f.repository, async queryRows(input, options) {
    if (!arrived && input.collection === 'files' && input.where?.runId === 'purged-during-prepare') {
      arrived = true;
      await f.trash.archive({ packageId: f.scope.packageId });
      purged = await purge.execute(await f.trash.preview({ packageIds: [f.scope.packageId] }), { reason: 'manual' });
    }
    return f.repository.queryRows(input, options);
  } };
  const result = await recoverWorkspace(repository);
  assert.equal(arrived, true); assert.deepEqual(purged.completed, [f.scope.packageId]); assert.deepEqual(purged.pending, []);
  assert.deepEqual(result.interruptedRunIds, []); assert.deepEqual(result.issues, []);
  assert.equal((await f.repository.queryRecoveryRunHeads({ runId: 'purged-during-prepare' })).rows.length, 0);
});

test('crossing 72 hours in the second snapshot prepare refreshes to deferred without reading expired content', async t => {
  const f = await fixture(t); await ownedSnapshot(f, 'expires-during-second-prepare');
  await f.trash.archive({ packageId: f.scope.packageId });
  const revision = await f.repository.getMeta('revision'); let fileQueries = 0, snapshotReads = 0;
  const originalRead = fs.readFile;
  fs.readFile = async function (filename, ...args) { if (String(filename).includes('runs-v2')) snapshotReads++; return originalRead.call(this, filename, ...args); };
  const repository = { ...f.repository, async queryRows(input, options) {
    if (input.collection === 'files' && input.where?.runId === 'expires-during-second-prepare' && ++fileQueries === 2) f.clock.advance(72 * 3600_000);
    return f.repository.queryRows(input, options);
  } };
  try {
    f.repository.metrics({ reset: true });
    const result = await recoverWorkspace(repository);
    assert.equal(fileQueries, 2); assert.equal(snapshotReads, 1);
    assert.deepEqual(result.issues, []);
    assert.ok(result.deferredChecks.some(item => item.runId === 'expires-during-second-prepare' && item.reason === 'package_expired'));
    assert.equal(await f.repository.getMeta('revision'), revision);
    assert.equal(f.repository.metrics().rowsWritten, 0); noMaintenance(f.repository);
  } finally { fs.readFile = originalRead; }
});

test('snapshot metadata prepare propagates unrelated storage errors and bounds repeated revocation races', async t => {
  const f = await fixture(t); await ownedSnapshot(f, 'prepare-errors');
  for (const code of ['EIO', 'package_not_found']) {
    let attempts = 0;
    const repository = { ...f.repository, async queryRows(input, options) {
      if (input.collection === 'files' && input.where?.runId === 'prepare-errors') { attempts++; throw Object.assign(Error('synthetic metadata receiver failure'), { code }); }
      return f.repository.queryRows(input, options);
    } };
    await assert.rejects(recoverWorkspace(repository), { code: code === 'EIO' ? 'EIO' : 'recovery_state_changed' });
    assert.equal(attempts, code === 'EIO' ? 1 : 3);
  }
});
