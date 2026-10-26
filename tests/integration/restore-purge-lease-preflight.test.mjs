import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { packageBusinessFixture } from '../helpers/package-business-fixture.mjs';
import { tempRepository } from '../helpers/repository.mjs';
import { registerTestResource } from '../helpers/fixtures.mjs';
import { createPurgeService } from '../../src/application/purge-service.mjs';
import { createApplicationContext } from '../../src/application/context.mjs';
import { createModelCredentialBinding } from '../../src/application/model-credential-binding.mjs';
import { createSourceRegistry } from '../../src/sources/registry.mjs';
import { DEFAULT_CONFIG } from '../../src/config.mjs';
import { createBackup, restoreBackup, validateBackupArchive, isRestorePurgePreflightError } from '../../src/infrastructure/storage/backup.mjs';
import { recoverPendingStorageMaintenance } from '../../src/infrastructure/storage/restore-maintenance.mjs';
import { contentHash, canonicalContentHash } from '../../src/infrastructure/storage/content-hash.mjs';

async function fixture(t){
  const f=await packageBusinessFixture(t);Object.assign(f,await f.twoTargets());
  f.purge=createPurgeService({repository:f.repository,trash:f.trash,fsAdapter:f.fsAdapter});
  f.backup=await createBackup({repository:f.repository});
  f.restore=(extra={})=>restoreBackup({repository:f.repository,archivePath:f.backup.path,
    trashService:f.trash,purgeService:f.purge,fsAdapter:f.fsAdapter,...extra});
  return f;
}
const noRestoreIntent = control => assert.equal(Object.values(control.migrationJournal.maintenance||{}).some(task=>task.kind==='restore'),false);
const preflight = error => {
  assert.equal(error.code,'purge_pending');assert.equal(error.status,409);
  assert.equal(isRestorePurgePreflightError(error),true);
  assert.match(error.message,/回收站.*重试恢复/);assert.equal(error.fieldErrors,undefined);return true;
};
async function withFailedPurgePublish(f,action){
  const original=f.repository.withMaintenanceTransaction;
  let publications=0,failures=0;
  f.repository.withMaintenanceTransaction=(callback,options={})=>original(async tx=>{
    const commitWorkspace=tx.commitWorkspace;
    tx.commitWorkspace=async(...args)=>{
      if(options.operationLease?.kind!=='permanent-delete')return commitWorkspace(...args);
      // Lease acquisition and durable prepare must succeed first. Arm the real
      // storage fault only when the genuine purge executor publishes workspace.
      const lease=tx.workspace.operationLeases[options.operationLease.operationId];
      assert.equal(lease?.kind,'permanent-delete');assert.equal(lease?.token,options.operationLease.token);
      assert.ok(Object.values(tx.control.purgeTasks).some(task=>task.packageId===f.a.packageId&&task.phase!=='completed'));
      publications++;
      if(publications===1)f.armFailure('workspace_commit');
      try{return await commitWorkspace(...args);}
      catch(error){
        if(publications===1){assert.equal(error.message,'synthetic storage failure');failures++;}
        throw error;
      }
    };
    return callback(tx);
  },options);
  try{return await action();}
  finally{
    f.repository.withMaintenanceTransaction=original;f.armFailure(null);
    assert.equal(publications,1,'reach one real purge workspace publication after its lease/prepare');
    assert.equal(failures,1,'the existing storage fault fires at that publication');
  }
}
async function makePending(f){
  const result=await withFailedPurgePublish(f,async()=>f.purge.execute(await f.trash.preview({packageIds:[f.a.packageId]})));
  assert.deepEqual(result.pending,[f.a.packageId]);assert.equal(result.completed.length,0);
}

