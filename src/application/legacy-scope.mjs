import {assertScope,assertOwned,requirePackage,packageError} from '../domain/packages.mjs';
import {resolveJobId} from '../domain/job-resolution.mjs';
import {packageWorkspace} from './package-job-service.mjs';
import {resolveOwnedJobId} from './job-row-access.mjs';
const required=()=>packageError('version_scope_required','此旧入口不能唯一确定目标版本，请提供 packageId 与 targetRevisionId。');
export function resolveLegacyScope(input={},w,now=Date.now()){
 if(w.schemaVersion!==3)return undefined;
 const explicit=input.scope||input;if(explicit.allTargets)throw required();if(explicit.packageId||explicit.targetRevisionId){
  const targets=Object.values(w.targets).flat().filter(t=>t.revisionId===explicit.targetRevisionId);const selected={packageId:explicit.packageId||targets[0]?.ownerPackageId,targetRevisionId:explicit.targetRevisionId||w.packages[explicit.packageId]?.versionId};assertScope(w,selected,now);verify(w,input,selected);return selected;
 }
 let owner;if(input.runId){const r=w.runs[input.runId];if(!r)throw packageError('run_not_found','运行记录不存在。',404);owner=r.ownerPackageId;}
 else if(input.applicationId){const a=w.applications[input.applicationId];if(!a)throw required();owner=a.ownerPackageId;}
 else if(input.jobId){try{owner=w.jobs[resolveJobId(w,input.jobId)]?.ownerPackageId;}catch{throw required();}}
 else if(input.targetId){const targets=Object.values(w.targets).flat().filter(t=>t.targetId===input.targetId&&w.packages[t.ownerPackageId]?.state==='active');if(targets.length!==1)throw required();owner=targets[0].ownerPackageId;}
 else{const packages=Object.values(w.packages).filter(p=>p.kind==='target'&&p.state==='active');if(packages.length!==1)throw required();owner=packages[0].packageId;}
 const pkg=requirePackage(w,owner,{now}),selected={packageId:owner,targetRevisionId:pkg.versionId};assertScope(w,selected,now);verify(w,input,selected);return selected;
}
function verify(w,input,scope){if(input.runId)assertOwned(w,w.runs[input.runId],scope.packageId);if(input.applicationId)assertOwned(w,w.applications[input.applicationId],scope.packageId);if(input.jobId){if(w.jobs[input.jobId])assertOwned(w,w.jobs[input.jobId],scope.packageId);resolveJobId(packageWorkspace(w,scope.packageId),input.jobId);}}

/** Normal compatibility routing reads only indexed identity metadata before owner authorization. */
export async function resolveLegacyScopeFromRepository(input = {}, repository) {
 if (await repository.getMeta('schemaVersion') !== 3) return undefined;
 const explicit = input.scope || input;
 if (explicit.allTargets) throw required();
 let selected;
 if (explicit.packageId || explicit.targetRevisionId) {
  let packageId = explicit.packageId;
  if (!packageId) {
   const {owners} = await repository.discoverLegacyOwners({kind:'revision',id:explicit.targetRevisionId});
   if (owners.length !== 1) throw required();
   packageId = owners[0].ownerPackageId;
  }
  const pkg = (await repository.queryRows({collection:'packages',ids:[packageId],limit:1})).rows[0]?.value;
  selected = {packageId,targetRevisionId:explicit.targetRevisionId || pkg?.versionId};
 } else {
  const [kind,id] = input.runId ? ['run',input.runId] : input.applicationId ? ['application',input.applicationId] : input.jobId ? ['job',input.jobId] : input.targetId ? ['target',input.targetId] : ['default',undefined];
  const {owners} = await repository.discoverLegacyOwners({kind,...(id ? {id} : {})});
  if (owners.length !== 1) {
   if (!owners.length && kind === 'run') throw packageError('run_not_found','运行记录不存在。',404);
   throw required();
  }
  selected = {packageId:owners[0].ownerPackageId,targetRevisionId:owners[0].targetRevisionId};
 }
 // Empty results still pass the repository's before/after control and TTL fence.
 await repository.readView({select:[]},{scope:selected});
 if (input.runId) {
  const run = await repository.getRecord({collection:'runs',id:input.runId,ownerPackageId:selected.packageId},{scope:selected});
  if (!run || run.indexes.targetRevisionId !== selected.targetRevisionId) throw packageError('package_scope_mismatch','运行不属于此目标版本。');
 }
 if (input.applicationId && !await repository.getRow({collection:'applications',id:input.applicationId,ownerPackageId:selected.packageId},{scope:selected})) throw packageError('package_scope_mismatch','投递记录不存在于所选目标版本。');
 if (input.jobId) await resolveOwnedJobId(repository,selected,input.jobId);
 await repository.readView({select:[]},{scope:selected});
 return selected;
}

export async function resolveLegacyApplicationReference(id, input, repository) {
 if (await repository.getMeta('schemaVersion') !== 3) return {scope:undefined,isApplication:true};
 const {owners} = await repository.discoverLegacyOwners({kind:'application',id});
 const isApplication = owners.length > 0;
 const scope = await resolveLegacyScopeFromRepository({...input,...(isApplication ? {applicationId:id} : {jobId:id})},repository);
 return {scope,isApplication};
}
