import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { packageBusinessFixture } from '../helpers/package-business-fixture.mjs';
import { job } from '../helpers/fixtures.mjs';
import { createEvaluationService } from '../../src/application/evaluation-service.mjs';
import { jobIdentityIndexKeys, nextJobTemporalChangeAt } from '../../src/domain/job-read-model.mjs';
import { rowKey } from '../../src/infrastructure/storage/sqlite-records.mjs';
import { jobFactHash } from '../../src/domain/job-facts.mjs';
import { createJobCleanupService } from '../../src/application/job-cleanup-service.mjs';

const verifiedJob = (clock, overrides = {}) => job({
  title: '消防工程师', jobType: 'social', graduationYear: null,
  description: '岗位职责：负责消防工程设施维护、安全检查、工程项目巡检与应急演练。任职要求：本科及以上学历，认真落实消防安全责任，整理工程维护记录，执行巡检操作流程。',
  detailStatus: 'complete', deadlineAt: '2030-01-01T00:00:00.000Z',
  applyUrl: 'https://jobs.example.com/application',
  applicationVerification: { status: 200, formVerified: true, checkedAt: new Date(clock.now()).toISOString() },
  ...overrides,
});
const metrics = repository => repository.metrics();
const scopeOf = value => ({ packageId: value.packageId, targetRevisionId: value.targetRevisionId });

test('formal owned profile save → rules → list/detail/export uses the copy revision and bounded ordinary reads', async t => {
  const f = await packageBusinessFixture(t), { sourceProfile, a } = await f.twoTargets();
  assert.notEqual(a.profileSnapshot.revisionId, sourceProfile.revisionId);
  const [id] = await f.ingest(a, [verifiedJob(f.clock)]);
  const evaluations = createEvaluationService({ repository: f.repository, modelFactory: () => { throw Error('Rules must not invoke a model'); } });
  const result = await evaluations.evaluate({ scope: a, jobIds: [id], mode: 'rules' });
  const evaluation = result.evaluations[0];
  assert.equal(evaluation.profileRevisionId, a.profileSnapshot.revisionId);
  assert.equal(evaluation.qualification.status, 'pass');
  assert.equal(evaluation.recommended, true);
  await f.repository.metrics({ reset: true });
  const list = await f.jobs.queryJobs({ ...scopeOf(a), pageSize: 1 });
  const detail = await f.jobs.getJob(id, a);
  const exported = JSON.parse((await f.exportService.export({ scope: a })).body);
  for (const row of [list.items[0], detail, exported[0]]) {
    assert.equal(row.evaluation.evaluationId, evaluation.evaluationId);
    assert.equal(row.evaluation.profileRevisionId, a.profileSnapshot.revisionId);
    assert.equal(row.evaluation.recommended, true);
  }
  const m = await metrics(f.repository);
  assert.equal(m.maintenanceReads, 0); assert.equal(m.maintenanceMutations, 0);
  assert.equal(m.maintenanceExports, 0);
  assert.ok(m.decodedRows < 200);
});

test('72 hour evidence boundary, opening filter, quality and export share one time basis without a GET mutation', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets(), [id] = await f.ingest(a, [verifiedJob(f.clock)]);
  await createEvaluationService({ repository: f.repository }).evaluate({ scope: a, jobIds: [id], mode: 'rules' });
  const first = await f.jobs.queryJobs({ ...scopeOf(a), openingStatus: 'open', qualification: 'pass' });
  assert.equal(first.total, 1); assert.equal(first.items[0].evaluation.recommended, true);
  f.clock.advance(72 * 3600000);
  assert.equal((await f.jobs.queryJobs(scopeOf(a))).items[0].evaluation.recommended, true);
  f.clock.advance(1);
  await f.repository.metrics({ reset: true });
  const list = await f.jobs.queryJobs({ ...scopeOf(a), openingStatus: 'open', qualification: 'pass', recommendation: 'insufficient' });
  const detail = await f.jobs.getJob(id, a), quality = await f.repository.queryJobQuality({ ownerPackageId: a.packageId, asOf: f.clock.now() }, { scope: a });
  const exported = JSON.parse((await f.exportService.export({ scope: a, filters: { qualification: 'pass', recommendation: 'insufficient' } })).body);
  assert.equal(list.total, 1); assert.equal(exported.length, 1);
  assert.equal(quality.openCount, 1); assert.equal(quality.verifiedRecommendationCount, 0);
  for (const row of [list.items[0], detail, exported[0]]) {
    assert.equal(row.evaluation.qualification.status, 'pass');
    assert.equal(row.recruitmentEvidence.openingStatus, 'open');
    assert.equal(row.recruitmentEvidence.applicationStatus, 'unknown');
    assert.equal(row.evaluation.recommended, false);
    assert.ok(row.nextTemporalChangeAt === null || Date.parse(row.nextTemporalChangeAt) > Number(f.clock.now()));
  }
  const m = await metrics(f.repository); assert.equal(m.maintenanceReads, 0); assert.equal(m.rowsWritten, 0);
});

