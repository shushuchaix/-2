import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { packageBusinessFixture } from '../helpers/package-business-fixture.mjs';
import { job } from '../helpers/fixtures.mjs';
import { summary, listJobs, setStatus } from '../../src/store.mjs';
import {upsert,loadIndex,annotate} from '../../src/store.mjs';
import {resolveLegacyScopeFromRepository} from '../../src/application/legacy-scope.mjs';
import {apiFixture} from '../helpers/api-fixture.mjs';
import {handlePackageBusinessRequest} from '../../src/server/package-business-routes.mjs';
import {createDiagnosticsLog} from '../../src/infrastructure/diagnostics/log.mjs';
import {buildWorkspaceDuplicatePlan} from '../../src/domain/job-duplicates.mjs';
import {createSqliteLegacyQueries} from '../../src/infrastructure/storage/sqlite-legacy-queries.mjs';
import {createRequire} from 'node:module';
import {runPipeline,loadRun,saveRun,listRuns} from '../../src/pipeline.mjs';
import {createPagedProvider} from '../../src/sources/adapters/shared.mjs';
import { writeTestEvidence } from '../helpers/evidence.mjs';

const noMaintenance = repository => {
  const m = repository.metrics();
  for (const key of ['maintenanceReads', 'maintenanceMutations', 'maintenanceTransactions', 'maintenanceExports', 'maintenanceImports']) assert.equal(m[key], 0, key);
};

test('legacy tracking ordinary summary list and status use bounded owner ports', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets();
  const [id] = await f.ingest(a, [job({ id: 'legacy-visible' })]);
  const context = { repository: f.repository, jobService: f.jobs };
  f.repository.metrics({ reset: true });
  assert.equal((await summary({ context, scope: a })).total, 1);
  assert.equal((await listJobs({ context, scope: a, limit: 1 })).length, 1);
  await setStatus(id, 'applied', 'bounded synthetic edit', { context, scope: a });
  noMaintenance(f.repository);
});

test('owned unresolved applications retain ambiguous and missing association and manual events', async t => {
  const f = await packageBusinessFixture(t), { a } = await f.twoTargets();
  const ids = await f.ingest(a, [job(), job({ sourceRecordId: '2', url: 'https://jobs.example.com/2', title: '机场安全专员' })]);
  await f.repository.mutateWorkspace(w => {
    for (const [applicationId, legacyJobIds] of [['legacy-ambiguous', ids], ['legacy-missing', ['not-present']]]) {
      w.applications[applicationId] = { applicationId, recordId: randomUUID(), ownerPackageId: a.packageId, jobId: ids[0], legacyJobIds, status: 'applied', note: applicationId, events: [{ recordId: randomUUID(), ownerPackageId: a.packageId, type: 'legacy_note', note: 'retained history' }] };
    }
  });
  f.repository.metrics({ reset: true });
  const page = await f.jobs.listUnresolvedApplications({ packageId:a.packageId,targetRevisionId:a.targetRevisionId, status: 'applied', pageSize: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  const ambiguous = await f.jobs.getApplication('legacy-ambiguous', a);
  assert.equal(ambiguous.association.status, 'ambiguous');
  assert.deepEqual([...ambiguous.association.jobIds].sort(), [...ids].sort());
  assert.equal(ambiguous.application.events[0].note, 'retained history');
  assert.equal((await f.jobs.getApplication('legacy-missing', a)).association.status, 'missing');
  await f.jobs.updateApplication('legacy-ambiguous', { note: 'manual edit' }, a);
  const edited = await f.jobs.getApplication('legacy-ambiguous', a);
  assert.deepEqual(edited.application.legacyJobIds, ids);
  assert.equal(edited.application.events.length, 2);
  assert.equal((await f.jobs.getJob(ids[0], a)).application.status, 'new');
  assert.equal((await f.jobs.getJob(ids[1], a)).application.status, 'new');
  assert.equal((await f.jobs.queryJobs({packageId:a.packageId,targetRevisionId:a.targetRevisionId,status:'applied'})).total,0);
  assert.equal((await summary({context:{repository:f.repository},scope:a})).byStatus.applied,0);
  const exported=JSON.parse((await f.exportService.export({scope:a})).body);
  assert.equal(exported.filter(row=>row.unresolved).length,2);
  assert.equal(exported.find(row=>row.unresolved&&row.application.applicationId==='legacy-ambiguous').application.note,'manual edit');
  const run=(await f.repository.queryRows({collection:'runs',ownerPackageId:a.packageId,limit:1},{scope:a})).rows[0].id;
  await f.jobs.ingestRecords({runId:run,scope:a,records:[job()]});
  assert.equal((await f.jobs.queryJobs({packageId:a.packageId,targetRevisionId:a.targetRevisionId,status:'applied'})).total,0,'incremental projection does not promote an ambiguous application');
  noMaintenance(f.repository);
});

test('legacy alias discovery rejects cross-owner ambiguity and explicit scope remains exact',async t=>{
 const f=await packageBusinessFixture(t),{a,b}=await f.twoTargets();
 await f.ingest(a,[job({id:'shared-legacy'})]);await f.ingest(b,[job({id:'shared-legacy'})]);
 f.repository.metrics({reset:true});
 await assert.rejects(()=>resolveLegacyScopeFromRepository({jobId:'shared-legacy'},f.repository),{code:'version_scope_required'});
 assert.deepEqual(await resolveLegacyScopeFromRepository({scope:a,jobId:'shared-legacy'},f.repository),{packageId:a.packageId,targetRevisionId:a.targetRevisionId});
 const scope=await resolveLegacyScopeFromRepository({targetId:a.targetId},f.repository);assert.equal(scope.packageId,a.packageId);
 noMaintenance(f.repository);
 const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),db=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'),{readOnly:true}),queries=[];
 try{
  const port=createSqliteLegacyQueries({db,statement(sql){queries.push(sql);return db.prepare(sql);}});
  assert.equal(port.discoverLegacyOwners({kind:'job',id:'shared-legacy'},{excludedOwnerPackageIds:[]}).owners.length,2);
  const sql=queries.at(-1),bindings=['shared-legacy','shared-legacy','[]'];
  const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...bindings),vm=db.prepare('EXPLAIN '+sql).all(...bindings);
  assert.ok(plan.some(row=>/rows_legacy_alias_routing/.test(row.detail)&&/SEARCH/.test(row.detail)));
  assert.ok(vm.some(row=>row.opcode==='SeekGE'));
  await writeTestEvidence('legacy-bridge-bounded','alias-routing-plan.json',JSON.stringify({sql,bindings,plan,vm},null,2));
 }finally{db.close();}
});

