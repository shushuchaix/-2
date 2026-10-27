import { resolveLegacyScopeFromRepository } from './legacy-scope.mjs';
import { resolveOwnedJobId } from './job-row-access.mjs';
import { packageError } from '../domain/packages.mjs';
import {rowKey} from '../infrastructure/storage/sqlite-records.mjs';

export async function guardLegacyScope(repository, scope) {
 await repository.readView({select:[]},{scope});
}

// `loadIndex` explicitly asks for the complete selected owner's legacy index.
export async function exportLegacyOwner(repository, scope) {
 await guardLegacyScope(repository,scope);
 const workspace = await repository.exportPackage(scope.packageId);
 for (const job of Object.values(workspace.jobs)) for (const alias of job.identityAliases || []) {
  workspace.identityAliases[alias] ||= [];
  if (!workspace.identityAliases[alias].includes(job.jobId)) workspace.identityAliases[alias].push(job.jobId);
 }
 workspace._scope = {...scope};
 await guardLegacyScope(repository,scope);
 return workspace;
}

export async function legacyTrackingPage(repository, scope, input = {}) {
 const selected = await repository.queryLegacyTrackingPage({...input,ownerPackageId:scope.packageId},{scope});
 const jobIds = selected.items.map(item => item.jobId), applicationIds = selected.items.map(item => item.applicationId).filter(Boolean), evaluationIds = selected.items.map(item => item.evaluationId).filter(Boolean);
 const view = await repository.readView({select:[
  {collection:'jobs',ownerPackageId:scope.packageId,ids:jobIds},
  {collection:'applications',ownerPackageId:scope.packageId,ids:applicationIds},
  {collection:'evaluations',ownerPackageId:scope.packageId,ids:evaluationIds},
 ]},{scope});
 const items = [];
 for (const item of selected.items) {
  const job = view.rows.jobs[item.jobId];
  if (!job) throw packageError('job_read_model_changed','岗位索引正在变化，请重新读取。');
  let id = item.jobId;
  for (const alias of job.identityAliases || []) {
   if (/^(?:id:|url:|fields:|content:|input:)/.test(alias)) continue;
   try { if (await resolveOwnedJobId(repository,scope,alias) === job.jobId) { id=alias; break; } }
   catch(error) { if (!['job_identity_ambiguous','job_not_found'].includes(error.code)) throw error; }
  }
  const application=view.rows.applications?.[item.applicationId] || {status:'new',note:''}, evaluation=view.rows.evaluations?.[item.evaluationId];
  items.push({...job.canonical,id,jobId:job.jobId,city:(job.canonical.cities || []).join(' / '),source:job.canonical.sourceId,
   firstSeen:job.firstSeen,lastSeen:job.lastSeen,seenCount:item.seenCount,score:evaluation?.score ?? null,scoreHistory:item.scoreHistory,
   status:application.status,note:application.note,lifecycle:job.lifecycle});
 }
 await guardLegacyScope(repository,scope);
 return {...selected,items};
}

/** Once a run completes, project only the application IDs for its requested jobs. */
export async function legacySnapshotWorkspace(repository, scope, snapshot) {
 const workspace={schemaVersion:3,jobs:Object.fromEntries((snapshot.jobs || []).map(job=>[job.jobId,job])),applications:{},identityAliases:{},jobRedirects:{}};
 const ids=Object.keys(workspace.jobs);
 for (let offset=0;offset<ids.length;offset+=200) {
  const page=await repository.queryLegacyTrackingPage({ownerPackageId:scope.packageId,jobIds:ids.slice(offset,offset+200),pageSize:200},{scope});
  const appIds=page.items.map(item=>item.applicationId).filter(Boolean);
  const rows=await repository.queryRows({collection:'applications',ownerPackageId:scope.packageId,ids:appIds},{scope});
  for (const row of rows.rows) {
   const jobId=page.items.find(item=>item.applicationId===row.id)?.jobId;
   workspace.applications[row.id]={...row.value,jobId,...(row.value.legacyJobIds?{legacyJobIds:[jobId]}:{})};
  }
 }
 await guardLegacyScope(repository,scope);
 return workspace;
}

export async function hydrateLegacySnapshot(repository, scope, snapshot) {
 const runId=snapshot.run.runId,view=await repository.readView({select:[{collection:'runSnapshots',ownerPackageId:scope.packageId,ids:[rowKey(runId,'targetSnapshot','value'),rowKey(runId,'profileSnapshot','value')]}]},{scope});
 const target=view.rows.runSnapshots?.[rowKey(runId,'targetSnapshot','value')],profile=view.rows.runSnapshots?.[rowKey(runId,'profileSnapshot','value')];
 if(!target || target.revisionId!==scope.targetRevisionId)throw packageError('snapshot_identity_conflict','运行缺少经过验证的原目标快照。');
 return {...snapshot,run:{...snapshot.run,targetSnapshot:target},profileRevision:snapshot.profileRevision||snapshot.profile||profile||target.profileSnapshot};
}

/** Diagnostic ownership is a metadata query; logger filtering happens once, before its limit. */
export async function legacyDiagnosticSelection(repository, selection, runId, candidateRunIds = []) {
 if (runId) {
  const scope=await resolveLegacyScopeFromRepository({...(selection.allTargets?{}:{scope:selection}),runId},repository);
  return {runIds:[runId],scopes:[scope]};
 }
 if(!Array.isArray(candidateRunIds))throw packageError('diagnostic_snapshot_invalid','诊断快照无效。',400);
 if(!selection.allTargets)await guardLegacyScope(repository,selection);
 const scopes=new Map(selection.allTargets?[]:[[selection.packageId,selection]]),runIds=[];
 // Candidate identities come only from this logger's retained snapshot. The
 // fixed query reads routing metadata, never every historical owner or run.
 for(let offset=0;offset<Math.max(1,candidateRunIds.length);offset+=200){
  const page=await repository.queryDiagnosticRunScopes({runIds:candidateRunIds.slice(offset,offset+200)},selection.allTargets?{}:{scope:selection});
  for(const item of page.items){const scope={packageId:item.ownerPackageId,targetRevisionId:item.targetRevisionId};scopes.set(scope.packageId,scope);runIds.push(item.runId);}
 }
 for(const scope of scopes.values())await guardLegacyScope(repository,scope);
 return {runIds:[...new Set(runIds)],scopes:[...scopes.values()]};
}
