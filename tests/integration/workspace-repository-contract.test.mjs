import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTempDir,registerTestResource } from '../helpers/fixtures.mjs';
import { openWorkspaceRepository } from '../../src/infrastructure/storage/repository.mjs';
import { openSqliteRowStore } from '../../src/infrastructure/storage/sqlite-store.mjs';
import { createWorkspaceService } from '../../src/application/workspace-service.mjs';
import { createWorkspaceOperationGate } from '../../src/application/workspace-operations.mjs';
import { canonicalContentHash } from '../../src/infrastructure/storage/content-hash.mjs';
import { JOB_READ_MODEL_VERSION } from '../../src/domain/job-read-model.mjs';
import { rowKey } from '../../src/infrastructure/storage/sqlite-records.mjs';

async function fixture(t){
  const dataDir=await createTempDir(t),repository=await openWorkspaceRepository({dataDir});registerTestResource(t,()=>repository.close());
  const service=createWorkspaceService({repository}),p=await service.saveProfile({versionName:'离线资料',text:'合成离线资料，包含本科毕业和工程项目开发维护经验，并记录明确的安全检查与交付流程。',profile:{}});
  const target=await service.saveTarget({versionName:'离线目标',profileRevisionId:p.revisionId,roles:['工程'],cityMode:'any',cities:[],jobTypes:['social'],sourceIds:['synthetic'],siteIds:[],budgets:{}});
  return {dataDir,repository,scope:{packageId:target.packageId,targetRevisionId:target.revisionId}};
}
async function seedJob(f){
  const {repository,scope}=f;
  await repository.transaction({select:[{collection:'jobs',ids:['legacy-fact'],ownerPackageId:scope.packageId}]},tx=>tx.putRow({collection:'jobs',id:'legacy-fact',ownerPackageId:scope.packageId,value:{jobId:'legacy-fact',recordId:randomUUID(),ownerPackageId:scope.packageId,kind:'job',canonical:{title:'合成工程岗位',sourceId:'synthetic',url:'https://synthetic.invalid/job',description:'合成事实正文，负责工程维护及开发工作，要求本科毕业并熟悉项目交付流程。'},firstSeen:'2026-10-01T00:00:00.000Z',lastSeen:'2026-10-01T00:00:00.000Z'}}),{scope});
  await repository.rebuildReadModels();
}

for(const boundary of ['control-prepared','sql-published','control-complete'])test('fixed generation migration resumes at '+boundary+' without rewriting business facts',async t=>{
  const f=await fixture(t);await seedJob(f);
  const business=await f.repository.exportWorkspace();delete business.revision;
  await f.repository.close();
  const old=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'));
  old.prepare("UPDATE store_meta SET value='1' WHERE key='jobReadModelVersion'").run();
  old.prepare("UPDATE rows SET value=json_set(value,'$.version',1) WHERE collection='jobProjections'").run();
  old.close();
  let armed=true;
  await assert.rejects(openWorkspaceRepository({dataDir:f.dataDir,faultInjector(stage){if(armed&&stage==='read-model.'+boundary){armed=false;throw Object.assign(Error('synthetic generation interruption'),{code:'synthetic_generation_interruption'});}}}),{code:'synthetic_generation_interruption'});
  const repository=await openWorkspaceRepository({dataDir:f.dataDir});registerTestResource(t,()=>repository.close());
  const after=await repository.exportWorkspace();delete after.revision;
  assert.equal(canonicalContentHash(after)===canonicalContentHash(business),true);
  assert.equal(await repository.getMeta('jobReadModelVersion'),JOB_READ_MODEL_VERSION);
  assert.equal((await repository.readControl()).migrationJournal.readModels.phase,'complete');
  const raw=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'));registerTestResource(t,()=>raw.close());
  assert.throws(()=>raw.prepare("UPDATE rows SET value=json_set(value,'$.version',1) WHERE collection='jobProjections'").run(),/generation constraint/);
});

test('future or invalid derived generations preserve the database and refuse open',async t=>{
  for(const [key,value] of [['jobReadModelVersion',99],['collectionProjectionVersion',99],['jobReadModelVersion',0],['collectionProjectionVersion','invalid']])await t.test(key+' '+typeof value,async child=>{
    const f=await fixture(child);await seedJob(f);await f.repository.close();
    const filename=path.join(f.dataDir,'workspace.sqlite'),raw=new DatabaseSync(filename);
    raw.prepare('UPDATE store_meta SET value=? WHERE key=?').run(JSON.stringify(value),key);
    const before=raw.prepare('SELECT collection,id,value FROM rows ORDER BY collection,id').all();raw.close();
    const marker=await fs.readFile(path.join(f.dataDir,'workspace.v2.json'),'utf8');
    await assert.rejects(openWorkspaceRepository({dataDir:f.dataDir}),{code:'read_model_version_unsupported'});
    const after=new DatabaseSync(filename);try{
      assert.equal(JSON.parse(after.prepare('SELECT value FROM store_meta WHERE key=?').get(key).value),value);
      assert.deepEqual(after.prepare('SELECT collection,id,value FROM rows ORDER BY collection,id').all(),before);
    }finally{after.close();}
    assert.equal(await fs.readFile(path.join(f.dataDir,'workspace.v2.json'),'utf8'),marker);
  });
});

