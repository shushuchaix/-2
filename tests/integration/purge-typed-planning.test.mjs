import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { packageBusinessFixture } from '../helpers/package-business-fixture.mjs';
import { seedUnassignedClosure } from '../helpers/legacy-business-fixture.mjs';
import { registerTestResource, job } from '../helpers/fixtures.mjs';
import { createPurgeService } from '../../src/application/purge-service.mjs';
import { createCollectionRoot } from '../../src/domain/collection.mjs';
import { packageRecords, countPackageRecords } from '../../src/domain/package-ownership.mjs';
import { planPackageFiles } from '../../src/infrastructure/storage/purge-files.mjs';
import { resolveDataLayout } from '../../src/infrastructure/storage/layout.mjs';
import { openWorkspaceRepository } from '../../src/infrastructure/storage/repository.mjs';

const boundaryCode='synthetic_after_prepare';
async function fixture(t) {
  const f=await packageBusinessFixture(t);Object.assign(f,await f.twoTargets());
  f.purge=createPurgeService({repository:f.repository,trash:f.trash,fsAdapter:f.fsAdapter});
  return f;
}
async function snapshotPeers(f) {
  const a=await seedUnassignedClosure(f,{managedSnapshot:true});
  // The shared legacy helper uses one default display name. Give the first
  // synthetic package a distinct legal name before creating another owner;
  // never weaken the real package-name unique constraint for a path fixture.
  await f.repository.transaction({select:[{collection:'packages',ids:[a.packageId]}]},tx=>{
    const p=tx.getRow({collection:'packages',id:a.packageId});
    tx.putRow({collection:'packages',id:a.packageId,value:{...p,versionName:'合成冲突所有者A'}});
  });
  const b=await seedUnassignedClosure(f,{managedSnapshot:true});
  return {a,b};
}
// This is the existing public boundary, after the persisted prepare and before
// runTasks' full assertion/export. No production-only test branch is introduced.
async function stopAfterPrepare(f,preview,options={}) {
  const original=f.repository.exportWorkspace;
  f.repository.exportWorkspace=async()=>{throw Object.assign(Error('Synthetic prepare boundary'),{code:boundaryCode});};
  try { await assert.rejects(f.purge.execute(preview,options),{code:boundaryCode}); }
  finally {f.repository.exportWorkspace=original;}
}
const structure = m => {
  for(const key of ['maintenanceExports','maintenanceImports','maintenanceReads','maintenanceMutations'])assert.equal(m[key],0,key);
  assert.equal(m.decodedPrivateRows,0,'no private business value decode');
  assert.ok(m.decodedRows<100,'only bounded package/lease coordination rows may decode');
  assert.ok(m.decodedBytes<100000,'coordination bytes stay bounded');
};
const cost = (t,fixtureRows,phase,started,m) => t.diagnostic(JSON.stringify({fixtureRows,phase,
  prepareMs:performance.now()-started,guardMs:m.purgeIdentityGuardMs??null,
  guardStatements:m.purgeIdentityGuardStatements??0,maintenanceExports:m.maintenanceExports,
  decodedRows:m.decodedRows,decodedBytes:m.decodedBytes,rowsRead:m.rowsRead}));
async function addUnrelatedRows(f,n) {
  await f.repository.mutateWorkspace(w=>{
    const runId='peer-fill',target=Object.values(w.targets).flat().find(v=>v.revisionId===f.b.revisionId);
    const root=createCollectionRoot({runId,scope:f.b,targetSnapshot:target,now:f.clock.now()});
    root.collectionProgress.manualPaused=true;root.collectionProgress.refreshReady=false;
    for(let i=0;i<n;i++){
      const jobId='fill-'+i,observationId='observation-'+i;
      const fields=job({sourceRecordId:String(i),title:'合成岗位'+i,company:'合成单位'+i,url:'https://example.invalid/fill/'+i});
      w.jobs[jobId]={jobId,kind:'job',canonical:fields,recordId:randomUUID(),ownerPackageId:f.b.packageId};
      w.observations[observationId]={observationId,jobId,fields,recordId:randomUUID(),ownerPackageId:f.b.packageId};
      const id='reservation-'+i;root.collectionProgress.ledger.reservations[id]={reservationId:id,status:'settled',kind:'synthetic'};
    }
    w.runs[runId]=root;
    // Genuine ownerless diagnostics may contain a descriptive recordId while
    // their physical record_id remains NULL; the global entity guard allows it.
    w.recoveryRecords.push({code:'synthetic_ownerless',ownerPackageId:null,recordId:'diagnostic-not-an-entity-uuid'});
  });
}

