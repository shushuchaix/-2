import { JOB_READ_MODEL_VERSION } from '../../domain/job-read-model.mjs';
import { COLLECTION_PROJECTION_VERSION } from '../../domain/collection-projections.mjs';
import { hasLiveOwner } from './process-owner.mjs';
import { packageError } from '../../domain/packages.mjs';

/** Fixed cold migration. The caller owns the common workspace file fence. */
export async function ensureSqliteReadModels({store,controlStore,clock,faultInjector,onStartupStage}) {
  if(store.getMeta('schemaVersion')!==3)return {changed:false};
  const jobVersion=store.getMeta('jobReadModelVersion'),collectionVersion=store.getMeta('collectionProjectionVersion');
  if((jobVersion!==undefined&&(!Number.isSafeInteger(jobVersion)||jobVersion<1||jobVersion>JOB_READ_MODEL_VERSION))||
     (collectionVersion!==undefined&&(!Number.isSafeInteger(collectionVersion)||collectionVersion<1||collectionVersion>COLLECTION_PROJECTION_VERSION)))
    throw packageError('read_model_version_unsupported','派生索引格式不受此版本支持，已保留原数据库。',503);
  let control=await controlStore.read(),task=control.migrationJournal.readModels;
  const ready=()=>store.getMeta('jobReadModelVersion')===JOB_READ_MODEL_VERSION&&store.getMeta('collectionProjectionVersion')===COLLECTION_PROJECTION_VERSION;
  if(ready()&&task?.phase!=='prepared')return {changed:false};
  onStartupStage?.({stage:'storage-preparing-indexes',code:'read_model_upgrade'});
  const state=store.readOperationState();
  if(state.hasMore||state.leases.some(hasLiveOwner)||state.runs.some(hasLiveOwner))
    throw packageError('workspace_migration_busy','派生索引升级需要等待当前活动操作结束。',409);
  const commit=async next=>{await controlStore.commitInLock(next,{previous:control});control=next;task=next.migrationJournal.readModels;};
  if(!task||task.jobVersion!==JOB_READ_MODEL_VERSION||task.collectionVersion!==COLLECTION_PROJECTION_VERSION||task.phase!=='prepared'){
    const next=structuredClone(control);next.migrationJournal.readModels={phase:'prepared',jobVersion:JOB_READ_MODEL_VERSION,
      collectionVersion:COLLECTION_PROJECTION_VERSION,preparedAt:new Date(clock.now()).toISOString()};await commit(next);
  }
  await faultInjector?.('read-model.control-prepared');
  if(!ready())store.rebuildReadModels({asOf:clock.now()});
  await faultInjector?.('read-model.sql-published');
  const next=structuredClone(control);next.migrationJournal.readModels.phase='complete';await commit(next);
  await faultInjector?.('read-model.control-complete');
  return {changed:true};
}
