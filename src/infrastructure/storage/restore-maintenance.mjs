import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentHash, canonicalContentHash } from './content-hash.mjs';
import { writeAtomicJson } from './atomic.mjs';
import { filterBackup } from './backup-filter.mjs';
import { createManagedSnapshotPort, assertSnapshotPath } from './managed-snapshots.mjs';
import { createWorkspaceOperationGate } from '../../application/workspace-operations.mjs';
import { assertWorkspace } from '../../domain/contracts.mjs';
import { packageError, UUID_RE, PACKAGE_KINDS } from '../../domain/packages.mjs';
import { packageRecords } from '../../domain/package-ownership.mjs';
import { redactBusiness } from '../../domain/redact.mjs';

const businessHash=w=>canonicalContentHash({...w,revision:0,operationLeases:{}});
const pending=()=>packageError('workspace_restore_pending','备份恢复尚未完成，业务访问暂时关闭。请重试恢复或重新启动。',503);
const archiveFor=(workspace,snapshots,at)=>({manifest:{version:1,schemaVersion:workspace.schemaVersion,createdAt:at,
  workspaceHash:contentHash(workspace),snapshots:Object.fromEntries(Object.entries(snapshots).map(([id,value])=>[id,contentHash(value)]))},workspace,runSnapshots:snapshots});
const validateArchive=archive=>{
  assertWorkspace(archive.workspace);
  if(archive.manifest?.version!==1||contentHash(archive.workspace)!==archive.manifest.workspaceHash)throw pending();
  for(const [id,value]of Object.entries(archive.runSnapshots||{}))if(!/^[A-Za-z0-9_-]{1,160}$/.test(id)||contentHash(value)!==archive.manifest.snapshots[id])throw pending();
  return archive;
};
const fileAt=(dataDir,id)=>{
  if(!/^workspace-restore-(?:source|plan)-[a-f0-9-]{36}\.json$/.test(id))throw pending();
  return path.join(dataDir,'backups',id);
};
const trashFields=['packageId','kind','versionId','state','archiveId','archivedAt','purgeAt'];
const trashEpisodes=w=>Object.values(w.packages).filter(p=>p.state==='trashed').sort((a,b)=>a.packageId.localeCompare(b.packageId))
  .map(p=>Object.fromEntries(trashFields.map(key=>[key,p[key]])));
const trashAuthority=w=>({version:1,packages:trashEpisodes(w)});
function assertTrashAuthority(local,planned,authority,snapshots){
  if(!authority||authority.version!==1||!Array.isArray(authority.packages)||
    Object.keys(authority).some(key=>!['version','packages'].includes(key))||
    new Set(authority.packages.map(p=>p?.packageId)).size!==authority.packages.length)throw pending();
  for(const p of authority.packages)if(!p||Object.keys(p).length!==trashFields.length||trashFields.some(key=>!Object.hasOwn(p,key))||
    !UUID_RE.test(p.packageId||'')||!UUID_RE.test(p.archiveId||'')||!PACKAGE_KINDS.includes(p.kind)||p.state!=='trashed'||
    typeof p.versionId!=='string'||!p.versionId||!Number.isFinite(Date.parse(p.archivedAt))||!Number.isFinite(Date.parse(p.purgeAt)))throw pending();
  if(canonicalContentHash(trashEpisodes(local))!==canonicalContentHash(authority.packages))throw pending();
  const localRecords=packageRecords(local),plannedRecords=packageRecords(planned);
  const owned=(records,id)=>records.filter(n=>n.record.ownerPackageId===id)
    .map(n=>({collection:n.collection,record:n.record})).sort((a,b)=>a.record.recordId.localeCompare(b.record.recordId)||a.collection.localeCompare(b.collection));
  for(const episode of authority.packages){
    const target=planned.packages[episode.packageId];
    if(!target||trashFields.some(key=>target[key]!==episode[key]))throw pending();
    // Local archived bodies remain authoritative, including detached owned
    // copies/events. A valid outer manifest must not replace them with old data.
    if(canonicalContentHash(owned(localRecords,episode.packageId))!==canonicalContentHash(owned(plannedRecords,episode.packageId))||
      canonicalContentHash(local.targetMembers?.[episode.versionId]||{})!==canonicalContentHash(planned.targetMembers?.[episode.versionId]||{}))throw pending();
    if(snapshots!==undefined)for(const run of Object.values(local.runs).filter(r=>r.ownerPackageId===episode.packageId&&r.snapshotRef))
      if(!snapshots[run.runId]||contentHash(snapshots[run.runId])!==run.snapshotRef.hash)throw pending();
  }
}

