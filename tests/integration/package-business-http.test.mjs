import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {packageBusinessFixture} from '../helpers/package-business-fixture.mjs';import {job} from '../helpers/fixtures.mjs';
import {handlePackageBusinessRequest} from '../../src/server/package-business-routes.mjs';import {readJsonBody} from '../../src/server/validation.mjs';
import {allowLocalOrigin} from '../helpers/network-guard.mjs';
test('HTTP scope is mandatory and applications use stable application identifiers',async t=>{
 const f=await packageBusinessFixture(t);const {a,b}=await f.twoTargets(),[id]=await f.ingest(a,[job()]);const context={repository:f.repository,jobService:f.jobs,exportService:f.exportService,http:{readJson:readJsonBody,json(req,res,status,data){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}}};
 const server=http.createServer((req,res)=>handlePackageBusinessRequest(req,res,context).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(e=>context.http.json(req,res,e.status||500,{code:e.code})));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port+'/api/v2';
 allowLocalOrigin(base);const missing=await fetch(base+'/jobs');assert.equal(missing.status,409);assert.equal((await missing.json()).code,'version_scope_required');
 const updated=await fetch(base+'/jobs/'+id+'/application',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'applied',packageId:a.packageId,targetRevisionId:a.targetRevisionId})});assert.equal(updated.status,200);const app=await updated.json();assert.notEqual(app.applicationId,id);
 const query='?packageId='+a.packageId+'&targetRevisionId='+encodeURIComponent(a.targetRevisionId);const list=await (await fetch(base+'/applications'+query)).json();assert.equal(list.items[0].applicationId,app.applicationId);
 const wrong=await fetch(base+'/applications/'+app.applicationId+'?packageId='+b.packageId+'&targetRevisionId='+encodeURIComponent(b.targetRevisionId));assert.equal(wrong.status,409);assert.equal((await wrong.json()).code,'package_scope_mismatch');
 const exportResponse=await fetch(base+'/exports'+query);assert.equal(exportResponse.status,200);assert.equal((await exportResponse.json())[0].ownerPackageId,a.packageId);
});
