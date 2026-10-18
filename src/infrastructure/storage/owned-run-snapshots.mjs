import { randomUUID } from 'node:crypto';
import { contentHash } from './content-hash.mjs';
import { assertJson } from './sqlite-records.mjs';
import { createManagedSnapshotPort } from './managed-snapshots.mjs';
import { assertCollectionWrite } from '../../domain/collection.mjs';
import { packageError } from '../../domain/packages.mjs';

/** Reserve identities, write an immutable copy outside the fence, then publish
 * only its file row. A collection/operation lease spans the three short fences. */
export function createOwnedRunSnapshotWriter({repository,dataDir,fsAdapter,clock,faultInjector}) {
  const fail=()=>packageError('snapshot_identity_conflict','运行快照的持久身份、归属或内容不一致。');
  const tick=stage=>faultInjector?.('snapshot.'+stage);
  return async function writeOwnedRunSnapshot(id,snapshot,options={}) {
    assertJson(snapshot);
    const {scope,collectionGuard}=options;
    if(!scope?.packageId||!scope?.targetRevisionId||!options.operationLease)
      throw packageError('invalid_operation_lease','运行快照需要目标范围和有效操作凭证。');
    const read=(fence)=>{
      const pkg=fence.getRow({collection:'packages',id:scope.packageId});
      const run=fence.getRow({collection:'runs',id,ownerPackageId:scope.packageId});
      if(!run)throw packageError('package_not_found','检索记录不存在。',404);
      if(collectionGuard){
        if(collectionGuard.ref?.scope?.packageId!==scope.packageId||collectionGuard.ref.scope.targetRevisionId!==scope.targetRevisionId)throw fail();
        const root=fence.getRecord({collection:'runs',id:collectionGuard.ref.activityId,ownerPackageId:scope.packageId});
        assertCollectionWrite({runs:root?{[root.id]:{...root.value,targetSnapshot:{revisionId:root.indexes.targetRevisionId}}}:{}},collectionGuard);
      }
      const page=fence.queryRows({collection:'files',ownerPackageId:scope.packageId,where:{runId:id,kind:'run_snapshot'},limit:2});
      if(page.hasMore||page.rows.length>1)throw fail();
      return {pkg,run,file:page.rows[0]?.value};
    };
    const prepared=await repository.withWriteFence(async fence=>{
      const {pkg,run,file}=read(fence),control=fence.control;
      const index=control.identityIndex.record,key='snapshot:'+contentHash(id),fileKey='snapshot-file:'+contentHash(id);
      const recordId=index[key]||file?.snapshotRecordId||randomUUID(),fileId=index[fileKey]||file?.recordId||randomUUID();
      if(file&&(file.snapshotRecordId!==recordId||file.recordId!==fileId))throw fail();
      if((snapshot.ownerPackageId&&snapshot.ownerPackageId!==scope.packageId)||
          (snapshot.recordId&&snapshot.recordId!==recordId)||
          (snapshot.run?.ownerPackageId&&snapshot.run.ownerPackageId!==scope.packageId)||
          (snapshot.run?.runId&&snapshot.run.runId!==id))throw fail();
      const owned={...structuredClone(snapshot),ownerPackageId:scope.packageId,recordId},hash=contentHash(owned);
      const intents=(control.migrationJournal.runSnapshots||={}),prior=intents[id];
      if(prior&&(prior.hash!==hash||prior.recordId!==recordId||prior.fileId!==fileId||prior.packageId!==scope.packageId))throw fail();
      if(file&&file.hash!==hash)throw fail();
      index[key]=recordId;index[fileKey]=fileId;
      if(!prior)intents[id]={packageId:scope.packageId,targetRevisionId:scope.targetRevisionId,recordId,fileId,hash,phase:'prepared'};
      if(!prior||!control.identityIndex.record[key]||!control.identityIndex.record[fileKey])await fence.commitControl(control);
      return {pkg,run,owned,hash,recordId,fileId};
    },options);
    await tick('control-prepared');
    const port=createManagedSnapshotPort({dataDir,fsAdapter,clock,options,
      tx:{workspace:{schemaVersion:3,runs:{[id]:prepared.run},packages:{[scope.packageId]:prepared.pkg}}}});
    const ref=await port.writeSnapshot(id,prepared.owned);
    await tick('file-written');
    await repository.withWriteFence(fence=>{
      const {run}=read(fence),intent=fence.control.migrationJournal.runSnapshots?.[id];
      if(run.recordId!==prepared.run.recordId||intent?.hash!==prepared.hash||intent?.recordId!==prepared.recordId)throw fail();
      return fence.transaction({select:[{collection:'files',ids:[prepared.fileId],ownerPackageId:scope.packageId}]},tx=>{
        tx.putRow({collection:'files',id:prepared.fileId,ownerPackageId:scope.packageId,value:{fileId:prepared.fileId,
          recordId:prepared.fileId,snapshotRecordId:prepared.recordId,ownerPackageId:scope.packageId,
          runId:id,path:ref.path,hash:ref.hash,kind:'run_snapshot'}});
      });
    },options);
    await tick('sql-published');
    await repository.withWriteFence(async fence=>{
      read(fence);const control=fence.control,intent=control.migrationJournal.runSnapshots?.[id];
      if(intent?.hash!==prepared.hash||intent.recordId!==prepared.recordId)throw fail();
      if(intent.phase!=='complete'){intent.phase='complete';await fence.commitControl(control);}
    },options);
    await tick('control-complete');
    return ref;
  };
}
