import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createTempDir, registerTestResource } from '../helpers/fixtures.mjs';
import { openWorkspaceRepository } from '../../src/infrastructure/storage/repository.mjs';
import { createEmptyWorkspace } from '../../src/domain/contracts.mjs';
import { createWorkspaceService } from '../../src/application/workspace-service.mjs';
import { createTrashService } from '../../src/application/trash-service.mjs';
import { createPurgeService } from '../../src/application/purge-service.mjs';
import { createBackup, restoreBackup } from '../../src/infrastructure/storage/backup.mjs';
import { recoverPendingStorageMaintenance } from '../../src/infrastructure/storage/restore-maintenance.mjs';
import { createFakeClock } from '../helpers/clock.mjs';
import { rowKey } from '../../src/infrastructure/storage/sqlite-records.mjs';
import { createWorkspaceOperationGate } from '../../src/application/workspace-operations.mjs';

async function fixture(t,options={}){
  const dataDir=options.dataDir||await createTempDir(t);
  const repository=await openWorkspaceRepository({dataDir,...options});registerTestResource(t,()=>repository.close());
  const trash=createTrashService({repository}),purge=createPurgeService({repository,trash});trash.setPurgeService(purge);
  const service=createWorkspaceService({repository,trashService:trash});return {dataDir,repository,trash,purge,service};
}
const profileInput=(name='合成资料',extra={})=>({text:'合成离线资料，记录本科工程学习与安全检查项目经验，用于仓储回归测试。',profile:{education:'本科'},versionName:name,...extra});
const targetInput=p=>({versionName:'合成目标',profileRevisionId:p.revisionId,roles:['消防'],cityMode:'any',cities:[],jobTypes:['campus'],sourceIds:['synthetic'],siteIds:[],budgets:{}});

for(const boundary of ['control-prepared','file-written','sql-published','control-complete'])test('owned snapshot resumes after '+boundary+' using only bounded rows',async t=>{
  let armed=false;
  const f=await fixture(t,{faultInjector(stage){if(armed&&stage==='snapshot.'+boundary){armed=false;throw Object.assign(Error('synthetic snapshot interruption'),{code:'snapshot_test_interruption'});}}});
  const p=await f.service.saveProfile(profileInput()),target=await f.service.saveTarget(targetInput(p));
  const scope={packageId:target.packageId,targetRevisionId:target.revisionId},id='bounded-snapshot',recordId=randomUUID();
  await f.repository.transaction({select:[{collection:'runs',ids:[id],ownerPackageId:scope.packageId}]},tx=>{
    tx.putRow({collection:'runs',id,ownerPackageId:scope.packageId,value:{runId:id,recordId,ownerPackageId:scope.packageId,targetRevisionId:scope.targetRevisionId,status:'completed'}});
  },{scope});
  const snapshot={run:{runId:id,recordId,ownerPackageId:scope.packageId,status:'completed'},jobs:[],evaluations:[],events:[]};
  armed=true;
  await assert.rejects(createWorkspaceOperationGate({repository:f.repository}).withOperation('import',{scope},operationLease=>
    f.repository.writeOwnedRunSnapshot(id,snapshot,{scope,operationLease})),{code:'snapshot_test_interruption'});
  const prepared=await f.repository.readControl(),identity=prepared.identityIndex.record;
  await f.repository.close();
  const repository=await openWorkspaceRepository({dataDir:f.dataDir});registerTestResource(t,()=>repository.close());
  repository.metrics({reset:true});
  const ref=await createWorkspaceOperationGate({repository}).withOperation('import',{scope},operationLease=>repository.writeOwnedRunSnapshot(id,snapshot,{scope,operationLease}));
  const saved=await repository.readRunSnapshot(id,{scope});
  assert.equal(saved.run.runId,id);assert.equal(typeof ref.hash,'string');
  assert.equal(JSON.stringify((await repository.readControl()).identityIndex.record)===JSON.stringify(identity),true);
  assert.equal((await repository.readControl()).migrationJournal.runSnapshots[id].phase,'complete');
  const metrics=repository.metrics();assert.equal(metrics.maintenanceReads,0);assert.equal(metrics.maintenanceExports,0);assert.equal(metrics.maintenanceMutations,0);assert.equal(metrics.maintenanceImports,0);
});

