import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { openPackageControl, applyDeletionLedger } from './package-control.mjs';
import { openSqliteRowStore } from './sqlite-store.mjs';
import { PRIVATE_COLLECTIONS } from './sqlite-schema.mjs';
import { createManagedSnapshotPort, assertSnapshotOwner, assertSnapshotPath, snapshotPath } from './managed-snapshots.mjs';
import { withWorkspaceLock } from './lock.mjs';
import { assertWorkspace } from '../../domain/contracts.mjs';
import { requirePackage, assertScope, packageError, UUID_RE } from '../../domain/packages.mjs';
import { assertOperationWriteAllowed } from '../../application/workspace-operations.mjs';
import { canonicalContentHash } from './content-hash.mjs';
import { countPackageRows } from './package-counts.mjs';
import { createOwnedRunSnapshotWriter } from './owned-run-snapshots.mjs';
import { contentHash } from './content-hash.mjs';
import { hasLiveOwner } from './process-owner.mjs';
import { createStorageDiagnostics, tagStorageError } from './diagnostics.mjs';
import { inspectExistingMaintenance, existingMaintenanceState, recheckExistingMaintenance, assertExistingDatabasePathSync } from './maintenance-existing.mjs';
import { assertPurgeDescriptor, assertPurgeJournal, assertPurgeLease, assertPurgeWorker, assertPurgeHostStatus, samePurgeDescriptor,
  purgeDescriptor, purgeClaimError, isProtectedPurgeLease, PURGE_REPLACEMENT_STAGES } from '../maintenance/protocol.mjs';
export { contentHash } from './content-hash.mjs';

const clone=value=>value===undefined?undefined:structuredClone(value);
const packageFields=['packageId','kind','versionId','versionName','nameKey','enabled','state','archiveId','archivedAt','purgeAt'];
const packageMetadata=value=>Object.fromEntries(packageFields.filter(key=>Object.hasOwn(value,key)).map(key=>[key,clone(value[key])]));
const signature=stat=>{
  const fields=[stat.dev,stat.ino,stat.size,stat.mtimeNs??stat.mtimeMs,stat.ctimeNs??stat.ctimeMs];
  return fields.some(value=>value===undefined||value===null)?null:fields.map(String).join(':');
};

