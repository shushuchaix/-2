import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openSqliteRowStore } from '../../src/infrastructure/storage/sqlite-store.mjs';
import { createEmptyWorkspace } from '../../src/domain/contracts.mjs';
import { createCollectionRoot } from '../../src/domain/collection.mjs';
import { rowKey } from '../../src/infrastructure/storage/sqlite-records.mjs';

export function syntheticSqliteWorkspace({ jobs = 2, bodySize = 32 } = {}) {
  const w = createEmptyWorkspace({schemaVersion:3});
  const owner = '10000000-0000-4000-8000-000000000001';
  w.packages[owner] = {packageId:owner,kind:'target',versionId:'t@1',versionName:'Synthetic target',
    enabled:true,state:'active',archiveId:null,archivedAt:null,purgeAt:null,
    collectionCache:{ cached:{bodyHash:'a'.repeat(64),parsedEvidence:{body:'x'.repeat(bodySize)},checkedAt:'2026-01-01T00:00:00.000Z'} }};
  w.targets.t = [{targetId:'t',revisionId:'t@1',revision:1,recordId:randomUUID(),ownerPackageId:owner,
    profileSnapshot:{profileId:'copy',revisionId:'copy@1',revision:1,recordId:randomUUID(),ownerPackageId:owner,
      text:'resume'.repeat(bodySize),profile:{},overrides:{}},roles:['synthetic'],enabled:true}];
  w.runs.r = createCollectionRoot({runId:'r',scope:{packageId:owner,targetRevisionId:'t@1'},targetSnapshot:w.targets.t[0],
    profileSnapshot:w.targets.t[0].profileSnapshot,plan:{units:[{unitId:'u',sourceId:'synthetic',siteId:'s'}]}});
  w.runs.r.collectionProgress.ledger.reservations.a = {reservationId:'a',kind:'request',status:'reserved',requestUpperBound:1,resourceKey:null};
  w.runs.r.collectionProgress.pendingBodies = {one:{unitId:'u',record:{description:'b'.repeat(bodySize)},status:'pending'}};
  w.runs.r.events.push({recordId:randomUUID(),ownerPackageId:owner,runId:'r',seq:1,type:'started',payload:{unknown:'kept'}});
  w.runs.r.lastSeq = 1;
  w.targetMembers = {'t@1':{}};
  for (let i=0;i<jobs;i++) {
    const id = `j${String(i).padStart(5,'0')}`;
    w.jobs[id] = {jobId:id,recordId:randomUUID(),ownerPackageId:owner,kind:'job',canonical:{sourceId:'synthetic',
      title:`Fire ${i}`,url:`https://example.invalid/${id}`,kind:'job',jobType:'social',cities:['Synthetic'],evidence:[],description:'x'.repeat(bodySize)},
      legacyExtension:{city:'retained',unusual:null}};
    const observationId = `o${i}`;
    w.observations[observationId] = {observationId,recordId:randomUUID(),ownerPackageId:owner,jobId:id,runId:'r',fields:w.jobs[id].canonical};
    w.targetMembers['t@1'][id] = {factRefs:[{observationId}],currentObservationId:observationId,factContentHash:null};
  }
  w.identityAliases.alias = [Object.keys(w.jobs)[0]];
  w.managementVersion = 1; w.membershipVersion = 1;
  w.versionMetadata = {'t@1':{kind:'target',versionName:'Synthetic target',nameKey:'synthetic target',enabled:true,archivedAt:null,updatedAt:'2026-01-01'}};
  w.versionCounters = {profile:{},target:{t:1}}; w.versionSubmissions = {};
  w.operationLeases = {}; w.jobRedirects = {}; w.dedupOperations = {};
  w.unknownHistoricalExtension = {nested:{original:[1,null,'retained']}};
  return w;
}
export async function sqliteFixture(t, options = {}) {
  const directory = path.resolve('.cache','sqlite-row-store-tests',randomUUID());
  await fs.mkdir(directory,{recursive:true});
  const filename = path.join(directory,'workspace.sqlite');
  const stores = [];
  const open = extra => { const store = openSqliteRowStore({filename,...options,...extra}); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); });
  return {directory,filename,open};
}
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k,stable(value[k])])) : value;
const ownerOf = w => Object.keys(w.packages)[0];
const declare = (collection,id,ownerPackageId) => ({select:[{collection,ids:[id],...(ownerPackageId ? {ownerPackageId} : {})}]});

