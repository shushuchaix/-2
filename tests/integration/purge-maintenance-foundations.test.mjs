import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { packageBusinessFixture } from '../helpers/package-business-fixture.mjs';
import { registerTestResource, createTempDir, job } from '../helpers/fixtures.mjs';
import { createPurgeService } from '../../src/application/purge-service.mjs';
import { createWorkspaceOperationGate } from '../../src/application/workspace-operations.mjs';
import { openWorkspaceRepository, openExistingMaintenanceRepository } from '../../src/infrastructure/storage/repository.mjs';
import { openPackageControl } from '../../src/infrastructure/storage/package-control.mjs';
import { prepareAtomicJsonText, preparedAtomicMetadata, publishPreparedAtomicJsonText,
  discardPreparedAtomicJsonText, writeAtomicJsonText } from '../../src/infrastructure/storage/atomic.mjs';

const boundary='synthetic_prepare_complete';
const isPurgeError=error=>Boolean(error?.code?.startsWith('purge_'));
async function fixture(t){
  const f=await packageBusinessFixture(t);Object.assign(f,await f.twoTargets());
  await fs.mkdir(path.join(f.dataDir,'backups'),{recursive:true});
  await fs.mkdir(path.join(f.dataDir,'runs-v2'),{recursive:true});
  await f.ingest(f.a,[job({sourceRecordId:'selected'})]);
  await f.ingest(f.b,[job({sourceRecordId:'peer',title:'合成机场维护岗'})]);
  await f.trash.archive({packageId:f.a.packageId});f.clock.advance(72*3600*1000);
  const preview=await f.trash.preview({expiredOnly:true}),purge=createPurgeService({repository:f.repository,trash:f.trash,fsAdapter:f.fsAdapter}),
    original=f.repository.exportWorkspace;
  f.repository.exportWorkspace=async()=>{throw Object.assign(Error('Synthetic public prepare boundary'),{code:boundary});};
  try{await assert.rejects(purge.execute(preview,{reason:'expired'}),{code:boundary});}
  finally{f.repository.exportWorkspace=original;}
  const control=await f.repository.readControl();f.taskId=control.deletionLedger[f.a.packageId].operationId;
  f.originalLedger=structuredClone(control.deletionLedger[f.a.packageId]);f.workspaceId=control.workspaceId;
  f.claim=async()=>f.repository.claimPurgeDispatch({taskId:f.taskId});
  f.worker=async(options={})=>{
    const claim=options.descriptor?{descriptor:options.descriptor}:await f.claim();
    const worker=await openExistingMaintenanceRepository({dataDir:f.dataDir,workspaceId:f.workspaceId,descriptor:claim.descriptor,
      fsAdapter:f.fsAdapter,clock:f.clock,...options});
    registerTestResource(t,()=>worker.close());return {worker,descriptor:claim.descriptor};
  };
  return f;
}
function raw(f,action,{write=false}={}){
  const db=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'),{readOnly:!write,enableDoubleQuotedStringLiterals:false});
  try{return action(db);}finally{db.close();}
}
const leaseRow=(f,id)=>raw(f,db=>db.prepare("SELECT value FROM rows WHERE collection='operationLeases' AND id=?").get(id)?.value??null);
const journal=f=>raw(f,db=>{const row=db.prepare("SELECT value FROM store_meta WHERE key='purgeWorkerJournal'").get();return row?JSON.parse(row.value):null;});
const businessRows=f=>raw(f,db=>db.prepare("SELECT collection,id,owner_id,value FROM rows WHERE collection<>'operationLeases' ORDER BY collection,id").all());
const closedHost=descriptor=>({descriptor,state:'exited',childRegistered:true,exitObserved:true,spawnFailed:false,
  cleanupSettled:true,workerPid:process.pid,code:'purge_worker_stopped'});
const failedHost=descriptor=>({descriptor,state:'spawn_failed',childRegistered:false,exitObserved:false,spawnFailed:true,
  cleanupSettled:true,workerPid:null,code:'purge_boot_failed'});