test('expired cleanup uses its real permanent-delete lease before a distinct restore lease',async t=>{
  const f=await fixture(t),seen=[],withFence=f.repository.withWriteFence;
  f.repository.withWriteFence=(action,options={})=>withFence(fence=>{
    if(options.operationLease){
      const stored=fence.getRow({collection:'operationLeases',id:options.operationLease.operationId});
      if(stored){assert.equal(stored.token,options.operationLease.token);seen.push({id:stored.operationId,kind:stored.kind});}
    }
    return action(fence);
  },options);
  await f.trash.archive({packageId:f.a.packageId});f.clock.advance(72*3600*1000);
  await f.restore();
  const w=await f.repository.exportWorkspace(),control=await f.repository.readControl();
  assert.equal(w.packages[f.a.packageId],undefined);assert.ok(w.packages[f.b.packageId]);
  assert.equal(control.deletionLedger[f.a.packageId].phase,'purged');
  const purgeIds=new Set(seen.filter(row=>row.kind==='permanent-delete').map(row=>row.id)),
    restoreIds=new Set(seen.filter(row=>row.kind==='restore').map(row=>row.id));
  assert.ok(purgeIds.size>0);assert.ok(restoreIds.size>0);
  for(const id of restoreIds)assert.equal(purgeIds.has(id),false);
  assert.equal((await f.repository.queryRows({collection:'operationLeases'})).rows.length,0);
});

test('caller-owned restore lease defers expired or young pending state without borrowing/releasing it',async t=>{
  for(const mode of ['expired','pending']){
    const f=await fixture(t);await f.trash.archive({packageId:f.a.packageId});
    if(mode==='expired')f.clock.advance(72*3600*1000);else await makePending(f);
    const lease=await f.operationGate.acquire('restore',{}),before=await f.repository.readControl(),revision=await f.repository.getMeta('revision');
    let resumeCalls=0,executeCalls=0;
    const monitored={...f.purge,
      async resumePending(input){resumeCalls++;return f.purge.resumePending(input);},
      async execute(...args){executeCalls++;return f.purge.execute(...args);}};
    try{
      await assert.rejects(f.restore({operationLease:lease,purgeService:monitored}),preflight);
      assert.equal(resumeCalls,0);assert.equal(executeCalls,0);
      const stored=await f.repository.getRow({collection:'operationLeases',id:lease.operationId});
      assert.equal(stored.token,lease.token);assert.equal(stored.kind,'restore');
      assert.equal(await f.repository.getMeta('revision'),revision);
      assert.deepEqual(await f.repository.readControl(),before);noRestoreIntent(before);
    }finally{await lease.release();}
  }
});

test('unfinished cleanup before restore remains a purge barrier and creates no restore intent',async t=>{
  const f=await fixture(t);await f.trash.archive({packageId:f.a.packageId});await makePending(f);
  const ledger=structuredClone((await f.repository.readControl()).deletionLedger[f.a.packageId]);
  await withFailedPurgePublish(f,()=>assert.rejects(f.restore(),preflight));
  const control=await f.repository.readControl();noRestoreIntent(control);
  assert.deepEqual(control.deletionLedger[f.a.packageId],ledger);
  assert.equal((await f.repository.queryRows({collection:'operationLeases'})).rows.length,0);
});

test('fresh restore fence rejects expiry or new pending work after the outside cleanup stage',async t=>{
  for(const mode of ['expires','new_pending']){
    const f=await fixture(t);await f.trash.archive({packageId:f.a.packageId});
    if(mode==='expires')f.clock.advance(72*3600*1000-1);
    let injected=false;
    const trash={...f.trash,async preview(input){
      const result=await f.trash.preview(input);
      if(input.expiredOnly&&!injected){
        injected=true;assert.equal(result.candidates.length,0);
        if(mode==='expires')f.clock.advance(1);else await makePending(f);
      }
      return result;
    }};
    await assert.rejects(f.restore({trashService:trash}),preflight);assert.equal(injected,true);
    const control=await f.repository.readControl();noRestoreIntent(control);
    assert.equal((await f.repository.queryRows({collection:'operationLeases'})).rows.length,0);
    if(mode==='expires')assert.equal(control.deletionLedger[f.a.packageId],undefined);
    else assert.equal(control.deletionLedger[f.a.packageId].phase,'purge_pending');
  }
});

