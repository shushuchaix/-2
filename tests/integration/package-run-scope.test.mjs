import test from 'node:test';
import assert from 'node:assert/strict';
import {packageBusinessFixture} from '../helpers/package-business-fixture.mjs';
import {fakeProvider} from '../helpers/fake-sources.mjs';
import {createSourceRegistry} from '../../src/sources/registry.mjs';
import {createEvaluationService} from '../../src/application/evaluation-service.mjs';
import {createRunService} from '../../src/application/run-service.mjs';
import {createRunEventHub} from '../../src/application/run-events.mjs';
import {job} from '../helpers/fixtures.mjs';
import {runtimeRepository} from '../../src/application/package-runtime-service.mjs';
import {contentHash} from '../../src/infrastructure/storage/repository.mjs';
import {createPurgeService} from '../../src/application/purge-service.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
async function fixture(t,provider=fakeProvider()){
 const f=await packageBusinessFixture(t);Object.assign(f,await f.twoTargets());
 f.eventHub=createRunEventHub({repository:f.repository});
 f.evaluator=createEvaluationService({repository:f.repository,operationGate:f.operationGate});
 f.runs=createRunService({repository:f.repository,workspaceService:f.workspaceService,jobService:f.jobs,evaluationService:f.evaluator,eventHub:f.eventHub,operationGate:f.operationGate,registry:createSourceRegistry([provider]),requestFactory:()=>async()=>{throw Error('No network');},catalog:[{siteId:'synthetic-1',providerId:'synthetic',category:'job_board',name:'synthetic',origin:'https://example.com',status:'ready'}]});
 return f;
}
test('target run uses owned resume after source library deletion and retains owned snapshots/events',async t=>{
 const f=await fixture(t);await f.repository.mutateWorkspace(w=>{delete w.profiles[f.sourceProfile.profileId];delete w.packages[f.sourceProfile.packageId];delete w.versionMetadata[f.sourceProfile.revisionId];});
 const run=await f.runs.startRun({scope:f.a});
 await assert.rejects(()=>f.runs.getRun(run.runId,f.b),{code:'package_scope_mismatch'});
 await assert.rejects(()=>f.eventHub.subscribe(run.runId,{scope:f.b,onEvent(){}}),{code:'package_scope_mismatch'});
 await assert.rejects(()=>f.runs.cancelRun(run.runId,f.b),{code:'package_scope_mismatch'});
 const result=await f.runs.waitForRun(run.runId,f.a);
 assert.equal(result.run.status,'completed');assert.equal(result.profileRevision.ownerPackageId,f.a.packageId);
 assert.equal(result.ownerPackageId,f.a.packageId);assert.ok(result.recordId);
 assert.ok(result.events.length);assert.ok(result.events.every(e=>e.ownerPackageId===f.a.packageId&&e.recordId));
 assert.equal(result.evaluations[0].ownerPackageId,f.a.packageId);
 assert.equal((await f.runs.listRuns({...f.b})).length,0);
 await assert.rejects(()=>f.runs.waitForRun(run.runId),{code:'version_scope_required'});
});
test('evaluation cache and job selection are bound to package and owned profile',async t=>{
 const f=await fixture(t);const [ja]=await f.ingest(f.a,[job()]),[jb]=await f.ingest(f.b,[job()]);
 const a=await f.evaluator.evaluate({scope:f.a,jobIds:[ja]}),b=await f.evaluator.evaluate({scope:f.b,jobIds:[jb]});
 assert.notEqual(a.evaluations[0].cacheKey,b.evaluations[0].cacheKey);assert.equal(a.evaluations[0].profileRevisionId,f.a.profileSnapshot.revisionId);
 await assert.rejects(()=>f.evaluator.evaluate({scope:f.a,jobIds:[jb]}),{code:'package_scope_mismatch'});
 const cached=await f.evaluator.evaluate({scope:f.a,jobIds:[ja]});assert.equal(cached.evaluations[0].evaluationId,a.evaluations[0].evaluationId);
});
test('operation lease records exact package and cancel waits for final write and release',async t=>{
 const f=await fixture(t,fakeProvider({hold:async ctx=>{ctx.signal.throwIfAborted();await new Promise(resolve=>ctx.signal.addEventListener('abort',resolve,{once:true}));ctx.signal.throwIfAborted();}}));
 const run=await f.runs.startRun({scope:f.a});
 const w=await f.repository.read();const leases=Object.values(w.operationLeases);assert.equal(leases.length,1);assert.deepEqual(leases[0].scope,{packageId:f.a.packageId,targetRevisionId:f.a.targetRevisionId});assert.deepEqual(leases[0].packageIds,[f.a.packageId]);
 await f.runs.cancelPackageAndWait(f.a.packageId);
 assert.equal((await f.repository.read()).runs[run.runId].status,'cancelled');assert.equal(Object.keys((await f.repository.read()).operationLeases).length,0);
});
test('failed snapshot registration reserves durable root and file identities before writing and retry reuses both',async t=>{
 const f=await fixture(t);await f.ingest(f.a,[job()]);const w=await f.repository.read(),run=Object.values(w.runs)[0],snapshot={run:structuredClone(run),jobs:[],events:[]};
 f.armFailure('workspace_commit');await assert.rejects(()=>runtimeRepository(f.repository,f.a).writeRunSnapshot(run.runId,snapshot),/synthetic storage failure/);
 const c=await f.control.read(),rootId=c.identityIndex.record['snapshot:'+contentHash(run.runId)],fileId=c.identityIndex.record['snapshot-file:'+contentHash(run.runId)];assert.ok(rootId);assert.ok(fileId);assert.notEqual(rootId,fileId);
 const physical=JSON.parse(await fs.readFile(path.join(f.dataDir,'runs-v2',run.runId+'.json'),'utf8'));assert.equal(physical.recordId,rootId);assert.equal(physical.ownerPackageId,f.a.packageId);assert.equal(Object.keys((await f.repository.read()).files).length,0);
 await f.reopen();await runtimeRepository(f.repository,f.a).writeRunSnapshot(run.runId,snapshot);await runtimeRepository(f.repository,f.a).writeRunSnapshot(run.runId,snapshot);
 const files=Object.values((await f.repository.read()).files);assert.equal(files.length,1);assert.equal(files[0].recordId,fileId);assert.equal(files[0].snapshotRecordId,rootId);
});
test('orphan snapshot after failed registration remains verifiable and is permanently cleaned after restart',async t=>{
 const f=await fixture(t);await f.ingest(f.a,[job()]);const run=Object.values((await f.repository.read()).runs)[0];
 f.armFailure('workspace_commit');await assert.rejects(()=>runtimeRepository(f.repository,f.a).writeRunSnapshot(run.runId,{run:structuredClone(run)}));
 const c=await f.control.read(),rootId=c.identityIndex.record['snapshot:'+contentHash(run.runId)];assert.ok(rootId);await f.reopen();await f.trash.archive({packageId:f.a.packageId});const purge=createPurgeService({repository:f.repository,trash:f.trash,fsAdapter:f.fsAdapter}),preview=await f.trash.preview({packageIds:[f.a.packageId]});const result=await purge.execute(preview);
 assert.deepEqual(result.completed,[f.a.packageId]);await assert.rejects(()=>fs.access(path.join(f.dataDir,'runs-v2',run.runId+'.json')),{code:'ENOENT'});assert.ok((await f.control.read()).deletionLedger[f.a.packageId].recordIds.includes(rootId));
});
test('an existing event subscription closes when its package is archived',async t=>{
 const f=await fixture(t);await f.ingest(f.a,[job()]);const run=Object.values((await f.repository.read()).runs)[0],events=[];let closed=0,resolveClosed;const ended=new Promise(resolve=>{resolveClosed=resolve;});const unsubscribe=await f.eventHub.subscribe(run.runId,{scope:f.a,onEvent:event=>events.push(event),onClose:error=>{closed++;resolveClosed(error);}});t.after(unsubscribe);
 await f.trash.archive({packageId:f.a.packageId});let timeout;try{const error=await Promise.race([ended,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Archived subscription remained open')),2500);})]);assert.equal(error.code,'package_archived');assert.equal(closed,1);}finally{clearTimeout(timeout);}
 assert.ok(events.length<=1);
});