test('store persist false projects a full owner index without durable writes or operation leases',async t=>{
 const f=await packageBusinessFixture(t),{a}=await f.twoTargets();await f.ingest(a,[job({id:'first'})]);
 const context={repository:f.repository,jobService:f.jobs,operationGate:f.operationGate};
 const revision=await f.repository.getMeta('revision'),before=await f.repository.queryIds({collection:'runs',ownerPackageId:a.packageId},{scope:a});
 const diff=await upsert([job({id:'second',sourceRecordId:'2',url:'https://jobs.example.com/2',title:'合成另一个岗位'})],{persist:false,context,scope:a});
 assert.equal(diff.stats.persisted,false);assert.equal(diff.stats.total,2);assert.equal(diff.added.length,1);
 assert.equal(await f.repository.getMeta('revision'),revision);assert.deepEqual(await f.repository.queryIds({collection:'runs',ownerPackageId:a.packageId},{scope:a}),before);
 assert.equal((await f.repository.queryRows({collection:'operationLeases',limit:200})).rows.length,0);
 assert.equal(Object.keys((await loadIndex({context,scope:a})).jobs).length,1);
 const persisted=await upsert([job({id:'third',sourceRecordId:'3',url:'https://jobs.example.com/3',title:'合成持久岗位'})],{context,scope:a});
 assert.equal(persisted.stats.total,2);assert.equal(persisted.added.length,1);
 const jobs=[{...job(),id:'first'}];await annotate(jobs,persisted,{context,scope:a});assert.equal(jobs[0].tracking.seenCount,1);
});

test('real v1 HTTP queries edits summary and v2 unresolved export share guarded ports',async t=>{
 const f=await packageBusinessFixture(t),{a}=await f.twoTargets(),[id]=await f.ingest(a,[job()]);
 const api=await apiFixture(t,{dataDir:f.dataDir,legacySchema:false,dependencies:{clock:f.clock}}),ctx=await api.ctx.ready;
 const query='?packageId='+a.packageId+'&targetRevisionId='+encodeURIComponent(a.targetRevisionId);
 ctx.repository.metrics({reset:true});
 const listed=await api.call('/api/tracking/jobs'+query+'&limit=1');assert.equal(listed.response.status,200);assert.equal(listed.data.jobs[0].jobId,id);
 const edit=await api.call('/api/tracking/jobs/'+id,{packageId:a.packageId,targetRevisionId:a.targetRevisionId,status:'applied',note:'HTTP synthetic edit'});
 assert.equal(edit.response.status,200);
 const totals=await api.call('/api/tracking/summary'+query);assert.equal(totals.data.total,1);assert.equal(totals.data.byStatus.applied,1);
 assert.equal((await api.call('/api/tracking/summary')).response.status,409);
 noMaintenance(ctx.repository);
 await f.trash.archive({packageId:a.packageId});
 assert.equal((await api.call('/api/tracking/summary'+query)).response.status,409);
 f.clock.advance(72*3600000);assert.equal((await api.call('/api/tracking/jobs'+query)).response.status,409);
});