// Foundation tests use a real SQLite claim owned by the executing PID. They do
// not claim a second process or real process-host exit: host snapshots below are
// explicit synthetic input at the internal coordinator boundary. Actual PID,
// IPC, cleanup and shutdown proof belongs to the later 2A-2 integration batch.
test('maintenance open uses existing files without initialization and withholds body access before claim',async t=>{
  const f=await fixture(t),{descriptor}=await f.claim(),markers=await Promise.all(['workspace.v2.json','control/state.json','control/initialized.json'].map(name=>fs.readFile(path.join(f.dataDir,name))));
  let mkdirs=0;
  const adapter={...f.fsAdapter,async mkdir(){mkdirs++;throw Error('Maintenance must not initialize a directory');}};
  const {worker}=await f.worker({descriptor,fsAdapter:adapter});
  assert.equal(mkdirs,0);assert.equal(worker.migration.existingOnly,true);assert.equal(worker.transaction,undefined);
  await assert.rejects(worker.exportWorkspace(),isPurgeError);
  for(const [index,name]of ['workspace.v2.json','control/state.json','control/initialized.json'].entries())assert.deepEqual(await fs.readFile(path.join(f.dataDir,name)),markers[index]);
  const pragmas=worker.pragmas();assert.equal(pragmas.synchronous,2);assert.equal(pragmas.foreign_keys,1);assert.equal(pragmas.secure_delete,1);
});

for(const missing of ['workspace.sqlite','workspace.v2.json','control/state.json','control/initialized.json','backups','runs-v2'])
  test('maintenance open rejects missing '+missing+' before creating business files',async t=>{
    const f=await fixture(t),{descriptor}=await f.claim();await f.repository.close();
    const location=path.join(f.dataDir,missing),retained=location+'.synthetic-retained';await fs.rename(location,retained);
    let mkdirs=0;const adapter={...f.fsAdapter,async mkdir(){mkdirs++;throw Error('Unexpected initialization');}};
    await assert.rejects(openExistingMaintenanceRepository({dataDir:f.dataDir,workspaceId:f.workspaceId,descriptor,fsAdapter:adapter,clock:f.clock}),isPurgeError);
    assert.equal(mkdirs,0);await assert.rejects(fs.stat(location),{code:'ENOENT'});assert.ok(await fs.stat(retained));
  });

test('maintenance open rejects bad checksum and unfinished restore without repairing control',async t=>{
  const f=await fixture(t),{descriptor}=await f.claim();await f.repository.close();
  const stateFile=path.join(f.dataDir,'control','state.json'),original=await fs.readFile(stateFile,'utf8'),envelope=JSON.parse(original);
  envelope.checksum='0'.repeat(64);await fs.writeFile(stateFile,JSON.stringify(envelope));const bad=await fs.readFile(stateFile);
  await assert.rejects(openExistingMaintenanceRepository({dataDir:f.dataDir,workspaceId:f.workspaceId,descriptor,clock:f.clock}),isPurgeError);
  assert.deepEqual(await fs.readFile(stateFile),bad);await fs.writeFile(stateFile,original);
  const controlStore=openPackageControl({dataDir:f.dataDir}),control=await controlStore.read(),next=structuredClone(control);
  next.migrationJournal.maintenance={synthetic:{kind:'restore',phase:'prepared'}};await controlStore.commitInLock(next,{previous:control});
  const pending=await fs.readFile(stateFile);
  await assert.rejects(openExistingMaintenanceRepository({dataDir:f.dataDir,workspaceId:f.workspaceId,descriptor,clock:f.clock}),isPurgeError);
  assert.deepEqual(await fs.readFile(stateFile),pending);
});

