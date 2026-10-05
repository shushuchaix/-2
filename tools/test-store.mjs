// Regression coverage for the asynchronous v1 facade; synthetic data only.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rjr-store-'));process.env.RJR_DATA_DIR=dir;
try {const store=await import('../src/store.mjs');const job=id=>({id,title:'岗位 '+id,company:'合成公司',city:'成都',source:'test',url:'https://jobs.example.com/'+id,score:80});
assert.equal(Object.keys((await store.loadIndex()).jobs).length,0);
const first=await store.upsert([job('a'),job('b')],{runId:'r1',at:'2026-09-01T10:00:00Z'});assert.equal(first.stats.added,2);assert.equal(first.stats.persisted,true);
await store.setStatus('a','applied','等待回复');const next=await store.upsert([job('a')],{runId:'r2',at:'2026-09-02T10:00:00Z'});assert.equal(next.stats.ongoing,1);assert.equal(next.stats.disappeared,0);assert.equal(Object.keys((await store.loadIndex()).jobs).length,2);
assert.equal((await store.loadIndex()).jobs.a.note,'等待回复');await store.setStatus('a','interviewing');assert.equal((await store.loadIndex()).jobs.a.note,'等待回复');await store.setStatus('a','interviewing','');assert.equal((await store.loadIndex()).jobs.a.note,'');assert.equal((await store.summary()).byStatus.interviewing,1);assert.equal((await store.listJobs({status:'offer'})).length,0);
const preview=await store.upsert([job('c')],{runId:'preview',persist:false});assert.equal(preview.stats.persisted,false);assert.equal((await store.loadIndex()).jobs.c,undefined);
await assert.rejects(store.setStatus('a','invalid'),e=>e.status===400&&!!e.fieldErrors.status);await fs.writeFile(store.INDEX_PATH,'{broken');await assert.rejects(store.loadIndex(),/Corrupt/);console.log('✅ store facade: persisted facts, independent status, explicit empty note, preview, corrupt-file rejection');
} finally {await fs.rm(dir,{recursive:true,force:true});}