// Baseline-compatible structure entry: the original tree reaches a real export
// and fails maintenanceExports, not a missing new internal method. For baseline
// verification copy this file and select --test-name-pattern='structural gate
// one due'. It imports only pre-existing production/public fixture modules.
test('structural gate one due and pending do not scale with unrelated 1k to 10k rows',async t=>{
  const measured=[];
  for(const n of [1000,10000]){
    const f=await fixture(t);await addUnrelatedRows(f,n);await f.trash.archive({packageId:f.a.packageId});
    f.clock.advance(72*3600*1000);
    const preview=await f.trash.preview({expiredOnly:true});assert.equal(preview.packageCount,1);
    f.repository.metrics({reset:true});let started=performance.now();await stopAfterPrepare(f,preview,{reason:'expired'});
    const first=f.repository.metrics();cost(t,n,'one_due',started,first);
    const c=await f.repository.readControl(),ledger=c.deletionLedger[f.a.packageId],task=c.purgeTasks[ledger.operationId];
    assert.equal(task.phase,'prepared');assert.equal(ledger.phase,'purge_pending');
    assert.ok(ledger.recordIds.includes(f.a.profileSnapshot.recordId));
    const prior=structuredClone(ledger),pending=await f.trash.preview({packageIds:[f.a.packageId]});
    f.repository.metrics({reset:true});started=performance.now();await stopAfterPrepare(f,pending);
    const retry=f.repository.metrics();cost(t,n,'pending',started,retry);
    assert.deepEqual((await f.repository.readControl()).deletionLedger[f.a.packageId],prior);
    const zero=await f.trash.preview({packageIds:[]}),revision=await f.repository.getMeta('revision');
    f.repository.metrics({reset:true});started=performance.now();assert.deepEqual(await f.purge.execute(zero),{completed:[],pending:[],failed:[]});
    const empty=f.repository.metrics();cost(t,n,'zero_due',started,empty);
    assert.equal(await f.repository.getMeta('revision'),revision);
    assert.equal((await f.repository.aggregateRows({collection:'jobs',ownerPackageId:f.b.packageId,operation:'count'})).groups[0].value,n);
    measured.push({first,retry,empty});
  }
  // Defer structural gates until both sizes emitted actual cost diagnostics, so
  // the independent baseline run also reports real JS-export1k/10k measurements.
  for(const {first,retry,empty}of measured){
    structure(first);structure(retry);structure(empty);
    assert.equal(first.purgeIdentityGuardStatements,1);assert.equal(retry.purgeIdentityGuardStatements,1);
    assert.equal(empty.purgeIdentityGuardStatements,0);
    assert.ok(Number.isFinite(first.purgeIdentityGuardMs)&&first.purgeIdentityGuardMs>=0);
    assert.ok(Number.isFinite(retry.purgeIdentityGuardMs)&&retry.purgeIdentityGuardMs>=0);
  }
  assert.equal(measured[0].first.rowsRead,measured[1].first.rowsRead,'logical returned rows independent of peer filler');
  assert.equal(measured[0].retry.rowsRead,measured[1].retry.rowsRead);
  assert.equal(measured[0].empty.rowsRead,measured[1].empty.rowsRead);
  assert.equal(measured[0].first.decodedRows,measured[1].first.decodedRows);
  assert.equal(measured[0].retry.decodedRows,measured[1].retry.decodedRows);
});