test('explicit rebuild refuses a live operation and job head ignores bookkeeping while tracking facts and replacement',async t=>{
  const f=await fixture(t),owner={ownerPackageId:f.scope.packageId};
  const first=(await f.repository.readJobHead(owner,{scope:f.scope})).head;
  await f.repository.transaction({select:[{collection:'settings',ids:['budgets']}]},tx=>tx.putRow({collection:'settings',id:'budgets',value:{maxDetails:3}}));
  assert.equal((await f.repository.readJobHead(owner,{scope:f.scope})).head,first);
  const lease=await createWorkspaceOperationGate({repository:f.repository}).acquire('import',{scope:f.scope});
  try{await assert.rejects(f.repository.rebuildReadModels(),{code:'workspace_migration_busy'});}finally{await lease.release();}
  assert.equal((await f.repository.readJobHead(owner,{scope:f.scope})).head,first);
  await seedJob(f);
  const changed=(await f.repository.readJobHead(owner,{scope:f.scope})).head;assert.ok(changed>first);
  await f.repository.replaceWorkspace(await f.repository.exportWorkspace());
  assert.ok((await f.repository.readJobHead(owner,{scope:f.scope})).head>changed);
  await assert.rejects(f.repository.queryCollectionSnapshot({scope:{...f.scope,targetRevisionId:'wrong'},afterSeq:0}),{code:'package_scope_mismatch'});
  await assert.rejects(f.repository.queryRunHeads({scope:{...f.scope,targetRevisionId:'wrong'}}),{code:'package_scope_mismatch'});
});

test('empty fixed parts register in the declared transaction and roll back together',async t=>{
  const f=await fixture(t),id='empty-parts',run={runId:id,recordId:randomUUID(),ownerPackageId:f.scope.packageId,status:'completed'};
  const selection={select:[{collection:'runs',ids:[id],ownerPackageId:f.scope.packageId}]};
  await assert.rejects(f.repository.transaction(selection,tx=>{tx.putRow({collection:'runs',id,ownerPackageId:f.scope.packageId,value:run});tx.ensurePart({collection:'runs',id,path:'events'});throw Error('synthetic rollback');},{scope:f.scope}),/synthetic rollback/);
  assert.equal(await f.repository.getRow({collection:'runs',id,ownerPackageId:f.scope.packageId},{scope:f.scope}),null);
  await f.repository.transaction(selection,tx=>{tx.putRow({collection:'runs',id,ownerPackageId:f.scope.packageId,value:run});for(const field of ['events','coverage','issues','evaluationIds','jobIds'])tx.ensurePart({collection:'runs',id,path:field});assert.throws(()=>tx.ensurePart({collection:'runs',id,path:'unknown'}),{code:'sqlite_part_invalid'});},{scope:f.scope});
  const out=await f.repository.exportWorkspace();for(const field of ['events','coverage','issues','evaluationIds','jobIds'])assert.deepEqual(out.runs[id][field],[]);
  await seedJob(f);
  await f.repository.transaction({select:[{collection:'runs',ids:[id],ownerPackageId:f.scope.packageId},{collection:'activityJobIds',ids:[rowKey(id,'jobIds','0')],ownerPackageId:f.scope.packageId}]},tx=>tx.putRow({collection:'activityJobIds',id:rowKey(id,'jobIds','0'),ownerPackageId:f.scope.packageId,parent:{collection:'runs',id,path:'jobIds'},ordinal:0,value:'legacy-fact'}),{scope:f.scope});
  assert.equal((await f.repository.queryRows({collection:'activityJobIds',ownerPackageId:f.scope.packageId,where:{parentId:id,path:'jobIds',jobId:'legacy-fact'},limit:1},{scope:f.scope})).rows.length,1);
});

test('prepared statements have bounded retained memory and closing releases SQLite files',async t=>{
  const dataDir=await createTempDir(t),filename=path.join(dataDir,'workspace.sqlite'),store=openSqliteRowStore({filename});registerTestResource(t,()=>store.close());
  const heapBefore=process.memoryUsage().heapUsed;
  for(let n=1;n<=600;n++)store.queryRows({collection:'settings',ids:Array.from({length:n},(_,i)=>'missing-'+i),total:false});
  const metrics=store.metrics();assert.ok(metrics.prepares>256);assert.ok(metrics.cachedStatements<=256);assert.equal(metrics.statementCacheLimit,256);assert.ok(metrics.statementCacheHits>0);
  assert.ok(process.memoryUsage().heapUsed-heapBefore<64*1024*1024);
  store.close();assert.equal(store.metrics().cachedStatements,0);
  const renamed=path.join(dataDir,'closed.sqlite');await fs.rename(filename,renamed);await fs.unlink(renamed);
});