for(const corrupt of ['schema','derived','table'])test('maintenance open refuses '+corrupt+' drift without upgrade or DDL',async t=>{
  const f=await fixture(t),{descriptor}=await f.claim();await f.repository.close();
  raw(f,db=>{
    if(corrupt==='table')db.exec('CREATE TABLE synthetic_unknown(id TEXT PRIMARY KEY) STRICT');
    else db.prepare('UPDATE store_meta SET value=? WHERE key=?').run(JSON.stringify(corrupt==='schema'?2:-1),corrupt==='schema'?'schemaVersion':'jobReadModelVersion');
  },{write:true});
  const inspect=()=>raw(f,db=>({schema:db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
    meta:db.prepare('SELECT key,value FROM store_meta ORDER BY key').all(),rows:db.prepare('SELECT count(*) AS n FROM rows').get().n}));
  const before=inspect(),marker=await fs.readFile(path.join(f.dataDir,'workspace.v2.json'));
  await assert.rejects(openExistingMaintenanceRepository({dataDir:f.dataDir,workspaceId:f.workspaceId,descriptor,clock:f.clock}),isPurgeError);
  assert.deepEqual(inspect(),before);assert.deepEqual(await fs.readFile(path.join(f.dataDir,'workspace.v2.json')),marker);
});

test('claim lease and SQL journal commit atomically and retry preserves the real PID and token',async t=>{
  const f=await fixture(t);let armed=false;
  const {worker,descriptor}=await f.worker({faultInjector:phase=>{if(armed&&phase==='sqlite.beforePurgeCoordinationCommit'){armed=false;throw Error('synthetic before SQL coordination commit');}}});
  armed=true;await assert.rejects(worker.acquirePurgeClaim(),/synthetic before SQL coordination commit/);
  assert.equal(leaseRow(f,descriptor.leaseOperationId),null);assert.equal(journal(f).state,'dispatch_reserved');
  const lease=await worker.acquirePurgeClaim(),first=leaseRow(f,descriptor.leaseOperationId),again=await worker.acquirePurgeClaim();
  assert.equal(lease.ownerPid,process.pid);assert.equal(lease.kind,'permanent-delete');assert.equal(lease.token,again.token);
  assert.equal(leaseRow(f,descriptor.leaseOperationId),first);assert.equal(journal(f).state,'running');
  assert.equal((await f.repository.readControl()).purgeTasks[f.taskId].worker.workerPid,process.pid);
  await worker.releasePurgeClaim();assert.equal(leaseRow(f,descriptor.leaseOperationId),null);assert.equal(journal(f).state,'release_observed');
});

test('SQL claim survives failed control association and resumes the same generation',async t=>{
  const f=await fixture(t),{worker,descriptor}=await f.worker();f.armFailure('control_commit');
  await assert.rejects(worker.acquirePurgeClaim(),/synthetic storage failure/);
  const first=JSON.parse(leaseRow(f,descriptor.leaseOperationId)),claimed=journal(f);
  assert.equal(claimed.state,'claimed');assert.equal(claimed.leaseToken,first.token);
  const recovered=await worker.acquirePurgeClaim();assert.equal(recovered.token,first.token);assert.equal(journal(f).state,'running');
  assert.equal((await f.claim()).dispatchAllowed,false);assert.deepEqual((await f.claim()).descriptor,descriptor);
  await worker.releasePurgeClaim();
});

test('ordinary recovery, acquire and parent borrow preserve live or unknown purge claims',async t=>{
  const f=await fixture(t),ordinary=await f.operationGate.acquire('backup');
  // A live ordinary lease legitimately prevents a new dispatch. Release it
  // before obtaining the actual maintenance lease.
  await assert.rejects(f.claim(),isPurgeError);await ordinary.release();
  const {worker,descriptor}=await f.worker(),lease=await worker.acquirePurgeClaim(),before=leaseRow(f,descriptor.leaseOperationId),
    gate=createWorkspaceOperationGate({repository:f.repository,isOwnerAlive:()=>{throw Error('synthetic unknown ownership');}});
  assert.equal((await gate.recover()).pending,true);assert.equal(leaseRow(f,descriptor.leaseOperationId),before);
  await assert.rejects(gate.acquire('backup'),{code:'workspace_operation_busy'});
  await assert.rejects(gate.acquire('backup',{parentLease:lease}),{code:'workspace_operation_busy'});
  await assert.rejects(f.repository.transaction({select:[{collection:'operationLeases',ids:[lease.operationId]}]},tx=>tx.deleteRow({collection:'operationLeases',id:lease.operationId}),{operationMaintenance:true}),isPurgeError);
  await assert.rejects(f.repository.transaction({select:[],metaKeys:['purgeWorkerJournal']},tx=>tx.setMeta('purgeWorkerJournal',null),{operationMaintenance:true}),{code:'sqlite_meta_managed'});
  assert.equal(leaseRow(f,descriptor.leaseOperationId),before);await worker.releasePurgeClaim();
});