test('typed empty preview validates scope/hash/revision without lease or maintenance export',async t=>{
  const f=await fixture(t),preview=await f.trash.preview({expiredOnly:true}),revision=await f.repository.getMeta('revision');
  f.repository.metrics({reset:true});assert.deepEqual(await f.purge.execute(preview,{reason:'expired'}),{completed:[],pending:[],failed:[]});
  structure(f.repository.metrics());assert.equal(await f.repository.getMeta('revision'),revision);
  assert.equal((await f.repository.queryRows({collection:'operationLeases'})).rows.length,0);
  await assert.rejects(f.purge.execute({...preview,totals:{...preview.totals,jobs:7}}),{code:'trash_preview_stale'});
  await f.repository.transaction({select:[],metaKeys:['syntheticChange']},tx=>tx.setMeta('syntheticChange',true));
  assert.equal(await f.repository.getMeta('revision'),revision+1);
  await assert.rejects(f.purge.execute(preview),{code:'trash_preview_stale'});
});

test('typed preview preserves legacy plan hashes, false/missing fields and exact 72h boundary',async t=>{
  const f=await fixture(t);await f.trash.archive({packageId:f.a.packageId});
  for(const delta of [72*3600*1000-1,1]){
    f.clock.advance(delta);
    for(const scope of [{emptyAll:true},{packageIds:[f.a.packageId]},{expiredOnly:true}]){
      const preview=await f.trash.preview(scope);
      await f.repository.withMaintenanceTransaction(tx=>assert.equal(f.trash.validatePreview(tx,preview).length,preview.packageCount),{operationMaintenance:true});
      if(preview.packageCount){
        const lease=await f.operationGate.acquire('permanent-delete',{packageIds:[f.a.packageId],expectedWorkspaceRevision:preview.workspaceRevision});
        try {await f.repository.withWriteFence(fence=>{
          const result=f.trash.validatePreviewRows(fence,preview);assert.equal(result[0].packageId,f.a.packageId);
        },{operationLease:lease});}finally{await lease.release();}
      }
    }
  }
  await f.repository.mutateWorkspace(w=>{w.packages[f.a.packageId].enabled=false;delete w.packages[f.a.packageId].nameKey;});
  const preview=await f.trash.preview({emptyAll:true}),lease=await f.operationGate.acquire('permanent-delete',{packageIds:[f.a.packageId]});
  try{await f.repository.withWriteFence(fence=>{
    const p=f.trash.validatePreviewRows(fence,preview)[0];assert.equal(p.enabled,false);assert.equal(Object.hasOwn(p,'nameKey'),false);
  },{operationLease:lease});}finally{await lease.release();}
});

