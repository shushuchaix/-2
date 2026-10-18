import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createEmptyWorkspace } from '../../src/domain/contracts.mjs';
import { buildWorkspaceJobReadModels, currentDuplicateStatus } from '../../src/domain/job-read-model.mjs';
import { buildWorkspaceDuplicatePlan } from '../../src/domain/job-duplicates.mjs';
import { assertJson } from '../../src/infrastructure/storage/sqlite-records.mjs';
import { job } from '../helpers/fixtures.mjs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/infrastructure/storage/sqlite-schema.mjs';
import { createSqliteJobQueries } from '../../src/infrastructure/storage/sqlite-job-queries.mjs';
import { normalizeRecord } from '../../src/domain/record.mjs';
import { assessRecruitmentEvidence } from '../../src/domain/recruitment-evidence.mjs';
import { writeTestEvidence } from '../helpers/evidence.mjs';

function equivalentWorkspace(count) {
  const w = createEmptyWorkspace({ schemaVersion: 3 }), owner = '10000000-0000-4000-8000-000000000001', seen = '2026-10-09T00:00:00.000Z';
  w.packages[owner] = { packageId: owner, kind: 'target', versionId: 't@1', versionName: 'Synthetic', state: 'active' };
  w.targets.t = [{ targetId: 't', revisionId: 't@1', ownerPackageId: owner, profileSnapshot: { profileId: 'copy', revisionId: 'copy@1', profile: {} } }];
  w.targetMembers = { 't@1': {} };
  const canonical = job({ retrievedAt: seen });
  for (let n = 0; n < count; n++) {
    const id = 'j-' + String(n).padStart(6, '0'), observationId = 'o-' + n;
    w.jobs[id] = { jobId: id, recordId: randomUUID(), ownerPackageId: owner, kind: 'job', canonical, identityAliases: [], sourceRefs: [], duplicateGroupIds: [], firstSeen: seen, lastSeen: seen };
    w.observations[observationId] = { observationId, jobId: id, runId: 'r', ownerPackageId: owner, fields: canonical, observedAt: seen };
    w.targetMembers['t@1'][id] = { currentObservationId: observationId, factRefs: [{ observationId }] };
  }
  for (const id of ['j-000000', 'j-' + String(count - 1).padStart(6, '0')]) w.applications['a-' + id] = { applicationId: 'a-' + id, jobId: id, ownerPackageId: owner, status: 'applied', events: [] };
  return { w, owner, seen };
}

test('source optional top-level undefined fields are absent without upgrading body evidence or accepting nested undefined', () => {
  const record = normalizeRecord(job({ bodyStatus: undefined, detailStatus: undefined, optionalExtension: undefined }));
  assertJson(record); assert.equal(Object.hasOwn(record, 'optionalExtension'), false);
  assert.equal(assessRecruitmentEvidence({ record, now: Date.now() }).bodyVerified === true, false);
  const nested = normalizeRecord(job({ optionalExtension: { nested: undefined } }));
  assert.throws(() => assertJson(nested), { code: 'sqlite_invalid_json' });
});

test('10000 equivalent confirmed jobs produce a linear group/member read model and retain exact cleanup protection', async () => {
  const measurements = [];
  for (const jobs of [1000, 10000]) {
    const { w, owner, seen } = equivalentWorkspace(jobs), started = performance.now();
    const records = buildWorkspaceJobReadModels(w, { asOf: seen });
    const heads = records.filter(row => row.collection === 'jobRelations' && row.value.kind === 'confirmed_group_head'), members = records.filter(row => row.collection === 'jobRelations' && row.value.kind === 'confirmed_group_member');
    assert.equal(heads.length, 1); assert.equal(members.length, jobs);
    assert.equal(heads[0].value.memberCount, jobs); assert.equal(heads[0].value.manualApplicationCount, 2); assert.equal(heads[0].value.status, 'protected');
    const relations = records.filter(row => row.collection === 'jobRelations');
    const seeds = relations.filter(row => row.value.kind === 'legacy_application_seed');
    assert.equal(heads.length + members.length, jobs + 1);
    assert.deepEqual(seeds.map(row => ({ parent: row.parent, value: row.value })),
      Object.values(w.applications).map(application => ({
        parent: { collection: 'applications', id: application.applicationId, path: 'legacyAssociationSeeds' },
        value: { kind: 'legacy_application_seed', resourceKey: application.jobId, ownerPackageId: owner },
      })));
    assert.equal(relations.length, jobs + 1 + seeds.length);
    assert.ok(records.length < 20 * jobs + 10);
    for (const row of records) assertJson(row.value);
    const projection = records.find(row => row.collection === 'jobProjections');
    assert.equal(typeof projection.value.bodyVerified, 'boolean');
    assert.equal(currentDuplicateStatus(projection.value, heads[0].value), 'protected');
    const plan = buildWorkspaceDuplicatePlan({ ...w, _scope: { packageId: owner } }, { readModelOnly: true });
    assert.equal(plan.groups.length, 1); assert.equal(plan.groups[0].protected, true); assert.equal(plan.groups[0].removeJobIds.length, jobs - 1); assert.equal(plan.counts.removedEntities, 0);
    assert.equal(plan.groups[0].keepJobId, heads[0].value.representativeJobId);
    measurements.push({ jobs, elapsedMs: performance.now() - started, records: records.length, relationRecords: relations.length, confirmedGroupRecords: heads.length + members.length, legacyApplicationSeeds: seeds.length });
  }
  assert.ok(measurements[1].records <= measurements[0].records * 10);
  await writeTestEvidence('job-read-model', 'confirmed-group-linear.json', JSON.stringify({ synthetic: true, nonIsolated: true, measurements }, null, 2));
});