test('SQLite import/export preserves every field and detached parts while small reads stay small',async t => {
  const f = await sqliteFixture(t),store = f.open(),w = syntheticSqliteWorkspace({bodySize:10000}),owner = ownerOf(w);
  store.importWorkspace(w);
  assert.deepEqual(store.exportWorkspace(),w);
  assert.equal(digest(store.exportWorkspace()),digest(w));
  const root = store.getRecord({collection:'runs',id:'r',ownerPackageId:owner});
  assert.equal(root.indexes.targetRevisionId,'t@1');
  assert.equal(root.value.targetSnapshot,undefined);
  assert.equal(root.value.profileSnapshot,undefined);
  assert.equal(root.value.events,undefined);
  assert.equal(root.value.collectionProgress.units,undefined);
  assert.equal(root.value.collectionProgress.ledger.reservations,undefined);
  assert.deepEqual(store.queryIds({collection:'runs',ownerPackageId:owner,where:{status:'paused',kind:'collection_root'}}).ids,['r']);
  assert.equal(store.getRow({collection:'packages',id:owner}).collectionCache,undefined);
  const view = store.readView({select:[{collection:'runs',ids:['r'],ownerPackageId:owner,readParts:['collectionProgress.units']}]});
  assert.equal(Object.keys(view.rows.activityUnits).length,1);
  assert.equal(view.rows.reservations,undefined);
  assert.equal(view.rows.runSnapshots,undefined);
  assert.deepEqual(store.pragmas(),{journal_mode:'wal',synchronous:2,foreign_keys:1,secure_delete:1});
  assert.deepEqual(store.integrityCheck(),{integrity:['ok'],foreignKeys:[]});
});

test('SQLite declared writes roll back, reject async and undeclared writes, and isolate caller values',async t => {
  const f = await sqliteFixture(t),store = f.open(),w = syntheticSqliteWorkspace(),owner = ownerOf(w);
  store.importWorkspace(w);
  const selection = declare('jobs','j00000',owner),before = store.getMeta('revision');
  assert.throws(() => store.transaction(selection,tx => {const job=tx.getRow({collection:'jobs',id:'j00000'});job.canonical.title='rollback';tx.putRow({collection:'jobs',id:'j00000',value:job});throw Error('synthetic');}),/synthetic/);
  assert.equal(store.getMeta('revision'),before);
  assert.equal(store.getRow({collection:'jobs',id:'j00000',ownerPackageId:owner}).canonical.title,'Fire 0');
  let late;
  assert.throws(() => store.transaction(selection,async tx => {late=tx;await Promise.resolve();}),{code:'sqlite_async_transaction'});
  assert.throws(() => late.putRow({collection:'jobs',id:'j00000',value:w.jobs.j00000}),{code:'sqlite_transaction_closed'});
  assert.throws(() => store.transaction(selection,tx => tx.deleteRow({collection:'jobs',id:'j00001'})),{code:'sqlite_undeclared_write'});
  assert.throws(() => store.transaction(selection,tx => tx.putRow({collection:'jobs',id:'another',value:w.jobs.j00000})),{code:'sqlite_undeclared_write'});
  const read=store.getRow({collection:'jobs',id:'j00000',ownerPackageId:owner}); read.canonical.title='caller';
  const result=store.transaction(selection,tx => {const job=tx.getRow({collection:'jobs',id:'j00000'});job.canonical.title='committed';tx.putRow({collection:'jobs',id:'j00000',value:job});return job;});
  result.result.canonical.title='outside';
  assert.equal(store.getRow({collection:'jobs',id:'j00000',ownerPackageId:owner}).canonical.title,'committed');
  assert.equal(result.revision,before+1);
  assert.equal(store.readChanges().changes.at(-1).collection,'jobs');
  assert.throws(() => store.queryRows({collection:'jobs'}),{code:'sqlite_scope_required'});
  assert.throws(() => store.queryRows({collection:'jobs',ownerPackageId:owner,limit:Infinity}),{code:'sqlite_selection_invalid'});
});

