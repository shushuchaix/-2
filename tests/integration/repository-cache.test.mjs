import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTempDir, registerTestResource } from '../helpers/fixtures.mjs';
import { packageFixture } from '../helpers/package-fixture.mjs';
import { openWorkspaceRepository } from '../../src/infrastructure/storage/repository.mjs';
import { createBackup, validateBackupArchive } from '../../src/infrastructure/storage/backup.mjs';

// The retained cache is validated control metadata. Business values are read
// from SQLite each time; legacy JSON is an immutable refusal marker after import.
async function fixture(t){
  const dataDir=await createTempDir(t);let reads=0,failure=null;
  const adapter={...fs,async readFile(file,...args){if(String(file).endsWith('state.json'))reads++;return fs.readFile(file,...args);}};
  const repository=await openWorkspaceRepository({dataDir,fsAdapter:adapter,faultInjector:phase=>{
    if((failure==='before'&&phase==='sqlite.beforeWrite')||(failure==='after'&&phase==='sqlite.afterCommit')){failure=null;throw Error('synthetic SQLite persistence failure');}
  }});registerTestResource(t,()=>repository.close());
  const write=value=>repository.transaction({select:[{collection:'settings',ids:['cacheProbe']}]},tx=>tx.putRow({collection:'settings',id:'cacheProbe',value:{value,nested:{items:[1]}}}));
  await write('first');
  return {repository,dataDir,state:path.join(dataDir,'control/state.json'),marker:path.join(dataDir,'workspace.v2.json'),write,
    read:()=>repository.getRow({collection:'settings',id:'cacheProbe'}),reads:()=>reads,fail:when=>{failure=when;}};
}
async function replaceControl(filename,change){
  const {checksum:ignored,...control}=JSON.parse(await fs.readFile(filename,'utf8'));change(control);
  const checksum=createHash('sha256').update(JSON.stringify(control)).digest('hex');
  await fs.writeFile(filename+'.replacement',JSON.stringify({...control,checksum}));await fs.rename(filename+'.replacement',filename);
}