test('fresh preflight checks stored restore kind/token rather than a caller kind label',async t=>{
  const f=await fixture(t),lease=await f.operationGate.acquire('backup',{}),before=await f.repository.readControl();
  try{
    await assert.rejects(f.restore({operationLease:{...lease,kind:'restore'}}),{code:'invalid_operation_lease'});
    assert.equal((await f.repository.getRow({collection:'operationLeases',id:lease.operationId})).token,lease.token);
    assert.deepEqual(await f.repository.readControl(),before);noRestoreIntent(before);
  }finally{await lease.release();}
});

test('invalid archive hashes fail before cleanup, lease acquisition or either kind of intent',async t=>{
  const f=await fixture(t);await f.trash.archive({packageId:f.a.packageId});f.clock.advance(72*3600*1000);
  const invalid=JSON.parse(await fs.readFile(f.backup.path,'utf8'));invalid.workspace.revision++;
  const before=await f.repository.readControl(),revision=await f.repository.getMeta('revision');let calls=0;
  const monitored={...f.purge,async resumePending(...args){calls++;return f.purge.resumePending(...args);}};
  await assert.rejects(f.restore({validatedArchive:invalid,purgeService:monitored}),/hash/);
  assert.equal(calls,0);assert.equal(await f.repository.getMeta('revision'),revision);
  assert.deepEqual(await f.repository.readControl(),before);noRestoreIntent(before);
  assert.equal((await f.repository.queryRows({collection:'operationLeases'})).rows.length,0);
});

test('legacy2 restore keeps the original data path and no-purge behavior',async t=>{
  const repository=await tempRepository(t);assert.equal(await repository.getMeta('schemaVersion'),2);
  await repository.mutateWorkspace(w=>{w.settings.syntheticRestore='before';});
  const backup=await createBackup({repository});
  await repository.mutateWorkspace(w=>{w.settings.syntheticRestore='after';});
  await restoreBackup({repository,archivePath:backup.path,purgeService:{async resumePending(){throw Error('legacy must not purge');}}});
  assert.equal((await repository.exportWorkspace()).settings.syntheticRestore,'before');
  assert.equal(await repository.getMeta('schemaVersion'),2);
});

async function contextFixture(t,{readFailure=false}={}){
  const f=await fixture(t),cfg=structuredClone(DEFAULT_CONFIG);cfg.deepseek.apiKey='synthetic-preflight-binding';
  await f.repository.transaction({select:[{collection:'settings',ids:['model','apiKeyBinding']}]},tx=>{
    tx.putRow({collection:'settings',id:'model',value:{baseUrl:cfg.deepseek.baseUrl,model:cfg.deepseek.model}});
    tx.putRow({collection:'settings',id:'apiKeyBinding',value:createModelCredentialBinding(cfg.deepseek.apiKey,cfg.deepseek)});
  });
  let failRead=false;
  const adapter={...f.fsAdapter,async readFile(file,...args){
    if(failRead&&/^workspace-restore-[a-f0-9-]+\.json$/.test(path.basename(String(file))))
      throw Object.assign(Error('synthetic unrelated restore failure'),{code:'purge_pending',status:409});
    return f.fsAdapter.readFile(file,...args);
  }};
  const noTimers={setTimeout:()=>({unref(){}}),clearTimeout(){},setInterval:()=>({unref(){}}),clearInterval(){}};
  const context=await createApplicationContext({cfg,dataDir:f.dataDir,dependencies:{repository:f.repository,
    clock:f.clock,fsAdapter:adapter,startScheduler:false,timers:noTimers,registry:createSourceRegistry([]),catalog:[],
    ocr:{async close(){}},anonymousWorker:{async read(){throw Error('synthetic network forbidden');},async closePackage(){return {status:'clean'};},async stop(){}}}});
  registerTestResource(t,()=>context.close());
  return {...f,cfg,context,armReadFailure(){assert.equal(readFailure,true);failRead=true;}};
}