test('SQLite enforces foreign keys, ownership, stable identity, names and reservation idempotency keys',async t => {
  const f = await sqliteFixture(t),store = f.open(),w = syntheticSqliteWorkspace(),owner = ownerOf(w);
  store.importWorkspace(w);
  const other='20000000-0000-4000-8000-000000000002';
  const p={...w.packages[owner],packageId:other,versionId:'other@1',versionName:'Other'};delete p.collectionCache;
  store.transaction(declare('packages',other),tx=>tx.putRow({collection:'packages',id:other,value:p}));
  const observation={observationId:'bad',recordId:randomUUID(),ownerPackageId:other,jobId:'j00000'};
  assert.throws(()=>store.transaction(declare('observations','bad',other),tx=>tx.putRow({collection:'observations',id:'bad',ownerPackageId:other,value:observation})),{code:'sqlite_constraint'});
  const dangling={...observation,ownerPackageId:owner,jobId:'missing'};
  assert.throws(()=>store.transaction(declare('observations','bad',owner),tx=>tx.putRow({collection:'observations',id:'bad',ownerPackageId:owner,value:dangling})),{code:'sqlite_constraint'});
  assert.throws(()=>store.transaction(declare('jobs','j00000',owner),tx=>tx.putRow({collection:'jobs',id:'j00000',ownerPackageId:other,value:{...w.jobs.j00000,ownerPackageId:other}})),{code:'sqlite_identity_immutable'});
  assert.throws(()=>store.transaction(declare('packages',other),tx=>tx.putRow({collection:'packages',id:other,value:{...p,versionName:' SYNTHETIC   TARGET '}})),{code:'sqlite_constraint'});
  const id=rowKey('r','collectionProgress.ledger.reservations','d1'), id2=rowKey('r','collectionProgress.ledger.reservations','d2');
  const s={select:[{collection:'reservations',ownerPackageId:owner,ids:[id,id2]}]};
  store.transaction(s,tx=>tx.putRow({collection:'reservations',id,ownerPackageId:owner,parent:{collection:'runs',id:'r',path:'collectionProgress.ledger.reservations'},value:{reservationId:'d1',status:'reserved',kind:'detail_credit',resourceKey:'same'}}));
  assert.throws(()=>store.transaction(s,tx=>tx.putRow({collection:'reservations',id:id2,ownerPackageId:owner,parent:{collection:'runs',id:'r',path:'collectionProgress.ledger.reservations'},value:{reservationId:'d2',status:'reserved',kind:'detail_credit',resourceKey:'same'}})),{code:'sqlite_constraint'});
  assert.throws(()=>store.transaction(declare('jobs','j00000',owner),tx=>tx.putRow({collection:'jobs',id:'j00000',value:{...w.jobs.j00000,canonical:{...w.jobs.j00000.canonical,cities:'bad'}}})),/source evidence\/cities/);
  assert.deepEqual(store.integrityCheck(),{integrity:['ok'],foreignKeys:[]});
});

test('SQLite old schema is maintenance-only; replacement keeps revision and changes monotonic',async t=>{
  const f=await sqliteFixture(t),store=f.open(),legacy=createEmptyWorkspace({schemaVersion:2});
  legacy.jobs.old={jobId:'old',kind:'job',canonical:{title:'Historical sparse',city:'retained'}};
  assert.throws(()=>store.importWorkspace(legacy),{code:'sqlite_legacy_maintenance_only'});
  store.importWorkspace(legacy,{allowLegacy:true});
  assert.deepEqual(store.exportWorkspace(),legacy);
  assert.throws(()=>store.getRow({collection:'jobs',id:'old',ownerPackageId:'x'}),{code:'sqlite_legacy_maintenance_only'});
  const current=syntheticSqliteWorkspace();current.revision=10;
  store.replaceWorkspace(current);
  const seq=store.readChanges().head;
  current.revision=1;store.replaceWorkspace(current);
  assert.equal(store.getMeta('revision'),11);assert.ok(store.readChanges().head>seq);
  assert.throws(()=>store.replaceWorkspace({...current,schemaVersion:9}),/Unsupported workspace schema/);
});