test('journal-only or claim-only association remains protected from ordinary row writes',async t=>{
  const f=await fixture(t),{worker,descriptor}=await f.worker(),lease=await worker.acquirePurgeClaim();
  const original=leaseRow(f,descriptor.leaseOperationId),value=JSON.parse(original);delete value.purgeClaim;
  raw(f,db=>db.prepare("UPDATE rows SET value=? WHERE collection='operationLeases' AND id=?").run(JSON.stringify(value),descriptor.leaseOperationId),{write:true});
  await assert.rejects(f.repository.transaction({select:[{collection:'operationLeases',ids:[lease.operationId]}]},tx=>tx.deleteRow({collection:'operationLeases',id:lease.operationId}),{operationMaintenance:true}),isPurgeError);
  raw(f,db=>{db.prepare("UPDATE rows SET value=? WHERE collection='operationLeases' AND id=?").run(original,descriptor.leaseOperationId);db.prepare("DELETE FROM store_meta WHERE key='purgeWorkerJournal'").run();},{write:true});
  await assert.rejects(f.repository.transaction({select:[{collection:'operationLeases',ids:[lease.operationId]}]},tx=>tx.deleteRow({collection:'operationLeases',id:lease.operationId}),{operationMaintenance:true}),isPurgeError);
  assert.equal(leaseRow(f,descriptor.leaseOperationId),original);
});

test('opaque publication rejects forgery, another repository and reuse while preserving peer rows and coordination',async t=>{
  const f=await fixture(t),{worker,descriptor}=await f.worker(),lease=await worker.acquirePurgeClaim(),
    peerBefore=businessRows(f).filter(row=>row.owner_id===f.b.packageId),token=await worker.preparePurgeReplacement({stage:'body',operationLease:lease});
  assert.equal(Object.isFrozen(token),true);assert.deepEqual(Object.keys(token),[]);
  await assert.rejects(worker.publishPreparedPurgeReplacement(Object.freeze({})),isPurgeError);
  const other=await f.worker({descriptor});await assert.rejects(other.worker.publishPreparedPurgeReplacement(token),isPurgeError);
  const leaseBefore=leaseRow(f,lease.operationId),result=await worker.publishPreparedPurgeReplacement(token);
  assert.equal(result.publicationReceipt.committedRevision,result.publicationReceipt.baseRevision+1);
  assert.equal(businessRows(f).some(row=>row.owner_id===f.a.packageId),false);
  const peerAfter=businessRows(f).filter(row=>row.owner_id===f.b.packageId),expectedAsOf=new Date(f.clock.now()).toISOString();
  assert.ok(peerBefore.some(row=>row.collection==='jobProjections'),'fixture contains a peer derived projection');
  for(const row of peerBefore.filter(row=>row.collection==='jobProjections'))assert.notEqual(JSON.parse(row.value).asOf,expectedAsOf);
  for(const row of peerAfter.filter(row=>row.collection==='jobProjections'))assert.equal(JSON.parse(row.value).asOf,expectedAsOf,'derived view is rebuilt at the current clock');
  // Only the expected derived asOf changes. Every authoritative row remains
  // byte-for-byte equal; all identity and other derived fields remain present
  // in the full comparison instead of dropping the entire projection.
  const normalized=row=>row.collection==='jobProjections'?
    {...row,value:JSON.stringify({...JSON.parse(row.value),asOf:expectedAsOf})}:row;
  assert.deepEqual(peerAfter.map(normalized),peerBefore.map(normalized));
  assert.equal(leaseRow(f,lease.operationId),leaseBefore);assert.equal(journal(f).state,'running');
  await assert.rejects(worker.publishPreparedPurgeReplacement(token),isPurgeError);await worker.releasePurgeClaim();
});

