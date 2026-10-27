import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { packageBusinessFixture } from '../helpers/package-business-fixture.mjs';
import { createTempDir, job, registerTestResource } from '../helpers/fixtures.mjs';
import { normalizeRecord } from '../../src/domain/record.mjs';
import { resolveJobIdentity, relateJobs } from '../../src/domain/identity.mjs';
import { jobFactHash } from '../../src/domain/job-facts.mjs';
import { jobIdentityIndexKeys, jobTitleGrams, jobTitleCandidateGrams, buildWorkspaceJobReadModels } from '../../src/domain/job-read-model.mjs';
import { identityText } from '../../src/domain/job-identity.mjs';
import { duplicateSimHashMetrics } from '../../src/domain/duplicate-candidates.mjs';
import { createEvaluationService } from '../../src/application/evaluation-service.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteJobQueries } from '../../src/infrastructure/storage/sqlite-job-queries.mjs';
import { openWorkspaceRepository } from '../../src/infrastructure/storage/repository.mjs';
import { createJobService } from '../../src/application/job-service.mjs';
import { createExportService } from '../../src/application/export-service.mjs';
import { rowKey } from '../../src/infrastructure/storage/sqlite-records.mjs';
import { writeTestEvidence } from '../helpers/evidence.mjs';

const digest = input => createHash('sha256').update(String(input)).digest('hex');
const recordAt = (clock, index, company = '合成大型单位') => job({ sourceRecordId: 'large-' + index, company, title: digest(index).slice(0, 24), url: 'https://jobs.example.com/large/' + index,
  retrievedAt: new Date(clock.now()).toISOString(), description: '负责工程项目开发和安全维护，要求本科及以上学历，按明确流程完成任职工作。' + digest(index) + digest(index + '-body'), detailStatus: 'complete' });

test('a freshly opened repository exposes one stable owned snapshot writer before its first business write', async t => {
  const dataDir = await createTempDir(t), repository = await openWorkspaceRepository({ dataDir });
  registerTestResource(t, () => repository.close());
  const writer = repository.writeOwnedRunSnapshot;
  assert.equal(typeof writer, 'function');
  await repository.withWriteFence(() => null);
  assert.strictEqual(repository.writeOwnedRunSnapshot, writer);
  await repository.withWriteFence(() => null);
  assert.strictEqual(repository.writeOwnedRunSnapshot, writer);
});

