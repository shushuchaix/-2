import test from 'node:test';import assert from 'node:assert/strict';
import {packageBusinessFixture} from '../helpers/package-business-fixture.mjs';import {job} from '../helpers/fixtures.mjs';
import {listRuns,loadRun} from '../../src/pipeline.mjs';import {handleV1Request} from '../../src/server/routes-v1.mjs';
import {loadIndex,saveIndex,setStatus} from '../../src/store.mjs';
test('legacy pipeline reads require unique scope and reject archived package bodies',async t=>{
 const f=await packageBusinessFixture(t),{a,b}=await f.twoTargets();await f.ingest(a,[job()]);await f.ingest(b,[job()]);const context={repository:f.repository,runService:{listRuns:async filters=>Object.values((await f.repository.read()).runs),waitForRun:async()=>{throw Error('Modern scope check missing');}},cfg:{},registry:{get(){return null;}}};
 await assert.rejects(()=>listRuns(100,{context}),{code:'version_scope_required'});
 const run=Object.values((await f.repository.read()).runs).find(r=>r.ownerPackageId===a.packageId);await f.trash.archive({packageId:a.packageId});await assert.rejects(()=>loadRun(run.runId,{context,scope:a}),{code:'package_archived'});
});
test('legacy store projections and patches are scoped and reject archived cached rows',async t=>{
 const f=await packageBusinessFixture(t),{a,b}=await f.twoTargets(),[ja]=await f.ingest(a,[job({title:'合成A'})]),[jb]=await f.ingest(b,[job({title:'合成B'})]),context={repository:f.repository,jobService:f.jobs};
 const own=await loadIndex({context,scope:a});assert.equal(Object.keys(own.jobs).length,1);assert.equal(Object.values(own.jobs)[0].title,'合成A');await assert.rejects(()=>loadIndex({context}),{code:'version_scope_required'});
 await assert.rejects(()=>setStatus(ja,'applied','invalid',{context,scope:b}),{code:'package_scope_mismatch'});await f.trash.archive({packageId:a.packageId});await assert.rejects(()=>saveIndex(own,{context,scope:a}),{code:'package_archived'});assert.equal((await f.jobs.getJob(jb,b)).application.status,'new');
});
test('V1 tracking cannot read archived owner or write peer state through a legacy endpoint',async t=>{
 const f=await packageBusinessFixture(t),{a,b}=await f.twoTargets();const [id]=await f.ingest(a,[job()]);await f.ingest(b,[job()]);let response;const context={repository:f.repository,jobService:f.jobs,http:{json(req,res,status,data){response={status,data};},async readJson(){return {packageId:b.packageId,targetRevisionId:b.targetRevisionId,status:'applied'};}}};
 await assert.rejects(()=>handleV1Request({method:'GET',url:'/api/tracking/summary'},{},context),{code:'version_scope_required'});
 await assert.rejects(()=>handleV1Request({method:'POST',url:'/api/tracking/jobs/'+id},{},context),{code:'package_scope_mismatch'});
 await f.trash.archive({packageId:a.packageId});await assert.rejects(()=>handleV1Request({method:'GET',url:'/api/tracking/jobs?packageId='+a.packageId+'&targetRevisionId='+encodeURIComponent(a.targetRevisionId)},{},context),{code:'package_archived'});
});