test('formal versions, empty scope checks, and small writes never export the workspace',async t=>{
  const f=await fixture(t),p=await f.service.saveProfile(profileInput()),target=await f.service.saveTarget(targetInput(p));
  const scope={packageId:target.packageId,targetRevisionId:target.revisionId};
  f.repository.metrics({reset:true});
  const read=await f.service.getTargetRevision(target.revisionId);read.profileSnapshot.text='caller-mutated';
  assert.notEqual((await f.service.getTargetRevision(target.revisionId)).profileSnapshot.text,'caller-mutated');
  await f.repository.transaction({select:[{collection:'settings',ids:['budgets']}]},tx=>tx.putRow({collection:'settings',id:'budgets',value:{maxCostCny:10}}),{scope});
  const m=f.repository.metrics();assert.equal(m.maintenanceExports,0);assert.equal(m.maintenanceImports,0);assert.equal(m.maintenanceMutations,0);assert.equal(m.maintenanceReads,0);
  assert.ok(m.serializedBytes<1000);
  await assert.rejects(f.repository.queryRows({collection:'jobs',ownerPackageId:target.packageId,ids:[]},{scope:{...scope,targetRevisionId:'other'}}),{code:'package_scope_mismatch'});
  await assert.rejects(f.repository.transaction({select:[]},async tx=>{await Promise.resolve();tx.setMeta('invalid',1);}),{code:'sqlite_async_transaction'});
  assert.equal((await f.repository.getRow({collection:'settings',id:'budgets'})).maxCostCny,10);
});

test('control revocation fences cached readers and stale writers in another connection',async t=>{
  const f=await fixture(t),p=await f.service.saveProfile(profileInput()),target=await f.service.saveTarget(targetInput(p));
  const second=await openWorkspaceRepository({dataDir:f.dataDir});registerTestResource(t,()=>second.close());
  const scope={packageId:target.packageId,targetRevisionId:target.revisionId};
  await f.repository.queryRows({collection:'jobs',ownerPackageId:target.packageId,ids:[]},{scope});
  await second.withWriteFence(async fence=>{
    const c=fence.control;c.deletionLedger[target.packageId]={phase:'purge_pending',recordIds:[target.recordId,target.profileSnapshot.recordId],archiveId:randomUUID(),archivedAt:'2026-10-01T00:00:00.000Z',purgeAt:'2026-10-04T00:00:00.000Z',operationId:randomUUID()};await fence.commitControl(c);
  },{operationMaintenance:true});
  await assert.rejects(f.repository.queryRows({collection:'jobs',ownerPackageId:target.packageId,ids:[]},{scope}),{code:'package_purge_pending'});
  await assert.rejects(f.repository.transaction({select:[{collection:'settings',ids:['budgets']}]},tx=>tx.putRow({collection:'settings',id:'budgets',value:{maxCostCny:1}}),{scope}),{code:'package_purge_pending'});
  let late;
  await f.repository.withWriteFence(fence=>{late=()=>fence.transaction({select:[]},()=>{});},{operationMaintenance:true});
  assert.throws(late,{code:'workspace_fence_closed'});
});

test('nested and concurrent inherited fences cannot overwrite monotonic control',async t=>{
  const f=await fixture(t);
  await f.repository.withWriteFence(async fence=>{
    const a=fence.control,b=fence.control;a.versionHighWater['target:a']=7;b.versionHighWater['target:b']=8;
    const first=fence.commitControl(a);
    await assert.rejects(f.repository.withWriteFence(()=>{}),{code:'workspace_fence_nested'});
    assert.throws(()=>fence.transaction({select:[]},()=>{}),{code:'workspace_fence_busy'});
    assert.throws(()=>fence.commitControl(b),{code:'workspace_fence_busy'});
    await first;
    const latest=fence.control;latest.versionHighWater['target:b']=8;await fence.commitControl(latest);
  },{operationMaintenance:true});
  const control=await f.repository.readControl();assert.equal(control.versionHighWater['target:a'],7);assert.equal(control.versionHighWater['target:b'],8);
});