test('scoped and all-target job heads use terminal index seeks under unrelated owner and ledger change growth', async () => {
  const db = new DatabaseSync(':memory:'), owner = '10000000-0000-4000-8000-000000000001', other = '20000000-0000-4000-8000-000000000002';
  try {
    db.exec(SCHEMA_SQL);
    const insert = db.prepare('INSERT INTO changes(revision,collection,id,owner_id,topic,action) VALUES(?,?,?,?,?,?)');
    const add = (count, collection, selectedOwner) => { db.exec('BEGIN'); for (let n = 0; n < count; n++) insert.run(n, collection, String(n), selectedOwner, collection, 'put'); db.exec('COMMIT'); };
    const query = createSqliteJobQueries({ db }), measurements = [];
    const measure = phase => {
      const result = { phase, changeRows: db.prepare('SELECT count(*) AS n FROM changes').get().n };
      for (const [name, input] of [['scoped', { ownerPackageId: owner }], ['allTargets', { allTargets: true }]]) {
        const started = performance.now(); for (let n = 0; n < 100; n++) query.readJobHead(input);
        result[name + '100ReadsMs'] = performance.now() - started; result[name + 'Head'] = query.readJobHead(input).head;
      }
      measurements.push(result);
    };
    add(1000, 'jobIdentityKeys', owner); measure('1000_job_changes');
    add(99000, 'jobIdentityKeys', other); measure('100000_job_changes');
    add(100000, 'reservations', owner); measure('plus_100000_ledger_changes');
    assert.equal(measurements[0].scopedHead, measurements[2].scopedHead);
    assert.equal(measurements[1].allTargetsHead, measurements[2].allTargetsHead);
    assert.ok(measurements[1].allTargetsHead > measurements[0].allTargetsHead);
    const plans = [];
    for (const [name, sql, bindings, index] of [['scoped', "SELECT max(seq) FROM changes WHERE collection='jobIdentityKeys' AND owner_id=?", [owner], 'changes_job_owner'], ['allTargets', "SELECT max(seq) FROM changes WHERE collection='jobIdentityKeys'", [], 'changes_job_collection']]) {
      const explain = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...bindings).map(row => row.detail), bytecode = db.prepare('EXPLAIN ' + sql).all(...bindings);
      assert.ok(explain.some(detail => detail.includes(index)), JSON.stringify(explain));
      const aggregation = bytecode.findIndex(row => row.opcode === 'AggStep');
      assert.equal(bytecode[aggregation + 1].opcode, 'Goto'); // The first max row exits; no iteration across this collection.
      assert.ok(bytecode.some(row => row.opcode === 'SeekLE'));
      plans.push({ name, explain, bytecode: bytecode.map(({ addr, opcode, p1, p2, p3, p4 }) => ({ addr, opcode, p1, p2, p3, p4 })) });
    }
    await writeTestEvidence('job-read-model', 'job-head-index-growth.json', JSON.stringify({ synthetic: true, nonIsolated: true, microbenchmark: 'fixed job head only, not service latency', measurements, plans }, null, 2));
  } finally { db.close(); }
});
