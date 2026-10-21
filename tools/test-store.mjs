// Regression coverage for the scoped asynchronous compatibility facade; synthetic data only.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openWorkspaceRepository} from '../src/infrastructure/storage/repository.mjs';
import {createEmptyWorkspace} from '../src/domain/contracts.mjs';
import {createWorkspaceService} from '../src/application/workspace-service.mjs';
import {createJobService} from '../src/application/job-service.mjs';
import {createWorkspaceOperationGate} from '../src/application/workspace-operations.mjs';

const directories = [], repositories = new Set();
async function temporary(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rjr-' + name + '-'));
  directories.push(dir);
  return dir;
}
async function open(dataDir) {
  const repository = await openWorkspaceRepository({dataDir});
  repositories.add(repository);
  return repository;
}
async function close(repository) {
  await repository.close();
  repositories.delete(repository);
}
const contextFor = repository => ({repository, jobService:createJobService({repository}), operationGate:createWorkspaceOperationGate({repository})});
const previous = JSON.stringify(createEmptyWorkspace({schemaVersion:2}));

try {
  const store = await import('../src/store.mjs');
  const dir = await temporary('store');
  let repository = await open(dir);
  const workspace = createWorkspaceService({repository, sourceIds:['test']}), context = contextFor(repository);
  await assert.rejects(() => store.loadIndex({context}), {code:'version_scope_required'});
  const profile = await workspace.saveProfile({versionName:'合成工具简历', submissionId:'tool-profile', text:'合成本科消防工程求职简历，具有机场消防与安全检查项目经验，用于离线测试。', profile:{education:'本科', major:'消防工程'}});
  const make = async name => {
    const target = await workspace.saveTarget({versionName:name, submissionId:'tool-' + randomUUID(), profileRevisionId:profile.revisionId, roles:['消防'], cityMode:'any', cities:[], jobTypes:['campus'], sourceIds:['test']});
    return {packageId:target.packageId, targetRevisionId:target.revisionId};
  };
  const scope = await make('合成A'), peer = await make('合成B'), options = {context, scope};
  const job = id => ({id, title:'岗位 ' + id, company:'合成公司', city:'成都', source:'test', url:'https://jobs.example.com/' + id, score:80});
  assert.equal(Object.keys((await store.loadIndex(options)).jobs).length, 0);
  const first = await store.upsert([job('a'), job('b')], {...options, runId:'r1', at:'2026-09-01T10:00:00Z'});
  assert.equal(first.stats.added, 2);
  assert.equal(first.stats.persisted, true);
  await store.setStatus('a', 'applied', '等待回复', options);
  const next = await store.upsert([job('a')], {...options, runId:'r2', at:'2026-09-02T10:00:00Z'});
  assert.equal(next.stats.ongoing, 1);
  assert.equal(next.stats.disappeared, 0);
  assert.equal(Object.keys((await store.loadIndex(options)).jobs).length, 2);
  assert.equal((await store.loadIndex(options)).jobs.a.note, '等待回复');
  await store.setStatus('a', 'interviewing', undefined, options);
  assert.equal((await store.loadIndex(options)).jobs.a.note, '等待回复');
  await store.setStatus('a', 'interviewing', '', options);
  assert.equal((await store.loadIndex(options)).jobs.a.note, '');
  assert.equal((await store.summary(options)).byStatus.interviewing, 1);
  assert.equal((await store.listJobs({...options, status:'offer'})).length, 0);
  const preview = await store.upsert([job('c')], {...options, runId:'preview', persist:false});
  assert.equal(preview.stats.persisted, false);
  assert.equal((await store.loadIndex(options)).jobs.c, undefined);
  await assert.rejects(() => store.setStatus('a', 'invalid', undefined, options), e => e.status === 400 && !!e.fieldErrors.status);
  await assert.rejects(() => store.loadIndex({context}), {code:'version_scope_required'});
  await assert.rejects(() => store.setStatus('a', 'applied', undefined, {context, scope:peer}));

  // The formal repository contract makes SQLite authoritative and close releases its WAL handle.
  const persisted = await store.loadIndex(options), revision = await repository.getMeta('revision');
  const markerPath = path.join(dir, 'workspace.v2.json'), marker = await fs.readFile(markerPath, 'utf8');
  await close(repository);
  repository = await open(dir);
  assert.equal(repository.migration.changed, false);
  assert.equal(await repository.getMeta('revision'), revision);
  assert.deepEqual(await store.loadIndex({scope, context:contextFor(repository)}), persisted);
  assert.equal(await fs.readFile(markerPath, 'utf8'), marker);
  await close(repository);

  // Corrupt the closed synthetic business database, with a valid previous JSON beside it.
  const databasePath = path.join(dir, 'workspace.sqlite'), corruptDatabase = await fs.readFile(databasePath);
  corruptDatabase.fill(0, 0, 16);
  await fs.writeFile(databasePath, corruptDatabase);
  await fs.writeFile(path.join(dir, 'workspace.v2.previous.json'), previous);
  await assert.rejects(() => open(dir), error => error.code === 'ERR_SQLITE_ERROR' && /database|file/i.test(error.message));
  assert.deepEqual(await fs.readFile(databasePath), corruptDatabase);
  assert.equal(await fs.readFile(markerPath, 'utf8'), marker);
  assert.equal(await fs.readFile(path.join(dir, 'workspace.v2.previous.json'), 'utf8'), previous);

  // A migrated marker remains a cold-open guard even though it is not a daily business store.
  const markerDir = await temporary('marker'), markerRepository = await open(markerDir);
  await close(markerRepository);
  await fs.writeFile(path.join(markerDir, 'workspace.v2.json'), '{broken');
  await fs.writeFile(path.join(markerDir, 'workspace.v2.previous.json'), previous);
  await assert.rejects(() => open(markerDir), {code:'workspace_migration_conflict'});
  assert.equal(await fs.readFile(path.join(markerDir, 'workspace.v2.json'), 'utf8'), '{broken');
  assert.equal(await fs.readFile(path.join(markerDir, 'workspace.v2.previous.json'), 'utf8'), previous);

  // Legacy cold inputs must fail closed and preserve their bytes, never recover from previous.
  for (const filename of ['workspace.v2.json', 'job-index.json']) {
    const corruptDir = await temporary('legacy-corrupt');
    await fs.writeFile(path.join(corruptDir, filename), '{broken');
    await fs.writeFile(path.join(corruptDir, 'workspace.v2.previous.json'), previous);
    await assert.rejects(() => open(corruptDir), {code:'workspace_migration_conflict'});
    assert.equal(await fs.readFile(path.join(corruptDir, filename), 'utf8'), '{broken');
    assert.equal(await fs.readFile(path.join(corruptDir, 'workspace.v2.previous.json'), 'utf8'), previous);
    await assert.rejects(fs.stat(path.join(corruptDir, 'control', 'initialized.json')), {code:'ENOENT'});
  }

  // Exercise v1 conversion through formal open, then prove a fresh open does not replay migration.
  const legacyDir = await temporary('legacy-migration');
  await fs.writeFile(path.join(legacyDir, 'job-index.json'), JSON.stringify({version:1, jobs:{legacy:{...job('legacy'), status:'applied', note:'合成旧版人工备注'}}}));
  let importedRepository = await open(legacyDir);
  const imported = await importedRepository.exportWorkspace(), importedHash = await importedRepository.getMeta('migrationSourceHash');
  assert.equal(imported.schemaVersion, 3);
  assert.equal(Object.keys(imported.jobs).length, 1);
  assert.equal(Object.values(imported.applications)[0].status, 'applied');
  assert.equal(Object.values(imported.applications)[0].note, '合成旧版人工备注');
  await assert.rejects(fs.stat(path.join(legacyDir, 'job-index.json')), {code:'ENOENT'});
  const legacyMarkerPath = path.join(legacyDir, 'workspace.v2.json'), legacyMarker = await fs.readFile(legacyMarkerPath, 'utf8');
  await close(importedRepository);
  importedRepository = await open(legacyDir);
  assert.equal(importedRepository.migration.changed, false);
  assert.equal(await importedRepository.getMeta('migrationSourceHash'), importedHash);
  assert.deepEqual(await importedRepository.exportWorkspace(), imported);
  assert.equal(await fs.readFile(legacyMarkerPath, 'utf8'), legacyMarker);
  console.log('✅ store facade: scoped facts, independent status, explicit empty note, preview, owner guards, persistent reopen, idempotent migration, corrupt authority and legacy-input rejection');
} finally {
  for (const repository of repositories) await repository.close();
  for (const dir of directories) await fs.rm(dir, {recursive:true, force:true});
}