test('lease token/kind/scope/revocation and forged acquire revision do not grant metadata access',async t=>{
  const f=await fixture(t);await f.trash.archive({packageId:f.a.packageId});
  const preview=await f.trash.preview({emptyAll:true}),lease=await f.operationGate.acquire('permanent-delete',{packageIds:[f.a.packageId]});
  const query={section:'recordHeads',packageId:f.a.packageId};
  await assert.rejects(f.repository.withWriteFence(fence=>fence.queryPurgePlanningPage(query),{operationMaintenance:true}),{code:'invalid_operation_lease'});
  await assert.rejects(f.repository.withWriteFence(fence=>fence.queryPurgePlanningPage(query),{operationMaintenance:true,operationLease:{...lease,token:randomUUID()}}),{code:'invalid_operation_lease'});
  await assert.rejects(f.repository.withWriteFence(fence=>fence.queryPurgePlanningPage({...query,packageId:f.b.packageId}),{operationLease:lease}),{code:'package_scope_mismatch'});
  await f.repository.transaction({select:[],metaKeys:['bumped']},tx=>tx.setMeta('bumped',1),{operationLease:lease});
  assert.equal(await f.repository.getMeta('revision'),preview.workspaceRevision+2);
  await assert.rejects(f.repository.withWriteFence(fence=>f.trash.validatePreviewRows(fence,preview),{operationLease:{...lease,acquiredRevision:await f.repository.getMeta('revision')}}),{code:'trash_preview_stale'});
  let escaped;
  await f.repository.withWriteFence(fence=>{escaped=()=>fence.queryPurgePlanningPage({section:'packages'});},{operationLease:lease});
  assert.throws(escaped,{code:'workspace_fence_closed'});
  const db=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'));registerTestResource(t,()=>db.close());
  const original=db.prepare("SELECT value FROM rows WHERE collection='operationLeases' AND id=?").get(lease.operationId).value;
  try{
    for(const malformed of [{packageIds:'prefix-'+f.a.packageId+'-suffix'},{packageIds:null},{packageIds:true},
      {packageIds:[null]},{packageIds:[f.a.packageId,f.a.packageId]},{scope:'wrong-shape'},
      {scope:[]},{scope:{packageId:false}},{scope:{packageId:f.b.packageId}},{packageId:7}]){
      db.prepare("UPDATE rows SET value=? WHERE collection='operationLeases' AND id=?").run(JSON.stringify({...JSON.parse(original),...malformed}),lease.operationId);
      await assert.rejects(f.repository.withWriteFence(fence=>fence.queryPurgePlanningPage(query),{operationMaintenance:true,operationLease:lease}),{code:'invalid_operation_lease'});
    }
  }finally{db.prepare("UPDATE rows SET value=? WHERE collection='operationLeases' AND id=?").run(original,lease.operationId);}
  await lease.release();
  await assert.rejects(f.repository.withWriteFence(fence=>fence.queryPurgePlanningPage(query),{operationMaintenance:true,operationLease:lease}),{code:'invalid_operation_lease'});
  const other=await f.operationGate.acquire('backup',{});
  try{await assert.rejects(f.repository.withWriteFence(fence=>fence.queryPurgePlanningPage(query),{operationLease:{...other,kind:'permanent-delete'}}),{code:'invalid_operation_lease'});}finally{await other.release();}
});