for(const change of ['control','raw-sql'])test('prepared publication refuses stale '+change+' without replacing business rows',async t=>{
  const f=await fixture(t),{worker}=await f.worker(),lease=await worker.acquirePurgeClaim(),token=await worker.preparePurgeReplacement({stage:'body',operationLease:lease});
  if(change==='control')await f.repository.withWriteFence(async fence=>{const control=fence.control;control.versionHighWater.synthetic=1;await fence.commitControl(control);},{operationMaintenance:true});
  else raw(f,db=>db.prepare('INSERT INTO store_meta(key,value) VALUES (?,?)').run('syntheticExternalCommit','true'),{write:true});
  const before=businessRows(f),revision=await f.repository.getMeta('revision');
  await assert.rejects(worker.publishPreparedPurgeReplacement(token),{code:'purge_state_changed'});
  assert.deepEqual(businessRows(f),before);assert.equal(await f.repository.getMeta('revision'),revision);
  await assert.rejects(worker.publishPreparedPurgeReplacement(token),isPurgeError);await worker.releasePurgeClaim();
});

test('before-commit fault rolls back replacement; post-commit fault retains SQL receipt and cannot replay token',async t=>{
  const f=await fixture(t);let fault=null;
  const {worker}=await f.worker({faultInjector:phase=>{if(phase===fault){fault=null;throw Error('synthetic prepared publication fault');}}}),lease=await worker.acquirePurgeClaim();
  const rejected=await worker.preparePurgeReplacement({stage:'body',operationLease:lease}),before=businessRows(f),firstRevision=await f.repository.getMeta('revision');
  fault='sqlite.beforeCommit';await assert.rejects(worker.publishPreparedPurgeReplacement(rejected),/synthetic prepared publication fault/);
  assert.deepEqual(businessRows(f),before);assert.equal(await f.repository.getMeta('revision'),firstRevision);assert.equal(journal(f).publicationReceipt,null);
  await assert.rejects(worker.publishPreparedPurgeReplacement(rejected),isPurgeError);
  const committed=await worker.preparePurgeReplacement({stage:'body',operationLease:lease});fault='sqlite.afterCommit';
  await assert.rejects(worker.publishPreparedPurgeReplacement(committed),error=>error.code==='sqlite_post_commit'&&error.committed===true);
  const receipt=journal(f).publicationReceipt,revision=await f.repository.getMeta('revision');assert.equal(receipt.committedRevision,revision);
  await assert.rejects(worker.publishPreparedPurgeReplacement(committed),isPurgeError);assert.equal(await f.repository.getMeta('revision'),revision);
  await worker.releasePurgeClaim();assert.deepEqual((await f.repository.readControl()).purgeTasks[f.taskId].sqlPublication,{descriptor:journal(f).descriptor,...receipt});
});

for(const limits of [{sourceRows:1},{packedBytes:1}])test('prepared input limit '+Object.keys(limits)[0]+' rejects without replacing business rows',async t=>{
  const f=await fixture(t),{worker}=await f.worker({limits}),lease=await worker.acquirePurgeClaim(),before=businessRows(f);
  await assert.rejects(worker.preparePurgeReplacement({stage:'body',operationLease:lease}),{code:'purge_input_limit'});
  assert.deepEqual(businessRows(f),before);await worker.releasePurgeClaim();
  assert.equal(journal(f).state,'release_observed');assert.deepEqual((await f.repository.readControl()).deletionLedger[f.a.packageId],f.originalLedger);
});

test('final publication cannot remove the package before existing physical verification authority',async t=>{
  const f=await fixture(t),{worker}=await f.worker(),lease=await worker.acquirePurgeClaim(),before=businessRows(f);
  await assert.rejects(worker.preparePurgeReplacement({stage:'final',operationLease:lease}),isPurgeError);
  assert.deepEqual(businessRows(f),before);await worker.releasePurgeClaim();
});

