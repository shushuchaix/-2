import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { openPackageControl, applyDeletionLedger } from './package-control.mjs';
import { openSqliteRowStore } from './sqlite-store.mjs';
import { PRIVATE_COLLECTIONS } from './sqlite-schema.mjs';
import { migrateWorkspaceToSqlite } from './sqlite-migration.mjs';
import { createManagedSnapshotPort, assertSnapshotOwner, assertSnapshotPath, snapshotPath } from './managed-snapshots.mjs';
import { withWorkspaceLock } from './lock.mjs';
import { assertWorkspace } from '../../domain/contracts.mjs';
import { requirePackage, assertScope, packageError } from '../../domain/packages.mjs';
import { assertOperationWriteAllowed } from '../../application/workspace-operations.mjs';
import { canonicalContentHash } from './content-hash.mjs';
import { countPackageRows } from './package-counts.mjs';
import { createOwnedRunSnapshotWriter } from './owned-run-snapshots.mjs';
import { contentHash } from './content-hash.mjs';
import { ensureSqliteReadModels } from './read-model-maintenance.mjs';
import { hasLiveOwner } from './process-owner.mjs';
import { createStorageDiagnostics, tagStorageError } from './diagnostics.mjs';
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
  diagnostics,allowLegacy=false,busyTimeoutMs=250,faultInjector,onStartupStage}={}){
  if(!dataDir)throw Error('Missing data directory');
  dataDir=path.resolve(dataDir);await fsAdapter.mkdir(dataDir,{recursive:true});
  const storageDiagnostics=createStorageDiagnostics({diagnostics,metrics:()=>store.metrics()});
  const controlStore=openPackageControl({dataDir,fsAdapter,captureFileIdentity:true,onRenameRecovery:storageDiagnostics.onControlRenameRecovery});
  const heldLock=new AsyncLocalStorage();
  const counts={maintenanceReads:0,maintenanceMutations:0,maintenanceTransactions:0,controlReads:0,controlCacheHits:0,writeFences:0};
  let closed=false,queue=Promise.resolve(),controlCache,activePort,bootstrapping=true;
  const controlIndexes=new WeakMap();
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
    },{fsAdapter});
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
  const store=openSqliteRowStore({filename:path.join(dataDir,'workspace.sqlite'),busyTimeoutMs,guard,
    faultInjector:faultInjector?(phase,context)=>faultInjector('sqlite.'+phase,context):undefined});
  let migration;
  try{
    migration=await inLock(async()=>{const result=await migrateWorkspaceToSqlite({dataDir,store,controlStore,fsAdapter,clock,faultInjector,allowLegacy});
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
        getPackageCounts(packageId){return observation.measure(()=>{ensure();return callStore(()=>countPackageRows(store,packageId));});},
        readOperationState(input={}){return observation.measure(()=>{ensure();return callStore(()=>store.readOperationState(input));});},
        transaction(selection,action){return observation.measure(()=>{
          ensure();const newPackages=new Set((selection.select||[]).filter(s=>s.collection==='packages').flatMap(s=>s.ids||[]).filter(id=>!callStore(()=>store.getRow({collection:'packages',id}))));
          const prior=state.options;state.options={...prior,newPackages};
          try{check(selection);assertOperationWriteAllowed(operationView(),state.options);return callStore(()=>store.transaction(selection,action));}
          finally{state.options=prior;}
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
        const result=await action(Object.freeze(fence));
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
    async exportWorkspace(){counts.maintenanceReads++;const control=await currentControl();const raw=callStore(()=>store.exportWorkspace());const latest=await currentControl();const value=applyDeletionLedger(raw,latest);return clone(value);},
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
  return repository;
}