test('fixed heads cover embedded identities, composite cursor collisions, references and ledger semantics',async t=>{
  const f=await fixture(t);
  await f.repository.mutateWorkspace(w=>{
    const owner=f.a.packageId,runId='shared-id';
    w.runs[runId]={runId,recordId:randomUUID(),ownerPackageId:owner,status:'completed',events:[{recordId:randomUUID(),ownerPackageId:owner,type:'done',runId}],lastSeq:1};
    w.jobs[runId]={jobId:runId,kind:'job',canonical:job(),recordId:randomUUID(),ownerPackageId:owner};
    w.observations[runId]={observationId:runId,jobId:runId,fields:job(),runId,recordId:randomUUID(),ownerPackageId:owner};
    w.applications[runId]={applicationId:runId,jobId:runId,status:'new',recordId:randomUUID(),ownerPackageId:owner,
      events:[{recordId:randomUUID(),ownerPackageId:owner,type:'note'}]};
    w.recoveryRecords.push({recordId:randomUUID(),ownerPackageId:owner,runId,code:'synthetic'});
    w.recoveryRecords.push({code:'synthetic_ownerless'});
  });
  await f.trash.archive({packageId:f.a.packageId});
  const before=await f.repository.exportWorkspace(),expected=packageRecords(before).filter(n=>n.record.ownerPackageId===f.a.packageId).map(n=>n.record.recordId).sort(),
    lease=await f.operationGate.acquire('permanent-delete',{packageIds:[f.a.packageId]});
  try{await f.repository.withWriteFence(fence=>{
    const heads=[];let after;do{const page=fence.queryPurgePlanningPage({section:'recordHeads',packageId:f.a.packageId,limit:1,...(after?{after}:{})});heads.push(...page.rows);after=page.nextCursor;}while(after);
    assert.deepEqual(heads.map(h=>h.recordId).sort(),expected);assert.equal(new Set(heads.map(h=>h.collection)).has('profileCopies'),true);
    assert.deepEqual(fence.getPurgePlanningCounts(f.a.packageId),countPackageRecords(before,f.a.packageId));
    for(const input of [{section:'other'},{section:'recordHeads',packageId:f.a.packageId,value:true},
      {section:'recordHeads',packageId:f.a.packageId,after:{collection:'jobs',id:''}},
      {section:'packages',limit:201}])assert.throws(()=>fence.queryPurgePlanningPage(input));
  },{operationLease:lease});}finally{await lease.release();}
  // A different owner's ledger can exclude an individual record of this owner.
  // Raw public preview and filtered validation must retain their stale boundary.
  const deletedJob=before.jobs['shared-id'];
  await f.repository.withWriteFence(async fence=>{const c=fence.control;c.deletionLedger[f.b.packageId]={phase:'purge_pending',recordIds:[deletedJob.recordId],archiveId:randomUUID(),archivedAt:new Date(f.clock.now()).toISOString(),purgeAt:new Date(f.clock.now().getTime()+72*3600*1000).toISOString()};await fence.commitControl(c);},{operationMaintenance:true});
  const preview=await f.trash.preview({packageIds:[f.a.packageId]}),next=await f.operationGate.acquire('permanent-delete',{packageIds:[f.a.packageId]});
  try{await assert.rejects(f.repository.withWriteFence(fence=>f.trash.validatePreviewRows(fence,preview),{operationLease:next}),{code:'trash_preview_stale'});}finally{await next.release();}
});

test('metadata contradictions and row_refs tampering fail before control intent publication',async t=>{
  for(const kind of ['record','owner','ref']){
    const f=await fixture(t);await f.ingest(f.a,[{title:'合成岗位',company:'合成单位',url:'https://example.invalid/a',sourceId:'synthetic',description:'合成正文'}]);
    await f.trash.archive({packageId:f.a.packageId});
    const db=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'));registerTestResource(t,()=>db.close());
    if(kind==='record')db.prepare("UPDATE rows SET value=json_set(value,'$.recordId',?) WHERE collection='jobs' AND owner_id=?").run(randomUUID(),f.a.packageId);
    if(kind==='owner')db.prepare("UPDATE rows SET value=json_set(value,'$.ownerPackageId',?) WHERE collection='jobs' AND owner_id=?").run(f.b.packageId,f.a.packageId);
    if(kind==='ref')db.prepare("DELETE FROM row_refs WHERE collection='observations' AND owner_id=?").run(f.a.packageId);
    const before=await f.repository.readControl(),preview=await f.trash.preview({emptyAll:true});
    await assert.rejects(f.purge.execute(preview),{code:'sqlite_purge_metadata_invalid'});
    assert.deepEqual((await f.repository.readControl()).deletionLedger,before.deletionLedger);
  }
});