test('a batch of 50 uses persisted signatures and SQL candidates among 1000 different bodies at one employer', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets(), runId = 'candidate-seed';
  await f.repository.mutateWorkspace(w => {
    const target = Object.values(w.targets).flat().find(target => target.revisionId === a.targetRevisionId);
    w.runs[runId] = { runId, recordId: randomUUID(), ownerPackageId: a.packageId, targetSnapshot: structuredClone(target), status: 'completed', events: [], lastSeq: 0 };
    w.targetMembers[a.targetRevisionId] ||= {};
    for (let index = 0; index < 1000; index++) {
      const record = normalizeRecord(recordAt(f.clock, index)), jobId = 'j-index-' + index, observationId = 'o-index-' + index;
      const identity = resolveJobIdentity(record), seen = new Date(f.clock.now()).toISOString();
      w.jobs[jobId] = { jobId, recordId: randomUUID(), ownerPackageId: a.packageId, kind: 'job', canonical: record, identityAliases: identity.aliases, sourceRefs: [{ sourceId: record.sourceId, siteId: record.siteId }], firstSeen: seen, lastSeen: seen, lifecycle: 'observed', duplicateGroupIds: [] };
      w.observations[observationId] = { observationId, jobId, runId, recordId: randomUUID(), ownerPackageId: a.packageId, targetRevisionId: a.targetRevisionId, fields: record, observedAt: seen, factRevision: 1 };
      w.targetMembers[a.targetRevisionId][jobId] = { factRefs: [{ observationId }], currentObservationId: observationId, factContentHash: jobFactHash(record), firstSeen: seen, lastSeen: seen };
    }
  });
  const records = Array.from({ length: 50 }, (_, index) => recordAt(f.clock, 1000 + index));
  await f.repository.metrics({ reset: true }); duplicateSimHashMetrics({ reset: true });
  const start = performance.now();
  const first = await f.jobs.ingestRecords({ scope: a, runId, records });
  const initial = { durationMs: performance.now() - start, phases: (await f.jobs.getOperationMetrics()).ingest, storage: await f.repository.metrics(), simHash: duplicateSimHashMetrics() };
  assert.equal(new Set(first.jobIds).size, 50);
  assert.ok(initial.simHash.computations <= 50, JSON.stringify(initial.simHash));
  assert.equal(initial.storage.maintenanceExports, 0); assert.equal(initial.storage.maintenanceMutations, 0);
  // At most a small conservative candidate closure is decoded, not all 1000 bodies.
  assert.ok(initial.storage.decodedRows < 500, JSON.stringify(initial.storage));
  await f.repository.metrics({ reset: true }); duplicateSimHashMetrics({ reset: true });
  const replayStart = performance.now();
  const replay = await f.jobs.ingestRecords({ scope: a, runId, records });
  const second = { durationMs: performance.now() - replayStart, phases: (await f.jobs.getOperationMetrics()).ingest, storage: await f.repository.metrics(), simHash: duplicateSimHashMetrics() };
  assert.deepEqual(replay.jobIds, first.jobIds); assert.equal(second.simHash.computations, 0);
  assert.equal((await f.jobs.queryJobs({ packageId: a.packageId, targetRevisionId: a.targetRevisionId })).total, 1050);
  const plans = [], db = new DatabaseSync(path.join(f.dataDir, 'workspace.sqlite'), { readOnly: true });
  try {
    const statement = sql => {
      const prepared = db.prepare(sql), explain = (...bindings) => plans.push({ operation: sql.includes('CROSS JOIN') ? 'candidate' : sql.includes('count(*)') ? 'page_count' : 'page', steps: db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...bindings).map(row => row.detail) });
      return { get(...bindings) { explain(...bindings); return prepared.get(...bindings); }, all(...bindings) { explain(...bindings); return prepared.all(...bindings); } };
    };
    const query = createSqliteJobQueries({ db, statement });
    query.queryJobPage({ packageId: a.packageId, targetRevisionId: a.targetRevisionId, pageSize: 25 }, { asOf: f.clock.now() });
    query.findJobIdentityCandidates({ ownerPackageId: a.packageId, keys: jobIdentityIndexKeys(records[0]) });
  } finally { db.close(); }
  assert.ok(plans.some(plan => plan.operation === 'candidate' && plan.steps.some(step => /rows_identity_candidate.*kind=\?.*resource_key=\?/.test(step))), JSON.stringify(plans));
  await writeTestEvidence('job-candidate-index', 'candidate-1000-batch50.json', JSON.stringify({ schema: 1, synthetic: true, existingSameEmployer: 1000, batchSize: 50, initial, replay: second, plans }, null, 2));
});

test('SQL identity pruning retains every same or possible conflict-first decision', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets();
  const records = [
    job({ title: '高级工程开发岗位' }), job({ sourceRecordId: '2', title: '高级工程开发岗位A' }),
    job({ sourceRecordId: '3', title: '完全不同岗位' }), job({ sourceRecordId: '4', company: null }),
    job({ sourceRecordId: '5', title: '高级工程开发岗位🙂' }), job({ sourceRecordId: '6', title: '🙂' }),
    ...['消防安全工程设施检查维护与应急管理岗位', '消防安全工程设施检查维护与应急管理岗位A', '消防安全工程设施检查维护与应急管理岗位B', '工程🙂🙂设备巡检安全设施维护管理岗位', '工程🙂🙂设备巡检安全设施维护管理岗位A'].map((title, index) => job({ title, sourceId: 'recall-' + index, siteId: 'recall-' + index, identityScope: 'recall-' + index, sourceRecordId: 'recall-' + index, sourceRecordIdKind: 'weak', url: 'https://jobs.example.com/recall/' + index })),
  ];
  const ids = await f.ingest(a, records), canonical = await Promise.all(ids.map(id => f.repository.getRow({ collection: 'jobs', id, ownerPackageId: a.packageId }, { scope: a })));
  for (const input of [...records, job({ title: '' })]) {
    const record = normalizeRecord({ ...input, retrievedAt: new Date(f.clock.now()).toISOString() }), title = identityText(record.title), titleGrams = jobTitleGrams(title);
    const result = await f.repository.findJobIdentityCandidates({ ownerPackageId: a.packageId, keys: jobIdentityIndexKeys(record), recordIdentity: { company: identityText(record.company), title, titleGrams, titleGramCount: titleGrams.length } }, { scope: a });
    assert.equal(result.hasMore, false);
    for (const job of canonical) if (relateJobs(job.canonical, record).relation !== 'distinct') assert.ok(result.jobIds.includes(job.jobId), JSON.stringify({ title, existing: job.canonical.title }));
  }
});