test('ordinary lease release checks fresh journal association even if its original token is valid',async t=>{
  const f=await fixture(t),ordinary=await f.operationGate.acquire('backup'),before=leaseRow(f,ordinary.operationId),
    descriptor={taskId:f.taskId,packageId:f.a.packageId,generation:1,dispatchId:randomUUID(),leaseOperationId:ordinary.operationId};
  raw(f,db=>db.prepare('INSERT INTO store_meta(key,value) VALUES (?,?)').run('purgeWorkerJournal',JSON.stringify({version:1,descriptor,sequence:1,
    state:'claimed',workerPid:process.pid,leaseToken:ordinary.token,stage:'prepared',publicationReceipt:null})),{write:true});
  await assert.rejects(ordinary.release(),{code:'workspace_operation_busy'});assert.equal(leaseRow(f,ordinary.operationId),before);
  raw(f,db=>db.prepare("DELETE FROM store_meta WHERE key='purgeWorkerJournal'").run(),{write:true});await ordinary.release();
});

test('failed spawn retirement survives each durable boundary and retry observes real cooldown',async t=>{
  const f=await fixture(t);await f.repository.close();let stopAt=null;
  f.repository=await openWorkspaceRepository({dataDir:f.dataDir,clock:f.clock,fsAdapter:f.fsAdapter,faultInjector:phase=>{if(phase===stopAt){stopAt=null;throw Error('synthetic durable boundary');}}});
  const {descriptor}=await f.claim(),status=failedHost(descriptor),ledger=structuredClone((await f.repository.readControl()).deletionLedger[f.a.packageId]);
  stopAt='purge.retire-control-prepared';await assert.rejects(f.repository.retirePurgeDispatch({descriptor,hostStatus:status}),/synthetic durable boundary/);
  assert.equal((await f.repository.readControl()).purgeTasks[f.taskId].worker.retirement.stage,'prepared');assert.equal(journal(f).state,'dispatch_reserved');
  stopAt='purge.retire-sql-retired';await assert.rejects(f.repository.retirePurgeDispatch({descriptor,hostStatus:status}),/synthetic durable boundary/);
  assert.equal(journal(f).state,'retired');assert.equal((await f.repository.readControl()).purgeTasks[f.taskId].worker.retirement.stage,'prepared');
  await f.repository.retirePurgeDispatch({descriptor,hostStatus:status});
  const retired=(await f.repository.readControl()).purgeTasks[f.taskId].worker;
  assert.equal(retired.retirement.stage,'complete');assert.ok(f.clock.now() instanceof Date,'keep the supported Date-valued clock');
  assert.equal(Date.parse(retired.nextRetryAt),Number(f.clock.now())+300000);
  assert.equal((await f.claim()).dispatchAllowed,false);f.clock.advance(300000);
  stopAt='purge.claim-control-prepared';await assert.rejects(f.claim(),/synthetic durable boundary/);
  assert.equal(journal(f).descriptor.generation,1);assert.equal((await f.repository.readControl()).purgeTasks[f.taskId].worker.generation,2);
  const next=await f.claim();assert.equal(next.dispatchAllowed,true);assert.equal(next.descriptor.generation,2);assert.notEqual(next.descriptor.dispatchId,descriptor.dispatchId);
  assert.deepEqual((await f.repository.readControl()).deletionLedger[f.a.packageId],ledger);assert.equal(journal(f).state,'dispatch_reserved');
});

test('release retry retires only after explicit exit and cleanup settlement without completing the business task',async t=>{
  const f=await fixture(t),{worker,descriptor}=await f.worker();await worker.acquirePurgeClaim();await worker.releasePurgeClaim();await worker.close();
  assert.equal(Date.parse((await f.repository.readControl()).purgeTasks[f.taskId].worker.nextRetryAt),Number(f.clock.now())+300000);
  const status=closedHost(descriptor);
  await assert.rejects(f.repository.retirePurgeDispatch({descriptor,hostStatus:{...status,cleanupSettled:false}}),isPurgeError);
  await assert.rejects(f.repository.retirePurgeDispatch({descriptor,hostStatus:{...status,state:'stopping',exitObserved:false}}),isPurgeError);
  await f.repository.retirePurgeDispatch({descriptor,hostStatus:status});
  const task=(await f.repository.readControl()).purgeTasks[f.taskId];assert.equal(task.phase,'prepared');assert.equal(task.worker.state,'retry_wait');assert.equal(task.worker.retirement.stage,'complete');
  assert.deepEqual((await f.repository.readControl()).deletionLedger[f.a.packageId],f.originalLedger);
});