test('reverse physical owner routing is rejected before intent and leaves peer/row bytes unchanged',async t=>{
  const f=await fixture(t),packageId=randomUUID(),jobId='independent-reverse-owner';
  await f.repository.mutateWorkspace(w=>{
    // This legacy package has no projected target or externally referencing
    // observation/application/row_refs, so the raw physical-owner mutation is a
    // real independent routing contradiction rather than an FK failure fixture.
    w.packages[packageId]={packageId,kind:'legacy_unassigned',versionId:'independent@1',versionName:'合成独立包',enabled:true,state:'active',archiveId:null,archivedAt:null,purgeAt:null};
    w.jobs[jobId]={jobId,kind:'job',canonical:job(),recordId:randomUUID(),ownerPackageId:packageId};
  });
  await f.trash.archive({packageId});
  const db=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'));registerTestResource(t,()=>db.close());
  assert.equal(db.prepare("SELECT count(*) AS n FROM row_refs WHERE target_collection='jobs' AND target_id=?").get(jobId).n,0);
  db.prepare("UPDATE rows SET owner_id=? WHERE collection='jobs' AND id=?").run(f.b.packageId,jobId);
  const row=db.prepare("SELECT owner_id,record_id,value FROM rows WHERE collection='jobs' AND id=?").get(jobId),
    peer=db.prepare("SELECT value FROM rows WHERE collection='targets' AND owner_id=?").get(f.b.packageId).value,
    before=await f.repository.readControl(),preview=await f.trash.preview({packageIds:[packageId]});
  assert.equal(preview.candidates[0].counts.jobs,0,'physical public count omits the JSON-owned row');
  f.repository.metrics({reset:true});
  await assert.rejects(f.purge.execute(preview),{code:'sqlite_purge_metadata_invalid'});
  assert.equal(f.repository.metrics().purgeIdentityGuardStatements,1);
  assert.deepEqual((await f.repository.readControl()).deletionLedger,before.deletionLedger);
  assert.deepEqual(db.prepare("SELECT owner_id,record_id,value FROM rows WHERE collection='jobs' AND id=?").get(jobId),row);
  assert.equal(db.prepare("SELECT value FROM rows WHERE collection='targets' AND owner_id=?").get(f.b.packageId).value,peer);
});

test('peer file hidden by wrong physical record_id cannot bypass same-path protection',async t=>{
  const f=await fixture(t),{a:selected,b:peer}=await snapshotPeers(f);
  const view=await f.repository.read(),selectedFile=Object.values(view.files).find(v=>v.ownerPackageId===selected.packageId),
    peerFile=Object.values(view.files).find(v=>v.ownerPackageId===peer.packageId),peerOriginalPath=peerFile.path;
  const oldOwner=randomUUID(),hiddenPhysicalRecord=randomUUID();
  await f.repository.withWriteFence(async fence=>{
    const c=fence.control;c.deletionLedger[oldOwner]={phase:'purged',recordIds:[hiddenPhysicalRecord]};await fence.commitControl(c);
  },{operationMaintenance:true});
  await f.trash.archive({packageId:selected.packageId});
  const db=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'));registerTestResource(t,()=>db.close());
  // Fault injection only in this owned synthetic DB. files.value.path is the
  // managed pathname; rows.part_path is structural routing, not a file path.
  // Keep all real constraints and owner/ref metadata intact; only the intended
  // same-path body and physical record-id contradiction are injected.
  db.prepare("UPDATE rows SET value=json_set(value,'$.path',?),record_id=? WHERE collection='files' AND id=?")
    .run(selectedFile.path,hiddenPhysicalRecord,peerFile.fileId);
  const row=db.prepare("SELECT owner_id,record_id,value FROM rows WHERE collection='files' AND id=?").get(peerFile.fileId),
    sharedBytes=await fs.readFile(path.join(f.dataDir,selectedFile.path)),peerBytes=await fs.readFile(path.join(f.dataDir,peerOriginalPath)),
    before=await f.repository.readControl(),preview=await f.trash.preview({packageIds:[selected.packageId]});
  f.repository.metrics({reset:true});
  await assert.rejects(f.purge.execute(preview),{code:'sqlite_purge_metadata_invalid'});
  assert.equal(f.repository.metrics().purgeIdentityGuardStatements,1);
  assert.deepEqual((await f.repository.readControl()).deletionLedger,before.deletionLedger);
  assert.deepEqual(db.prepare("SELECT owner_id,record_id,value FROM rows WHERE collection='files' AND id=?").get(peerFile.fileId),row);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir,selectedFile.path)),sharedBytes);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir,peerOriginalPath)),peerBytes);
});

