import test from 'node:test';import assert from 'node:assert/strict';
import {packageBusinessFixture} from '../helpers/package-business-fixture.mjs';import {job} from '../helpers/fixtures.mjs';
import {handlePackageBusinessRequest} from '../../src/server/package-business-routes.mjs';
test('diagnostic requests filter exact owned runs and reject peer run ids',async t=>{
 const f=await packageBusinessFixture(t),{a,b}=await f.twoTargets();await f.ingest(a,[job()]);await f.ingest(b,[job()]);const w=await f.repository.read(),runA=Object.values(w.runs).find(r=>r.ownerPackageId===a.packageId),runB=Object.values(w.runs).find(r=>r.ownerPackageId===b.packageId),calls=[];let response;
 const context={repository:f.repository,http:{json(req,res,status,data){response={status,data};}},diagnostics:{async list(opts){calls.push(opts);return {entries:[{diagnosticId:'safe-'+opts.runId,runId:opts.runId,at:'2026-10-09T00:00:00Z',level:'info'}],summary:{total:1},runtime:{},retention:{}};}}};
 const query='?packageId='+a.packageId+'&targetRevisionId='+encodeURIComponent(a.targetRevisionId);assert.equal(await handlePackageBusinessRequest({method:'GET',url:'/api/v2/diagnostics/logs'+query},{},context),true);assert.deepEqual(response.data.entries.map(e=>e.runId),[runA.runId]);assert.ok(calls.every(c=>c.runId===runA.runId));
 await assert.rejects(()=>handlePackageBusinessRequest({method:'GET',url:'/api/v2/diagnostics/logs'+query+'&runId='+runB.runId},{},context),{code:'package_scope_mismatch'});
 await assert.rejects(()=>handlePackageBusinessRequest({method:'GET',url:'/api/v2/diagnostics/logs'},{},context),{code:'version_scope_required'});
});
test('scoped diagnostic requests preserve validated filter feedback and complete-export defaults',async t=>{
 const f=await packageBusinessFixture(t),{a}=await f.twoTargets();await f.ingest(a,[job()]);const calls=[],context={repository:f.repository,http:{json(){}},diagnostics:{async list(options){calls.push(options);return {entries:[],summary:{total:0}};},async exportText(options){calls.push(options);return 'safe synthetic log';}}},query='?packageId='+a.packageId+'&targetRevisionId='+encodeURIComponent(a.targetRevisionId);
 for(const [input,field]of [['diagnosticId=bad','diagnosticId'],['requestId=bad','requestId'],['unexpected=bad','filters']])await assert.rejects(()=>handlePackageBusinessRequest({method:'GET',url:'/api/v2/diagnostics/logs'+query+'&'+input},{},context),error=>error.code==='invalid_input'&&Boolean(error.fieldErrors?.[field]));
 let output;await handlePackageBusinessRequest({method:'GET',url:'/api/v2/diagnostics/logs/export'+query},{writeHead(){},end(text){output=text;}},context);assert.equal(output,'safe synthetic log');assert.equal(calls.at(-1).limit,undefined);
});