test('strict prepared file refuses a replaced temp between sharing-lock retries and retains uncertain bytes',async t=>{
  const dir=await createTempDir(t),filename=path.join(dir,'managed.json');await fs.writeFile(filename,'{"old":true}');let calls=0,temp;
  const adapter={...fs,async rename(from,to){calls++;if(calls===1)throw Object.assign(Error('synthetic sharing lock'),{code:'EACCES'});return fs.rename(from,to);}};
  const token=await prepareAtomicJsonText(filename,'{"new":true}',{fsAdapter:adapter,platform:'win32',captureFileIdentity:true,requireExistingParent:true,requireFileIdentity:true,
    sleep:async()=>{await fs.rename(temp,temp+'.retained');await fs.writeFile(temp,'{"unexpected":true}');}});
  temp=path.join(dir,preparedAtomicMetadata(token).tempBasename);
  await assert.rejects(publishPreparedAtomicJsonText(token),{code:'atomic_prepared_invalid'});assert.equal(calls,1);
  assert.equal(await fs.readFile(filename,'utf8'),'{"old":true}');assert.equal(await fs.readFile(temp,'utf8'),'{"unexpected":true}');
  const discarded=await discardPreparedAtomicJsonText(token);assert.equal(discarded.retainedUncertain,true);assert.equal(await fs.readFile(temp,'utf8'),'{"unexpected":true}');
});

test('legacy atomic write keeps one synced temp and the fixed bounded rename delays',async t=>{
  const dir=await createTempDir(t),filename=path.join(dir,'ordinary.json');let opens=0,renames=0;const delays=[];
  const adapter={...fs,async open(file,flags){if(flags==='wx')opens++;return fs.open(file,flags);},async rename(from,to){renames++;if(renames<=2)throw Object.assign(Error('synthetic sharing lock'),{code:'EPERM'});return fs.rename(from,to);}};
  await writeAtomicJsonText(filename,'{"saved":true}',{fsAdapter:adapter,platform:'win32',sleep:async ms=>{delays.push(ms);}});
  assert.equal(opens,1);assert.equal(renames,3);assert.deepEqual(delays,[25,50]);assert.equal(await fs.readFile(filename,'utf8'),'{"saved":true}');
  assert.deepEqual(await fs.readdir(dir),['ordinary.json']);
});
// R1: a real stored primary-key/JSON conflict must fail before recovery can
// turn the damaged row A into a deletion of unrelated live B. Liveness is a
// deterministic injected fault model, not a claim of actual worker OS exit.
test('conflicting physical and JSON lease IDs reject recover/acquire/parent before any reconciliation',async t=>{
  const f=await fixture(t),{worker,descriptor}=await f.worker(),lease=await worker.acquirePurgeClaim(),
    other={...lease,operationId:'op-'+randomUUID(),kind:'backup',token:randomUUID(),ownerPid:process.pid,packageIds:[]};
  delete other.acquiredRevision;delete other.release;delete other.purgeClaim;
  await f.repository.transaction({select:[{collection:'operationLeases',ids:[other.operationId]}]},tx=>
    tx.putRow({collection:'operationLeases',id:other.operationId,value:other}),{operationMaintenance:true});
  const damaged=JSON.parse(leaseRow(f,descriptor.leaseOperationId)),syntheticDeadPid=process.pid===1?2:1;
  delete damaged.purgeClaim;damaged.operationId=other.operationId;damaged.ownerPid=syntheticDeadPid;
  raw(f,db=>db.prepare("UPDATE rows SET value=? WHERE collection='operationLeases' AND id=?").run(JSON.stringify(damaged),descriptor.leaseOperationId),{write:true});
  const snapshot=()=>raw(f,db=>({leases:db.prepare("SELECT id,value FROM rows WHERE collection='operationLeases' ORDER BY id").all(),
    revision:db.prepare("SELECT value FROM store_meta WHERE key='revision'").get().value,
    journal:db.prepare("SELECT value FROM store_meta WHERE key='purgeWorkerJournal'").get().value}));
  const before=snapshot(),control=await fs.readFile(path.join(f.dataDir,'control','state.json'));let livenessChecks=0;
  const gate=createWorkspaceOperationGate({repository:f.repository,isOwnerAlive:pid=>{livenessChecks++;return pid!==syntheticDeadPid;}});
  for(const attempt of [()=>gate.recover(),()=>gate.acquire('backup'),()=>gate.acquire('backup',{parentLease:other})]){
    await assert.rejects(attempt(),{code:'purge_claim_conflict'});assert.deepEqual(snapshot(),before);
    assert.deepEqual(await fs.readFile(path.join(f.dataDir,'control','state.json')),control);
  }
  assert.equal(livenessChecks,0,'identity conflict is rejected before any liveness-derived mutation');
});