test('unchanged public reads reuse validated control metadata and return isolated nested values',async t=>{
  const f=await fixture(t);await f.read();const before=f.reads();
  const a=await f.read();a.value='outside';a.nested.items.push(2);
  assert.deepEqual(await f.read(),{value:'first',nested:{items:[1]}});assert.equal(f.reads(),before);
});
test('a successful Windows row save needs no later full workspace read',async t=>{
  const f=await fixture(t);f.repository.metrics({reset:true});await f.write('saved');assert.equal((await f.read()).value,'saved');
  assert.equal(f.repository.metrics().maintenanceExports,0);assert.equal(f.repository.metrics().maintenanceReads,0);
});
test('same-size replacement and in-place metadata changes invalidate the control cache',async t=>{
  const f=await fixture(t);await replaceControl(f.state,c=>{c.versionHighWater.cache=1;});await f.repository.readControl();
  const original=await fs.readFile(f.state,'utf8');await replaceControl(f.state,c=>{c.versionHighWater.cache=2;});
  assert.equal((await fs.stat(f.state)).size,Buffer.byteLength(original));assert.equal((await f.repository.readControl()).versionHighWater.cache,2);
  const before=await fs.stat(f.state),{checksum:ignored,...control}=JSON.parse(await fs.readFile(f.state,'utf8'));control.versionHighWater.cache=3;
  const checksum=createHash('sha256').update(JSON.stringify(control)).digest('hex');await fs.writeFile(f.state,JSON.stringify({...control,checksum}));await fs.utimes(f.state,before.atime,before.mtime);
  assert.equal((await f.repository.readControl()).versionHighWater.cache,3);
});
test('failed callbacks and real SQL write faults never publish uncommitted values',async t=>{
  const f=await fixture(t);await assert.rejects(f.repository.transaction({select:[{collection:'settings',ids:['cacheProbe']}]},tx=>{
    tx.putRow({collection:'settings',id:'cacheProbe',value:{value:'failed'}});throw Error('synthetic mutation failure');
  }),/synthetic mutation/);assert.equal((await f.read()).value,'first');
  f.fail('before');await assert.rejects(f.write('failed'),/synthetic SQLite/);assert.equal((await f.read()).value,'first');
  await f.write('saved');assert.equal((await f.read()).value,'saved');
});
test('external control corruption fails closed and a repaired file is read afresh',async t=>{
  const f=await fixture(t),good=await fs.readFile(f.state,'utf8');await f.read();await fs.writeFile(f.state,'{broken');
  await assert.rejects(f.read(),{code:'control_state_invalid'});await fs.writeFile(f.state,good);assert.equal((await f.read()).value,'first');
  await fs.unlink(path.join(f.dataDir,'control/initialized.json'));await assert.rejects(f.read(),{code:'control_state_invalid'});
});
test('two cached repository instances observe every serialized SQL commit',async t=>{
  const f=await fixture(t),other=await openWorkspaceRepository({dataDir:f.dataDir});registerTestResource(t,()=>other.close());
  await Promise.all(Array.from({length:16},(_,i)=>(i%2?f.repository:other).transaction({select:[{collection:'settings',ids:['counter']}]},tx=>{
    const old=tx.getRow({collection:'settings',id:'counter'})||0;tx.putRow({collection:'settings',id:'counter',value:old+1});
  })));
  for(const repository of [f.repository,other])assert.equal(await repository.getRow({collection:'settings',id:'counter'}),16);
});
test('retained transaction and maintenance capabilities expire after their callback',async t=>{
  const f=await fixture(t);let rowTx,maintenanceTx;
  await f.repository.transaction({select:[{collection:'settings',ids:['cacheProbe']}]},tx=>{rowTx=tx;});
  assert.throws(()=>rowTx.getRow({collection:'settings',id:'cacheProbe'}),{code:'sqlite_transaction_closed'});
  await f.repository.withMaintenanceTransaction(tx=>{maintenanceTx=tx;});
  assert.throws(()=>maintenanceTx.workspace,{code:'workspace_fence_closed'});assert.equal((await f.read()).value,'first');
});
test('a cold maintenance draft remains separate from its transaction committed view',async t=>{
  const f=await fixture(t);await f.repository.mutateWorkspace((draft,tx)=>{
    draft.settings.cacheProbe.value='changed';assert.equal(tx.workspace.settings.cacheProbe.value,'first');
    tx.workspace.recoveryRecords.push({message:'separate view'});assert.deepEqual(draft.recoveryRecords,[]);
  });assert.equal((await f.read()).value,'changed');assert.deepEqual((await f.repository.read()).recoveryRecords,[]);
});
test('explicit backups retain prior revisions while normal writes do not create previous JSON',async t=>{
  const f=await fixture(t),backup=await createBackup({repository:f.repository});await f.write('changed');
  const archive=validateBackupArchive(JSON.parse(await fs.readFile(backup.path,'utf8')));assert.equal(archive.workspace.settings.cacheProbe.value,'first');
  await assert.rejects(fs.stat(path.join(f.dataDir,'workspace.v2.previous.json')),{code:'ENOENT'});assert.equal((await f.read()).value,'changed');
});
test('adapters without stat validate control without a cached fingerprint',async t=>{
  const f=await fixture(t),repository=await openWorkspaceRepository({dataDir:f.dataDir,fsAdapter:{...fs,stat:undefined}});registerTestResource(t,()=>repository.close());
  await replaceControl(f.state,c=>{c.versionHighWater.cache=3;});assert.equal((await repository.readControl()).versionHighWater.cache,3);
  await fs.writeFile(f.state,'{broken');await assert.rejects(repository.getRow({collection:'settings',id:'cacheProbe'}),{code:'control_state_invalid'});
});
test('post-commit reporting failures expose committed state rather than claiming rollback',async t=>{
  const f=await fixture(t);f.fail('after');await assert.rejects(f.write('durable'),error=>error.code==='sqlite_post_commit'&&error.committed===true);
  assert.equal((await f.read()).value,'durable');
});
test('the business authority is SQLite and multiline values do not rewrite the marker',async t=>{
  const f=await fixture(t),marker=await fs.readFile(f.marker,'utf8');await f.write('line one\nline two');
  assert.equal(await fs.readFile(f.marker,'utf8'),marker);assert.equal((await f.read()).value,'line one\nline two');
  assert.equal((await fs.readFile(path.join(f.dataDir,'workspace.sqlite'))).subarray(0,16).toString(),'SQLite format 3\0');
});
test('lossy non-JSON values are rejected without changing committed state',async t=>{
  const withExtra=[,'value'];withExtra.extra='not JSON';
  for(const value of [new Date('2026-10-16T00:00:00.000Z'),undefined,NaN,-0,[,'value'],withExtra]){
    const f=await fixture(t);await assert.rejects(f.repository.transaction({select:[{collection:'settings',ids:['invalid']}]},tx=>tx.putRow({collection:'settings',id:'invalid',value:{value}})),{code:'sqlite_invalid_json'});
    assert.equal(await f.repository.getRow({collection:'settings',id:'invalid'}),null);assert.equal((await f.read()).value,'first');
  }
});
test('an external SQL commit cannot be hidden by a previously cached business read',async t=>{
  const f=await fixture(t),other=await openWorkspaceRepository({dataDir:f.dataDir});registerTestResource(t,()=>other.close());await f.read();await f.write('saved');
  await other.transaction({select:[{collection:'settings',ids:['cacheProbe']}]},tx=>tx.putRow({collection:'settings',id:'cacheProbe',value:{value:'other',nested:{items:[1]}}}));
  assert.equal((await f.read()).value,'other');assert.equal((await f.read()).value,'other');
});
test('an external deletion ledger change after COMMIT cannot be hidden by old cached values',async t=>{
  const f=await packageFixture(t),packageId=randomUUID(),recordId=randomUUID();
  await f.repository.mutateWorkspace(w=>{w.packages[packageId]={packageId,kind:'profile',state:'active',enabled:true,versionId:'p@1',versionName:'Synthetic',archiveId:null,archivedAt:null,purgeAt:null};w.profiles.p=[{recordId,ownerPackageId:packageId,revisionId:'p@1',text:'SYNTHETIC BODY'}];});
  const state=path.join(f.dataDir,'control/state.json');let inject=true;
  const repository=await openWorkspaceRepository({dataDir:f.dataDir,faultInjector:phase=>{
    if(inject&&phase==='sqlite.afterCommit'){
      inject=false;const {checksum:ignored,...control}=JSON.parse(syncFs.readFileSync(state,'utf8'));control.deletionLedger[packageId]={phase:'purged',recordIds:[recordId]};
      const checksum=createHash('sha256').update(JSON.stringify(control)).digest('hex');syncFs.writeFileSync(state+'.external',JSON.stringify({...control,checksum}));syncFs.renameSync(state+'.external',state);
    }
  }});registerTestResource(t,()=>repository.close());await repository.transaction({select:[{collection:'settings',ids:['cacheProbe']}]},tx=>tx.putRow({collection:'settings',id:'cacheProbe',value:'saved'}));
  const next=await repository.exportWorkspace();assert.equal(next.packages[packageId],undefined);assert.deepEqual(next.profiles,{});
});
