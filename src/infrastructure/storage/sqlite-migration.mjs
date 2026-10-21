import fs from 'node:fs/promises';
import path from 'node:path';
import { createEmptyWorkspace, assertWorkspace } from '../../domain/contracts.mjs';
import { normalizeBackupOwnership } from './package-migration.mjs';
import { normalizeWorkspaceExtensions } from '../../domain/workspace-management.mjs';
import { backfillTargetMembers } from '../../domain/job-facts.mjs';
import { createEmptyControl } from './package-control.mjs';
import { writeAtomicJson } from './atomic.mjs';
import { contentHash, canonicalContentHash } from './content-hash.mjs';
import { hasLiveOwner } from './process-owner.mjs';
import { packageError } from '../../domain/packages.mjs';

export const SQLITE_MIGRATED_FORMAT = 'resume-job-radar/sqlite-migrated';
const failure = message => packageError('workspace_migration_conflict', message, 503);
const businessHash = workspace => canonicalContentHash({...workspace,revision:0});
const readOptional = async (adapter, filename) => {
  try { return await adapter.readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

/** A cold schema2 SQL import can later be opened by the formal schema3 context. */
async function upgradeImportedWorkspace({dataDir,store,control,controlStore,fsAdapter,clock,fault}){
  let task=control.migrationJournal.sqliteSchemaUpgrade;
  const commit=async next=>{await controlStore.commitInLock(next,{previous:control});control=structuredClone(next);task=control.migrationJournal.sqliteSchemaUpgrade;};
  if(task?.phase==='complete')return control;
  if(!task){
    const source=store.exportWorkspace();
    if(Object.values(source.operationLeases||{}).some(hasLiveOwner)||Object.values(source.runs).some(run=>['queued','running'].includes(run.status)&&hasLiveOwner(run)))
      throw packageError('workspace_migration_busy','旧格式仍有活动操作，请先停止。',409);
    const next=structuredClone(control);next.migrationJournal.sqliteSchemaUpgrade={phase:'preparing',preparedAt:new Date(clock.now()).toISOString(),
      archiveId:'workspace-schema-upgrade-'+contentHash({sourceHash:control.migrationJournal.sqlite.sourceHash,revision:source.revision,hash:businessHash(source)}).slice(0,32)+'.json'};
    await commit(next);await fault('migration.schema3-preparing');
  }
  const filename=path.join(dataDir,'backups',task.archiveId),raw=await readOptional(fsAdapter,filename);let archive;
  if(raw!==null){
    try{archive=JSON.parse(raw);}catch{throw failure('旧格式升级备份损坏。');}
    if(contentHash(archive.workspace)!==archive.manifest?.workspaceHash)throw failure('旧格式升级备份校验失败。');
  }else{
    const source=store.exportWorkspace(),snapshots={};
    for(const run of Object.values(source.runs))if(run.snapshotRef){
      if(!/^[A-Za-z0-9_-]{1,160}$/.test(run.runId)||run.snapshotRef.path!=='runs-v2/'+run.runId+'.json')throw failure('旧格式运行快照路径无效。');
      const old=await readOptional(fsAdapter,path.join(dataDir,run.snapshotRef.path));
      if(old===null){run.snapshotRef=null;source.recoveryRecords.push({type:'missing_legacy_snapshot',runId:run.runId});continue;}
      try{snapshots[run.runId]=JSON.parse(old);}catch{throw failure('旧格式运行快照损坏。');}
      if(contentHash(snapshots[run.runId])!==run.snapshotRef.hash)throw failure('旧格式运行快照哈希无效。');
    }
    source.operationLeases={};
    const normalized=normalizeBackupOwnership({workspace:source,snapshots,control,now:Date.parse(task.preparedAt)});
    const next=normalized.control;next.migrationJournal.sqliteSchemaUpgrade={...task,phase:'prepared',workspaceHash:businessHash(normalized.workspace)};
    await commit(next);await fault('migration.schema3-prepared');
    archive={manifest:{version:1,schemaVersion:3,createdAt:task.preparedAt,workspaceHash:contentHash(normalized.workspace),snapshots:Object.fromEntries(Object.entries(normalized.snapshots).map(([id,value])=>[id,contentHash(value)]))},workspace:normalized.workspace,runSnapshots:normalized.snapshots};
    await writeAtomicJson(filename,archive,{fsAdapter});await fault('migration.schema3-archived');
  }
  for(const [id,snapshot]of Object.entries(archive.runSnapshots||{})){
    if(contentHash(snapshot)!==archive.manifest.snapshots[id])throw failure('旧格式升级快照校验失败。');
    await writeAtomicJson(path.join(dataDir,'runs-v2',id+'.json'),snapshot,{fsAdapter});
  }
  await fault('migration.schema3-snapshots');
  if(store.getMeta('schemaVersion')===2)store.replaceWorkspace(archive.workspace);
  if(store.getMeta('schemaVersion')!==3||businessHash(store.exportWorkspace())!==task.workspaceHash)throw failure('旧格式 SQL 升级核验失败。');
  await fault('migration.schema3-published');
  const next=structuredClone(control);next.migrationJournal.sqliteSchemaUpgrade.phase='complete';await commit(next);
  await fault('migration.schema3-complete');return control;
}

/** Caller holds the old workspace file lock for the entire upgrade. No business port is published. */
export async function migrateWorkspaceToSqlite({dataDir, store, controlStore, fsAdapter = fs, allowLegacy = false,
  clock = {now: () => Date.now()}, faultInjector}) {
  const filename = path.join(dataDir, 'workspace.v2.json');
  const fault = async phase => { if (faultInjector) await faultInjector(phase); };
  const raw = await readOptional(fsAdapter, filename);
  let source;
  try { source = raw === null ? createEmptyWorkspace({schemaVersion:2}) : JSON.parse(raw); }
  catch { throw failure('旧工作区 JSON 损坏，原件已保留。'); }
  const marked = source?.format === SQLITE_MIGRATED_FORMAT;
  if (!marked) assertWorkspace(source);
  let control = await controlStore.read({allowUninitialized: !marked && source.schemaVersion !== 3});
  let journal = control?.migrationJournal?.sqlite;
  const commitControl = async next => {
    await controlStore.commitInLock(next, {previous: control});
    control = structuredClone(next);
    journal = control.migrationJournal.sqlite;
  };
  if (journal?.phase === 'complete') {
    if (!marked || source.workspaceId !== control.workspaceId || source.sourceHash !== journal.sourceHash)
      throw failure('旧工作区迁移标记不一致，已停止访问。');
    if (store.getMeta('migrationSourceHash') !== journal.sourceHash)
      throw failure('业务数据库与迁移标记不一致。');
    if(!allowLegacy&&(store.getMeta('schemaVersion')===2||control.migrationJournal.sqliteSchemaUpgrade?.phase&&control.migrationJournal.sqliteSchemaUpgrade.phase!=='complete'))
      control=await upgradeImportedWorkspace({dataDir,store,control,controlStore,fsAdapter,clock,fault});
    if(!allowLegacy&&store.getMeta('schemaVersion')!==3)throw failure('正式业务库需要完成归属升级。');
    return {changed:false,sourceHash:journal.sourceHash,phase:'complete'};
  }
  if (marked && !journal) throw failure('迁移标记没有对应的持久记录。');
  // A SQL write lock only excludes another short write; it cannot prove a legacy
  // process has drained its async work. Check live owners while the old lock is held.
  if (!marked) {
    const liveLeases = Object.values(source.operationLeases || {}).filter(hasLiveOwner);
    const liveRuns = Object.values(source.runs || {}).filter(run => ['queued','running'].includes(run.status) && hasLiveOwner(run));
    if (liveLeases.length || liveRuns.length)
      throw packageError('workspace_migration_busy','旧实例仍有活动任务，请先停止任务并关闭旧实例。',409);
  }
  const inputs = [];
  if (!marked && source.schemaVersion === 2) {
    const index = await readOptional(fsAdapter,path.join(dataDir,'job-index.json'));
    if (index !== null) {
      let value; try { value=JSON.parse(index); } catch { throw failure('旧岗位索引损坏，原件已保留。'); }
      if (value.version !== 1 || !value.jobs || Array.isArray(value.jobs)) throw failure('旧岗位索引格式不支持。');
      inputs.push({path:'job-index.json',body:index});
    }
    const names = await fsAdapter.readdir(path.join(dataDir,'runs')).catch(error => {if(error.code==='ENOENT')return [];throw error;});
    for(const name of names.filter(name=>name.endsWith('.json')).sort()) {
      if(!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(name))throw failure('旧运行文件名称无效。');
      const body=await fsAdapter.readFile(path.join(dataDir,'runs',name),'utf8');
      let run;try{run=JSON.parse(body);}catch{throw failure('旧运行文件损坏，原件已保留。');}
      if(!Array.isArray(run.jobs||run.results))throw failure('旧运行文件格式不支持。');
      if(['queued','running'].includes(run.status)&&hasLiveOwner(run))throw packageError('workspace_migration_busy','旧实例仍有活动任务。',409);
      inputs.push({path:'runs/'+name,body});
    }
  }
  const sourceHash = marked ? journal.sourceHash : contentHash({workspace:raw,inputs});
  if(journal && journal.sourceHash !== sourceHash)throw failure('准备迁移后旧数据发生变化，原件已保留。');
  if(!journal) {
    const next=structuredClone(control||createEmptyControl());
    next.migrationJournal.sqlite={phase:'preparing',sourceHash,preparedAt:new Date(clock.now()).toISOString(),exclusiveOwnerPid:process.pid};
    await commitControl(next);
    await fault('migration.control-preparing');
  }
  let archive;
  const archiveId=journal.archiveId||'workspace-sqlite-migration-'+sourceHash.slice(0,32)+'.json';
  const archivePath=path.join(dataDir,'backups',archiveId);
  const archived=await readOptional(fsAdapter,archivePath);
  if(archived!==null){
    try{archive=JSON.parse(archived);}catch{throw failure('受管迁移备份损坏。');}
    if(archive.manifest?.migrationSourceHash!==sourceHash||contentHash(archive.workspace)!==archive.manifest.workspaceHash)
      throw failure('受管迁移备份校验失败。');
    assertWorkspace(archive.workspace);
    for(const [id,snapshot] of Object.entries(archive.runSnapshots||{}))
      if(contentHash(snapshot)!==archive.manifest.snapshots?.[id])throw failure('受管迁移快照校验失败。');
  }
  if(!archive){
    if(marked)throw failure('迁移中断但缺少受管迁移备份。');
    let workspace=structuredClone(source),snapshots={};
    // V1 conversion uses its supported memory-only input port. It does not
    // create a second JSON writer or delete a legacy source before SQL is durable.
    if(source.schemaVersion===2 && inputs.length && !workspace.migration){
      const {migrateV1}=await import('./migrate-v1.mjs');
      const memory={dataDir,clock:{now:()=>Date.parse(journal.preparedAt)},
        read:async()=>structuredClone(workspace),
        mutateWorkspace:async action=>{const result=await action(workspace);workspace.revision++;return {result,revision:workspace.revision};},
        writeRunSnapshot:async(id,snapshot)=>{snapshots[id]=structuredClone(snapshot);return {path:'runs-v2/'+id+'.json',hash:contentHash(snapshot)};}};
      await migrateV1({dataDir,repository:memory,memoryOnly:{inputs}});
    }
    for(const run of Object.values(workspace.runs))if(run.snapshotRef&&!snapshots[run.runId]){
      if(!/^[A-Za-z0-9_-]{1,160}$/.test(run.runId)||run.snapshotRef.path!=='runs-v2/'+run.runId+'.json')throw failure('旧快照路径无效。');
      const snapshotRaw=await readOptional(fsAdapter,path.join(dataDir,run.snapshotRef.path));
      if(snapshotRaw===null){
        if(allowLegacy&&workspace.schemaVersion===2)continue;
        if(workspace.schemaVersion===3)throw failure('受管运行快照缺失。');
        run.snapshotRef=null;workspace.recoveryRecords.push({type:'missing_legacy_snapshot',runId:run.runId});continue;
      }
      try{snapshots[run.runId]=JSON.parse(snapshotRaw);}catch{throw failure('运行快照损坏。');}
      if(contentHash(snapshots[run.runId])!==run.snapshotRef.hash&&!(allowLegacy&&workspace.schemaVersion===2))throw failure('运行快照哈希不一致。');
    }
    workspace.operationLeases={}; // Only proven dead leases remain after the gate above.
    if(!(allowLegacy&&workspace.schemaVersion===2)){
      workspace=normalizeWorkspaceExtensions(workspace);
      backfillTargetMembers(workspace);
    }
    const normalized=allowLegacy&&workspace.schemaVersion===2 ? {workspace,snapshots,control:structuredClone(control)} :
      normalizeBackupOwnership({workspace,snapshots,control,now:Date.parse(journal.preparedAt)});
    normalized.workspace.operationLeases={};
    const next=normalized.control;
    next.migrationJournal.sqlite={...journal,phase:'prepared',archiveId,
      workspaceHash:businessHash(normalized.workspace),legacyFiles:inputs.map(input=>({path:input.path,hash:contentHash(input.body)}))};
    await commitControl(next);
    await fault('migration.control-prepared');
    archive={manifest:{version:1,schemaVersion:normalized.workspace.schemaVersion,createdAt:journal.preparedAt,
      workspaceHash:contentHash(normalized.workspace),migrationSourceHash:sourceHash,
      snapshots:Object.fromEntries(Object.entries(normalized.snapshots).map(([id,value])=>[id,contentHash(value)]))},
      workspace:normalized.workspace,runSnapshots:normalized.snapshots};
    await writeAtomicJson(archivePath,archive,{fsAdapter});
    await fault('migration.archive-written');
  }
  if(!['imported','marked'].includes(journal.phase)){
    const next=structuredClone(control);next.migrationJournal.sqlite.phase='archived';await commitControl(next);
    await fault('migration.control-archived');
    for(const [id,snapshot]of Object.entries(archive.runSnapshots||{}))
      await writeAtomicJson(path.join(dataDir,'runs-v2',id+'.json'),snapshot,{fsAdapter});
    await fault('migration.snapshots-written');
    // Import only an empty store. A crash after COMMIT is recognized by the
    // durable hash and content, rather than replacing an arbitrary database.
    const importedHash=store.getMeta('migrationSourceHash');
    if(importedHash&&importedHash!==sourceHash)throw failure('数据库属于另一份迁移源。');
    const current=store.exportWorkspace();
    const empty=current.revision===0&&Object.keys(current.packages||{}).length===0&&
      Object.keys(current.jobs||{}).length===0&&Object.keys(current.profiles||{}).length===0;
    if(empty&&!importedHash)store.importWorkspace(archive.workspace,{allowLegacy,migrationSourceHash:sourceHash});
    else if(businessHash(current)!==journal.workspaceHash)throw failure('现有数据库内容与受管迁移备份不一致。');
    await fault('migration.sql-imported');
    if(businessHash(store.exportWorkspace())!==journal.workspaceHash)throw failure('SQL 导入内容核验失败。');
    const integrity=store.integrityCheck();
    if(integrity.integrity.some(value=>value!=='ok')||integrity.foreignKeys.length)throw failure('SQL 导入完整性核验失败。');
    // The metadata transaction increases revision; record the verified business
    // hash independently, and never compare its later revision to the old source.
    const nextImported=structuredClone(control);nextImported.migrationJournal.sqlite.phase='imported';await commitControl(nextImported);
    await fault('migration.control-imported');
  }
  if(store.getMeta('migrationSourceHash')!==sourceHash)throw failure('SQL 切换标记缺失。');
  if(!marked){
    await writeAtomicJson(filename,{format:SQLITE_MIGRATED_FORMAT,version:1,workspaceId:control.workspaceId,
      database:'workspace.sqlite',sourceHash,completedAt:journal.preparedAt},{fsAdapter});
    await fault('migration.legacy-marked');
  }
  const markedControl=structuredClone(control);markedControl.migrationJournal.sqlite.phase='marked';await commitControl(markedControl);
  await fault('migration.control-marked');
  for(const input of journal.legacyFiles||[]){
    if(!/^(?:job-index\.json|runs\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json)$/.test(input.path))throw failure('旧源路径不安全。');
    const old=await readOptional(fsAdapter,path.join(dataDir,input.path));
    if(old===null)continue;
    if(contentHash(old)!==input.hash)throw failure('旧源在迁移后发生变化，已保留。');
    await fsAdapter.unlink(path.join(dataDir,input.path));
  }
  await fault('migration.legacy-consumed');
  const completed=structuredClone(control);completed.migrationJournal.sqlite.phase='complete';
  delete completed.migrationJournal.sqlite.exclusiveOwnerPid;
  await commitControl(completed);
  await fault('migration.control-complete');
  return {changed:true,sourceHash,phase:'complete',archiveId};
}