test('birthday and registration expiry recompute local rules without closing still-open recruitment', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets();
  await f.repository.mutateWorkspace(w => {
    const target = Object.values(w.targets).flat().find(target => target.revisionId === a.targetRevisionId);
    Object.assign(target.profileSnapshot.profile, { birthDate: '1996-10-10', certificates: [{ name: '注册消防工程师', registrationValidUntil: '2026-10-11T00:00:00.000Z' }] });
  });
  const [id] = await f.ingest(a, [verifiedJob(f.clock, { description: '岗位职责：负责消防工程设施维护、安全检查、工程项目巡检与应急演练。任职要求：本科及以上学历，年龄不超过29周岁，持有注册消防工程师证书且注册有效。认真落实消防安全责任，执行巡检操作流程。' })]);
  const evaluator = createEvaluationService({ repository: f.repository });
  const current = (await evaluator.evaluate({ scope: a, jobIds: [id], mode: 'rules' })).evaluations[0];
  assert.equal(current.qualification.status, 'pass');
  f.clock.advance(24 * 3600000);
  const birthday = await f.jobs.queryJobs({ ...scopeOf(a), openingStatus: 'open', qualification: 'fail' });
  assert.equal(birthday.total, 1); assert.equal(birthday.items[0].evaluation.temporalRecalculated, true);
  assert.equal(birthday.items[0].evaluation.qualification.checks.find(c => c.type === 'age').status, 'fail');
  assert.equal((await f.repository.queryJobQuality({ ownerPackageId: a.packageId, asOf: f.clock.now() }, { scope: a })).openCount, 1);
  f.clock.advance(24 * 3600000 + 1);
  const expired = await f.jobs.getJob(id, a);
  assert.equal(expired.evaluation.qualification.checks.find(c => c.type === 'certificate').status, 'fail');
  assert.equal(expired.recruitmentEvidence.openingStatus, 'open');
  assert.equal(expired.evaluation.recommended, false);
});

test('default job history and application events stay bounded and expose continuation', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets(), [id] = await f.ingest(a, [verifiedJob(f.clock)]);
  const application = await f.jobs.updateJobApplication(id, { status: 'applied' }, a);
  const events = Array.from({ length: 80 }, (_, index) => ({ collection: 'applicationEvents', id: rowKey(application.applicationId, 'events', String(index + 1)), ordinal: index + 1, ownerPackageId: a.packageId, parent: { collection: 'applications', id: application.applicationId, path: 'events' }, value: { recordId: randomUUID(), ownerPackageId: a.packageId, type: 'synthetic_history', at: new Date(f.clock.now()).toISOString() } }));
  await f.repository.transaction({ select: [{ collection: 'applicationEvents', ownerPackageId: a.packageId, ids: events.map(row => row.id) }] }, tx => { for (const event of events) tx.putRow(event); }, { scope: a });
  await f.repository.metrics({ reset: true });
  const detail = await f.jobs.getJob(id, a);
  assert.equal(detail.application.events.length, 50); assert.equal(detail.history.applicationEvents.total, 81); assert.equal(detail.history.applicationEvents.hasMore, true);
  assert.ok(detail.history.applicationEvents.nextCursor);
  await f.jobs.updateJobApplication(id, { note: 'Bounded update' }, a);
  const last = await f.repository.aggregateRows({ collection: 'applicationEvents', ownerPackageId: a.packageId, where: { parentId: application.applicationId }, operation: 'max', field: 'ordinal' }, { scope: a });
  assert.equal(last.groups[0].value, 81);
});

test('empty bodies do not share a content candidate bucket and boundaries preserve exact inclusive checks', () => {
  const empty = jobIdentityIndexKeys(job({ description: null }));
  assert.equal(empty.some(key => key.kind === 'content_hash' || key.kind.startsWith('simhash_')), false);
  assert.equal(empty.some(key => key.kind === 'fingerprint'), true);
  assert.equal(jobIdentityIndexKeys(job({ description: ' '.repeat(50) })).some(key => key.kind.startsWith('simhash_')), false);
  const checked = '2026-10-09T00:00:00.000Z';
  assert.equal(nextJobTemporalChangeAt(job({ applyUrl: 'https://jobs.example.com/apply', applicationVerification: { checkedAt: checked, status: 200, formVerified: true }, deadlineAt: null }), {}, checked), '2026-10-12T00:00:00.001Z');
});