test('short manual records retain business fingerprint candidates across input scopes without body hashes', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets();
  const record = job({ sourceId: 'manual', company: null, title: '人工同岗', url: null, description: '人工记录', sourceRecordIdKind: 'hint' });
  const [left] = await f.ingest(a, [{ ...record, siteId: 'manual-a', identityScope: 'manual-a' }]);
  const [right] = await f.ingest(a, [{ ...record, siteId: 'manual-b', identityScope: 'manual-b' }]);
  assert.notEqual(left, right);
  const page = await f.jobs.queryJobs({ packageId: a.packageId, targetRevisionId: a.targetRevisionId, duplicateStatus: 'possible' });
  assert.equal(page.total, 2);
});

test('Jaccard prefixes preserve the classifier UTF16 grams at the exact 82/100 boundary', () => {
  const sets = Array.from({ length: 256 }, (_, mask) => Array.from({ length: 8 }, (_, bit) => bit).filter(bit => mask & (1 << bit)));
  const prefix = grams => grams.slice(0, Math.floor(18 * grams.length / 100) + 1);
  for (const a of sets) for (const b of sets) {
    const common = a.filter(value => b.includes(value)).length;
    if (common && common * 182 >= (a.length + b.length) * 82) assert.ok(prefix(a).some(value => prefix(b).includes(value)), JSON.stringify({ a, b }));
  }
  const atBoundaryA = Array.from({ length: 91 }, (_, n) => n), atBoundaryB = Array.from({ length: 91 }, (_, n) => n + 9);
  assert.equal(atBoundaryA.filter(n => atBoundaryB.includes(n)).length / 100, 0.82);
  assert.ok(prefix(atBoundaryA).some(value => prefix(atBoundaryB).includes(value)));
  const titles = ['', 'a', 'aa', 'aaaa', 'ababab', '高级工程开发岗位', '高级工程开发岗位A', 'ＡＢＣ', 'abc', '🙂🙂a', '🙂🙂b', 'fire engineer 1', 'fire engineer 2'];
  for (const a of titles) for (const b of titles) {
    const x = jobTitleGrams(a), y = jobTitleGrams(b), common = x.filter(value => y.includes(value)).length;
    const result = relateJobs(job({ title: a }), job({ title: b }));
    if (result.reasons.includes('similar_company_title')) {
      assert.ok(common * 182 >= 82 * (x.length + y.length));
      assert.ok(jobTitleCandidateGrams(a).some(gram => jobTitleCandidateGrams(b).includes(gram)));
    }
  }
});

test('collection commit checks the stored target routing instead of the caller scope', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets(), [id] = await f.ingest(a, [job()]);
  const current = (await createEvaluationService({ repository: f.repository }).evaluate({ scope: a, jobIds: [id], mode: 'rules' })).evaluations[0];
  const rootId = 'incorrect-routing', pending = { ...current, evaluationId: 'guard-' + randomUUID() }; delete pending.recordId;
  await f.repository.transaction({ select: [{ collection: 'runs', ownerPackageId: a.packageId, ids: [rootId] }] }, tx => tx.putRow({ collection: 'runs', id: rootId, ownerPackageId: a.packageId, targetRevisionId: 'wrong@1', value: { runId: rootId, recordId: randomUUID(), ownerPackageId: a.packageId, status: 'running', collectionProgress: { epoch: 1, status: 'collecting', activeSliceRunId: 'slice' } } }), { scope: a });
  await assert.rejects(f.jobs.saveEvaluations([pending], a, { collectionGuard: { ref: { scope: { packageId: a.packageId, targetRevisionId: a.targetRevisionId }, activityId: rootId }, token: { epoch: 1, sliceRunId: 'slice' } } }), { code: 'collection_stale_epoch' });
  assert.equal(await f.repository.getRow({ collection: 'evaluations', id: pending.evaluationId, ownerPackageId: a.packageId }, { scope: a }), null);
});

