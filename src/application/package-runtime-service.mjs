import {randomUUID} from 'node:crypto';
import {assertScope,assertOwned,packageError} from '../domain/packages.mjs';
import {packageWorkspace,mergePackageWorkspace} from './package-job-service.mjs';
import {contentHash} from '../infrastructure/storage/repository.mjs';
export const exactScope=s=>({packageId:s.packageId,targetRevisionId:s.targetRevisionId});
export function runtimeRepository(repository,scope){
 const selected=exactScope(scope);
 function view(w){assertScope(w,selected,repository.clock.now());const v=packageWorkspace(w,selected.packageId),target=Object.values(v.targets).flat()[0];
  if(!target?.profileSnapshot)throw packageError('version_fact_unavailable','目标缺少自有简历画像。');
  const p=structuredClone(target.profileSnapshot);v.profiles={[p.profileId]:[p]};target.profileRevisionId=p.revisionId;return v;
 }
 return {...repository,
  async read(){return view(await repository.read());},
  async mutateWorkspace(action,options){return repository.mutateWorkspace(async w=>{const v=view(w);const result=await action(v);mergePackageWorkspace(w,v,selected.packageId);w.sources=v.sources;return result;},options);},
  async writeRunSnapshot(id,snapshot,options){
   return repository.withMaintenanceTransaction(async tx=>{
    assertScope(tx.workspace,selected,repository.clock.now());
    assertOwned(tx.workspace,tx.workspace.runs[id],selected.packageId);
    const existing=Object.values(tx.workspace.files).find(f=>f.runId===id&&f.kind==='run_snapshot');
    if(existing)assertOwned(tx.workspace,existing,selected.packageId);
    const rootKey='snapshot:'+contentHash(id),fileKey='snapshot-file:'+contentHash(id),control=structuredClone(tx.control),index=control.identityIndex.record;
    const recordId=index[rootKey]||existing?.snapshotRecordId||randomUUID(),fileId=index[fileKey]||existing?.recordId||randomUUID();
    if(existing&&(existing.snapshotRecordId!==recordId||existing.recordId!==fileId))throw packageError('snapshot_identity_conflict','快照登记与持久身份不一致。');
    if(!index[rootKey]||!index[fileKey]){index[rootKey]=recordId;index[fileKey]=fileId;await tx.commitControl(control);}
    // Identity preparation precedes the physical file. A failed main commit leaves
    // enough durable evidence for a retry or permanent package cleanup.
    snapshot.ownerPackageId=selected.packageId;snapshot.recordId=recordId;
    const owned=structuredClone(snapshot);
    const ref=await tx.writeSnapshot(id,owned),w=structuredClone(tx.workspace);
    w.files[fileId]={fileId,recordId:fileId,snapshotRecordId:recordId,ownerPackageId:selected.packageId,runId:id,path:ref.path,hash:ref.hash,kind:'run_snapshot'};
    await tx.commitWorkspace(w);
    return ref;
   },options);
  },
  async readRunSnapshot(id){const w=await repository.read();assertScope(w,selected,repository.clock.now());assertOwned(w,w.runs[id],selected.packageId);return repository.readRunSnapshot(id);}
 };
}
export function runtimeGate(gate,scope){return {...gate,acquire(kind,options={}){return gate.acquire(kind,{...options,scope:exactScope(scope)});},withOperation(kind,options,action){return gate.withOperation(kind,{...options,scope:exactScope(scope)},action);}};}
export async function assertRuntimeJobs(repository,scope,jobIds,runId){const w=await repository.read();assertScope(w,scope,repository.clock.now());for(const id of jobIds||[])if(w.jobs[id])assertOwned(w,w.jobs[id],scope.packageId);else if(!packageWorkspace(w,scope.packageId).jobRedirects[id])throw packageError('job_not_found','岗位不存在。',404);if(runId)assertOwned(w,w.runs[runId],scope.packageId);return Object.values(w.targets).flat().find(t=>t.revisionId===scope.targetRevisionId);}