test('compact confirmed group leaf updates maintain one shared protection head and bounded related history', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets(), [original] = await f.ingest(a, [verifiedJob(f.clock)]);
  const ids = [original, ...Array.from({ length: 120 }, (_, n) => 'j-compact-' + String(n).padStart(3, '0'))];
  await f.repository.mutateWorkspace(w => {
    const base = w.jobs[original], observation = Object.values(w.observations).find(row => row.jobId === original);
    for (const id of ids.slice(1)) {
      const observationId = 'o-compact-' + id;
      w.jobs[id] = { ...structuredClone(base), jobId: id, recordId: randomUUID() };
      w.observations[observationId] = { ...structuredClone(observation), observationId, jobId: id, recordId: randomUUID() };
      w.targetMembers[a.targetRevisionId][id] = { ...structuredClone(w.targetMembers[a.targetRevisionId][original]), currentObservationId: observationId, factRefs: [{ observationId }] };
    }
  });
  const heads = () => f.repository.queryRows({ collection: 'jobRelations', ownerPackageId: a.packageId, where: { kind: 'confirmed_group_head' }, limit: 1 }, { scope: a });
  const initialHead = (await heads()).rows[0], leafA = ids.at(-1), leafB = ids.at(-2);
  assert.notEqual(initialHead.value.representativeJobId, leafA);
  const first = await f.jobs.getJob(leafA, a);
  assert.ok(first.relatedJobs.length <= 50); assert.equal(first.relatedJobsPage.total, 120); assert.equal(first.relatedJobsPage.hasMore, true); assert.ok(first.relatedJobsPage.nextCursor);
  const next = await f.jobs.getJob(leafA, { ...a, relatedJobCursor: first.relatedJobsPage.nextCursor });
  assert.ok(next.relatedJobs.every(row => !first.relatedJobs.some(previous => previous.jobId === row.jobId)));
  const applicationA = await f.jobs.updateJobApplication(leafA, { status: 'applied' }, a);
  await f.repository.metrics({ reset: true });
  await f.jobs.updateJobApplication(leafB, { note: 'manual second application' }, a);
  const writes = await f.repository.metrics(); assert.ok(writes.rowsWritten < 15, JSON.stringify(writes)); assert.ok(writes.decodedRows < 100, JSON.stringify(writes));
  assert.equal((await heads()).rows[0].id, initialHead.id);
  assert.equal((await heads()).rows[0].value.manualApplicationCount, 2);
  await f.jobs.linkJobs(leafA, leafB, a);
  const relatedIds = new Set(); let relatedCursor;
  do {
    const page = await f.jobs.getJob(leafA, { ...a, ...(relatedCursor ? { relatedJobCursor: relatedCursor } : {}) });
    assert.equal(page.relatedJobsPage.total, 120);
    for (const related of page.relatedJobs) { assert.equal(relatedIds.has(related.jobId), false); relatedIds.add(related.jobId); }
    relatedCursor = page.relatedJobsPage.nextCursor;
  } while (relatedCursor);
  assert.equal(relatedIds.size, 120); // Legacy manual links and compact members overlap in the SQL union.
  await f.repository.metrics({ reset: true });
  assert.equal((await f.jobs.queryJobs({ ...scopeOf(a), duplicateStatus: 'protected' })).total, 121);
  assert.equal((await f.jobs.getJob(original, a)).duplicateStatus, 'protected');
  assert.equal((await f.repository.metrics()).maintenanceExports, 0);
  const cleanup = createJobCleanupService({ repository: f.repository });
  assert.equal((await cleanup.preview()).groups[0].protected, true);
  await f.jobs.updateJobApplication(leafA, { status: 'new', note: '' }, a);
  assert.equal((await cleanup.preview()).groups[0].protected, true); // Application history remains manual evidence.
  await f.repository.mutateWorkspace(w => { delete w.applications[applicationA.applicationId]; });
  assert.equal((await cleanup.preview()).groups[0].protected, false);
  assert.equal((await f.jobs.queryJobs({ ...scopeOf(a), duplicateStatus: 'protected' })).total, 0);
  const before = (await f.repository.readJobHead({ ownerPackageId: a.packageId }, { scope: a })).head;
  await f.repository.mutateWorkspace(w => {
    w.jobs[leafA].canonical = { ...w.jobs[leafA].canonical, company: '另一家合成单位', title: '独立岗位' };
    for (const observation of Object.values(w.observations)) if (observation.jobId === leafA) observation.fields = structuredClone(w.jobs[leafA].canonical);
    w.targetMembers[a.targetRevisionId][leafA].factContentHash = jobFactHash(w.jobs[leafA].canonical);
  });
  assert.ok((await f.repository.readJobHead({ ownerPackageId: a.packageId }, { scope: a })).head > before);
  assert.equal((await f.jobs.getJob(leafA, a)).duplicateStatus, 'normal');
  assert.equal((await heads()).rows[0].value.memberCount, 120);
  assert.equal((await cleanup.preview()).groups[0].protected, false);
});