test('abort while waiting for the write fence commits no evaluation or projection changes', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets(), [id] = await f.ingest(a, [job()]);
  const current = (await createEvaluationService({ repository: f.repository }).evaluate({ scope: a, jobIds: [id], mode: 'rules' })).evaluations[0];
  const pending = { ...current, evaluationId: 'cancel-' + randomUUID() }; delete pending.recordId;
  let release, entered;
  const entry = new Promise(resolve => { entered = resolve; }), pause = new Promise(resolve => { release = resolve; });
  const holder = f.repository.withWriteFence(async () => { entered(); await pause; });
  await entry; const signal = new AbortController();
  const result = f.jobs.saveEvaluations([pending], a, { signal: signal.signal });
  signal.abort(); release(); await holder;
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(await f.repository.getRow({ collection: 'evaluations', id: pending.evaluationId, ownerPackageId: a.packageId }, { scope: a }), null);
  const projection = await f.repository.getRow({ collection: 'jobProjections', id, ownerPackageId: a.packageId }, { scope: a });
  assert.equal(projection.evaluationId, current.evaluationId);
});

test('real ledger churn does not invalidate job list, detail, export or prepared ingest', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets(), [id] = await f.ingest(a, [job()]);
  const other = await openWorkspaceRepository({ dataDir: f.dataDir, clock: f.clock }); registerTestResource(t, () => other.close());
  const runId = (await other.queryRows({ collection: 'runs', ownerPackageId: a.packageId, limit: 1 }, { scope: a })).rows[0].id;
  let changes = 0;
  const churn = async () => {
    const key = 'churn-' + ++changes, reservationId = rowKey(runId, 'collectionProgress.ledger.reservations', key);
    const value = { reservationId: key, kind: 'request', status: 'reserved', requestUpperBound: 1 };
    await other.transaction({ select: [{ collection: 'reservations', ownerPackageId: a.packageId, ids: [reservationId] }] }, tx => tx.putRow({ collection: 'reservations', id: reservationId, ownerPackageId: a.packageId, parent: { collection: 'runs', id: runId, path: 'collectionProgress.ledger.reservations' }, value }), { scope: a });
  };
  const head = (await f.repository.readJobHead({ ownerPackageId: a.packageId }, { scope: a })).head, revision = await f.repository.getMeta('revision');
  const proxy = new Proxy(f.repository, { get(target, method) { const value = target[method]; return ['readView', 'findJobIdentityCandidates'].includes(method) ? async (...args) => { const result = await value(...args); await churn(); return result; } : value; } });
  const service = createJobService({ repository: proxy });
  assert.equal((await service.queryJobs({ packageId: a.packageId, targetRevisionId: a.targetRevisionId })).total, 1);
  assert.equal((await service.getJob(id, a)).jobId, id);
  assert.equal(JSON.parse((await createExportService({ repository: proxy }).export({ scope: a })).body).length, 1);
  assert.equal((await f.repository.readJobHead({ ownerPackageId: a.packageId }, { scope: a })).head, head);
  const result = await service.ingestRecords({ scope: a, runId, records: [job({ sourceRecordId: 'churn-new', title: '另一个岗位', url: 'https://jobs.example.com/churn-new' })] });
  assert.equal(result.jobIds.length, 1); assert.equal((await service.getOperationMetrics()).ingest.attempts, 1);
  assert.ok(changes >= 10); assert.ok(await f.repository.getMeta('revision') > revision + 10);
});