test('queued/running status and operation-state overflow stay busy before durable intent',async t=>{
  for(const mode of ['queued','running','overflow']){
    const f=await fixture(t);
    if(mode!=='overflow')await f.repository.transaction({select:[{collection:'runs',ids:['active-test'],ownerPackageId:f.a.packageId}]},tx=>{
      tx.putRow({collection:'runs',id:'active-test',ownerPackageId:f.a.packageId,value:{runId:'active-test',recordId:randomUUID(),ownerPackageId:f.a.packageId,status:'completed',ownerPid:0}});
    });
    await f.trash.archive({packageId:f.a.packageId});
    const lease=await f.operationGate.acquire('permanent-delete',{packageIds:[f.a.packageId]});
    try{
      if(mode==='overflow'){
        const ids=Array.from({length:201},(_,i)=>'synthetic-lease-'+i);
        await f.repository.transaction({select:[{collection:'operationLeases',ids}]},tx=>{
          for(const id of ids)tx.putRow({collection:'operationLeases',id,value:{operationId:id,token:randomUUID(),kind:'collect',packageIds:[f.b.packageId],ownerPid:process.pid}});
        },{operationMaintenance:true});
      }else{
        // Simulate an interrupted external/restored status after legal archive;
        // ordinary archived-owner writes must remain prohibited in production.
        const db=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'));registerTestResource(t,()=>db.close());
        db.prepare("UPDATE rows SET value=json_set(value,'$.status',?),status=? WHERE collection='runs' AND id=?")
          .run(mode,mode,'active-test');
      }
      const preview=await f.trash.preview({emptyAll:true});
      await assert.rejects(f.purge.execute(preview,{operationLease:lease}),{code:'workspace_operation_busy'});
      assert.equal((await f.repository.readControl()).deletionLedger[f.a.packageId],undefined);
    }finally{
      // Overflow deliberately closes the formal fence. Leave those rows only in
      // this synthetic directory; fixture close/removal is its cleanup boundary.
      if(mode!=='overflow')await lease.release();
    }
  }
});

test('full body assertion is deferred to runTasks but still precedes every destructive step',async t=>{
  const f=await fixture(t),ids=await f.ingest(f.a,[{title:'合成岗位',company:'合成单位',url:'https://example.invalid/body',sourceId:'synthetic',description:'合成正文'}]);
  await f.trash.archive({packageId:f.a.packageId});
  const db=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'));registerTestResource(t,()=>db.close());
  db.prepare("UPDATE rows SET value=json_set(value,'$.kind','invalid-body-kind') WHERE collection='jobs' AND id=?").run(ids[0]);
  const row=db.prepare("SELECT value FROM rows WHERE collection='jobs' AND id=?").get(ids[0]).value,
    peer=db.prepare('SELECT count(*) AS n FROM rows WHERE owner_id=?').get(f.b.packageId).n;
  await assert.rejects(f.purge.execute(await f.trash.preview({emptyAll:true})));
  const c=await f.repository.readControl(),task=c.purgeTasks[c.deletionLedger[f.a.packageId].operationId];
  assert.equal(task.phase,'prepared');assert.equal(c.deletionLedger[f.a.packageId].phase,'purge_pending');
  assert.equal(db.prepare("SELECT value FROM rows WHERE collection='jobs' AND id=?").get(ids[0]).value,row);
  assert.equal(db.prepare('SELECT count(*) AS n FROM rows WHERE owner_id=?').get(f.b.packageId).n,peer);
});