for(const change of ['conflicting-source','missing'])test('prepared publication refuses '+change+' migration marker with unchanged business and journal',async t=>{
  const f=await fixture(t),{worker}=await f.worker(),lease=await worker.acquirePurgeClaim(),
    token=await worker.preparePurgeReplacement({stage:'body',operationLease:lease}),marker=path.join(f.dataDir,'workspace.v2.json'),
    retained=marker+'.synthetic-retained',original=await fs.readFile(marker);
  await f.repository.withWriteFence(async()=>{
    if(change==='missing')await fs.rename(marker,retained);
    else{const value=JSON.parse(original.toString('utf8'));value.sourceHash=value.sourceHash==='0'.repeat(64)?'1'.repeat(64):'0'.repeat(64);await fs.writeFile(marker,JSON.stringify(value));}
  },{operationMaintenance:true});
  const before=businessRows(f),revision=await f.repository.getMeta('revision'),journalBytes=raw(f,db=>db.prepare("SELECT value FROM store_meta WHERE key='purgeWorkerJournal'").get().value);
  await assert.rejects(worker.publishPreparedPurgeReplacement(token),{code:'purge_existing_store_required'});
  assert.deepEqual(businessRows(f),before);assert.equal(await f.repository.getMeta('revision'),revision);
  assert.equal(raw(f,db=>db.prepare("SELECT value FROM store_meta WHERE key='purgeWorkerJournal'").get().value),journalBytes);
  await assert.rejects(worker.publishPreparedPurgeReplacement(token),isPurgeError);
  if(change==='missing')await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  // Restore only the owned synthetic namespace for normal test cleanup.
  await f.repository.withWriteFence(async()=>{
    if(change==='missing')await fs.rename(retained,marker);else await fs.writeFile(marker,original);
  },{operationMaintenance:true});await worker.releasePurgeClaim();
});
// The original durable-boundary case above retains its Date clock. This small
// complementary case verifies the default numeric-clock contract at the same
// real dispatch/retirement interface, including the exact retry boundary.
test('numeric clock holds failed-spawn cooldown until the exact nextRetryAt',async t=>{
  const f=await fixture(t),dateNow=f.clock.now;f.clock.now=()=>Number(dateNow());
  const {descriptor}=await f.claim();await f.repository.retirePurgeDispatch({descriptor,hostStatus:failedHost(descriptor)});
  const task=(await f.repository.readControl()).purgeTasks[f.taskId];
  assert.equal(typeof f.clock.now(),'number');assert.equal(Date.parse(task.worker.nextRetryAt),f.clock.now()+300000);
  assert.equal((await f.claim()).dispatchAllowed,false);f.clock.advance(299999);assert.equal((await f.claim()).dispatchAllowed,false);
  f.clock.advance(1);const next=await f.claim();assert.equal(next.dispatchAllowed,true);assert.equal(next.descriptor.generation,descriptor.generation+1);
});