test('SQLite single row and tiny metadata transactions do not scale with unrelated bodies',async t=>{
  const totals=[];
  for(const jobs of [1000,10000]){
    const f=await sqliteFixture(t),store=f.open(),w=syntheticSqliteWorkspace({jobs,bodySize:jobs === 1000 ? 128 : 1280}),owner=ownerOf(w);
    store.importWorkspace(w);store.metrics({reset:true});
    store.getRow({collection:'reservations',id:rowKey('r','collectionProgress.ledger.reservations','a'),ownerPackageId:owner});
    store.transaction({select:[],metaKeys:['heartbeat']},tx=>tx.setMeta('heartbeat',1));
    totals.push(store.metrics());
  }
  for(const field of ['rowsRead','rowsWritten','decodedRows','decodedBytes','metaRowsRead','metaDecodedBytes','serializedRows','serializedBytes']) assert.equal(totals[0][field],totals[1][field],field);
  assert.equal(totals[0].decodedRows,1);assert.ok(totals[0].serializedBytes<100);
  const evidence={observedAt:new Date().toISOString(),runtime:{node:process.versions.node,electron:process.versions.electron || null},
    scales:[{jobs:1000,bodySize:128},{jobs:10000,bodySize:1280}],measurements:totals};
  await fs.writeFile(path.resolve('.cache',`sqlite-foundation-metrics-${process.versions.node}.json`),JSON.stringify(evidence,null,2));
});

test('SQLite post-commit faults explicitly report a committed result, backup and compaction use real database',async t=>{
  let fail=false;const f=await sqliteFixture(t,{faultInjector:phase=>{if(fail&&phase==='afterCommit')throw Error('synthetic after commit');}}),store=f.open();
  store.importWorkspace(syntheticSqliteWorkspace());fail=true;
  assert.throws(()=>store.transaction({select:[],metaKeys:['proof']},tx=>tx.setMeta('proof','committed')),e=>e.code==='sqlite_post_commit'&&e.committed===true);
  assert.equal(store.getMeta('proof'),'committed');fail=false;
  const destination=path.join(f.directory,'backup.sqlite');const result=await store.backup(destination);assert.ok(result.pages>0);
  const copied=openSqliteRowStore({filename:destination});t.after(()=>copied.close());
  assert.deepEqual(copied.exportWorkspace(),store.exportWorkspace());
  assert.equal(store.compact().complete,true);
});

test('SQLite fixed indexed pages and same-transaction projections do not decode unrelated job bodies',async t=>{
  let projected=false;
  const f=await sqliteFixture(t,{onProjection:(tx,changes)=>{
    if(!changes.some(c=>c.collection==='jobs'))return;
    const changed=changes.find(c=>c.collection==='jobs');
    tx.putRow({collection:'jobProjections',id:changed.id,ownerPackageId:changed.ownerPackageId,
      value:{jobId:changed.id,ownerPackageId:changed.ownerPackageId,title:changed.after.canonical.title,score:82,recommendation:'consider'}});
    projected=true;
  }}),store=f.open(),w=syntheticSqliteWorkspace(),owner=ownerOf(w);store.importWorkspace(w);
  store.transaction({select:[{collection:'jobs',ids:['j00000'],ownerPackageId:owner},
    {collection:'jobProjections',ids:['j00000'],ownerPackageId:owner}]},tx=>{
    const job=tx.getRow({collection:'jobs',id:'j00000'});job.canonical.title='Projected';tx.putRow({collection:'jobs',id:'j00000',value:job});
  });
  assert.equal(projected,true);store.metrics({reset:true});
  const ids=store.queryIds({collection:'jobProjections',ownerPackageId:owner,where:{recommendation:'consider',score:{gte:80}},orderBy:'score',direction:'desc',limit:50});
  assert.deepEqual(ids.ids,['j00000']);assert.equal(ids.total,1);assert.equal(store.metrics().decodedRows,0);
  const aggregate=store.aggregateRows({collection:'jobProjections',ownerPackageId:owner,groupBy:'recommendation'});
  assert.deepEqual(aggregate.groups,[{key:'consider',value:1}]);assert.equal(store.metrics().decodedRows,0);
  const page=store.queryRows({collection:'jobs',ownerPackageId:owner,limit:1});
  assert.equal(page.hasMore,true);assert.equal(page.total,2);
  assert.deepEqual(store.queryRows({collection:'jobs',ownerPackageId:owner,afterId:page.nextCursor,limit:1}).rows.map(r=>r.id),['j00001']);
});

test('SQLite fixed fields reject prototype names and inherited comparison operators without changing data',async t=>{
  const f=await sqliteFixture(t),store=f.open(),w=syntheticSqliteWorkspace(),owner=ownerOf(w);store.importWorkspace(w);
  const before=digest(store.exportWorkspace());
  for(const where of [JSON.parse('{"__proto__":"x"}'),{constructor:'x'},{title:{constructor:'x'}},JSON.parse('{"title":{"__proto__":"x"}}')])
    assert.throws(()=>store.queryRows({collection:'jobs',ownerPackageId:owner,where}),{code:'sqlite_selection_invalid'});
  for(const orderBy of ['constructor','__proto__'])assert.throws(()=>store.queryRows({collection:'jobs',ownerPackageId:owner,orderBy}),{code:'sqlite_selection_invalid'});
  assert.equal(digest(store.exportWorkspace()),before);
});