test('transferred file effective owners and accepted snapshot hashes match original plan; cross-owner paths still fail',async t=>{
  const f=await fixture(t),legacy=await seedUnassignedClosure(f,{managedSnapshot:true});
  const w=await f.repository.read(),file=Object.values(w.files).find(r=>r.ownerPackageId===legacy.packageId),operationId=randomUUID(),toHash='synthetic-to-hash';
  await f.repository.withWriteFence(async fence=>{
    const c=fence.control;c.ownershipTransfers[file.recordId]={from:legacy.packageId,to:f.a.packageId,operationId,phase:'prepared'};
    c.ownershipTransfers[file.snapshotRecordId]={from:legacy.packageId,to:f.a.packageId,operationId,phase:'prepared'};
    c.migrationJournal.ownershipTransferSnapshots||={};c.migrationJournal.ownershipTransferSnapshots[operationId]={[file.snapshotRecordId]:{fromHash:file.hash,toHash}};
    await fence.commitControl(c);
  },{operationMaintenance:true});
  await f.trash.archive({packageId:f.a.packageId});
  const source=await f.repository.exportWorkspace(),control=await f.repository.readControl(),expected=planPackageFiles({layout:resolveDataLayout(f.dataDir),workspace:source,control,packageId:f.a.packageId});
  await stopAfterPrepare(f,await f.trash.preview({packageIds:[f.a.packageId]}));
  const c=await f.repository.readControl(),task=c.purgeTasks[c.deletionLedger[f.a.packageId].operationId];
  assert.deepEqual(task.files[0].acceptedHashes,expected.files[0].acceptedHashes);assert.ok(task.files[0].acceptedHashes.includes(toHash));
  assert.deepEqual(task.files[0].acceptedOwnerPackageIds,[legacy.packageId,f.a.packageId]);
  assert.ok(c.deletionLedger[f.a.packageId].recordIds.includes(file.recordId));assert.ok(c.deletionLedger[f.a.packageId].recordIds.includes(file.snapshotRecordId));
  // Separate fresh fixture: a peer's same path must not be deleted as ours.
  const g=await fixture(t),{a,b}=await snapshotPeers(g),view=await g.repository.read(),
    af=Object.values(view.files).find(x=>x.ownerPackageId===a.packageId),bf=Object.values(view.files).find(x=>x.ownerPackageId===b.packageId),
    db=new DatabaseSync(path.join(g.dataDir,'workspace.sqlite'));registerTestResource(t,()=>db.close());
  db.prepare("UPDATE rows SET value=json_set(value,'$.path',?) WHERE collection='files' AND id=?").run(af.path,bf.fileId);
  const peerBefore=db.prepare("SELECT owner_id,record_id,value FROM rows WHERE collection='files' AND id=?").get(bf.fileId),
    sharedBytes=await fs.readFile(path.join(g.dataDir,af.path)),peerBytes=await fs.readFile(path.join(g.dataDir,bf.path));
  await g.trash.archive({packageId:a.packageId});
  await assert.rejects(g.purge.execute(await g.trash.preview({packageIds:[a.packageId]})),{code:'purge_file_failed'});
  assert.equal((await g.repository.readControl()).deletionLedger[a.packageId],undefined);
  assert.deepEqual(db.prepare("SELECT owner_id,record_id,value FROM rows WHERE collection='files' AND id=?").get(bf.fileId),peerBefore);
  assert.deepEqual(await fs.readFile(path.join(g.dataDir,af.path)),sharedBytes);
  assert.deepEqual(await fs.readFile(path.join(g.dataDir,bf.path)),peerBytes);
});

test('formal writer fence serializes another connection and preserves stale preview rejection',async t=>{
  const f=await fixture(t);await f.trash.archive({packageId:f.a.packageId});
  const other=await openWorkspaceRepository({dataDir:f.dataDir,clock:f.clock});registerTestResource(t,()=>other.close());
  const preview=await f.trash.preview({emptyAll:true});let entered=false,waiting;
  await f.repository.withWriteFence(async()=>{
    waiting=other.withWriteFence(fence=>{entered=true;fence.transaction({select:[],metaKeys:['otherWriter']},tx=>tx.setMeta('otherWriter',true));},{operationMaintenance:true});
    await new Promise(r=>setTimeout(r,25));assert.equal(entered,false);
  },{operationMaintenance:true});
  await waiting;assert.equal(entered,true);
  await assert.rejects(f.purge.execute(preview),{code:'duplicate_preview_stale'});
});