test('a real child with cached control observes revocation before returning an empty private page',async t=>{
  const f=await fixture(t),p=await f.service.saveProfile(profileInput()),target=await f.service.saveTarget(targetInput(p));
  const child=fork(new URL('../helpers/workspace-control-process.mjs',import.meta.url),[f.dataDir,target.packageId,target.revisionId],
    {stdio:['ignore','ignore','ignore','ipc'],execArgv:['--import',new URL('../helpers/network-guard.mjs',import.meta.url).href],env:{...process.env,RJR_DISABLE_LOCAL_CREDENTIALS:'1'}});
  registerTestResource(t,()=>child.kill());assert.equal((await once(child,'message'))[0].ready,true);
  await f.repository.withWriteFence(async fence=>{
    const c=fence.control;c.deletionLedger[target.packageId]={phase:'purge_pending',recordIds:[target.recordId],archiveId:randomUUID(),archivedAt:'2026-10-01T00:00:00.000Z',purgeAt:'2026-10-04T00:00:00.000Z',operationId:randomUUID()};await fence.commitControl(c);
  },{operationMaintenance:true});
  const result=once(child,'message'),exited=once(child,'exit');child.send('probe');assert.equal((await result)[0].code,'package_purge_pending');await exited;
});

test('ordinary WAL reads do not wait for another connection workspace writer fence',async t=>{
  const f=await fixture(t),other=await openWorkspaceRepository({dataDir:f.dataDir});registerTestResource(t,()=>other.close());
  await f.repository.withWriteFence(async()=>{
    assert.equal(await other.getMeta('schemaVersion'),3);
    assert.deepEqual(await other.getRow({collection:'settings',id:'budgets'}),{});
  });
});

test('72h cache bodies cannot escape through the trash list or metadata queries',async t=>{
  const clock=createFakeClock('2026-10-09T00:00:00.000Z'),f=await fixture(t,{clock}),p=await f.service.saveProfile(profileInput()),target=await f.service.saveTarget(targetInput(p));
  const cacheId=rowKey(target.packageId,'collectionCache','synthetic');
  await f.repository.transaction({select:[{collection:'conditionalCache',ownerPackageId:target.packageId,ids:[cacheId]}]},tx=>{
    tx.putRow({collection:'conditionalCache',id:cacheId,ownerPackageId:target.packageId,parent:{collection:'packages',id:target.packageId,path:'collectionCache'},value:{parsedEvidence:{description:'SYNTHETIC-CACHED-PRIVATE-BODY'}}});
  });
  await f.trash.archive({packageId:target.packageId});clock.advance(72*3600000);f.repository.metrics({reset:true});
  const list=await f.trash.list(),metadata=await f.repository.queryRows({collection:'packages'});
  assert.doesNotMatch(JSON.stringify({list,metadata}),/SYNTHETIC-CACHED-PRIVATE-BODY|collectionCache|sessionRefs|profileSnapshot/);
  assert.equal(list[0].canReadBody,false);await assert.rejects(f.trash.get(target.packageId),{code:'package_expired'});
  assert.equal(f.repository.metrics().maintenanceExports,0);
});

const migrationPhases=['control-preparing','control-prepared','archive-written','control-archived','snapshots-written','sql-imported','control-imported','legacy-marked','control-marked','legacy-consumed','control-complete'];
for(const phase of migrationPhases)test('migration resumes after durable boundary '+phase,async t=>{
  const dataDir=await createTempDir(t),source=createEmptyWorkspace({schemaVersion:2});
  source.profiles.synthetic=[{profileId:'synthetic',revision:1,revisionId:'synthetic@1',text:'SYNTHETIC-MIGRATION-CONTENT',profile:{education:'本科'}}];
  const raw=JSON.stringify(source);await fs.writeFile(path.join(dataDir,'workspace.v2.json'),raw);
  let injected=false;
  await assert.rejects(openWorkspaceRepository({dataDir,faultInjector:point=>{if(!injected&&point==='migration.'+phase){injected=true;throw Error('injected durable boundary');}}}),/injected durable boundary/);
  assert.equal(injected,true);
  const repository=await openWorkspaceRepository({dataDir});registerTestResource(t,()=>repository.close());
  const w=await repository.exportWorkspace();assert.equal(w.schemaVersion,3);assert.equal(w.profiles.synthetic[0].text,'SYNTHETIC-MIGRATION-CONTENT');
  const marker=JSON.parse(await fs.readFile(path.join(dataDir,'workspace.v2.json'),'utf8'));assert.equal(marker.format,'resume-job-radar/sqlite-migrated');
  assert.equal((await repository.readControl()).migrationJournal.sqlite.phase,'complete');
});

