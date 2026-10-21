import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {job} from '../helpers/fixtures.mjs';
import {packageBusinessFixture} from '../helpers/package-business-fixture.mjs';
test('same posting has independent owned applications and observations',async t=>{
  const f=await packageBusinessFixture(t);const {a,b}=await f.twoTargets();
  const [ja]=await f.ingest(a,[job()]),[jb]=await f.ingest(b,[job()]);
  assert.notEqual(ja,jb);
  const aa=await f.jobs.updateJobApplication(ja,{status:'applied',note:'合成备注A'},a);
  const ab=await f.jobs.updateJobApplication(jb,{status:'interested',note:'合成备注B'},b);
  assert.notEqual(aa.applicationId,ab.applicationId);
  assert.notEqual(aa.applicationId,ja);
  const detail=await f.jobs.getJob(ja,a);
  assert.equal(detail.application.note,'合成备注A');
  assert.equal(detail.observations.length,1);
  assert.equal(detail.observations[0].ownerPackageId,a.packageId);
  assert.equal((await f.jobs.getJob(jb,b)).application.status,'interested');
  assert.equal((await f.jobs.getApplication(aa.applicationId,a)).application.applicationId,aa.applicationId);
  await assert.rejects(()=>f.jobs.getApplication(aa.applicationId,b),{code:'package_scope_mismatch'});
});
test('all target summary returns ownership and every write rejects missing or incorrect scope',async t=>{
  const f=await packageBusinessFixture(t);const {a,b}=await f.twoTargets();const [ja]=await f.ingest(a,[job()]);await f.ingest(b,[job()]);
  const rows=(await f.jobs.queryJobs({allTargets:true})).items;
  assert.equal(rows.length,2);assert.deepEqual(new Set(rows.map(r=>r.ownerPackageId)),new Set([a.packageId,b.packageId]));
  await assert.rejects(()=>f.jobs.updateJobApplication(ja,{note:'invalid'}),{code:'version_scope_required'});
  await assert.rejects(()=>f.jobs.getJob(ja,b),{code:'package_scope_mismatch'});
  await assert.rejects(()=>f.jobs.linkJobs(ja,rows.find(r=>r.ownerPackageId===b.packageId).jobId,a),{code:'package_scope_mismatch'});
  await assert.rejects(()=>f.jobs.updateJobApplication(ja,{note:'invalid'},{allTargets:true}),{code:'version_scope_required'});
});
test('archived package disappears from summaries and its reads exports and ordinary writes reject',async t=>{
  const f=await packageBusinessFixture(t);const {a,b}=await f.twoTargets();const [ja]=await f.ingest(a,[job()]);await f.ingest(b,[job()]);
  await f.repository.mutateWorkspace(w=>{Object.assign(w.packages[a.packageId],{state:'trashed',archiveId:randomUUID(),archivedAt:'2026-10-09T00:00:00.000Z',purgeAt:'2026-10-12T00:00:00.000Z'});});
  assert.equal((await f.jobs.queryJobs({allTargets:true})).total,1);
  await assert.rejects(()=>f.jobs.getJob(ja,a),{code:'package_archived'});
  await assert.rejects(()=>f.jobs.updateJobApplication(ja,{note:'invalid'},a),{code:'package_archived'});
  await assert.rejects(()=>f.exportService.export({scope:a}),{code:'package_archived'});
});
test('exports are scoped and application resume can only point to the target owned snapshot',async t=>{
  const f=await packageBusinessFixture(t);const {sourceProfile,a,b}=await f.twoTargets();const [ja]=await f.ingest(a,[job({title:'合成岗位A'})]);await f.ingest(b,[job({title:'合成岗位B'})]);
  await f.jobs.updateJobApplication(ja,{note:'合成A',resumeRevisionId:a.profileSnapshot.revisionId},a);
  await assert.rejects(()=>f.jobs.updateJobApplication(ja,{resumeRevisionId:sourceProfile.revisionId},a),{code:'package_scope_mismatch'});
  const rows=JSON.parse((await f.exportService.export({scope:a})).body);assert.equal(rows.length,1);assert.equal(rows[0].title,'合成岗位A');assert.equal(rows[0].application.note,'合成A');
});
test('manual import creates owned observations under a synthetic import run',async t=>{
  const f=await packageBusinessFixture(t);const {a,b}=await f.twoTargets();
  const result=await f.importService.import({text:'合成招聘公告：面向机场消防工程岗位，要求本科，工作地点北京。',title:'合成公告'},{scope:a});
  assert.equal(result.jobIds.length,1);assert.equal((await f.jobs.queryJobs({packageId:b.packageId,targetRevisionId:b.targetRevisionId})).total,0);
  const detail=await f.jobs.getJob(result.jobIds[0],a);assert.equal(detail.observations[0].ownerPackageId,a.packageId);assert.ok(detail.observations[0].recordId);
});
test('application board lists independent ids and owners with exact scope and pagination',async t=>{
 const f=await packageBusinessFixture(t);const {a,b}=await f.twoTargets();const [ja]=await f.ingest(a,[job({title:'合成A'})]),[jb]=await f.ingest(b,[job({title:'合成B'})]);
 const aa=await f.jobs.updateJobApplication(ja,{status:'applied'},a);await f.jobs.updateJobApplication(jb,{status:'interested'},b);
 const own=await f.jobs.queryApplications({packageId:a.packageId,targetRevisionId:a.targetRevisionId,page:1,pageSize:1});assert.equal(own.total,1);assert.equal(own.items[0].applicationId,aa.applicationId);assert.equal(own.items[0].ownerPackageId,a.packageId);assert.equal(own.items[0].title,'合成A');
 const all=await f.jobs.queryApplications({allTargets:true});assert.equal(all.total,2);assert.equal(all.readOnly,true);assert.deepEqual(new Set(all.items.map(r=>r.ownerPackageId)),new Set([a.packageId,b.packageId]));
 await assert.rejects(()=>f.jobs.queryApplications(),{code:'version_scope_required'});
});
test('a shared source alias resolves only inside the selected package for application writes',async t=>{
 const f=await packageBusinessFixture(t),{a,b}=await f.twoTargets(),[ja]=await f.ingest(a,[job()]),[jb]=await f.ingest(b,[job()]);await f.repository.mutateWorkspace(w=>{w.identityAliases['shared-source']=[ja,jb];});
 const aa=await f.jobs.updateJobApplication('shared-source',{note:'合成A'},a),ab=await f.jobs.updateJobApplication('shared-source',{note:'合成B'},b);assert.equal(aa.jobId,ja);assert.equal(ab.jobId,jb);assert.notEqual(aa.applicationId,ab.applicationId);await assert.rejects(()=>f.jobs.updateJobApplication(jb,{note:'invalid'},a),{code:'package_scope_mismatch'});
});
test('export accepts the all-target read scope and preserves row ownership',async t=>{
 const f=await packageBusinessFixture(t),{a,b}=await f.twoTargets();await f.ingest(a,[job()]);await f.ingest(b,[job()]);const rows=JSON.parse((await f.exportService.export({scope:{allTargets:true}})).body);assert.equal(rows.length,2);assert.deepEqual(new Set(rows.map(r=>r.ownerPackageId)),new Set([a.packageId,b.packageId]));await assert.rejects(()=>f.exportService.export({scope:{allTargets:true,packageId:a.packageId,targetRevisionId:a.targetRevisionId}}),{code:'package_scope_mismatch'});
});