test('context preserves configured credentials and original UI conflict only for real preflight provenance',async t=>{
  const f=await contextFixture(t),archive=JSON.parse(await fs.readFile(f.backup.path,'utf8')),
    binding=await f.repository.getRow({collection:'settings',id:'apiKeyBinding'});
  assert.equal((await f.context.getSettings()).model.configured,true);
  await f.context.trashService.archive({packageId:f.a.packageId});
  // Use the context's real purge service so its existing resource/lease boundary
  // is exercised. Inject only at its real workspace publish, after lease/prepare.
  const result=await withFailedPurgePublish(f,async()=>f.context.purgeService.execute(await f.context.trashService.preview({packageIds:[f.a.packageId]})));
  assert.deepEqual(result.pending,[f.a.packageId]);assert.equal(result.completed.length,0);
  await withFailedPurgePublish(f,()=>assert.rejects(f.context.restore(archive),preflight));
  // Check immediately, before getSettings can republish a persisted binding.
  assert.equal(f.cfg.deepseek.apiKey,'synthetic-preflight-binding');
  assert.equal(f.context.modelFactory({}).available,true);
  assert.equal((await f.context.getSettings()).model.configured,true);
  assert.deepEqual(await f.repository.getRow({collection:'settings',id:'apiKeyBinding'}),binding);
  noRestoreIntent(await f.repository.readControl());
});

test('an unrelated failure named purge_pending does not bypass existing credential invalidation',async t=>{
  const f=await contextFixture(t,{readFailure:true}),archive=JSON.parse(await fs.readFile(f.backup.path,'utf8'));
  assert.equal((await f.context.getSettings()).model.configured,true);f.armReadFailure();
  await assert.rejects(f.context.restore(archive),error=>{
    assert.equal(isRestorePurgePreflightError(error),false);assert.ok(error.fieldErrors?.file);return true;
  });
  assert.equal(Boolean(f.cfg.deepseek.apiKey),false);
  // Preserve the existing immediate runtime gate. A later explicit settings
  // read may legitimately revalidate an unchanged persisted binding; this test
  // must not invent a stronger permanent-invalidity contract.
  assert.equal(f.context.modelFactory({}).available,false);
});

async function snapshotClockFixture(t){
  const f=await fixture(t);
  for(const scope of [f.a,f.b])await f.ingest(scope,[{title:'合成时钟岗位',company:'合成时钟单位',url:'https://example.invalid/clock',sourceId:'synthetic',description:'合成时钟正文'}]);
  await f.repository.withMaintenanceTransaction(async tx=>{
    const w=structuredClone(tx.workspace);
    for(const scope of [f.a,f.b]){
      const run=Object.values(w.runs).find(r=>r.ownerPackageId===scope.packageId),snapshot={recordId:randomUUID(),
        ownerPackageId:scope.packageId,run:structuredClone(run),marker:scope===f.a?'synthetic-local-A':'synthetic-local-B'};
      run.snapshotRef=await tx.writeSnapshot(run.runId,snapshot);
      const fileId=randomUUID();w.files[fileId]={fileId,recordId:fileId,ownerPackageId:scope.packageId,runId:run.runId,
        snapshotRecordId:snapshot.recordId,path:run.snapshotRef.path,hash:run.snapshotRef.hash,kind:'run_snapshot'};
    }
    await tx.commitWorkspace(w);
  });
  f.backup=await createBackup({repository:f.repository});
  f.episode=await f.trash.archive({packageId:f.a.packageId});f.clock.advance(72*3600*1000-1);
  const w=await f.repository.exportWorkspace();
  f.peer=structuredClone(Object.values(w.targets).flat().find(r=>r.ownerPackageId===f.b.packageId));
  f.peerFile=Object.values(w.files).find(r=>r.ownerPackageId===f.b.packageId);
  f.peerBytes=await fs.readFile(path.join(f.dataDir,f.peerFile.path));
  return f;
}
async function assertExpiredTrashHeld(f,{archiveId=f.episode.archiveId}={}){
  const w=await f.repository.exportWorkspace(),p=w.packages[f.a.packageId];
  assert.equal(p.state,'trashed');assert.equal(p.archiveId,archiveId);
  assert.equal(p.archivedAt,f.episode.archivedAt);assert.equal(p.purgeAt,f.episode.purgeAt);
  assert.deepEqual(Object.values(w.targets).flat().find(r=>r.ownerPackageId===f.b.packageId),f.peer);
  await assert.rejects(f.trash.get(f.a.packageId),{code:'package_expired'});
  await assert.rejects(f.trash.restore({packageId:f.a.packageId,archiveId:p.archiveId}),{code:'package_expired'});
}

