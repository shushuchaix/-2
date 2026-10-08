// Regression coverage for the scoped asynchronous compatibility facade; synthetic data only.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {openWorkspaceRepository} from '../src/infrastructure/storage/repository.mjs';
import {createWorkspaceService} from '../src/application/workspace-service.mjs';import {createJobService} from '../src/application/job-service.mjs';import {createWorkspaceOperationGate} from '../src/application/workspace-operations.mjs';
import {randomUUID} from 'node:crypto';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rjr-store-'));
try {
 const store=await import('../src/store.mjs'),repository=await openWorkspaceRepository({dataDir:dir}),workspace=createWorkspaceService({repository,sourceIds:['test']}),context={repository,jobService:createJobService({repository}),operationGate:createWorkspaceOperationGate({repository})};
 await assert.rejects(()=>store.loadIndex({context}),{code:'version_scope_required'});
 const profile=await workspace.saveProfile({versionName:'合成工具简历',submissionId:'tool-profile',text:'合成本科消防工程求职简历，具有机场消防与安全检查项目经验，用于离线测试。',profile:{education:'本科',major:'消防工程'}});
 const make=async name=>{const target=await workspace.saveTarget({versionName:name,submissionId:'tool-'+randomUUID(),profileRevisionId:profile.revisionId,roles:['消防'],cityMode:'any',cities:[],jobTypes:['campus'],sourceIds:['test']});return {packageId:target.packageId,targetRevisionId:target.revisionId};},scope=await make('合成A'),peer=await make('合成B'),options={context,scope};
 const job=id=>({id,title:'岗位 '+id,company:'合成公司',city:'成都',source:'test',url:'https://jobs.example.com/'+id,score:80});
 assert.equal(Object.keys((await store.loadIndex(options)).jobs).length,0);
 const first=await store.upsert([job('a'),job('b')],{...options,runId:'r1',at:'2026-09-01T10:00:00Z'});assert.equal(first.stats.added,2);assert.equal(first.stats.persisted,true);
 await store.setStatus('a','applied','等待回复',options);const next=await store.upsert([job('a')],{...options,runId:'r2',at:'2026-09-02T10:00:00Z'});assert.equal(next.stats.ongoing,1);assert.equal(next.stats.disappeared,0);assert.equal(Object.keys((await store.loadIndex(options)).jobs).length,2);
 assert.equal((await store.loadIndex(options)).jobs.a.note,'等待回复');await store.setStatus('a','interviewing',undefined,options);assert.equal((await store.loadIndex(options)).jobs.a.note,'等待回复');await store.setStatus('a','interviewing','',options);assert.equal((await store.loadIndex(options)).jobs.a.note,'');assert.equal((await store.summary(options)).byStatus.interviewing,1);assert.equal((await store.listJobs({...options,status:'offer'})).length,0);
 const preview=await store.upsert([job('c')],{...options,runId:'preview',persist:false});assert.equal(preview.stats.persisted,false);assert.equal((await store.loadIndex(options)).jobs.c,undefined);
 await assert.rejects(()=>store.setStatus('a','invalid',undefined,options),e=>e.status===400&&!!e.fieldErrors.status);await assert.rejects(()=>store.loadIndex({context}),{code:'version_scope_required'});await assert.rejects(()=>store.setStatus('a','applied',undefined,{context,scope:peer}));
 await fs.writeFile(path.join(dir,'workspace.v2.json'),'{broken');await assert.rejects(()=>store.loadIndex(options),/Corrupt/);
 console.log('✅ store facade: scoped facts, independent status, explicit empty note, preview, owner guards, corrupt-file rejection');
} finally {await fs.rm(dir,{recursive:true,force:true});}
