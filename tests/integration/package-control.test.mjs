import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {packageFixture} from '../helpers/package-fixture.mjs';
import {reserveIdentity} from '../../src/infrastructure/storage/package-control.mjs';

async function seedOwned(f) {
  const packageId=randomUUID(),recordId=randomUUID();
  await f.repository.mutateWorkspace(w=>{
    w.packages[packageId]={packageId,kind:'profile',versionId:'p1@1',versionName:'合成资料',enabled:true,state:'active',archiveId:null,archivedAt:null,purgeAt:null};
    w.profiles.p1=[{profileId:'p1',revisionId:'p1@1',revision:1,recordId,ownerPackageId:packageId,text:'SYNTHETIC-PRIVATE-BODY'}];
  });
  return {packageId,recordId};
}
test('initialized control missing or corrupt blocks access without reinitializing',async t=>{
  for(const file of ['state.json','initialized.json']) {
    const f=await packageFixture(t);
    await fs.unlink(path.join(f.repository.dataDir,'control',file));
    await assert.rejects(()=>f.repository.read(),{code:'control_state_invalid'});
    await assert.rejects(()=>f.reopen(),{code:'control_state_invalid'});
    await assert.rejects(fs.stat(path.join(f.repository.dataDir,'control',file)),{code:'ENOENT'});
  }
  const f=await packageFixture(t);
  await fs.writeFile(path.join(f.repository.dataDir,'control/state.json'),'{bad');
  await assert.rejects(()=>f.control.read(),{code:'control_state_invalid'});
});
test('prepared identity survives failed main commit and is reused',async t=>{
  const f=await packageFixture(t); f.armFailure('workspace_commit');
  await assert.rejects(()=>f.repository.withMaintenanceTransaction(async tx=>{
    await reserveIdentity(tx,{namespace:'package',key:'synthetic'});
    await tx.commitWorkspace(tx.workspace);
  }),/synthetic storage failure/);
  const id=(await f.control.read()).identityIndex.package.synthetic;
  assert.match(id,/^[a-f0-9-]{36}$/);
  await f.reopen();
  const replay=await f.repository.withMaintenanceTransaction(tx=>reserveIdentity(tx,{namespace:'package',key:'synthetic'}));
  assert.equal(replay,id);
});
test('delete intent immediately hides bodies and previous writes never resurrect them',async t=>{
  const f=await packageFixture(t), {packageId,recordId}=await seedOwned(f), archiveId=randomUUID();
  await f.repository.withMaintenanceTransaction(async tx=>{
    tx.control.deletionLedger[packageId]={phase:'purge_pending',recordIds:[recordId],archiveId,archivedAt:'2026-10-09T00:00:00.000Z',purgeAt:'2026-10-12T00:00:00.000Z',operationId:randomUUID()};
    await tx.commitControl(tx.control);
  });
  assert.equal(Object.values((await f.repository.read()).profiles).flat().length,0);
  await f.repository.mutateWorkspace(w=>{w.settings.budgets={maxCostCny:10};});
  for(const file of ['workspace.v2.json','workspace.v2.previous.json'])assert.doesNotMatch(await fs.readFile(path.join(f.repository.dataDir,file),'utf8'),/SYNTHETIC-PRIVATE-BODY/);
  assert.doesNotMatch(JSON.stringify(await f.control.read()),/SYNTHETIC-PRIVATE-BODY|合成资料/);
});
test('maintenance callback reads reuse the held lock',async t=>{
  const f=await packageFixture(t);
  await f.repository.withMaintenanceTransaction(async tx=>{
    assert.equal((await f.repository.read()).schemaVersion,3);
    await tx.commitWorkspace(tx.workspace);
  });
  assert.equal((await f.repository.read()).revision,2);
});
test('identity and version high water cannot be rolled back',async t=>{
  const f=await packageFixture(t);
  await f.repository.withMaintenanceTransaction(async tx=>{
    await reserveIdentity(tx,{namespace:'record',key:'r'});
    tx.control.versionHighWater['target:t1']=7; await tx.commitControl(tx.control);
  });
  await assert.rejects(()=>f.repository.withMaintenanceTransaction(async tx=>{
    tx.control.versionHighWater['target:t1']=1; await tx.commitControl(tx.control);
  }),{code:'control_state_invalid'});
  assert.equal((await f.control.read()).versionHighWater['target:t1'],7);
});
test('private run snapshots require stable identity and the correct owner',async t=>{
  const f=await packageFixture(t),{packageId}=await seedOwned(f);
  await f.repository.mutateWorkspace(w=>{w.runs.r1={runId:'r1',recordId:randomUUID(),ownerPackageId:packageId,status:'completed'};});
  await assert.rejects(()=>f.repository.writeRunSnapshot('r1',{ownerPackageId:packageId,run:{runId:'r1'}}),{code:'package_scope_mismatch'});
  await assert.rejects(()=>f.repository.writeRunSnapshot('r1',{recordId:randomUUID(),ownerPackageId:randomUUID()}),{code:'package_scope_mismatch'});
  await assert.rejects(fs.stat(path.join(f.repository.dataDir,'runs-v2/r1.json')),{code:'ENOENT'});
});