test('diagnostics scan one filtered allowlist before its limit and revoke an archived owner',async t=>{
 const f=await packageBusinessFixture(t),{a,b}=await f.twoTargets();await f.ingest(a,[job()]);await f.ingest(b,[job()]);
 const runA=(await f.repository.queryRows({collection:'runs',ownerPackageId:a.packageId,limit:1},{scope:a})).rows[0].id;
 const runB=(await f.repository.queryRows({collection:'runs',ownerPackageId:b.packageId,limit:1},{scope:b})).rows[0].id;
 const logger=createDiagnosticsLog({dataDir:f.dataDir,clock:f.clock});
 await logger.record({operation:'legacy.synthetic',runId:runA,level:'info'});
 f.clock.advance(1000);await logger.record({operation:'legacy.synthetic',runId:runB,level:'info'});
 let calls=0,response;
 const context={repository:f.repository,http:{json(req,res,status,data){response={status,data};}},diagnostics:{captureReadSnapshot:()=>logger.captureReadSnapshot(),async list(options){calls++;return logger.list(options);}}};
 const url='/api/v2/diagnostics/logs?packageId='+a.packageId+'&targetRevisionId='+encodeURIComponent(a.targetRevisionId)+'&limit=1';
 f.repository.metrics({reset:true});await handlePackageBusinessRequest({method:'GET',url},{},context);
 assert.equal(calls,1);assert.equal(response.data.entries.length,1);assert.equal(response.data.entries[0].runId,runA);noMaintenance(f.repository);
 context.diagnostics.list=async options=>{const result=await logger.list(options);await f.trash.archive({packageId:a.packageId});return result;};
 await assert.rejects(()=>handlePackageBusinessRequest({method:'GET',url},{},context),{code:'package_archived'});
});

test('unrelated owner growth does not grow ordinary legacy tracking decode work',async t=>{
 const f=await packageBusinessFixture(t),{a,b}=await f.twoTargets();await f.ingest(a,[job({id:'stable-owner-alias'})]);
 const context={repository:f.repository,jobService:f.jobs};
 async function measure(){f.repository.metrics({reset:true});await summary({context,scope:a});await listJobs({context,scope:a,limit:1});await resolveLegacyScopeFromRepository({jobId:'stable-owner-alias'},f.repository);return f.repository.metrics();}
 const before=await measure();
 await f.repository.mutateWorkspace(w=>{for(let i=0;i<1000;i++){const jobId='unrelated-'+i;w.jobs[jobId]={recordId:randomUUID(),ownerPackageId:b.packageId,jobId,kind:'job',canonical:job({sourceRecordId:'other-'+i,title:'合成其它'+i,company:'公司'+i,url:'https://jobs.example.com/other/'+i}),sourceRefs:[],identityAliases:[],firstSeen:'2026-10-09T00:00:00.000Z',lastSeen:'2026-10-09T00:00:00.000Z',lifecycle:'observed',duplicateGroupIds:[]};}});
 const after=await measure();assert.equal(after.decodedRows,before.decodedRows);assert.equal(after.decodedBytes,before.decodedBytes);noMaintenance(f.repository);
 await writeTestEvidence('legacy-bridge-bounded','unrelated-owner-growth.json',JSON.stringify({unrelatedJobs:1000,before,after},null,2));
});

