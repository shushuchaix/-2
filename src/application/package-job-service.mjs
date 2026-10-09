import {randomUUID} from 'node:crypto';
import {assertScope,assertOwned,requirePackage,packageError} from '../domain/packages.mjs';
import {resolveJobId,projectJobApplication} from '../domain/job-resolution.mjs';
import {assertInput,inputError} from '../../public/js/validation-rules.js';
import {packageWorkspace,mergePackageWorkspace} from '../domain/package-workspace.mjs';
export {packageWorkspace,mergePackageWorkspace} from '../domain/package-workspace.mjs';
export function createPackageJobService({repository,clock=repository.clock,legacyFactory}) {
  const at=()=>new Date(clock.now()).toISOString();
  function service(scope,snapshot) {
    return legacyFactory({clock,repository:{...repository,
      async read(){const w=snapshot||await repository.read();assertScope(w,scope,clock.now());return packageWorkspace(w,scope.packageId);},
      async mutateWorkspace(action,options){return repository.mutateWorkspace(async w=>{assertScope(w,scope,clock.now());const view=packageWorkspace(w,scope.packageId);const result=await action(view);mergePackageWorkspace(w,view,scope.packageId);return result;},options);}
    }});
  }
  function resolveOwnedJob(w,id,scope){assertScope(w,scope,clock.now());if(w.jobs[id])assertOwned(w,w.jobs[id],scope.packageId);if(w.jobRedirects?.[id]&&w.jobRedirects[id].ownerPackageId!==scope.packageId)throw packageError('package_scope_mismatch','岗位重定向归属不一致。');return resolveJobId(packageWorkspace(w,scope.packageId),id);}
  async function checkJob(id,scope) {return resolveOwnedJob(await repository.read(),id,scope);}
  function applyPatch(w,application,patch,scope) {
    assertInput('application',patch);
    const target=Object.values(w.targets).flat().find(t=>t.revisionId===scope.targetRevisionId);
    if(Object.hasOwn(patch,'resumeRevisionId')&&patch.resumeRevisionId!=null&&patch.resumeRevisionId!==target.profileSnapshot?.revisionId)throw packageError('package_scope_mismatch','投递简历只能使用本目标自有简历副本。');
    const changes={};for(const key of ['status','note','resumeRevisionId','appliedAt','followUpAt'])if(Object.hasOwn(patch,key)&&application[key]!==patch[key]){changes[key]={from:application[key],to:patch[key]};application[key]=patch[key];}
    if(Object.keys(changes).length)application.events.push({recordId:randomUUID(),ownerPackageId:scope.packageId,type:'application_updated',at:at(),changes});
    return structuredClone(application);
  }
  const api={
    async ingestRecords(input){await checkRun(input.runId,input.scope);return service(input.scope).ingestRecords({...input,targetRevisionId:input.scope.targetRevisionId});},
    async finalizeCoverage(input){await checkRun(input.runId,input.scope);return service(input.scope).finalizeCoverage(input);},
    async saveEvaluations(evaluations,scope){for(const e of evaluations)await checkJob(e.jobId,scope);return service(scope).saveEvaluations(evaluations);},
    async queryJobs(filters={}) {
      const w=await repository.read();
      if(!filters.allTargets){assertScope(w,filters,clock.now());const rows=await service(filters).queryJobs(filters);return decorate(rows,filters,w);}
      const rows=[];
      for(const p of Object.values(w.packages).filter(p=>p.kind==='target'&&p.state==='active')) {
        const scope={packageId:p.packageId,targetRevisionId:p.versionId};const scoped={...filters,...scope};delete scoped.allTargets;
        const result=await service(scope,w).queryJobs({...scoped,page:1,pageSize:200});rows.push(...decorate(result,scope,w).items);
        for(let page=2;rows.filter(r=>r.ownerPackageId===scope.packageId).length<result.total;page++){const next=await service(scope,w).queryJobs({...scoped,page,pageSize:200});if(!next.items.length)break;rows.push(...decorate(next,scope,w).items);}
      }
      rows.sort((a,b)=>(b.evaluation?.score||0)-(a.evaluation?.score||0)||b.job.lastSeen.localeCompare(a.job.lastSeen));const page=Math.max(1,Number(filters.page)||1),pageSize=Math.max(1,Math.min(200,Number(filters.pageSize)||25));return {items:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,readOnly:true};
    },
    async queryApplications(filters={}){
      assertInput('filters',filters);const w=await repository.read();if(!filters.allTargets)assertScope(w,filters,clock.now());
      const selected=Object.values(w.applications).filter(a=>filters.allTargets?w.packages[a.ownerPackageId]?.kind==='target'&&w.packages[a.ownerPackageId].state==='active':a.ownerPackageId===filters.packageId).filter(a=>!(filters.status||filters.applicationStatus)||['all',a.status].includes(filters.status||filters.applicationStatus));
      const rows=selected.map(a=>{const pkg=w.packages[a.ownerPackageId],job=w.jobs[a.jobId],canonical=job?.canonical||{};return {...structuredClone(a),application:structuredClone(a),job:structuredClone(job),canonical:structuredClone(canonical),title:canonical.title||'',company:canonical.company||'',packageId:pkg.packageId,targetRevisionId:pkg.versionId,versionName:pkg.versionName,scope:{packageId:pkg.packageId,targetRevisionId:pkg.versionId}};}).filter(r=>!filters.search||[r.title,r.company,r.note].some(v=>String(v||'').toLowerCase().includes(String(filters.search).toLowerCase())));
      const page=Math.max(1,Number(filters.page)||1),pageSize=Math.max(1,Math.min(200,Number(filters.pageSize)||25));return {items:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,readOnly:!!filters.allTargets};
    },
    async getJob(id,scope){await checkJob(id,scope);const result=await service(scope).getJob(id,scope);return {...result,ownerPackageId:scope.packageId,packageId:scope.packageId};},
    async getApplication(id,scope){const w=await repository.read();assertScope(w,scope,clock.now());const application=w.applications[id];if(!application)throw packageError('application_not_found','投递记录不存在。',404);assertOwned(w,application,scope.packageId);return {application:structuredClone(application),association:{status:'single',jobIds:[application.jobId]},unresolved:false};},
    async updateApplication(id,patch,scope){return (await repository.mutateWorkspace(w=>{assertScope(w,scope,clock.now());const current=w.applications[id];if(!current)throw packageError('application_not_found','投递记录不存在。',404);assertOwned(w,current,scope.packageId);return applyPatch(w,current,patch,scope);})).result;},
    async updateJobApplication(id,patch,scope){return (await repository.mutateWorkspace(w=>{id=resolveOwnedJob(w,id,scope);let current=Object.values(w.applications).find(a=>a.jobId===id&&a.ownerPackageId===scope.packageId);if(!current){const applicationId='a-'+randomUUID();current={applicationId,jobId:id,recordId:randomUUID(),ownerPackageId:scope.packageId,status:'new',note:'',resumeRevisionId:null,appliedAt:null,followUpAt:null,events:[]};w.applications[applicationId]=current;}return applyPatch(w,current,patch,scope);})).result;},
    async linkJobs(a,b,scope){await checkJob(a,scope);await checkJob(b,scope);return service(scope).linkJobs(a,b);},
    async unlinkJobs(a,b,scope){await checkJob(a,scope);await checkJob(b,scope);return service(scope).unlinkJobs(a,b);},
    async listUnresolvedApplications(filters={}){if(!filters.allTargets)assertScope(await repository.read(),filters,clock.now());return {items:[],total:0};}
  };
  async function checkRun(id,scope){const w=await repository.read();assertScope(w,scope,clock.now());assertOwned(w,w.runs[id],scope.packageId);}
  function decorate(result,scope,w){return {...result,pageSize:result.pageSize,items:result.items.map(row=>({...row,ownerPackageId:scope.packageId,packageId:scope.packageId,targetRevisionId:scope.targetRevisionId,versionName:w.packages[scope.packageId].versionName,scope:{packageId:scope.packageId,targetRevisionId:scope.targetRevisionId}}))};}
  return api;
}