async function preparePlan({repository,task,source,operationLease,fsAdapter}){
  const local=await repository.exportWorkspace(),control=await repository.readControl();
  const filtered=filterBackup({workspace:source.workspace,snapshots:source.runSnapshots,control,now:repository.clock.now(),currentWorkspace:local});
  const restored=filtered.workspace,snapshots=filtered.snapshots;
  // Current local trash is authoritative, including its original 72h episode.
  // Time can pass after the outer preflight. Every current local trash episode
  // remains authoritative even at/after72h; its ordinary body/restore access
  // stays denied and a later real permanent-delete operation will remove it.
  for(const pkg of Object.values(local.packages).filter(pkg=>pkg.state==='trashed')){
    restored.packages[pkg.packageId]=structuredClone(pkg);
    for(const collection of ['profiles','targets']){
      for(const [id,list]of Object.entries(restored[collection])){
        restored[collection][id]=list.filter(row=>row.ownerPackageId!==pkg.packageId);if(!restored[collection][id].length)delete restored[collection][id];
      }
      for(const [id,list]of Object.entries(local[collection])){
        const owned=list.filter(row=>row.ownerPackageId===pkg.packageId);if(!owned.length)continue;
        (restored[collection][id]||=[]).push(...structuredClone(owned));
        for(const row of owned)restored.versionMetadata[row.revisionId]=structuredClone(local.versionMetadata[row.revisionId]);
      }
    }
    for(const collection of ['jobs','observations','evaluations','runs','applications','events','files']){
      for(const [id,row]of Object.entries(restored[collection]))if(row.ownerPackageId===pkg.packageId)delete restored[collection][id];
      for(const [id,row]of Object.entries(local[collection]))if(row.ownerPackageId===pkg.packageId)restored[collection][id]=structuredClone(row);
    }
    if(local.targetMembers[pkg.versionId])restored.targetMembers[pkg.versionId]=structuredClone(local.targetMembers[pkg.versionId]);
    else delete restored.targetMembers[pkg.versionId];
    restored.recoveryRecords=(restored.recoveryRecords||[]).filter(r=>r.ownerPackageId!==pkg.packageId)
      .concat(structuredClone((local.recoveryRecords||[]).filter(r=>r.ownerPackageId===pkg.packageId)));
    for(const run of Object.values(local.runs).filter(run=>run.ownerPackageId===pkg.packageId&&run.snapshotRef)){
      const filename=path.join(repository.dataDir,run.snapshotRef.path);await assertSnapshotPath(repository.dataDir,filename,fsAdapter);
      const snapshot=JSON.parse(await fsAdapter.readFile(filename,'utf8'));if(contentHash(snapshot)!==run.snapshotRef.hash)throw pending();snapshots[run.runId]=snapshot;
    }
  }
  const authority=trashAuthority(local);
  assertTrashAuthority(local,restored,authority,snapshots);
  restored.operationLeases={[operationLease.operationId]:structuredClone(local.operationLeases[operationLease.operationId])};
  const at=new Date(repository.clock.now()).toISOString();
  for(const run of Object.values(restored.runs))if(['queued','running'].includes(run.status)){
    Object.assign(run,{status:'interrupted',stage:'finished',finishedAt:at,ownerPid:null,cancelRequestedAt:null,snapshotRef:null});
    run.issues=[...(run.issues||[]),{code:'restored_unfinished_run',message:'恢复的未完成任务已中断，请重新更新来源。'}];
  }
  assertWorkspace(restored);
  await repository.withWriteFence(async fence=>{
    if(fence.getMeta('revision')!==local.revision)throw pending();
    // The operation lease excludes other writers, but still merge the current
    // durable maintenance task rather than replacing the control file from backup.
    const next=filtered.control,current=fence.control;
    if(canonicalContentHash(current)!==canonicalContentHash(control))throw pending();
    next.migrationJournal.maintenance={...next.migrationJournal.maintenance,...current.migrationJournal.maintenance};
    Object.assign(next.migrationJournal.maintenance[task.taskId],{phase:'prepared',planHash:businessHash(restored),trashAuthority:authority});
    await fence.commitControl(next);
  },{operationLease,operationMaintenance:true});
  return archiveFor(restored,snapshots,task.preparedAt);
}