/** The only production assembler of the SQLite business store and monotonic control fence. */
export async function openWorkspaceRepository({dataDir,fsAdapter=fs,clock={now:()=>Date.now()},
  diagnostics,allowLegacy=false,busyTimeoutMs=250,faultInjector,onStartupStage,existingMaintenanceBinding}={}){
  if(!dataDir)throw Error('Missing data directory');
  dataDir=path.resolve(dataDir);
  const maintenanceState=existingMaintenanceBinding===undefined?null:existingMaintenanceState(existingMaintenanceBinding,{dataDir});
  if(!maintenanceState)await fsAdapter.mkdir(dataDir,{recursive:true});
  const storageDiagnostics=createStorageDiagnostics({diagnostics,metrics:()=>store.metrics()});
  const controlStore=openPackageControl({dataDir,fsAdapter,captureFileIdentity:true,onRenameRecovery:storageDiagnostics.onControlRenameRecovery});
  const heldLock=new AsyncLocalStorage();
  // The common lock normally creates its directory (and a reclaimer directory
  // when recovering a dead owner). Maintenance may use existing coordination
  // paths but must never initialize them. Keep ordinary callers unchanged.
  const lockFsAdapter=maintenanceState?{...fsAdapter,async mkdir(directory){
    const resolved=path.resolve(directory),key=value=>process.platform==='win32'?value.toLowerCase():value;
    if(![dataDir,path.join(dataDir,'.workspace.lock.reclaimers')].some(allowed=>key(allowed)===key(resolved)))
      throw purgeClaimError('purge_existing_store_required');
    const stat=await fsAdapter.lstat(resolved,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink()||key(await fsAdapter.realpath(resolved))!==key(resolved))
      throw purgeClaimError('purge_existing_store_required');
  }}:fsAdapter;
  const counts={maintenanceReads:0,maintenanceMutations:0,maintenanceTransactions:0,controlReads:0,controlCacheHits:0,writeFences:0};
  let closed=false,queue=Promise.resolve(),controlCache,activePort,bootstrapping=true;
  const controlIndexes=new WeakMap();
  const controlIdentities=new WeakMap(),purgeReplacementTokens=new WeakMap();
  const controlIdentity=control=>{let value=controlIdentities.get(control);if(value===undefined){value=canonicalContentHash(control);controlIdentities.set(control,value);}return value;};
  const deletionHeads=new WeakMap();
  const deletionHeadFor=control=>{
    let head=deletionHeads.get(control);
    if(head===undefined){head=canonicalContentHash(indexesFor(control).excludedOwnerPackageIds);deletionHeads.set(control,head);}
    return head;
  };
  const indexesFor=control=>{
    let indexes=controlIndexes.get(control);
    if(!indexes){indexes={deletedRecords:new Set(Object.values(control.deletionLedger).flatMap(entry=>entry.recordIds)),
      packageIdentities:new Set(Object.values(control.identityIndex.package)),
      excludedOwnerPackageIds:[...new Set([...Object.keys(control.deletionLedger),...Object.entries(control.migrationJournal?.archives||{}).filter(([,task])=>task.phase==='prepared').map(([owner])=>owner)])].sort()};controlIndexes.set(control,indexes);}
    return indexes;
  };
  const assertOpen=()=>{if(closed)throw packageError('workspace_repository_closed','工作区仓储已关闭。',503);};
  const inLock=async action=>{
    assertOpen();const inherited=heldLock.getStore();
    if(inherited?.active)return action(inherited);
    return withWorkspaceLock(dataDir,async()=>{
      const token={active:true};
      try{return await heldLock.run(token,()=>action(token));}finally{token.active=false;}
    },{fsAdapter:lockFsAdapter});
  };
  const fingerprint=async()=>{
    if(typeof fsAdapter.stat!=='function')return null;
    const parts=[];
    for(const name of ['state.json','initialized.json']){
      try{const value=signature(await fsAdapter.stat(path.join(dataDir,'control',name),{bigint:true}));if(value===null)return null;parts.push(value);}
      catch(error){if(error.code!=='ENOENT')throw error;parts.push('missing');}
    }
    return parts.join('|');
  };
  const currentControl=async({fresh=false}={})=>{
    assertOpen();
    for(let attempt=0;attempt<3;attempt++){
      const before=await fingerprint();
      if(!fresh&&before!==null&&controlCache?.signature===before){counts.controlCacheHits++;return controlCache.control;}
      counts.controlReads++;controlCache=undefined;
      const control=await controlStore.read();
      const after=await fingerprint();
      if(before!==null&&before!==after)continue;
      if(after!==null)controlCache={signature:after,control};
      return control;
    }
    throw packageError('control_state_invalid','控制状态正在改变，已停止本次业务访问。',503);
  };
  const unavailable=control=>Object.values(control.migrationJournal?.maintenance||{}).some(task=>task.phase!=='complete'&&task.phase!=='aborted');
  const assertAccess=(owner,control,options={},readPort=store)=>{
    if(control.deletionLedger[owner])throw packageError('package_purge_pending','版本正在永久清理或已永久删除。');
    if(options.access!=='management'&&control.migrationJournal?.archives?.[owner]?.phase==='prepared')
      throw packageError('workspace_maintenance_pending','版本归档尚未完成，请等待清理或重试归档。',503);
    const value=callStore(()=>readPort.getRow({collection:'packages',id:owner}));
    if(!value){
      if(options.newPackages?.has(owner)&&indexesFor(control).packageIdentities.has(owner))return;
      throw packageError('package_not_found','版本数据包不存在。',404);
    }
    requirePackage({packages:{[owner]:value}},owner,{access:options.access||'business',now:clock.now()});
  };
  const validate=(selection,control,options={},readPort=store)=>{
    if(unavailable(control)&&!options.operationMaintenance&&!options.operationLease&&(options.enforceMaintenance||options.scope||selection?.select?.length))
      throw packageError('workspace_maintenance_pending','工作区维护尚未完成，业务访问暂时关闭。',503);
    if(options.scope){
      const value=callStore(()=>readPort.getRow({collection:'packages',id:options.scope.packageId}));
      if(control.deletionLedger[options.scope.packageId])throw packageError('package_purge_pending','该版本正在永久清理。');
      assertScope({packages:value?{[value.packageId]:value}:{}},options.scope,clock.now());
    }
    for(const s of selection?.select||[]){
      if(PRIVATE_COLLECTIONS.has(s.collection)&&s.ownerPackageId===undefined&&!s.ownerPackageIds)
        throw packageError('sqlite_scope_required','私有记录查询需要明确 owner。',400);
      const owners=s.ownerPackageIds||(s.ownerPackageId!==undefined?[s.ownerPackageId]:[]);
      for(const owner of owners){
        if(options.scope&&owner!==options.scope.packageId)throw packageError('package_scope_mismatch','查询归属与目标范围不一致。');
        assertAccess(owner,control,options,readPort);
      }
    }
  };
  const callStore=action=>{try{const result=action();return typeof result?.then==='function'?result.catch(error=>{throw tagStorageError(error);}):result;}catch(error){throw tagStorageError(error);}};
  const measureStore=action=>activePort?.observation?activePort.observation.measure(action):action();
  const guard=(input,readPort)=>{
    if(bootstrapping)return;
    if(!['write','commit','replace','import'].includes(input.phase))return;
    if(!activePort?.token.active||heldLock.getStore()!==activePort.token)throw packageError('workspace_fence_closed','写入缺少有效工作区 fence。',503);
    const {control,options}=activePort;
    if(!options.operationMaintenance&&!(options.maintenanceContext&&input.phase==='replace')){
      for(const owner of input.ownerPackageIds||[])assertAccess(owner,control,options,readPort);
      for(const id of input.recordIds||[])if(indexesFor(control).deletedRecords.has(id))
        throw packageError('package_purge_pending','记录已列入永久删除账本。');
    }
  };
  const storeOptions={filename:path.join(dataDir,'workspace.sqlite'),busyTimeoutMs,guard,
    faultInjector:faultInjector?(phase,context)=>faultInjector('sqlite.'+phase,context):undefined,
    ...(maintenanceState?{existingMaintenanceBinding}:{})};
  const store=maintenanceState?await inLock(async()=>{
    const before=await recheckExistingMaintenance(existingMaintenanceBinding),opened=openSqliteRowStore(storeOptions);
    try{
      const after=await recheckExistingMaintenance(existingMaintenanceBinding);
      if(before.controlDigest!==after.controlDigest)throw purgeClaimError('purge_state_changed');return opened;
    }catch(error){opened.close();throw error;}
  }):openSqliteRowStore(storeOptions);
  let migration;
  try{
    if(maintenanceState)migration={changed:false,phase:'complete',sourceHash:maintenanceState.sourceHash,existingOnly:true};
    else migration=await inLock(async()=>{
      const {migrateWorkspaceToSqlite}=await import('./sqlite-migration.mjs'),{ensureSqliteReadModels}=await import('./read-model-maintenance.mjs');
      const result=await migrateWorkspaceToSqlite({dataDir,store,controlStore,fsAdapter,clock,faultInjector,allowLegacy});
      await ensureSqliteReadModels({store,controlStore,clock,faultInjector,onStartupStage});return result;});
    bootstrapping=false;controlCache=undefined;
  }catch(error){store.close();throw error;}finally{storageDiagnostics.flushControlRecoveries();}
  const queryOptionsFor=(method,input,options={})=>{
    const scope=input?.scope||(['queryJobPage','queryApplicationPage','queryLegacyApplicationPage'].includes(method)&&!input?.allTargets&&(input?.packageId||input?.targetRevisionId)?{packageId:input.packageId,targetRevisionId:input.targetRevisionId}:undefined);
    if(!scope)return options;
    if(options.scope&&(options.scope.packageId!==scope.packageId||options.scope.targetRevisionId!==scope.targetRevisionId))throw packageError('package_scope_mismatch','查询范围与目标版本不一致。');
    return {...options,scope};
  };
  const readBounded=async(method,input,options={})=>{
    options=queryOptionsFor(method,input,options);
    assertOpen();const control=await currentControl();
    const jobQuery=['queryJobPage','queryApplicationPage','findJobIdentityCandidates','queryJobQuality','readJobBodySignatures','readJobHead','queryJobRelatedPage','queryCollectionSnapshot','queryRunHeads','queryCollectionSlicePage','discoverLegacyOwners','queryLegacyApplicationPage','queryLegacyTrackingSummary','queryLegacyTrackingPage','queryLegacyRunTargets','findLegacyApplicationIds','queryDiagnosticRunScopes'].includes(method);
    const queryOwner=options.scope?.packageId||input?.scope?.packageId||input?.ownerPackageId;
    const selection=jobQuery?{select:queryOwner?[{collection:'packages',ownerPackageId:queryOwner}]:[]}:method==='readView'?input:{select:method==='getMeta'?[]:[input]};
    if(method==='readChanges')selection.select=input?.ownerPackageId?[{collection:'packages',ownerPackageId:input.ownerPackageId}]:[];
    validate(selection,control,{...options,enforceMaintenance:jobQuery});
    const excludedOwnerPackageIds=indexesFor(control).excludedOwnerPackageIds;
    let result=callStore(()=>jobQuery?store[method](['queryCollectionSnapshot','queryRunHeads','queryCollectionSlicePage'].includes(method)?{...input,excludedOwnerPackageIds}:input,{...options,excludedOwnerPackageIds}):store[method](input));
    const latest=await currentControl();validate(selection,latest,{...options,enforceMaintenance:jobQuery});
    if(jobQuery&&latest!==control&&JSON.stringify(indexesFor(latest).excludedOwnerPackageIds)!==JSON.stringify(excludedOwnerPackageIds))throw packageError('workspace_control_changed','删除或归档控制状态已更新，请重新读取。',409);
    if(jobQuery)for(const item of [result?.items,result?.collections,result?.runs].find(Array.isArray)||[])if(item.ownerPackageId||item.scope?.packageId)assertAccess(item.ownerPackageId||item.scope.packageId,latest,{...options,scope:item.scope||options.scope});
    if(['queryJobPage','queryApplicationPage','readJobHead'].includes(method))result={...result,controlDeletionHead:deletionHeadFor(latest)};
    const returnedValues=method==='getRow'?[result]:method==='getRecord'?[result?.value]:method==='queryRows'?result.rows.map(row=>row.value):method==='readView'?Object.values(result.rows).flatMap(rows=>Object.values(rows)):[];
    for(const value of returnedValues)if(value?.recordId&&indexesFor(latest).deletedRecords.has(value.recordId))throw packageError('package_purge_pending','记录已列入永久删除账本。');
    if((method==='getRow'||method==='getRecord')&&input.collection==='packages'&&result){
      const value=method==='getRow'?result:result.value;assertAccess(value.packageId,latest,options);
    }
    if(method==='queryRows'&&input.collection==='packages')result={...result,rows:result.rows.map(row=>({...row,value:packageMetadata(row.value)}))};
    if(method==='readView'&&result.rows.packages)for(const [id,value]of Object.entries(result.rows.packages))result.rows.packages[id]=packageMetadata(value);
    return clone(result);
  };
  const operationView=()=>{
    if(callStore(()=>store.getMeta('schemaVersion'))===2)return callStore(()=>store.exportWorkspace());
    const leases=callStore(()=>store.queryRows({collection:'operationLeases',limit:200}));
    if(leases.hasMore)throw packageError('workspace_operation_busy','活动操作超过安全上限。',409);
    return {operationLeases:Object.fromEntries(leases.rows.map(row=>[row.id,row.value]))};
  };
  const purgeTaskFor=(control,descriptor,{states=['starting','running','retry_wait','stopped','completed']}={})=>{
    assertPurgeDescriptor(descriptor);
    const task=control.purgeTasks[descriptor.taskId],ledger=control.deletionLedger[descriptor.packageId];
    if(!task||!ledger||task.packageId!==descriptor.packageId||ledger.operationId!==descriptor.taskId||
      !samePurgeDescriptor(purgeDescriptor(task),descriptor)||!states.includes(task.worker.state))throw purgeClaimError();
    assertPurgeWorker(task.worker,{task});return task;
  };
  const requireMaintenanceBinding=binding=>{
    if(!maintenanceState||binding!==existingMaintenanceBinding)throw purgeClaimError();
    return existingMaintenanceState(binding,{dataDir,descriptor:maintenanceState.descriptor});
  };
  const runningPurgeAuthority=(control,{readPort=store}={})=>{
    if(!maintenanceState)throw purgeClaimError();
    const descriptor=maintenanceState.descriptor,task=purgeTaskFor(control,descriptor,{states:['running']}),
      journal=assertPurgeJournal(readPort.getMeta('purgeWorkerJournal')),
      lease=readPort.getRow({collection:'operationLeases',id:descriptor.leaseOperationId});
    if(!journal||!samePurgeDescriptor(journal.descriptor,descriptor)||journal.state!=='running'||journal.workerPid!==process.pid||
      task.worker.workerPid!==process.pid||task.worker.journalSequence!==journal.sequence)throw purgeClaimError();
    assertPurgeLease(lease,descriptor,{workerPid:process.pid,token:journal.leaseToken});
    return {descriptor,task,journal,lease};
  };
  // Fixed recovery metadata only, including inaccessible owners. These flags do
  // not grant any ordinary body-read/write capability.
  const recoveryHeads=(page,control)=>({...page,rows:page.rows.map(head=>{
    const owner=head.ownerPackageId;let deferredReason=null;
    if(!owner||!head.packageState)deferredReason='package_not_found';
    else if(control.deletionLedger[owner])deferredReason='deletion_pending';
    else if(['purge_pending','purged'].includes(head.packageState))deferredReason='package_purge_pending';
    else if(control.migrationJournal?.archives?.[owner]?.phase==='prepared')deferredReason='archive_prepared';
    else if(head.packageState==='trashed'&&clock.now()>=Date.parse(head.purgeAt))deferredReason='package_expired';
    return {...head,deferredReason};
  })});
  const withWriteFence=(action,options={})=>{
    if(typeof action!=='function')return Promise.reject(Error('A fence callback is required'));
    if(heldLock.getStore()?.active)return Promise.reject(packageError('workspace_fence_nested','已有写入 fence，请复用传入的 fence。',503));
    const observation=storageDiagnostics.startFence();
    const run=async()=>{let failure;try{return await inLock(async token=>{
      observation.acquired();
      counts.writeFences++;let live=true,controlWriting=false,pendingControl;
      const control=await currentControl();
      const state={control,options:{...options},token,observation};
      const previousPort=activePort;activePort=state;
      const ensureCapability=()=>{assertOpen();if(!live||!token.active||heldLock.getStore()!==token||activePort!==state)throw packageError('workspace_fence_closed','工作区 fence 已结束。',503);};
      const ensure=()=>{ensureCapability();if(controlWriting)throw packageError('workspace_fence_busy','请等待当前控制提交完成。',503);};
      const check=selection=>{ensure();validate(selection,state.control,state.options);};
      let purgeLeaseRecord;
      const purgeLeaseFor=packageId=>{
        ensure();const supplied=state.options.operationLease;
        if(!supplied?.operationId||!supplied.token)throw packageError('invalid_operation_lease','永久清理授权已失效。',409);
        purgeLeaseRecord||=callStore(()=>store.getRow({collection:'operationLeases',id:supplied.operationId}));
        const lease=purgeLeaseRecord;
        if(!lease||lease.operationId!==supplied.operationId||lease.token!==supplied.token||lease.kind!=='permanent-delete')
          throw packageError('invalid_operation_lease','永久清理授权已失效。',409);
        const invalidScope=()=>{throw packageError('invalid_operation_lease','永久清理授权范围已损坏。',409);};
        if(Object.hasOwn(lease,'packageIds')&&(!Array.isArray(lease.packageIds)||lease.packageIds.some(id=>typeof id!=='string'||!UUID_RE.test(id))||new Set(lease.packageIds).size!==lease.packageIds.length))invalidScope();
        if(Object.hasOwn(lease,'packageId')&&(typeof lease.packageId!=='string'||!UUID_RE.test(lease.packageId)))invalidScope();
        if(lease.scope!==undefined&&lease.scope!==null&&(!lease.scope||Object.getPrototypeOf(lease.scope)!==Object.prototype||
          Object.keys(lease.scope).some(key=>!['packageId','targetRevisionId'].includes(key))||
          typeof lease.scope.packageId!=='string'||!UUID_RE.test(lease.scope.packageId)||
          (Object.hasOwn(lease.scope,'targetRevisionId')&&(typeof lease.scope.targetRevisionId!=='string'||!lease.scope.targetRevisionId))))invalidScope();
        const ids=Object.hasOwn(lease,'packageIds')?lease.packageIds:lease.packageId?[lease.packageId]:lease.scope?.packageId?[lease.scope.packageId]:[];
        if((lease.packageId&&!ids.includes(lease.packageId))||(lease.scope?.packageId&&!ids.includes(lease.scope.packageId)))invalidScope();
        // An unscoped resume lease may only inspect an existing pending task it
        // owns through the current ledger. A random task must not grant access.
        const ledger=state.control.deletionLedger[packageId],task=state.control.purgeTasks[ledger?.operationId];
        const pending=ledger?.phase==='purge_pending'&&task&&task.operationId===ledger.operationId&&task.packageId===packageId&&
          ['prepared','purge_pending','verified'].includes(task.phase)&&Array.isArray(task.files)&&
          task.counts&&ledger.counts&&JSON.stringify(task.counts)===JSON.stringify(ledger.counts);
        if(!ids.includes(packageId)&&!(ids.length===0&&pending))throw packageError('package_scope_mismatch','永久清理授权范围不符。',409);
        const acquiredRevision=callStore(()=>store.readPurgeLeaseRevision(lease.operationId));
        if(!Number.isSafeInteger(acquiredRevision))throw packageError('invalid_operation_lease','永久清理授权缺少持久版本。',409);
        return {...lease,acquiredRevision};
      };
      const fence={
        get control(){ensure();return clone(state.control);},
        commitControl(next){
          ensure();const proposed=clone(next);controlCache=undefined;controlWriting=true;
          pendingControl=(async()=>{
            try{await callStore(()=>controlStore.commitInLock(proposed,{previous:state.control}));ensureCapability();state.control=proposed;}
            finally{controlWriting=false;}
          })();return pendingControl;
        },
        queryRecoveryRunHeads(input={}){return observation.measure(()=>{ensure();return recoveryHeads(callStore(()=>store.queryRecoveryRunHeads(input)),state.control);});},
        queryRecoveryRecordKeys(input){return observation.measure(()=>{ensure();return callStore(()=>store.queryRecoveryRecordKeys(input));});},
        queryPurgePlanningPage(input){return observation.measure(()=>{
          ensure();if(input?.section!=='packages')purgeLeaseFor(input?.packageId);
          return callStore(()=>store.queryPurgePlanningPage(input,state.control));
        });},
        getPurgePlanningCounts(packageId){return observation.measure(()=>{
          ensure();return callStore(()=>store.countPurgePlanningRecords(packageId,state.control));
        });},
        assertPurgeLease(packageId){return clone(purgeLeaseFor(packageId));},
        assertPurgePlanningIdentity(packageId){return observation.measure(()=>{
          purgeLeaseFor(packageId);return callStore(()=>store.assertPurgePlanningIdentity());
        });},
        getPackageCounts(packageId){return observation.measure(()=>{ensure();return callStore(()=>countPackageRows(store,packageId));});},
        readOperationState(input={}){return observation.measure(()=>{ensure();return callStore(()=>store.readOperationState(input));});},
        readPurgeWorkerJournal(){ensure();return callStore(()=>store.readPurgeWorkerJournal());},
        async reconcilePurgeWorker({isOwnerAlive=pid=>hasLiveOwner({ownerPid:pid})}={}){
          ensure();const journal=callStore(()=>store.readPurgeWorkerJournal());
          if(!journal||journal.state==='retired')return {status:'ordinary'};
          let task;try{task=purgeTaskFor(state.control,journal.descriptor);}catch{return {status:'maintenance_pending'};}
          if(journal.state==='dispatch_reserved')return {status:'maintenance_pending'};
          const lease=callStore(()=>store.getRow({collection:'operationLeases',id:journal.descriptor.leaseOperationId}));
          if(journal.state==='release_observed')return {status:'maintenance_pending'};
          try{assertPurgeLease(lease,journal.descriptor,{workerPid:journal.workerPid,token:journal.leaseToken});}catch{return {status:'maintenance_pending'};}
          let alive=true;try{alive=isOwnerAlive(lease.ownerPid)!==false;}catch{}
          // A missing publication receipt, before the first body publication,
          // proves this generation has not entered file effects. Any uncertain
          // receipt/file intent needs the later worker recovery executor instead.
          if(alive||journal.publicationReceipt!==null||!['prepared','body'].includes(journal.stage)||
            !['prepared','purge_pending'].includes(task.phase)||task.fileIntent||task.worker.fileIntent)return {status:'maintenance_pending'};
          const next=clone(state.control),current=next.purgeTasks[task.operationId];
          if(['starting','running'].includes(current.worker.state)){
            current.worker={...current.worker,state:'retry_wait',lastOutcome:'purge_worker_failed',
              nextRetryAt:new Date(Number(clock.now())+300000).toISOString()};
            current.attempts=(current.attempts||0)+1;current.nextRetryAt=current.worker.nextRetryAt;current.code='purge_worker_failed';
            await fence.commitControl(next);
          }
          const released=callStore(()=>store.updatePurgeWorkerJournal(journal.descriptor,{expectedSequence:journal.sequence,
            state:'release_observed',stage:journal.stage,leaseToken:journal.leaseToken,allowDeadOwner:true}));
          const associated=clone(state.control);associated.purgeTasks[task.operationId].worker.journalSequence=released.journal.sequence;
          await fence.commitControl(associated);return {status:'maintenance_reconciled_retry'};
        },
        ...(maintenanceState?{
          async acquirePurgeClaim(binding){
            ensure();requireMaintenanceBinding(binding);const descriptor=maintenanceState.descriptor,
              task=purgeTaskFor(state.control,descriptor,{states:['starting','running']}),journal=callStore(()=>store.readPurgeWorkerJournal());
            if(!journal||!samePurgeDescriptor(journal.descriptor,descriptor)||
              task.worker.workerPid!==null&&task.worker.workerPid!==process.pid)throw purgeClaimError();
            const acquired=callStore(()=>store.acquirePurgeWorkerLease(descriptor,{leaseToken:randomUUID(),createdAt:new Date(clock.now()).toISOString()})),
              next=clone(state.control),worker=next.purgeTasks[descriptor.taskId].worker;
            worker.workerPid=process.pid;worker.state='running';worker.startedAt??=new Date(clock.now()).toISOString();worker.journalSequence=acquired.journal.sequence;
            await fence.commitControl(next);
            const running=callStore(()=>store.updatePurgeWorkerJournal(descriptor,{expectedSequence:acquired.journal.sequence,
              state:'running',stage:acquired.journal.stage,workerPid:process.pid,leaseToken:acquired.lease.token}));
            const associated=clone(state.control);associated.purgeTasks[descriptor.taskId].worker.journalSequence=running.journal.sequence;
            await fence.commitControl(associated);
            return {...acquired.lease,acquiredRevision:callStore(()=>store.readPurgeLeaseRevision(acquired.lease.operationId))};
          },
          async releasePurgeClaim(binding,{outcome='purge_worker_stopped'}={}){
            ensure();requireMaintenanceBinding(binding);const descriptor=maintenanceState.descriptor,
              task=purgeTaskFor(state.control,descriptor),journal=callStore(()=>store.readPurgeWorkerJournal());
            if(!journal||!samePurgeDescriptor(journal.descriptor,descriptor)||journal.workerPid!==process.pid)throw purgeClaimError();
            const next=clone(state.control),current=next.purgeTasks[descriptor.taskId];
            if(current.fileIntent&&current.fileIntent.stage!=='verified')throw purgeClaimError();
            if(journal.publicationReceipt)current.sqlPublication={descriptor:clone(descriptor),...clone(journal.publicationReceipt)};
            current.worker.workerPid=process.pid;current.worker.startedAt??=new Date(clock.now()).toISOString();
            if(current.phase==='completed')current.worker.state='completed';
            else if(['starting','running'].includes(current.worker.state)){
              current.worker.state='retry_wait';current.worker.lastOutcome=outcome;
              current.worker.nextRetryAt=new Date(Number(clock.now())+300000).toISOString();
              current.attempts=(current.attempts||0)+1;current.nextRetryAt=current.worker.nextRetryAt;current.code=outcome;
            }
            await fence.commitControl(next);
            const released=callStore(()=>store.updatePurgeWorkerJournal(descriptor,{expectedSequence:journal.sequence,
              state:'release_observed',stage:current.phase==='completed'?'completed':journal.stage,leaseToken:journal.leaseToken}));
            const associated=clone(state.control);associated.purgeTasks[descriptor.taskId].worker.journalSequence=released.journal.sequence;
            await fence.commitControl(associated);return {released:true};
          },
          async beginPurgeStage(binding,stage){
            ensure();requireMaintenanceBinding(binding);if(!PURGE_REPLACEMENT_STAGES.includes(stage))throw purgeClaimError();
            const descriptor=maintenanceState.descriptor,task=purgeTaskFor(state.control,descriptor,{states:['running']}),
              journal=callStore(()=>store.readPurgeWorkerJournal()),lease=callStore(()=>store.getRow({collection:'operationLeases',id:descriptor.leaseOperationId}));
            if(!journal||journal.state!=='running'||!samePurgeDescriptor(journal.descriptor,descriptor)||journal.workerPid!==process.pid||
              task.worker.workerPid!==process.pid||(task.worker.journalSequence??0)>journal.sequence||
              stage==='final'&&task.phase!=='verified'||stage==='body'&&!['prepared','purge_pending'].includes(task.phase))throw purgeClaimError();
            assertPurgeLease(lease,descriptor,{workerPid:process.pid,token:journal.leaseToken});
            const updated=callStore(()=>store.updatePurgeWorkerJournal(descriptor,{expectedSequence:journal.sequence,state:'running',stage,
              workerPid:process.pid,leaseToken:lease.token})),next=clone(state.control);
            next.purgeTasks[descriptor.taskId].worker.journalSequence=updated.journal.sequence;
            await fence.commitControl(next);return {sequence:updated.journal.sequence};
          },
          async publishPreparedPurgeReplacement(token){
            ensure();const plan=purgeReplacementTokens.get(token);purgeReplacementTokens.delete(token);
            if(!plan||controlIdentity(state.control)!==plan.controlIdentity)throw purgeClaimError('purge_state_changed');
            const authority=runningPurgeAuthority(state.control);
            if(!samePurgeDescriptor(authority.descriptor,plan.descriptor)||authority.journal.sequence!==plan.sequence||
              plan.stage==='final'&&authority.task.phase!=='verified'||plan.stage==='body'&&!['prepared','purge_pending'].includes(authority.task.phase))
              throw purgeClaimError('purge_state_changed');
            // Reuse the bounded namespace/path inspection against the original
            // opaque binding. A marker-only replacement is invisible to the
            // control cache; never refresh the expected marker to accept it.
            const existing=await recheckExistingMaintenance(existingMaintenanceBinding);
            ensure();if(controlIdentity(existing.control)!==plan.controlIdentity)throw purgeClaimError('purge_state_changed');
            assertExistingDatabasePathSync(existingMaintenanceBinding);
            const receipt=callStore(()=>store.publishPreparedPurgeReplacement(plan.storeToken,{controlIdentity:plan.controlIdentity})),next=clone(state.control);
            next.purgeTasks[plan.descriptor.taskId].worker.journalSequence=receipt.journal.sequence;
            next.purgeTasks[plan.descriptor.taskId].sqlPublication={descriptor:clone(plan.descriptor),...clone(receipt.publicationReceipt)};
            try{await fence.commitControl(next);}catch(error){throw Object.assign(error,{committed:true,revision:receipt.revision});}
            return {revision:receipt.revision,publicationReceipt:receipt.publicationReceipt,rows:receipt.rows};
          },
        }:{}),
        transaction(selection,action){return observation.measure(()=>{
          ensure();const newPackages=new Set((selection.select||[]).filter(s=>s.collection==='packages').flatMap(s=>s.ids||[]).filter(id=>!callStore(()=>store.getRow({collection:'packages',id}))));
          const prior=state.options;state.options={...prior,newPackages};
          try{check(selection);assertOperationWriteAllowed(operationView(),state.options);return callStore(()=>store.transaction(selection,action));}
          finally{state.options=prior;purgeLeaseRecord=undefined;}
        });},
      };
  for(const method of ['getMeta','getRow','getRecord','readView','queryRows','queryIds','aggregateRows','readChanges'])fence[method]=input=>observation.measure(()=>{
        check(method==='getMeta'?{select:[]}:method==='readView'?input:{select:[input]});return clone(callStore(()=>store[method](input)));
      });
      for(const method of ['queryJobPage','queryApplicationPage','findJobIdentityCandidates','queryJobQuality','readJobBodySignatures','readJobHead','queryJobRelatedPage','queryCollectionSnapshot','queryRunHeads','queryCollectionSlicePage','discoverLegacyOwners','queryLegacyApplicationPage','queryLegacyTrackingSummary','queryLegacyTrackingPage','queryLegacyRunTargets','findLegacyApplicationIds','queryDiagnosticRunScopes'])fence[method]=(input,queryOptions={})=>observation.measure(()=>{
        queryOptions=queryOptionsFor(method,input,queryOptions);
        const queryOwner=queryOptions.scope?.packageId||input?.scope?.packageId||input?.ownerPackageId;
        check({select:queryOwner?[{collection:'packages',ownerPackageId:queryOwner}]:[]});
        if(queryOptions.scope)validate({select:[]},state.control,{...state.options,scope:queryOptions.scope});
        validate({select:[]},state.control,{...state.options,enforceMaintenance:true});
        const excludedOwnerPackageIds=indexesFor(state.control).excludedOwnerPackageIds,result=callStore(()=>store[method](['queryCollectionSnapshot','queryRunHeads','queryCollectionSlicePage'].includes(method)?{...input,excludedOwnerPackageIds}:input,{...queryOptions,excludedOwnerPackageIds}));
        return clone(['queryJobPage','queryApplicationPage','readJobHead'].includes(method)?{...result,controlDeletionHead:deletionHeadFor(state.control)}:result);
      });
      try{
        observation.measure(()=>{validate({select:[]},state.control,{...state.options,enforceMaintenance:true});if(!options.bootstrap)assertOperationWriteAllowed(operationView(),state.options);});
        const exposedFence=maintenanceState?Object.freeze({
          get control(){return fence.control;},commitControl:next=>fence.commitControl(next),
          getMeta:key=>{if(!['schemaVersion','revision','storeVersion','migrationSourceHash','jobReadModelVersion','collectionProjectionVersion'].includes(key))throw purgeClaimError();return fence.getMeta(key);},
          readOperationState:input=>fence.readOperationState(input),readPurgeWorkerJournal:()=>fence.readPurgeWorkerJournal(),
          reconcilePurgeWorker:input=>fence.reconcilePurgeWorker(input),acquirePurgeClaim:binding=>fence.acquirePurgeClaim(binding),
          releasePurgeClaim:(binding,input)=>fence.releasePurgeClaim(binding,input),beginPurgeStage:(binding,stage)=>fence.beginPurgeStage(binding,stage),
          publishPreparedPurgeReplacement:token=>fence.publishPreparedPurgeReplacement(token),
        }):Object.freeze(fence);
        const result=await action(exposedFence);
        if(controlWriting){await pendingControl;throw packageError('workspace_fence_busy','回调必须等待控制提交完成。',503);}
        return clone(result);
      }finally{if(controlWriting)await pendingControl.catch(()=>{});live=false;activePort=previousPort;}
    });}catch(error){failure=error;throw error;}finally{observation.finish(failure);}};
    const pending=queue.then(run);queue=pending.catch(()=>{});return pending;
  };
  const withMaintenanceTransaction=(action,options={})=>{
    if(heldLock.getStore()?.active)return Promise.reject(Error('Nested maintenance transaction: use the held transaction'));
    counts.maintenanceTransactions++;
    return withWriteFence(async fence=>{
      let workspace,live=true,localControl=fence.control;
      const token=heldLock.getStore();
      const ensure=()=>{if(!live||!token.active)throw packageError('workspace_fence_closed','维护事务已结束。',503);};
      const tx={
        get workspace(){ensure();if(!workspace){counts.maintenanceReads++;workspace=measureStore(()=>applyDeletionLedger(callStore(()=>store.exportWorkspace()),fence.control));}return workspace;},
        set workspace(value){ensure();workspace=value;},
        get control(){ensure();return localControl;},
        async commitControl(next){ensure();await fence.commitControl(next);localControl=clone(next);},
        async commitWorkspace(next){
          return measureStore(()=>{ensure();assertOperationWriteAllowed(operationView(),options);
          const draft=applyDeletionLedger(next,fence.control);assertWorkspace(draft);
          const receipt=callStore(()=>store.replaceWorkspace(draft,{allowLegacy:allowLegacy&&draft.schemaVersion===2}));
          draft.revision=receipt.revision;workspace=clone(draft);return receipt.revision;});
        },
      };
      Object.assign(tx,createManagedSnapshotPort({dataDir,fsAdapter,clock,tx,options,assertLive:ensure}));
      try{return await action(tx);}finally{live=false;}
    },{...options,maintenanceContext:true});
  };
  const repository={
    dataDir,clock,migration,
    enableStrictSchema3(){if(callStore(()=>store.getMeta('schemaVersion'))!==3)throw packageError('workspace_upgrade_required','旧格式仅可用于维护导入。',503);},
    withWriteFence,withMaintenanceTransaction,
    async readControl(){return clone(await currentControl());},
    async readPurgeWorkerJournal(){await currentControl();return callStore(()=>store.readPurgeWorkerJournal());},
    async claimPurgeDispatch({taskId,expectedDescriptor}={}){
      if(maintenanceState||!UUID_RE.test(taskId||''))throw purgeClaimError();
      return withWriteFence(async fence=>{
        const control=fence.control,task=control.purgeTasks[taskId];
        if(!task)throw purgeClaimError();
        if(task.phase==='completed')return {descriptor:task.worker?purgeDescriptor(task):null,dispatchAllowed:false,completed:true};
        const ledger=control.deletionLedger[task.packageId];if(!ledger||ledger.operationId!==taskId||ledger.phase!=='purge_pending')throw purgeClaimError();
        for(const item of Object.values(control.migrationJournal.maintenance||{}))if(!['complete','aborted'].includes(item.phase))throw purgeClaimError();
        for(const item of Object.values(control.migrationJournal.archives||{}))if(item.phase!=='complete')throw purgeClaimError();
        if(Object.values(control.ownershipTransfers).some(item=>item.phase!==undefined&&item.phase!=='complete'))throw purgeClaimError();
        let journal=fence.readPurgeWorkerJournal(),descriptor;
        const prior=task.worker;
        if(prior&&['starting','running'].includes(prior.state)){
          descriptor=purgeDescriptor(task);
          if(expectedDescriptor&&!samePurgeDescriptor(descriptor,expectedDescriptor))throw purgeClaimError();
          if(prior.dispatcherPid!==process.pid||prior.state==='running'||prior.workerPid!==null)
            return {descriptor,dispatchAllowed:false,completed:false};
          if(journal&&!samePurgeDescriptor(journal.descriptor,descriptor)&&
            (!prior.previousRetirement||!samePurgeDescriptor(journal.descriptor,prior.previousRetirement.descriptor)||
             journal.state!=='retired'||journal.sequence!==prior.previousRetirement.sequence))throw purgeClaimError();
        }else{
          if(expectedDescriptor&&(!prior||!samePurgeDescriptor(purgeDescriptor(task),expectedDescriptor)))throw purgeClaimError();
          if(prior&&(!['retry_wait','stopped'].includes(prior.state)||prior.retirement?.stage!=='complete'))throw purgeClaimError();
          if(prior?.nextRetryAt&&clock.now()<Date.parse(prior.nextRetryAt)||task.nextRetryAt&&clock.now()<Date.parse(task.nextRetryAt))
            return {descriptor:prior?purgeDescriptor(task):null,dispatchAllowed:false,completed:false};
          if(journal){
            const retiredTask=control.purgeTasks[journal.descriptor.taskId];
            if(journal.state!=='retired'||!retiredTask?.worker||retiredTask.worker.retirement?.stage!=='complete'||
              retiredTask.worker.journalSequence!==journal.sequence||!samePurgeDescriptor(purgeDescriptor(retiredTask),journal.descriptor))throw purgeClaimError();
          }
          const operations=fence.readOperationState();
          if(operations.hasMore||operations.leases.some(hasLiveOwner)||operations.runs.some(hasLiveOwner))throw purgeClaimError();
          descriptor={taskId,packageId:task.packageId,generation:(prior?.generation||0)+1,dispatchId:randomUUID(),leaseOperationId:'op-'+randomUUID()};
          const next=clone(control),worker={formatVersion:1,generation:descriptor.generation,dispatchId:descriptor.dispatchId,
            leaseOperationId:descriptor.leaseOperationId,state:'starting',dispatcherPid:process.pid,workerPid:null,
            claimStartedAt:new Date(clock.now()).toISOString(),startedAt:null,lastOutcome:null,nextRetryAt:null};
          if(journal)worker.previousRetirement={descriptor:clone(journal.descriptor),sequence:journal.sequence};
          else if(prior)worker.previousRetirement={descriptor:purgeDescriptor(task),sequence:null};
          next.purgeTasks[taskId].worker=worker;await fence.commitControl(next);await faultInjector?.('purge.claim-control-prepared');
        }
        const current=fence.control.purgeTasks[taskId].worker,previous=current.previousRetirement;
        const reserved=callStore(()=>store.reservePurgeWorkerJournal(descriptor,{expectedSequence:previous?.sequence??null,previousDescriptor:previous?.descriptor??null}));
        await faultInjector?.('purge.claim-sql-reserved');journal=reserved.journal;
        const next=fence.control;next.purgeTasks[taskId].worker.journalSequence=journal.sequence;
        delete next.purgeTasks[taskId].worker.previousRetirement;await fence.commitControl(next);await faultInjector?.('purge.claim-control-associated');
        return {descriptor,dispatchAllowed:journal.state==='dispatch_reserved'&&journal.workerPid===null,completed:false};
      },{operationMaintenance:true});
    },
    async reconcilePurgeCoordination(options={}){return withWriteFence(fence=>fence.reconcilePurgeWorker(options),{operationMaintenance:true});},
    async retirePurgeDispatch({descriptor,hostStatus}={}){
      if(maintenanceState)throw purgeClaimError();assertPurgeHostStatus(hostStatus,descriptor);
      if(!hostStatus.cleanupSettled||!(hostStatus.exitObserved||hostStatus.spawnFailed))throw purgeClaimError();
      return withWriteFence(async fence=>{
        let task=purgeTaskFor(fence.control,descriptor),journal=fence.readPurgeWorkerJournal();
        if(!journal&&task.worker.journalSequence!==undefined)throw purgeClaimError();
        if(hostStatus.exitObserved&&(task.worker.workerPid??journal?.workerPid)!==hostStatus.workerPid)throw purgeClaimError();
        if(hostStatus.spawnFailed&&(task.worker.workerPid!==null||journal?.workerPid!==undefined&&journal.workerPid!==null))throw purgeClaimError();
        if(journal&&!samePurgeDescriptor(journal.descriptor,descriptor))throw purgeClaimError();
        if(journal&&['claimed','running'].includes(journal.state)){
          await fence.reconcilePurgeWorker();journal=fence.readPurgeWorkerJournal();task=purgeTaskFor(fence.control,descriptor);
        }
        if(journal&&journal.state!=='release_observed'&&!(hostStatus.spawnFailed&&journal.state==='dispatch_reserved')&&journal.state!=='retired')throw purgeClaimError();
        const operations=fence.readOperationState();if(operations.hasMore||operations.leases.some(lease=>lease.operationId===descriptor.leaseOperationId))throw purgeClaimError();
        if(task.fileIntent&&task.fileIntent.stage!=='verified')throw purgeClaimError();
        if(journal?.publicationReceipt){
          const proof=task.sqlPublication;
          if(!proof||!samePurgeDescriptor(proof.descriptor,descriptor)||
            !['stage','baseRevision','committedRevision'].every(key=>proof[key]===journal.publicationReceipt[key]))throw purgeClaimError();
        }
        if(!['retry_wait','stopped','completed'].includes(task.worker.state)){
          if(!hostStatus.spawnFailed)throw purgeClaimError();
          const failed=fence.control,current=failed.purgeTasks[descriptor.taskId];
          current.worker={...current.worker,state:'retry_wait',lastOutcome:'purge_boot_failed',nextRetryAt:new Date(Number(clock.now())+300000).toISOString()};
          current.attempts=(current.attempts||0)+1;current.nextRetryAt=current.worker.nextRetryAt;current.code='purge_boot_failed';await fence.commitControl(failed);
        }
        task=purgeTaskFor(fence.control,descriptor);
        if(task.worker.retirement?.stage==='complete'){
          if(journal&&journal.state!=='retired'||journal&&task.worker.journalSequence!==journal.sequence)throw purgeClaimError();
          return {retired:true,sequence:journal?.sequence??null};
        }
        if(!task.worker.retirement){
          if(journal?.state==='retired')throw purgeClaimError();
          const prepared=fence.control;prepared.purgeTasks[descriptor.taskId].worker.retirement={sequence:journal?.sequence??0,stage:'prepared'};
          await fence.commitControl(prepared);await faultInjector?.('purge.retire-control-prepared');
        }
        if(journal&&journal.state!=='retired'){
          if(purgeTaskFor(fence.control,descriptor).worker.retirement.sequence!==journal.sequence)throw purgeClaimError();
          const retired=callStore(()=>store.updatePurgeWorkerJournal(descriptor,{expectedSequence:journal.sequence,state:'retired'}));
          journal=retired.journal;await faultInjector?.('purge.retire-sql-retired');
        }
        if(journal&&purgeTaskFor(fence.control,descriptor).worker.retirement.sequence+1!==journal.sequence)throw purgeClaimError();
        const complete=fence.control,worker=complete.purgeTasks[descriptor.taskId].worker;
        worker.retirement.stage='complete';if(journal)worker.journalSequence=journal.sequence;
        await fence.commitControl(complete);await faultInjector?.('purge.retire-control-complete');return {retired:true,sequence:journal?.sequence??null};
      },{operationMaintenance:true});
    },
    ...(maintenanceState?{
      async acquirePurgeClaim(){
        const value=await withWriteFence(fence=>fence.acquirePurgeClaim(existingMaintenanceBinding),{operationMaintenance:true});
        return Object.freeze({...value,release:()=>repository.releasePurgeClaim()});
      },
      releasePurgeClaim:input=>withWriteFence(fence=>fence.releasePurgeClaim(existingMaintenanceBinding,input),{operationMaintenance:true}),
      async preparePurgeReplacement({stage,operationLease}={}){
        if(!PURGE_REPLACEMENT_STAGES.includes(stage))throw purgeClaimError();
        const initial=runningPurgeAuthority(await currentControl());
        if(operationLease?.operationId!==initial.lease.operationId||operationLease?.token!==initial.lease.token)throw purgeClaimError();
        // Own intent/sequence is durable before any expensive computation; never
        // rebind an already prepared token after publishing more own progress.
        await withWriteFence(fence=>fence.beginPurgeStage(existingMaintenanceBinding,stage),{operationLease,operationMaintenance:true});
        const before=await currentControl(),authority=runningPurgeAuthority(before),identity=controlIdentity(before);
        if(stage==='final'&&authority.task.phase!=='verified')throw purgeClaimError();
        const snapshot=callStore(()=>store.exportPurgeWorkspaceSnapshot(maintenanceState.limits)),latest=await currentControl();
        if(controlIdentity(latest)!==identity)throw purgeClaimError('purge_state_changed');
        const draft=applyDeletionLedger(snapshot.workspace,latest);
        if(stage==='final')delete draft.packages[authority.descriptor.packageId];
        assertWorkspace(draft);
        const storeToken=callStore(()=>store.preparePurgeReplacement(draft,{descriptor:authority.descriptor,
          leaseToken:authority.lease.token,expectedSequence:authority.journal.sequence,controlIdentity:identity,
          sourceDataVersion:snapshot.dataVersion,stage,asOf:clock.now(),limits:maintenanceState.limits}));
        const token=Object.freeze(Object.create(null));purgeReplacementTokens.set(token,{storeToken,descriptor:authority.descriptor,
          lease:authority.lease,sequence:authority.journal.sequence,controlIdentity:identity,stage});return token;
      },
      async publishPreparedPurgeReplacement(token){
        const plan=purgeReplacementTokens.get(token);if(!plan)throw purgeClaimError();
        try{return await withWriteFence(fence=>fence.publishPreparedPurgeReplacement(token),{operationLease:plan.lease,operationMaintenance:true});}
        finally{purgeReplacementTokens.delete(token);}
      },
    }:{}),
    async queryRecoveryRunHeads(input={}){
      await currentControl();const page=callStore(()=>store.queryRecoveryRunHeads(input));
      return clone(recoveryHeads(page,await currentControl()));
    },
    async exportPackage(packageId,options={}){
      counts.maintenanceReads++;const control=await currentControl();assertAccess(packageId,control,options);
      const value=callStore(()=>store.exportPackage(packageId));assertAccess(packageId,await currentControl(),options);return value;
    },
    async getPackageCounts(packageId){
      if(typeof packageId!=='string'||!packageId)throw packageError('package_scope_mismatch','包身份无效。',400);
      await currentControl();const result=callStore(()=>countPackageRows(store,packageId));await currentControl();return result;
    },
    async exportWorkspace(){counts.maintenanceReads++;const control=await currentControl();if(maintenanceState)runningPurgeAuthority(control);
      const raw=callStore(()=>store.exportWorkspace());const latest=await currentControl();if(maintenanceState)runningPurgeAuthority(latest);
      const value=applyDeletionLedger(raw,latest);return clone(value);},
    async read(){return repository.exportWorkspace();},
    async replaceWorkspace(workspace,options={}){return withMaintenanceTransaction(tx=>tx.commitWorkspace(workspace),options);},
    async mutateWorkspace(action,options={}){
      counts.maintenanceMutations++;
      return withMaintenanceTransaction(async tx=>{
        const draft=clone(tx.workspace),before=canonicalContentHash(draft);
        if(!options.bootstrap)assertOperationWriteAllowed(draft,options);
        const business=value=>canonicalContentHash({...value,revision:0,operationLeases:null});
        const previousBusiness=options.operationMaintenance?business(draft):null;
        const result=await action(draft,tx);
        if(options.operationMaintenance&&previousBusiness!==business(draft))throw Error('Operation maintenance cannot change business data');
        if(canonicalContentHash(draft)!==before)await tx.commitWorkspace(draft);
        return {revision:tx.workspace.revision,result:clone(result)};
      },options);
    },
    transaction(selection,action,options={}){return withWriteFence(fence=>fence.transaction(selection,action),options);},
    async writeRunSnapshot(id,snapshot,options={}){
      if(typeof id==='object'){snapshot=id;id=snapshot.run?.runId||snapshot.runId;}
      return withMaintenanceTransaction(tx=>tx.writeSnapshot(id,snapshot),options);
    },
    async readRunSnapshot(id,options={}){
      if(!options.scope&&!options.ownerPackageId)return withMaintenanceTransaction(async tx=>{
        const snapshot=await tx.readSnapshot(id);if(tx.workspace.schemaVersion===3)assertSnapshotOwner(tx.workspace,id,snapshot,clock);return snapshot;
      },{operationMaintenance:true});
      const ownerPackageId=options.scope?.packageId||options.ownerPackageId;
      const pkg=await repository.getRow({collection:'packages',id:ownerPackageId},options);
      const run=await repository.getRow({collection:'runs',id,ownerPackageId:pkg.packageId},options);
      const filename=snapshotPath(dataDir,id);await assertSnapshotPath(dataDir,filename,fsAdapter);
      const snapshot=JSON.parse(await fsAdapter.readFile(filename,'utf8'));
      assertSnapshotOwner({runs:{[id]:run},packages:{[pkg.packageId]:pkg}},id,snapshot,clock,options);
      const files=await repository.queryRows({collection:'files',ownerPackageId:pkg.packageId,where:{runId:id,kind:'run_snapshot'},limit:2},options);
      if(files.hasMore||files.rows.length!==1||files.rows[0].value.snapshotRecordId!==snapshot.recordId||files.rows[0].value.hash!==contentHash(snapshot)||(run.snapshotRef&&run.snapshotRef.hash!==contentHash(snapshot)))throw packageError('snapshot_identity_conflict','运行快照的登记或内容未通过核查。');
      await repository.getRow({collection:'packages',id:pkg.packageId},options);return snapshot;
    },
    metrics({reset=false}={}){const result={...counts,...store.metrics({reset})};if(reset)for(const key of Object.keys(counts))counts[key]=0;return result;},
    pragmas:()=>callStore(()=>store.pragmas()),integrityCheck:()=>callStore(()=>store.integrityCheck()),
    rebuildReadModels:(options={})=>withWriteFence(fence=>{
      const state=fence.readOperationState(),own=options.operationLease;
      if(state.hasMore||state.runs.some(hasLiveOwner)||state.leases.some(lease=>hasLiveOwner(lease)&&lease.operationId!==own?.operationId)||
          (own&&!state.leases.some(lease=>lease.operationId===own.operationId&&lease.token===own.token&&['upgrade','restore'].includes(lease.kind))))
        throw packageError('workspace_migration_busy','派生索引重建需要升级独占且当前没有活动运行。',409);
      return measureStore(()=>callStore(()=>store.rebuildReadModels({asOf:clock.now()})));
    },{...options,operationMaintenance:true}),
    checkpoint:()=>withWriteFence(()=>callStore(()=>store.checkpoint()),{operationMaintenance:true}),
    compact:()=>withWriteFence(()=>callStore(()=>store.compact()),{operationMaintenance:true}),
    backupDatabase:destination=>withWriteFence(()=>callStore(()=>store.backup(destination)),{operationMaintenance:true}),
    async close(){if(closed)return;await queue;store.close();closed=true;controlCache=undefined;},
  };
  for(const method of ['getMeta','getRow','getRecord','readView','queryRows','queryIds','aggregateRows','readChanges','queryJobPage','queryApplicationPage','findJobIdentityCandidates','queryJobQuality','readJobBodySignatures','readJobHead','queryJobRelatedPage','queryCollectionSnapshot','queryRunHeads','queryCollectionSlicePage','discoverLegacyOwners','queryLegacyApplicationPage','queryLegacyTrackingSummary','queryLegacyTrackingPage','queryLegacyRunTargets','findLegacyApplicationIds','queryDiagnosticRunScopes'])repository[method]=(input,options)=>readBounded(method,input,options);
  repository.writeOwnedRunSnapshot=createOwnedRunSnapshotWriter({repository,dataDir,fsAdapter,clock,faultInjector});
  if(maintenanceState){
    // This instance is a worker capability, not a second ordinary business
    // context. Before the real claim is associated it exposes metadata only.
    const selected=['dataDir','clock','migration','withWriteFence','readControl','readPurgeWorkerJournal','getMeta',
      'acquirePurgeClaim','releasePurgeClaim','preparePurgeReplacement','publishPreparedPurgeReplacement','exportWorkspace','close','metrics','pragmas'];
    const limited=Object.fromEntries(selected.map(key=>[key,repository[key]]));
    limited.getMeta=async key=>{if(!['schemaVersion','revision','storeVersion','migrationSourceHash','jobReadModelVersion','collectionProjectionVersion'].includes(key))throw purgeClaimError();return repository.getMeta(key);};
    limited.compact=()=>withWriteFence(()=>{runningPurgeAuthority(activePort.control);return callStore(()=>store.compact());},{operationMaintenance:true});
    return Object.freeze(limited);
  }
  return repository;
}

/** Internal worker factory. It cannot initialize a directory or perform the
 * ordinary cold migration path, and a plain object is never a valid binding. */
export async function openExistingMaintenanceRepository({dataDir,workspaceId,descriptor,fsAdapter=fs,clock={now:()=>Date.now()},
  diagnostics,busyTimeoutMs=250,faultInjector,limits={}}={}){
  const existingMaintenanceBinding=await inspectExistingMaintenance({dataDir,workspaceId,descriptor,fsAdapter,busyTimeoutMs,limits});
  return openWorkspaceRepository({dataDir,fsAdapter,clock,diagnostics,busyTimeoutMs,faultInjector,existingMaintenanceBinding});
}