test('migration refuses live legacy work and preserves corrupt or future source bytes',async t=>{
  for(const kind of ['live','corrupt','future']){
    const dataDir=await createTempDir(t),source=createEmptyWorkspace({schemaVersion:2});
    if(kind==='live')source.operationLeases={old:{operationId:'old',kind:'collect',token:'old',ownerPid:process.pid}};
    const raw=kind==='corrupt'?'{broken':kind==='future'?JSON.stringify({schemaVersion:99}):JSON.stringify(source);
    await fs.writeFile(path.join(dataDir,'workspace.v2.json'),raw);await assert.rejects(openWorkspaceRepository({dataDir}));
    assert.equal(await fs.readFile(path.join(dataDir,'workspace.v2.json'),'utf8'),raw);
    await assert.rejects(fs.stat(path.join(dataDir,'control','initialized.json')),{code:'ENOENT'});
  }
});

test('the immutable c4 JSON reader, including its warm cache, rejects the migration marker without previous fallback',async t=>{
  const dataDir=await createTempDir(t),moduleDir=await createTempDir(t);
  const storage=path.resolve('src/infrastructure/storage');
  // Immutable source: c4d9515c7cfe3081d4602a905950e105e69a9256:
  // src/infrastructure/storage/repository.mjs (Git blob 94bca82c0675c5ba1921056fbde15115787174f9).
  // A text fixture keeps this offline test independent of Git and clone depth.
  const legacyBytes=await fs.readFile(new URL('../fixtures/legacy-repository/c4d9515-repository.mjs.txt',import.meta.url));
  assert.equal(createHash('sha256').update(legacyBytes).digest('hex'),'8065f147fec41e88b145c8e3e11fb6ebb008b72d4ec5e6ec4370cc18d0339d82');
  let source=legacyBytes.toString('utf8');
  source=source.replace(/from\s+(["'])(\.[^"']+)\1/g,(_match,quote,specifier)=>'from '+quote+pathToFileURL(path.resolve(storage,specifier)).href+quote);
  const filename=path.join(moduleDir,'c4-repository.mjs');await fs.writeFile(filename,source);
  const {openWorkspaceRepository:openOld}=await import(pathToFileURL(filename).href);
  const old=await openOld({dataDir,allowLegacy:true});
  await old.mutateWorkspace(w=>{w.recoveryRecords.push({message:'SYNTHETIC-OLD-1'});});
  await old.mutateWorkspace(w=>{w.recoveryRecords.push({message:'SYNTHETIC-OLD-2'});});
  await old.read();const previous=await fs.readFile(path.join(dataDir,'workspace.v2.previous.json'),'utf8');
  const repository=await openWorkspaceRepository({dataDir});registerTestResource(t,()=>repository.close());
  const marker=await fs.readFile(path.join(dataDir,'workspace.v2.json'),'utf8');
  await assert.rejects(old.read(),/schema|format|upgrade/i);
  await assert.rejects(old.mutateWorkspace(w=>{w.recoveryRecords.push({message:'MUST-NOT-WRITE'});}),/schema|format|upgrade/i);
  await assert.rejects(openOld({dataDir,allowLegacy:true}),/schema|format|upgrade/i);
  assert.equal(await fs.readFile(path.join(dataDir,'workspace.v2.json'),'utf8'),marker);
  assert.equal(await fs.readFile(path.join(dataDir,'workspace.v2.previous.json'),'utf8'),previous);
});

test('purge normalizes and sanitizes the retained schema2 previous copy with durable legacy identities',async t=>{
  const dataDir=await createTempDir(t),old=createEmptyWorkspace({schemaVersion:2});
  old.jobs.old={jobId:'old',kind:'job',canonical:{title:'合成历史岗位',sourceId:'synthetic',description:'PREVIOUS-LEGACY-PRIVATE-BODY'}};
  await fs.writeFile(path.join(dataDir,'workspace.v2.previous.json'),JSON.stringify({...old,revision:1}));
  await fs.writeFile(path.join(dataDir,'workspace.v2.json'),JSON.stringify({...old,revision:2}));
  const f=await fixture(t,{dataDir}),marker=await fs.readFile(path.join(dataDir,'workspace.v2.json'),'utf8');
  const pkg=(await f.repository.queryRows({collection:'packages',where:{kind:'legacy_unassigned'},limit:2})).rows[0].value;
  await f.trash.archive({packageId:pkg.packageId});
  const result=await f.purge.execute(await f.trash.preview({emptyAll:true}));assert.deepEqual(result.pending,[]);assert.deepEqual(result.completed,[pkg.packageId]);
  const previous=await fs.readFile(path.join(dataDir,'workspace.v2.previous.json'),'utf8');
  assert.equal(JSON.parse(previous).schemaVersion,3);assert.equal(previous.includes('PREVIOUS-LEGACY-PRIVATE-BODY'),false);
  assert.equal(await fs.readFile(path.join(dataDir,'workspace.v2.json'),'utf8'),marker);
  for(const filename of await fs.readdir(path.join(dataDir,'backups')))assert.equal((await fs.readFile(path.join(dataDir,'backups',filename),'utf8')).includes('PREVIOUS-LEGACY-PRIVATE-BODY'),false);
});

test('real checkpoint busy keeps purge pending and the name reserved until files and SQLite finish',async t=>{
  const f=await fixture(t),p=await f.service.saveProfile(profileInput('物理清理名称'));
  await f.trash.archive({packageId:p.packageId});
  const reader=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'));reader.exec('BEGIN');reader.prepare('SELECT count(*) FROM rows').get();
  try{
    const result=await f.purge.execute(await f.trash.preview({packageIds:[p.packageId]}));assert.deepEqual(result.pending,[p.packageId]);
    assert.equal((await f.purge.getStatus(result.failed[0].operationId)).code,'purge_sqlite_busy');
    await assert.rejects(f.service.saveProfile(profileInput('物理清理名称')),{code:'version_name_conflict'});
  }finally{reader.exec('ROLLBACK');reader.close();}
  assert.deepEqual((await f.purge.resumePending()).completed,[p.packageId]);
  await f.service.saveProfile(profileInput('物理清理名称'));
});

const restorePhases=['source-written','control-preparing','control-prepared','plan-written','control-files','snapshots-written','control-files-ready','sql-published','control-published','plan-cleaned','control-complete'];
for(const phase of restorePhases)test('restore resumes after durable boundary '+phase+' without lowering high water',async t=>{
  const f=await fixture(t),p=await f.service.saveProfile(profileInput('第一版',{profileId:'stable'}));
  const backup=await createBackup({repository:f.repository});
  await f.service.saveProfile(profileInput('第二版',{profileId:'stable'}));
  let injected=false;
  await assert.rejects(restoreBackup({repository:f.repository,archivePath:backup.path,faultInjector:point=>{if(!injected&&point==='restore.'+phase){injected=true;throw Error('injected restore boundary');}}}),/injected restore boundary/);
  assert.equal(injected,true);
  if(phase==='source-written')await restoreBackup({repository:f.repository,archivePath:backup.path});
  else await recoverPendingStorageMaintenance({repository:f.repository});
  const restored=await f.repository.exportWorkspace();assert.equal(restored.profiles.stable.length,1);assert.equal(restored.profiles.stable[0].revisionId,p.revisionId);
  assert.equal((await f.service.saveProfile(profileInput('第三版',{profileId:'stable'}))).revision,3);
});
