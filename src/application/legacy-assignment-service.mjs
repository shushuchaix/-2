import {randomUUID} from 'node:crypto';
import {contentHash} from '../infrastructure/storage/repository.mjs';
import {packageRecords,PRIVATE_MAPS} from '../domain/package-ownership.mjs';
import {assertScope,requirePackage,packageError} from '../domain/packages.mjs';
import {addTargetMemberFact} from '../domain/job-facts.mjs';
import {createWorkspaceOperationGate} from './workspace-operations.mjs';
const fail=(code,message)=>packageError(code,message);
const pending=()=>fail('ownership_transfer_pending','此记录已有未完成的归属转移，请先恢复原操作。');
const stale=()=>fail('legacy_assignment_stale','历史记录或目标已变化，请重新预览。');
function nodes(w){
 const all=packageRecords(w).map(x=>({...x,id:x.record.recordId})),byId=new Map(all.map(n=>[n.id,n]));
 const edges=new Map(all.map(n=>[n.id,new Set()]));
 const link=(a,b)=>{if(!a||!b||!edges.has(a)||!edges.has(b))return;edges.get(a).add(b);edges.get(b).add(a);};
 for(const n of all){for(const [field,map]of [['jobId','jobs'],['runId','runs'],['observationId','observations'],['applicationId','applications']])if(n.collection!==map)link(n.id,w[map]?.[n.record[field]]?.recordId);
  if(['applications','runs'].includes(n.collection))for(const e of n.record.events||[])link(n.id,e.recordId);
  for(const id of n.record.legacyJobIds||[])link(n.id,w.jobs[id]?.recordId);
 }
 return {all,byId,edges};
}
export function legacyClosure(w,recordId,now=Date.now()){
 const graph=nodes(w),root=graph.byId.get(recordId);if(!root)throw fail('legacy_record_not_found','历史记录不存在。');
 const pkg=requirePackage(w,root.record.ownerPackageId,{access:'management',now});if(pkg.kind!=='legacy_unassigned')throw fail('legacy_already_assigned','该记录已归属目标版本。');
 const visited=new Set(),queue=[recordId];while(queue.length){const id=queue.pop();if(visited.has(id))continue;visited.add(id);queue.push(...graph.edges.get(id));}
 const records=[...visited].map(id=>graph.byId.get(id));if(records.some(n=>n.record.ownerPackageId!==pkg.packageId||['profiles','targets'].includes(n.collection)))throw fail('legacy_dependency_conflict','记录依赖不能独立迁移。');
 const recordIds=[...visited,...records.filter(n=>n.collection==='files').map(n=>n.record.snapshotRecordId).filter(Boolean)].sort();
 const counts={};for(const n of records)counts[n.collection]=(counts[n.collection]||0)+1;
 return {recordId,ownerPackageId:pkg.packageId,root:root.record,records,recordIds,counts};
}
function checkDestination(w,closure,destination,now){
 assertScope(w,destination,now);const target=Object.values(w.targets).flat().find(t=>t.revisionId===destination.targetRevisionId),p=target.profileSnapshot;
 if(!p)throw fail('legacy_dependency_conflict','目标缺少自有简历副本。');
 for(const {record:r,collection}of closure.records){
  if(r.targetRevisionId&&r.targetRevisionId!==destination.targetRevisionId)throw fail('legacy_dependency_conflict','历史记录已有其他目标依赖。');
  if(collection==='runs'&&r.targetSnapshot?.revisionId&&r.targetSnapshot.revisionId!==destination.targetRevisionId)throw fail('legacy_dependency_conflict','运行画像与所选目标不一致。');
  const profileId=r.resumeRevisionId||r.profileRevisionId;if(profileId&&![p.revisionId,p.provenance?.profileRevisionId].includes(profileId))throw fail('legacy_dependency_conflict','简历画像依赖不能归属所选目标。');
 }
 return target;
}
function plan(w,closure,destination){return {workspaceRevision:w.revision,planHash:contentHash({records:closure.records.map(n=>({collection:n.collection,record:n.record})),destination:{packageId:destination.packageId,targetRevisionId:destination.targetRevisionId},target:Object.values(w.targets).flat().find(t=>t.revisionId===destination.targetRevisionId),package:w.packages[destination.packageId]}),recordIds:closure.recordIds,counts:closure.counts};}
export function applyOwnershipTransfer(w,intent,{now=Date.now(),allowExpired=false}={}){
 const pkg=allowExpired?w.packages[intent.to]:requirePackage(w,intent.to,{access:'management',now});if(!pkg||!['active','trashed'].includes(pkg.state))throw pending();const target=Object.values(w.targets).flat().find(t=>t.revisionId===pkg.versionId);if(pkg.kind!=='target'||!target?.profileSnapshot)throw fail('legacy_dependency_conflict','归属目标画像不可用。');
 const selected=new Set(intent.recordIds),moved=[];
 for(const n of nodes(w).all)if(selected.has(n.id)){
  const r=n.record;if(![intent.from,intent.to].includes(r.ownerPackageId))throw fail('ownership_transfer_conflict','记录归属与持久转移索引冲突。');
  r.ownerPackageId=intent.to;
  if(['observations','evaluations','applications'].includes(n.collection))r.targetRevisionId=pkg.versionId;
  if(n.collection==='applications'&&r.resumeRevisionId)r.resumeRevisionId=target.profileSnapshot.revisionId;
  if(n.collection==='evaluations'){r.profileRevisionId=target.profileSnapshot.revisionId;r.cacheKey=null;}
  if(n.collection==='runs'){r.targetSnapshot=structuredClone(target);r.profileRevisionId=target.profileSnapshot.revisionId;r.profileSnapshot=structuredClone(target.profileSnapshot);}
  moved.push(n);
 }
 const snapshots=moved.filter(n=>n.collection==='files').map(n=>n.record.snapshotRecordId);
 if(moved.length+snapshots.length!==intent.recordIds.length)throw fail('ownership_transfer_conflict','转移闭包有缺失记录。');
 const jobs=moved.filter(n=>n.collection==='jobs').map(n=>n.record);
 for(const j of jobs){const obs=moved.filter(n=>n.collection==='observations'&&n.record.jobId===j.jobId);if(obs.length)for(const n of obs)addTargetMemberFact(w,{targetRevisionId:pkg.versionId,jobId:j.jobId,observationId:n.record.observationId,provenanceOperationId:intent.operationId});else addTargetMemberFact(w,{targetRevisionId:pkg.versionId,jobId:j.jobId});}
 for(const r of Object.values(w.jobRedirects||{}))if(w.jobs[r.toJobId]?.ownerPackageId===intent.to&&r.ownerPackageId===intent.from)r.ownerPackageId=intent.to;
 for(const g of Object.values(w.duplicateGroups||{}))if(g.ownerPackageId===intent.from&&g.jobIds.every(id=>w.jobs[id]?.ownerPackageId===intent.to))g.ownerPackageId=intent.to;
 return moved.reduce((counts,n)=>({...counts,[n.collection]:(counts[n.collection]||0)+1}),{});
}
export function createLegacyAssignmentService({repository,clock=repository.clock,operationGate=createWorkspaceOperationGate({repository})}){
 const read=()=>repository.withMaintenanceTransaction(tx=>({w:tx.workspace,c:tx.control}),{operationMaintenance:true});
 async function available(recordId){const {w,c}=await read();const transfer=c.ownershipTransfers[recordId];if(transfer?.phase==='prepared')throw pending();if(transfer?.phase==='complete')throw fail('legacy_already_assigned','该记录已完成归属。');const closure=legacyClosure(w,recordId,clock.now());requirePackage(w,closure.ownerPackageId,{now:clock.now()});return {w,c,closure};}
 function rewriteSnapshot(snapshot,w,intent){const copy=structuredClone(snapshot);function visit(value){if(!value||typeof value!=='object')return;if(value.ownerPackageId===intent.from)value.ownerPackageId=intent.to;for(const child of Object.values(value))visit(child);}visit(copy);const file=Object.values(w.files).find(f=>f.snapshotRecordId===copy.recordId),run=w.runs[file.runId];copy.run={...structuredClone(run),snapshotRef:null};return copy;}
 async function validateSnapshots(tx,closure,destination){for(const n of closure.records.filter(n=>n.collection==='files')){const file=n.record,snapshot=await tx.readSnapshot(file.runId);if(snapshot.recordId!==file.snapshotRecordId||snapshot.ownerPackageId!==closure.ownerPackageId||contentHash(snapshot)!==file.hash)throw fail('legacy_dependency_conflict','历史快照身份、归属或哈希无法验证。');const run=tx.workspace.runs[file.runId];if(run.snapshotRef?.hash!==file.hash)throw fail('legacy_dependency_conflict','历史快照引用不一致。');const target=Object.values(tx.workspace.targets).flat().find(t=>t.revisionId===destination.targetRevisionId);for(const profile of [snapshot.profileRevision,snapshot.profile,snapshot.profileSnapshot].filter(Boolean))if(contentHash(profile.profile||profile)!==contentHash(target.profileSnapshot.profile))throw fail('legacy_dependency_conflict','历史快照画像与目标自有简历不一致。');}}
 async function finish(tx,intent,{recovery=false}={}){const w=structuredClone(tx.workspace),counts=applyOwnershipTransfer(w,intent,{now:clock.now(),allowExpired:recovery});for(const file of Object.values(w.files).filter(f=>intent.recordIds.includes(f.recordId))){const raw=await tx.readSnapshot(file.runId),snapshot=rewriteSnapshot(raw,w,intent),ref=await tx.replaceSnapshot(file.runId,snapshot);file.hash=ref.hash;w.runs[file.runId].snapshotRef=ref;}await tx.commitWorkspace(w);const c=structuredClone(tx.control);for(const id of intent.recordIds)c.ownershipTransfers[id]={...c.ownershipTransfers[id],phase:'complete'};await tx.commitControl(c);return {recordId:intent.recordIds[0],ownerPackageId:intent.to,movedCounts:counts,operationId:intent.operationId};}
 return {
  async list(){const {w,c}=await read(),seen=new Set(),result=[];const candidates=Object.values(w.applications).concat(Object.values(w.jobs),Object.values(w.runs));for(const r of candidates){if(seen.has(r.recordId)||w.packages[r.ownerPackageId]?.kind!=='legacy_unassigned'||w.packages[r.ownerPackageId]?.state!=='active')continue;const closure=legacyClosure(w,r.recordId,clock.now());closure.recordIds.forEach(id=>seen.add(id));const transfer=closure.recordIds.map(id=>c.ownershipTransfers[id]).find(Boolean);if(transfer?.phase==='complete'||transfer&&c.deletionLedger[transfer.to])continue;result.push({recordId:r.recordId,ownerPackageId:r.ownerPackageId,title:r.note||r.canonical?.title||'历史记录',counts:closure.counts,pendingTransfer:transfer?.phase==='prepared',canAssign:!transfer});}return result;},
  async get(recordId){const {closure}=await available(recordId);return structuredClone(closure);},
  async preview({recordId,destination}){const {w,closure}=await available(recordId);checkDestination(w,closure,destination,clock.now());await repository.withMaintenanceTransaction(tx=>validateSnapshots(tx,closure,destination),{operationMaintenance:true});return plan(w,closure,destination);},
  async move({recordId,destination,workspaceRevision,planHash}){const initial=await read(),prior=initial.c.ownershipTransfers[recordId];if(prior?.phase==='complete')throw fail('legacy_already_assigned','该记录已完成归属。');const from=prior?.from||legacyClosure(initial.w,recordId,clock.now()).ownerPackageId;return operationGate.withOperation('legacy',{packageIds:[from,destination?.packageId],...(prior?{}:{expectedWorkspaceRevision:workspaceRevision})},lease=>repository.withMaintenanceTransaction(async tx=>{
   const old=tx.control.ownershipTransfers[recordId];if(old){if(old.phase==='complete')throw fail('legacy_already_assigned','该记录已完成归属。');if(old.to!==destination?.packageId)throw pending();assertScope(tx.workspace,destination,clock.now());return finish(tx,old);}
   const closure=legacyClosure(tx.workspace,recordId,clock.now());requirePackage(tx.workspace,from,{now:clock.now()});checkDestination(tx.workspace,closure,destination,clock.now());await validateSnapshots(tx,closure,destination);const p=plan(tx.workspace,closure,destination);if(p.workspaceRevision!==lease.acquiredRevision||p.planHash!==planHash)throw stale();
   if(closure.recordIds.some(id=>tx.control.ownershipTransfers[id]))throw pending();
   const intent={operationId:'transfer-'+randomUUID(),from:closure.ownerPackageId,to:destination.packageId,recordIds:closure.recordIds,phase:'prepared',createdAt:new Date(clock.now()).toISOString()},c=structuredClone(tx.control);
   for(const id of intent.recordIds)c.ownershipTransfers[id]=intent;
   const next=structuredClone(tx.workspace);applyOwnershipTransfer(next,intent,{now:clock.now()});const hashes={};for(const n of closure.records.filter(n=>n.collection==='files')){const raw=await tx.readSnapshot(n.record.runId),rewritten=rewriteSnapshot(raw,next,intent);hashes[n.record.snapshotRecordId]={fromHash:contentHash(raw),toHash:contentHash(rewritten)};}if(Object.keys(hashes).length){c.migrationJournal.ownershipTransferSnapshots||={};c.migrationJournal.ownershipTransferSnapshots[intent.operationId]=hashes;}
   await tx.commitControl(c);return {...await finish(tx,intent),recordId};
  },{operationLease:lease}));},
  async recoverPending(){return repository.withMaintenanceTransaction(async tx=>{const intents=[...new Map(Object.values(tx.control.ownershipTransfers).filter(i=>i.phase==='prepared').map(i=>[i.operationId,i])).values()],retired=[],waiting=[];let recovered=0;for(const intent of intents){const ledger=tx.control.deletionLedger[intent.to];if(ledger){const task=Object.values(tx.control.purgeTasks).find(t=>t.packageId===intent.to),complete=intent.recordIds.every(id=>ledger.recordIds.includes(id));if(complete&&(ledger.phase==='purged'||task))retired.push({operationId:intent.operationId,packageId:intent.to,phase:ledger.phase});else waiting.push({operationId:intent.operationId,packageId:intent.to,code:'ownership_transfer_pending'});continue;}await finish(tx,intent,{recovery:true});recovered++;}return {recovered,retired,pending:waiting};});}
 };
}