async function runRestoreTask({repository,taskId,operationLease,fsAdapter=fs,faultInjector}){
  const fault=async phase=>{if(faultInjector)await faultInjector(phase);};
  const getTask=async()=>{const task=(await repository.readControl()).migrationJournal.maintenance?.[taskId];if(!task||task.kind!=='restore'||
    !['preparing','prepared','files','files-ready','published','cleaning','complete'].includes(task.phase))throw pending();return task;};
  const stage=async phase=>repository.withWriteFence(async fence=>{
    const next=fence.control,task=next.migrationJournal.maintenance[taskId];if(!task||task.kind!=='restore')throw pending();task.phase=phase;await fence.commitControl(next);
  },{operationLease,operationMaintenance:true});
  let task=await getTask();if(task.phase==='complete')return {revision:await repository.getMeta('revision'),recovered:true};
  if(task.phase==='published'||task.phase==='cleaning'){
    const current=await repository.exportWorkspace();
    if(businessHash(current)!==task.planHash)throw pending();
    // Old published tasks without retained authority cannot be guessed safe.
    // Stop rather than claiming to reconstruct a possibly lost trash episode.
    assertTrashAuthority(current,current,task.trashAuthority);
  }else{
    let plan;
    try{plan=validateArchive(JSON.parse(await fsAdapter.readFile(fileAt(repository.dataDir,task.planId),'utf8')));}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      const source=validateArchive(JSON.parse(await fsAdapter.readFile(fileAt(repository.dataDir,task.sourceId),'utf8')));
      plan=await preparePlan({repository,task,source,operationLease,fsAdapter});
      await fault('restore.control-prepared');
      await writeAtomicJson(fileAt(repository.dataDir,task.planId),plan,{fsAdapter});
      await fault('restore.plan-written');
    }
    task=await getTask();if(businessHash(plan.workspace)!==task.planHash)throw pending();
    // Adopt this recovery attempt's live exclusive lease; never revive a lease
    // from the archive or the process which crashed during the previous attempt.
    const currentLease=await repository.getRow({collection:'operationLeases',id:operationLease.operationId},{operationLease});
    if(!currentLease||currentLease.token!==operationLease.token)throw pending();
    plan.workspace.operationLeases={[operationLease.operationId]:currentLease};
    await stage('files');await fault('restore.control-files');
    await repository.withMaintenanceTransaction(async current=>{
      const latest=current.control.migrationJournal.maintenance[taskId];
      if(latest?.planHash!==task.planHash)throw pending();
      // Check the complete local trash authority before the first file can be
      // replaced, under the same formal fence as every snapshot replacement.
      assertTrashAuthority(current.workspace,plan.workspace,latest.trashAuthority,plan.runSnapshots||{});
      const localSnapshots=createManagedSnapshotPort({dataDir:repository.dataDir,fsAdapter,clock:repository.clock,tx:current,options:{operationLease}});
      for(const run of Object.values(current.workspace.runs).filter(r=>current.workspace.packages[r.ownerPackageId]?.state==='trashed'&&r.snapshotRef)){
        const files=Object.values(current.workspace.files).filter(f=>f.runId===run.runId&&f.ownerPackageId===run.ownerPackageId&&f.kind==='run_snapshot'),snapshot=await localSnapshots.readSnapshot(run.runId);
        if(files.length!==1||run.snapshotRef.path!=='runs-v2/'+run.runId+'.json'||files[0].path!==run.snapshotRef.path||
          files[0].hash!==run.snapshotRef.hash||files[0].snapshotRecordId!==snapshot.recordId||
          snapshot.ownerPackageId!==run.ownerPackageId||contentHash(snapshot)!==run.snapshotRef.hash)throw pending();
      }
      const snapshotPort=createManagedSnapshotPort({dataDir:repository.dataDir,fsAdapter,clock:repository.clock,
        tx:{workspace:plan.workspace,control:current.control},options:{operationLease}});
      for(const [id,snapshot]of Object.entries(plan.runSnapshots||{}))if(plan.workspace.runs[id]?.snapshotRef)await snapshotPort.replaceSnapshot(id,snapshot);
    },{operationLease,operationMaintenance:true});
    await fault('restore.snapshots-written');
    await stage('files-ready');await fault('restore.control-files-ready');
    await repository.withMaintenanceTransaction(async tx=>{
      if(tx.control.migrationJournal.maintenance[taskId]?.planHash!==task.planHash)throw pending();
      assertTrashAuthority(tx.workspace,plan.workspace,tx.control.migrationJournal.maintenance[taskId].trashAuthority,plan.runSnapshots||{});
      const lease=tx.workspace.operationLeases[operationLease.operationId];
      plan.workspace.operationLeases={[operationLease.operationId]:structuredClone(lease)};
      await tx.commitWorkspace(plan.workspace);
    },{operationLease,operationMaintenance:true});
    await fault('restore.sql-published');
    if(businessHash(await repository.exportWorkspace())!==task.planHash)throw pending();
    await stage('published');await fault('restore.control-published');
  }
  await stage('cleaning');
  for(const id of [task.sourceId,task.planId]){
    const filename=fileAt(repository.dataDir,id);await assertSnapshotPath(repository.dataDir,filename,fsAdapter,{allowMissing:true});
    await fsAdapter.unlink(filename).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  await fault('restore.plan-cleaned');
  await stage('complete');await fault('restore.control-complete');
  return {revision:await repository.getMeta('revision'),recovered:true};
}