test('control visibility excludes owners before routing count and limit and maintenance rejects empty allTargets',async t=>{
 const f=await packageBusinessFixture(t),{a,b,sourceProfile}=await f.twoTargets();
 const third=await f.workspaceService.saveTarget({versionName:'third route owner',submissionId:'third-route-owner',profileRevisionId:sourceProfile.revisionId,roles:['合成'],cityMode:'any',cities:[],jobTypes:['campus'],sourceIds:['synthetic'],siteIds:[],budgets:{}}),c={packageId:third.packageId,targetRevisionId:third.revisionId};
 for(const scope of [a,b,c])await f.ingest(scope,[job({id:'three-way-alias'})]);
 const owners=[a,b,c].sort((x,y)=>x.packageId.localeCompare(y.packageId));
 await f.repository.withWriteFence(async fence=>{const control=fence.control;control.deletionLedger[owners[0].packageId]={phase:'purge_pending',recordIds:[]};control.migrationJournal.archives||={};control.migrationJournal.archives[owners[1].packageId]={phase:'prepared'};await fence.commitControl(control);},{operationMaintenance:true});
 f.repository.metrics({reset:true});
 const selected=await resolveLegacyScopeFromRepository({jobId:'three-way-alias'},f.repository);assert.equal(selected.packageId,owners[2].packageId);
 assert.equal((await f.repository.queryJobPage({allTargets:true,page:999})).total,1);
 assert.equal((await f.repository.queryRunHeads({allTargets:true,offset:999})).total,1);
 const head=await f.repository.readJobHead({allTargets:true});assert.equal(typeof head.controlDeletionHead,'string');
 await f.repository.withWriteFence(async fence=>{const control=fence.control;control.migrationJournal.maintenance||={};control.migrationJournal.maintenance.synthetic={phase:'prepared'};await fence.commitControl(control);},{operationMaintenance:true});
 for(const action of [()=>f.repository.queryJobPage({allTargets:true,page:999}),()=>f.repository.queryLegacyApplicationPage({allTargets:true,page:999}),()=>f.repository.queryRunHeads({allTargets:true,offset:999}),()=>f.repository.queryCollectionSnapshot({allTargets:true}),()=>f.repository.discoverLegacyOwners({kind:'default'})])await assert.rejects(action,{code:'workspace_maintenance_pending'});
 assert.equal(await f.repository.getMeta('schemaVersion'),3,'small management metadata remains available');
 noMaintenance(f.repository);
});

test('ambiguous manual history protects a compact group without assigning status and redirects restore single association',async t=>{
 const f=await packageBusinessFixture(t),{a}=await f.twoTargets(),[id]=await f.ingest(a,[job()]),other='same-canonical-synthetic';
 await f.repository.mutateWorkspace(w=>{
  w.jobs[other]={...structuredClone(w.jobs[id]),jobId:other,recordId:randomUUID()};
  w.applications.amb={applicationId:'amb',recordId:randomUUID(),ownerPackageId:a.packageId,jobId:id,legacyJobIds:[id,other],status:'applied',note:'preserve ambiguous',events:[]};
  w.applications.single={applicationId:'single',recordId:randomUUID(),ownerPackageId:a.packageId,jobId:other,status:'interested',note:'second manual history',events:[]};
 });
 const baseline=buildWorkspaceDuplicatePlan(await f.repository.exportPackage(a.packageId));assert.equal(baseline.groups[0].protected,true);assert.equal(baseline.groups[0].manualApplicationCount,2);
 const heads=await f.repository.queryRows({collection:'jobRelations',ownerPackageId:a.packageId,where:{kind:'confirmed_group_head'}},{scope:a});assert.equal(heads.rows[0].value.manualApplicationCount,2);assert.equal(heads.rows[0].value.status,'protected');
 f.repository.metrics({reset:true});
 assert.equal((await f.jobs.getJob(id,a)).application.status,'new');assert.equal((await f.jobs.getJob(other,a)).application.status,'interested');
 await f.jobs.updateApplication('amb',{status:'new',note:''},a);
 assert.equal((await f.jobs.getApplication('amb',a)).application.manualHistory,true);
 assert.equal((await f.jobs.getJob(id,a)).application.status,'new');
 const run=(await f.repository.queryRows({collection:'runs',ownerPackageId:a.packageId,limit:1},{scope:a})).rows[0].id;
 await f.jobs.ingestRecords({runId:run,scope:a,records:[job()]});
 assert.equal((await f.repository.queryRows({collection:'jobRelations',ownerPackageId:a.packageId,where:{kind:'confirmed_group_head'}},{scope:a})).rows[0].value.status,'protected');
 noMaintenance(f.repository);
 await f.repository.mutateWorkspace(w=>{delete w.applications.single;});
 const afterDelete=buildWorkspaceDuplicatePlan(await f.repository.exportPackage(a.packageId));assert.equal(afterDelete.groups[0].manualApplicationCount,1);
 assert.equal((await f.repository.queryRows({collection:'jobRelations',ownerPackageId:a.packageId,where:{kind:'confirmed_group_head'}},{scope:a})).rows[0].value.manualApplicationCount,1);
 await f.repository.mutateWorkspace(w=>{delete w.jobs[other];w.jobRedirects[other]={fromJobId:other,toJobId:id,ownerPackageId:a.packageId,operationId:'synthetic-redirect'};});
 const resolved=await f.jobs.getApplication('amb',a);assert.equal(resolved.association.status,'single');assert.deepEqual(resolved.association.jobIds,[id]);assert.deepEqual(resolved.application.legacyJobIds,[id,other]);
 assert.equal((await f.jobs.listUnresolvedApplications({packageId:a.packageId,targetRevisionId:a.targetRevisionId})).total,0);
});