test('SQLite new detached records persist into maintenance export; uncloneable callback results roll back',async t=>{
  const f=await sqliteFixture(t),store=f.open(),w=syntheticSqliteWorkspace(),owner=ownerOf(w);store.importWorkspace(w);
  const id=rowKey(owner,'collectionCache','another');
  store.transaction(declare('conditionalCache',id,owner),tx=>tx.putRow({collection:'conditionalCache',id,ownerPackageId:owner,
    parent:{collection:'packages',id:owner,path:'collectionCache'},value:{checkedAt:'2026-01-02',parsedEvidence:{body:'new'}}}));
  assert.equal(store.exportWorkspace().packages[owner].collectionCache.another.parsedEvidence.body,'new');
  const revision=store.getMeta('revision');
  assert.throws(()=>store.transaction({select:[],metaKeys:['uncloneable']},tx=>{tx.setMeta('uncloneable',true);return ()=>{};}));
  assert.equal(store.getMeta('uncloneable'),undefined);assert.equal(store.getMeta('revision'),revision);
});

test('SQLite guard and projection callbacks stay synchronous and cannot open undeclared storage reads',async t=>{
  let guardAsync=false,projectAsync=false,guardPorts,savedPort;
  const f=await sqliteFixture(t,{guard:(input,port)=>{guardPorts=Object.keys(port);savedPort=port;if(guardAsync&&input.phase==='write')return Promise.resolve();},
    onProjection:()=>projectAsync ? Promise.resolve() : undefined}),store=f.open();
  store.importWorkspace(syntheticSqliteWorkspace());assert.deepEqual(guardPorts,['getMeta','getRow']);
  assert.throws(()=>savedPort.getMeta('revision'),{code:'sqlite_guard_closed'});
  guardAsync=true;assert.throws(()=>store.transaction({select:[],metaKeys:['no']},tx=>tx.setMeta('no',1)),{code:'sqlite_async_transaction'});
  guardAsync=false;projectAsync=true;assert.throws(()=>store.transaction({select:[],metaKeys:['no']},tx=>tx.setMeta('no',1)),{code:'sqlite_async_transaction'});
  projectAsync=false;assert.throws(()=>store.transaction({select:[]},()=>store.getMeta('revision')),{code:'sqlite_nested_transaction'});
  assert.equal(store.getMeta('no'),undefined);
});