export async function restoreWorkspaceWithIntent({repository,source,operationLease,fsAdapter=fs,faultInjector}){
  const existingTasks=Object.values((await repository.readControl()).migrationJournal.maintenance||{}).filter(task=>task?.kind==='restore'&&task.phase!=='complete'&&task.phase!=='aborted');
  if(existingTasks.length>1)throw pending();
  const existing=existingTasks[0];
  if(existing){
    if(existing.sourceHash!==contentHash(redactBusiness(source.workspace)))throw pending();
    return runRestoreTask({repository,taskId:existing.taskId,operationLease,fsAdapter,faultInjector});
  }
  const taskId=randomUUID(),preparedAt=new Date(repository.clock.now()).toISOString(),sourceId='workspace-restore-source-'+taskId+'.json',planId='workspace-restore-plan-'+taskId+'.json';
  const clean=archiveFor(redactBusiness(source.workspace),redactBusiness(source.runSnapshots||{}),preparedAt);
  await writeAtomicJson(fileAt(repository.dataDir,sourceId),clean,{fsAdapter});
  if(faultInjector)await faultInjector('restore.source-written');
  await repository.withWriteFence(async fence=>{
    const next=fence.control;next.migrationJournal.maintenance||={};
    next.migrationJournal.maintenance[taskId]={taskId,kind:'restore',phase:'preparing',preparedAt,sourceId,planId,sourceHash:clean.manifest.workspaceHash};
    await fence.commitControl(next);
  },{operationLease,operationMaintenance:true});
  if(faultInjector)await faultInjector('restore.control-preparing');
  return runRestoreTask({repository,taskId,operationLease,fsAdapter,faultInjector});
}

export async function recoverPendingStorageMaintenance({repository,fsAdapter=fs,faultInjector}){
  const pendingTasks=Object.values((await repository.readControl()).migrationJournal.maintenance||{}).filter(task=>task.kind==='restore'&&task.phase!=='complete'&&task.phase!=='aborted');
  if(!pendingTasks.length)return {recovered:0};
  if(pendingTasks.length>1)throw pending();
  const gate=createWorkspaceOperationGate({repository});await gate.recover();
  for(const task of pendingTasks)await gate.withOperation('restore',{},lease=>runRestoreTask({repository,taskId:task.taskId,operationLease:lease,fsAdapter,faultInjector}));
  return {recovered:pendingTasks.length};
}