test('legacy pipeline executes one formal page and replays its owned snapshot with current tracking',async t=>{
 let pages=0;
 const provider=createPagedProvider({id:'synthetic',name:'合成一页',capabilities:{},listPage:async()=>{pages++;return {records:[job()],hasMore:false};}});
 const api=await apiFixture(t,{legacySchema:false,providers:[provider],dependencies:{catalog:[{siteId:'synthetic-1',providerId:'synthetic',category:'job_board',name:'合成一页',origin:'https://jobs.example.com',status:'ready',verifiedAt:new Date().toISOString(),probeEvidence:[{hasRequirements:true}]}]}}),ctx=await api.ctx.ready;
 ctx.repository.metrics({reset:true});
 const result=await runPipeline({resumeText:'合成学生，本科软件工程专业，2027届毕业，拥有Java和SQL项目开发经验，求职北京Java开发岗位。',cfg:api.cfg,context:ctx,options:{sourceIds:['synthetic'],siteIds:['synthetic-1'],cities:['北京'],useLlm:false,maxTitleKeywords:1}});
 assert.equal(pages,1);assert.equal(result.jobs.length,1);assert.match(result.resumeProfile.major,/软件工程/);
 const saved=await saveRun(result,{context:ctx});assert.ok(saved.startsWith(ctx.repository.dataDir));assert.ok((await fs.stat(saved)).isFile());
 const before=await listRuns(100,{context:ctx,scope:result.scope});assert.equal(before.length,1);assert.ok(before[0].targetRoles.length);
 await ctx.jobService.updateJobApplication(result.jobs[0].jobId,{status:'applied',note:'after completed run'},result.scope);
 const replay=await loadRun(result.runId,{context:ctx,scope:result.scope});assert.equal(replay.jobs[0].tracking.status,'applied');assert.equal(replay.jobs[0].tracking.note,'after completed run');
 const query='?packageId='+result.scope.packageId+'&targetRevisionId='+encodeURIComponent(result.scope.targetRevisionId);
 assert.equal((await api.call('/api/runs/'+result.runId+query)).response.status,200);
 const exported=await api.call('/api/runs/'+result.runId+'/export'+query+'&format=json');assert.equal(exported.response.status,200);assert.equal(exported.data.jobs.length,1);
 noMaintenance(ctx.repository);
});

test('legacy full index and bounded tracking preserve all score history seen counts and map-only aliases',async t=>{
 const f=await packageBusinessFixture(t),{a}=await f.twoTargets(),[id]=await f.ingest(a,[job({id:'preserved-legacy-id'})]);
 for(let i=0;i<4;i++)await f.ingest(a,[job({id:'preserved-legacy-id'})]);
 await f.repository.mutateWorkspace(w=>{
  for(let i=0;i<60;i++){const evaluationId='historical-score-'+i;w.evaluations[evaluationId]={evaluationId,recordId:randomUUID(),ownerPackageId:a.packageId,jobId:id,score:i,status:'legacy',targetRevisionId:null,createdAt:new Date(Date.parse('2026-10-09T00:00:00.000Z')+i*1000).toISOString()};}
  w.identityAliases['alias-only-in-map']=[id];
  w.applications['mapped-single']={applicationId:'mapped-single',recordId:randomUUID(),ownerPackageId:a.packageId,jobId:id,legacyJobIds:['alias-only-in-map'],status:'interested',note:'single historical map alias',events:[]};
 });
 const context={repository:f.repository,jobService:f.jobs};f.repository.metrics({reset:true});
 const row=(await listJobs({context,scope:a,limit:1}))[0];assert.equal(row.id,'preserved-legacy-id');assert.equal(row.seenCount,5);assert.equal(row.scoreHistory.length,60);assert.equal(row.scoreHistory[0].score,59);
 assert.equal((await f.jobs.getJob(id,a)).application.status,'interested');assert.equal((await f.jobs.getApplication('mapped-single',a)).association.status,'single');
 noMaintenance(f.repository);
 const index=await loadIndex({context,scope:a});assert.equal(Object.keys(index.jobs).length,1);assert.equal(Object.values(index.jobs)[0].scoreHistory.length,60);assert.equal(Object.values(index.jobs)[0].seenCount,5);
});