test('crossing72h after fresh preflight, after plan-write or immediately before SQL keeps original local trash',async t=>{
  for(const point of ['restore.source-written','restore.plan-written','restore.control-files-ready']){
    const f=await snapshotClockFixture(t);let advanced=false;
    const result=await f.restore({faultInjector(stage){if(stage===point&&!advanced){advanced=true;f.clock.advance(1);}}});
    assert.equal(advanced,true);assert.equal(result.recovered,true);
    await assertExpiredTrashHeld(f);
    assert.deepEqual(await fs.readFile(path.join(f.dataDir,f.peerFile.path)),f.peerBytes);
    assert.equal((await f.repository.readControl()).deletionLedger[f.a.packageId],undefined,'late expiry is not an unauthorized purge under restore lease');
  }
});

test('recovery refuses a valid old active plan before replacing any local snapshot',async t=>{
  for(const legacyAuthority of [false,true]){
    const f=await snapshotClockFixture(t);let interrupted=false;
    await assert.rejects(f.restore({faultInjector(stage){if(stage==='restore.plan-written'&&!interrupted){interrupted=true;throw Error('synthetic plan interruption');}}}),/synthetic plan interruption/);
    assert.equal(interrupted,true);
    const control=await f.repository.readControl(),task=Object.values(control.migrationJournal.maintenance).find(t=>t.kind==='restore'),
      file=path.join(f.dataDir,'backups',task.planId),plan=JSON.parse(await fs.readFile(file,'utf8'));
    // Make an old-style plan genuinely valid under the ordinary archive hash /
    // entity contract, while it contradicts the current trash episode. A peer
    // snapshot differs so byte sentinels prove no write occurred before refusal.
    Object.assign(plan.workspace.packages[f.a.packageId],{state:'active',archiveId:null,archivedAt:null,purgeAt:null});
    plan.runSnapshots[f.peerFile.runId].marker='synthetic-conflicting-old-peer';
    const peerHash=contentHash(plan.runSnapshots[f.peerFile.runId]);
    plan.workspace.runs[f.peerFile.runId].snapshotRef.hash=peerHash;
    for(const value of Object.values(plan.workspace.files))if(value.runId===f.peerFile.runId)value.hash=peerHash;
    plan.manifest.workspaceHash=contentHash(plan.workspace);plan.manifest.snapshots[f.peerFile.runId]=peerHash;
    // Public validator stays meaningful: hashes are not the reason for refusal.
    validateBackupArchive(plan);
    await fs.writeFile(file,JSON.stringify(plan));
    await f.repository.withWriteFence(async fence=>{
      const c=fence.control,t=c.migrationJournal.maintenance[task.taskId];
      t.planHash=canonicalContentHash({...plan.workspace,revision:0,operationLeases:{}});
      if(legacyAuthority)delete t.trashAuthority;
      await fence.commitControl(c);
    },{operationMaintenance:true});
    f.clock.advance(1);
    // Both same-source explicit retry and startup's direct recovery bypass the
    // original unstarted preflight but must hit the kernel authority guard.
    await assert.rejects(legacyAuthority?recoverPendingStorageMaintenance({repository:f.repository,fsAdapter:f.fsAdapter}):f.restore(),error=>{
      assert.equal(error.code,'workspace_restore_pending');assert.equal(isRestorePurgePreflightError(error),false);return true;
    });
    await assertExpiredTrashHeld(f);
    assert.deepEqual(await fs.readFile(path.join(f.dataDir,f.peerFile.path)),f.peerBytes);
    assert.notEqual((await f.repository.readControl()).migrationJournal.maintenance[task.taskId].phase,'complete');
  }
});

