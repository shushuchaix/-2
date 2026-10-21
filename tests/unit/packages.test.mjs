import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createEmptyWorkspace, assertWorkspace} from '../../src/domain/contracts.mjs';

const pid=randomUUID(), bid=randomUUID();
const pkg=(id=pid)=>({packageId:id,kind:'target',versionId:id===pid?'t1@1':'t2@1',versionName:id,enabled:true,state:'active',archiveId:null,archivedAt:null,purgeAt:null});
function workspace(){
  const w=createEmptyWorkspace({schemaVersion:3});
  w.packages={[pid]:pkg(),[bid]:pkg(bid)};
  return w;
}
test('schema3 constructor and ownership validation preserve empty data',()=>{
  const w=workspace();
  assert.equal(w.schemaVersion,3);
  assert.equal(assertWorkspace(w),w);
  assert.throws(()=>assertWorkspace({...w,schemaVersion:4}),/schema/i);
});
test('every private collection rejects a missing or different owner',()=>{
  for(const collection of ['jobs','observations','evaluations','runs','applications','events','files']){
    const w=workspace(), id=randomUUID();
    w[collection]={[id]:{recordId:id,ownerPackageId:'missing',jobId:id,kind:'job',status:'new'}};
    assert.throws(()=>assertWorkspace(w), /owner|package|ownership/i,collection);
  }
});
test('cross-package private references and duplicate stable ids are rejected',()=>{
  const w=workspace(), jobId=randomUUID(), evaluationId=randomUUID();
  w.jobs[jobId]={jobId,kind:'job',recordId:randomUUID(),ownerPackageId:pid};
  w.evaluations[evaluationId]={evaluationId,jobId,recordId:randomUUID(),ownerPackageId:bid};
  assert.throws(()=>assertWorkspace(w),/owner|package|ownership/i);
  w.evaluations[evaluationId].ownerPackageId=pid;
  assert.equal(assertWorkspace(w),w);
  w.evaluations[evaluationId].recordId=w.jobs[jobId].recordId;
  assert.throws(()=>assertWorkspace(w),/record|identity/i);
});
test('72h boundary and management access enforce the expiry instant',async()=>{
  const {archiveDeadline,requirePackage,assertScope}=await import('../../src/domain/packages.mjs');
  const w=workspace(), p=w.packages[pid];
  p.state='trashed';p.archiveId=randomUUID();p.archivedAt='2026-10-09T00:00:00.000Z';p.purgeAt=archiveDeadline(p.archivedAt);
  assert.equal(p.purgeAt,'2026-10-12T00:00:00.000Z');
  assert.equal(requirePackage(w,pid,{access:'trash_read',now:new Date('2026-10-11T23:59:59.999Z')}),p);
  assert.throws(()=>requirePackage(w,pid,{access:'trash_read',now:new Date(p.purgeAt)}),{code:'package_expired'});
  assert.throws(()=>assertScope(w,{packageId:bid,targetRevisionId:'t1@1'},new Date()),{code:'package_scope_mismatch'});
});
test('a targets embedded resume cannot be owned by another package',()=>{
  const w=workspace();
  w.targets.t1=[{targetId:'t1',revisionId:'t1@1',recordId:randomUUID(),ownerPackageId:pid,
    profileSnapshot:{recordId:randomUUID(),ownerPackageId:bid,text:'合成简历'}}];
  assert.throws(()=>assertWorkspace(w),/owner|package|ownership/i);
});