test('a selected job change retries the whole SQL page and its current closure', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets(), [id] = await f.ingest(a, [job()]); let pages = 0;
  const proxy = new Proxy(f.repository, { get(target, method) { return method === 'queryJobPage' ? async (...args) => { const result = await target.queryJobPage(...args); if (++pages === 1) await f.jobs.updateJobApplication(id, { note: 'new current application' }, a); return result; } : target[method]; } });
  const page = await createJobService({ repository: proxy }).queryJobs({ packageId: a.packageId, targetRevisionId: a.targetRevisionId });
  assert.equal(pages, 2); assert.equal(page.total, 1); assert.equal(page.items[0].application.note, 'new current application');
});

test('prepared ingest retries on a real job change and preserves the intervening application', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets(), [id] = await f.ingest(a, [job()]);
  const runId = (await f.repository.queryRows({ collection: 'runs', ownerPackageId: a.packageId, limit: 1 }, { scope: a })).rows[0].id; let changed = false;
  const proxy = new Proxy(f.repository, { get(target, method) { return method === 'findJobIdentityCandidates' ? async (...args) => { const result = await target.findJobIdentityCandidates(...args); if (!changed) { changed = true; await f.jobs.updateJobApplication(id, { note: 'committed during fact preparation' }, a); } return result; } : target[method]; } });
  const service = createJobService({ repository: proxy });
  const result = await service.ingestRecords({ scope: a, runId, records: [job({ sourceRecordId: 'after-conflict', title: '另一岗位', url: 'https://jobs.example.com/after-conflict' })] });
  assert.equal(result.jobIds.length, 1); assert.equal((await service.getOperationMetrics()).ingest.attempts, 2);
  assert.equal((await f.jobs.getJob(id, a)).application.note, 'committed during fact preparation');
});

test('an empty all-target page retries its total after a control-only owner tombstone', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets(); await f.ingest(a, [job()]);
  const before = await f.repository.readJobHead({ allTargets: true }), revision = await f.repository.getMeta('revision'); let pages = 0;
  const proxy = new Proxy(f.repository, { get(target, method) { return method === 'queryJobPage' ? async (...args) => { const result = await target.queryJobPage(...args); if (++pages === 1) await target.withWriteFence(async fence => { const control = fence.control; control.deletionLedger[a.packageId] = { phase: 'purged', recordIds: [] }; await fence.commitControl(control); }); return result; } : target[method]; } });
  const page = await createJobService({ repository: proxy }).queryJobs({ allTargets: true, page: 2, pageSize: 1 });
  assert.equal(page.items.length, 0); assert.equal(page.total, 0); assert.equal(pages, 2);
  const after = await f.repository.readJobHead({ allTargets: true });
  assert.equal(after.head, before.head); assert.notEqual(after.controlDeletionHead, before.controlDeletionHead);
  assert.equal(await f.repository.getMeta('revision'), revision);
});

test('sparse evidence cannot make persisted duplicate relations ignore a known certificate conflict', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets();
  const [left] = await f.ingest(a, [job({ certificateRequirementStatus: 'none' })]);
  const [right] = await f.ingest(a, [job({ sourceId: 'other', siteId: 'other', identityScope: 'other', sourceRecordId: 'other', requiredCertificates: ['注册消防工程师'] })]);
  assert.notEqual(left, right);
  const runId = (await f.repository.queryRows({ collection: 'runs', ownerPackageId: a.packageId, limit: 1 }, { scope: a })).rows[0].id;
  const result = await f.jobs.ingestRecords({ scope: a, runId, records: [job({ certificateRequirementStatus: undefined })] });
  assert.deepEqual(result.jobIds, [left]);
  assert.equal(result.duplicateRelations.find(relation => relation.otherJobId === right).relation, 'possible');
  const relations = await f.repository.queryRows({ collection: 'jobRelations', ownerPackageId: a.packageId, where: { jobId: left }, limit: 50 }, { scope: a });
  assert.equal(relations.rows.find(row => row.value.otherJobId === right).value.relation, 'possible');
  assert.equal((await f.repository.getRow({ collection: 'jobs', id: left, ownerPackageId: a.packageId }, { scope: a })).canonical.certificateRequirementStatus, 'none');
});