test('SQLite secure-delete and successful physical maintenance remove current cache bytes but not an old backup',async t=>{
  const f=await sqliteFixture(t),store=f.open(),w=syntheticSqliteWorkspace(),owner=ownerOf(w),marker='RJR_PRIVATE_SYNTHETIC_CACHE_DELETE_20261016_f792';
  w.packages[owner].collectionCache.cached.parsedEvidence={body:marker};store.importWorkspace(w);
  const backup=path.join(f.directory,'pre-delete.sqlite');await store.backup(backup);
  const id=rowKey(owner,'collectionCache','cached');
  store.transaction(declare('conditionalCache',id,owner),tx=>tx.deleteRow({collection:'conditionalCache',id}));
  assert.deepEqual(store.exportWorkspace().packages[owner].collectionCache,{});
  assert.equal(store.compact().complete,true);store.close();
  for(const suffix of ['','-wal']){
    try{assert.equal((await fs.readFile(f.filename+suffix)).includes(Buffer.from(marker)),false);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  assert.equal((await fs.readFile(backup)).includes(Buffer.from(marker)),true);
});

test('SQLite preserves prototype-named own keys in views, metadata and every maintenance dictionary',async t=>{
  const f=await sqliteFixture(t),store=f.open(),w=syntheticSqliteWorkspace();
  Object.defineProperty(w,'__proto__',{value:{kept:'extension'},enumerable:true,writable:true,configurable:true});
  w.versionCounters.target=JSON.parse('{"t":1,"__proto__":7,"constructor":9}');
  w.settings=JSON.parse('{"__proto__":{"marker":"own"},"constructor":{"marker":"own constructor"}}');
  store.importWorkspace(w);
  const exported=store.exportWorkspace();assert.deepEqual(exported,w);assert.equal(Object.getPrototypeOf(exported),Object.prototype);
  assert.equal(Object.hasOwn(exported,'__proto__'),true);assert.equal(Object.hasOwn(exported.versionCounters.target,'__proto__'),true);
  const view=store.readView({select:[{collection:'settings',ids:['__proto__','constructor']}],metaKeys:['constructor']});
  assert.equal(Object.hasOwn(view.rows.settings,'__proto__'),true);assert.equal(Object.hasOwn(view.indexes.settings,'__proto__'),true);
  assert.equal(Object.getPrototypeOf(view.rows.settings),Object.prototype);assert.equal(view.rows.settings.__proto__.marker,'own');
  assert.equal(Object.hasOwn(view.meta,'constructor'),true);assert.equal(view.meta.constructor,undefined);
  assert.throws(()=>store.getMeta('__proto__'),{code:'sqlite_meta_invalid'});
});

test('SQLite rejects noncanonical detached identities and scalar duplicates before durable commit',async t=>{
  const f=await sqliteFixture(t),store=f.open(),w=syntheticSqliteWorkspace(),owner=ownerOf(w);store.importWorkspace(w);
  const before=digest(store.exportWorkspace()),revision=store.getMeta('revision');
  for(const id of ['not-json-row-key',rowKey('wrong','collectionProgress.ledger.reservations','a'),rowKey('r','wrong','a'),
    '[ "r", "collectionProgress.ledger.reservations", "a" ]',rowKey('r','collectionProgress.ledger.reservations','different')]){
    assert.throws(()=>store.transaction(declare('reservations',id,owner),tx=>tx.putRow({collection:'reservations',id,ownerPackageId:owner,
      parent:{collection:'runs',id:'r',path:'collectionProgress.ledger.reservations'},value:{reservationId:'a',kind:'request',status:'reserved'}})),{code:'sqlite_part_invalid'});
  }
  const extra=rowKey('r','profileSnapshot','extra');
  assert.throws(()=>store.transaction(declare('runSnapshots',extra,owner),tx=>tx.putRow({collection:'runSnapshots',id:extra,ownerPackageId:owner,
    parent:{collection:'runs',id:'r',path:'profileSnapshot'},ordinal:1,value:{marker:'must not hide'}})),{code:'sqlite_part_invalid'});
  const badOrdinal=rowKey('r','issues','01');
  assert.throws(()=>store.transaction(declare('runIssues',badOrdinal,owner),tx=>tx.putRow({collection:'runIssues',id:badOrdinal,ownerPackageId:owner,
    parent:{collection:'runs',id:'r',path:'issues'},ordinal:1,value:{code:'bad'}})),{code:'sqlite_part_invalid'});
  const copy={...w.targets.t[0].profileSnapshot,revisionId:'another-copy@1',recordId:randomUUID()};
  assert.throws(()=>store.transaction(declare('profileCopies',copy.revisionId,owner),tx=>tx.putRow({collection:'profileCopies',id:copy.revisionId,ownerPackageId:owner,
    parent:{collection:'targets',id:'t@1',path:'profileSnapshot'},value:copy})),{code:'sqlite_constraint'});
  assert.equal(store.getMeta('revision'),revision);assert.equal(digest(store.exportWorkspace()),before);
});

test('SQLite metadata declarations are immutable and repeated writes obey final-value/no-op semantics',async t=>{
  const f=await sqliteFixture(t),store=f.open(),selection={select:[],metaKeys:[]};
  assert.throws(()=>store.transaction(selection,tx=>{selection.metaKeys.push('late');tx.setMeta('late',42);}),{code:'sqlite_meta_managed'});
  assert.equal(store.getMeta('late'),undefined);
  for(const metaKeys of ['bad',['same','same'],Array.from({length:65},(_,i)=>'k'+i)])assert.throws(()=>store.readView({select:[],metaKeys}),{code:'sqlite_selection_invalid'});
  store.transaction({select:[],metaKeys:['value']},tx=>tx.setMeta('value',1));const before=store.getMeta('revision');
  const receipt=store.transaction({select:[],metaKeys:['value','missing']},tx=>{
    tx.setMeta('value',2);assert.equal(tx.getMeta('value'),2);tx.setMeta('value',1);assert.equal(tx.getMeta('value'),1);
    tx.setMeta('missing',3);tx.deleteMeta('missing');assert.equal(tx.getMeta('missing'),undefined);
  });
  assert.equal(receipt.revision,before);assert.equal(store.getMeta('value'),1);assert.equal(store.getMeta('missing'),undefined);
  store.transaction({select:[],metaKeys:['value']},tx=>{tx.deleteMeta('value');assert.equal(tx.getMeta('value'),undefined);tx.setMeta('value',4);});
  assert.equal(store.getMeta('value'),4);
});

test('SQLite declared missing private IDs infer one owner and reject ambiguous owner declarations',async t=>{
  const f=await sqliteFixture(t),store=f.open(),w=syntheticSqliteWorkspace(),owner=ownerOf(w);store.importWorkspace(w);
  const id=rowKey('r','collectionProgress.ledger.reservations','new');
  const receipt=store.transaction(declare('reservations',id,owner),tx=>{
    assert.equal(tx.getRow({collection:'reservations',id}),null);
    tx.putRow({collection:'reservations',id,parent:{collection:'runs',id:'r',path:'collectionProgress.ledger.reservations'},value:{reservationId:'new',kind:'request',status:'reserved'}});
    return tx.getRow({collection:'reservations',id});
  });
  assert.equal(receipt.result.reservationId,'new');
  const absent=rowKey('r','collectionProgress.ledger.reservations','absent');
  assert.throws(()=>store.transaction({select:[{collection:'reservations',ids:[absent],ownerPackageIds:[owner,randomUUID()]}]},tx=>tx.getRow({collection:'reservations',id:absent})),{code:'sqlite_scope_required'});
});

test('SQLite rejects lossy sparse, extra, symbolic, hidden and accessor JSON properties',async t=>{
  const f=await sqliteFixture(t),store=f.open(),sparse=[];sparse.length=2;sparse[0]='first';sparse.extra='lost';
  const symbolic={ok:1};symbolic[Symbol('private')]=2;
  const hidden={ok:1};Object.defineProperty(hidden,'hidden',{value:2});
  const accessor={get unsafe(){return 2;}};
  const arrayExtra=['first','second'];arrayExtra.extra='lost';
  for(const value of [sparse,symbolic,hidden,accessor,arrayExtra])
    assert.throws(()=>store.transaction(declare('settings','lossy'),tx=>tx.putRow({collection:'settings',id:'lossy',value})),{code:'sqlite_invalid_json'});
  assert.equal(store.getRow({collection:'settings',id:'lossy'}),null);assert.equal(store.getMeta('revision'),0);
});

test('SQLite descending/explicit-order pages never advertise ascending cursors',async t=>{
  const f=await sqliteFixture(t),store=f.open();store.transaction({select:[{collection:'settings',ids:['a','b','c']}]},tx=>{
    for(const id of ['a','b','c'])tx.putRow({collection:'settings',id,value:{id}});
  });
  for(const method of ['queryRows','queryIds']){
    const first=store[method]({collection:'settings',direction:'desc',limit:1});assert.equal(first.hasMore,true);assert.equal(first.nextCursor,null);
    const explicit=store[method]({collection:'settings',orderBy:'id',limit:1});assert.equal(explicit.nextCursor,null);
    assert.throws(()=>store[method]({collection:'settings',direction:'desc',afterId:'c',limit:1}),{code:'sqlite_selection_invalid'});
    const second=store[method]({collection:'settings',direction:'desc',offset:1,limit:1});assert.deepEqual(second.ids || second.rows.map(r=>r.id),['b']);
  }
});

test('SQLite replacement rejects exhausted revision without committing an unreadable store',async t=>{
  const f=await sqliteFixture(t),store=f.open(),workspace=createEmptyWorkspace({schemaVersion:3});
  workspace.revision=Number.MAX_SAFE_INTEGER;store.importWorkspace(workspace);
  const before=store.exportWorkspace(),head=store.readChanges().head;
  assert.throws(()=>store.replaceWorkspace(createEmptyWorkspace({schemaVersion:3})),{code:'sqlite_sequence_exhausted'});
  assert.equal(store.getMeta('revision'),Number.MAX_SAFE_INTEGER);assert.equal(store.readChanges().head,head);
  assert.deepEqual(store.exportWorkspace(),before);store.close();
  assert.equal(f.open().getMeta('revision'),Number.MAX_SAFE_INTEGER);
});