test('the final SQL fence rejects a trash identity change after snapshot preparation',async t=>{
  const f=await snapshotClockFixture(t),replacementArchiveId=randomUUID();let changed=false;
  await assert.rejects(f.restore({faultInjector:async stage=>{
    if(stage!=='restore.control-files-ready'||changed)return;changed=true;f.clock.advance(1);
    // Owned synthetic interruption: another formal maintenance action changed
    // the episode identity without extending the original archivedAt/purgeAt.
    await f.repository.withMaintenanceTransaction(async tx=>{
      const w=structuredClone(tx.workspace);w.packages[f.a.packageId].archiveId=replacementArchiveId;await tx.commitWorkspace(w);
    },{operationMaintenance:true});
  }}),error=>{assert.equal(error.code,'workspace_restore_pending');assert.equal(isRestorePurgePreflightError(error),false);return true;});
  assert.equal(changed,true);await assertExpiredTrashHeld(f,{archiveId:replacementArchiveId});
  assert.deepEqual(await fs.readFile(path.join(f.dataDir,f.peerFile.path)),f.peerBytes);
  assert.ok(Object.values((await f.repository.readControl()).migrationJournal.maintenance).some(t=>t.kind==='restore'&&t.phase!=='complete'));
});

test('started restore never switches archive source or chooses between multiple durable intents',async t=>{
  for(const mode of ['different_source','multiple_intents']){
    const f=await snapshotClockFixture(t);
    await assert.rejects(f.restore({faultInjector(stage){if(stage==='restore.plan-written')throw Error('synthetic started restore');}}),/synthetic started restore/);
    const before=await f.repository.readControl(),original=Object.values(before.migrationJournal.maintenance).find(t=>t.kind==='restore');
    let extra={};
    if(mode==='different_source'){
      const archive=JSON.parse(await fs.readFile(f.backup.path,'utf8'));
      archive.workspace.settings.syntheticDifferentSource=true;archive.manifest.workspaceHash=contentHash(archive.workspace);
      validateBackupArchive(archive);extra={validatedArchive:archive};
    }else await f.repository.withWriteFence(async fence=>{
      const c=fence.control,id=randomUUID();c.migrationJournal.maintenance[id]={...structuredClone(original),taskId:id};await fence.commitControl(c);
    },{operationMaintenance:true});
    f.clock.advance(1);
    await assert.rejects(f.restore(extra),error=>{assert.equal(error.code,'workspace_restore_pending');assert.equal(isRestorePurgePreflightError(error),false);return true;});
    if(mode==='multiple_intents')await assert.rejects(recoverPendingStorageMaintenance({repository:f.repository,fsAdapter:f.fsAdapter}),{code:'workspace_restore_pending'});
    await assertExpiredTrashHeld(f);assert.deepEqual(await fs.readFile(path.join(f.dataDir,f.peerFile.path)),f.peerBytes);
    const after=await f.repository.readControl();assert.equal(after.migrationJournal.maintenance[original.taskId].sourceHash,original.sourceHash);
    assert.notEqual(after.migrationJournal.maintenance[original.taskId].phase,'complete');
  }
});
