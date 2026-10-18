// Legacy API facade over the authoritative v2 workspace.
import path from "node:path";
import { DATA_ROOT } from "./config.mjs";
import { APPLICATION_STATUSES } from "./domain/contracts.mjs";
import {
  openWorkspaceRepository,
  contentHash,
} from "./infrastructure/storage/repository.mjs";
import { migrateV1 } from "./infrastructure/storage/migrate-v1.mjs";
import { createWorkspaceOperationGate } from "./application/workspace-operations.mjs";
import {getDefaultApplicationContext} from './application/context.mjs';
import {resolveLegacyScopeFromRepository,resolveLegacyApplicationReference} from './application/legacy-scope.mjs';
import {exportLegacyOwner,legacyTrackingPage,guardLegacyScope} from './application/legacy-bridge.mjs';
import {ingestRecordsDraft} from './domain/ingest-records.mjs';
import {rowKey} from './infrastructure/storage/sqlite-records.mjs';
import {resolveOwnedJobId} from './application/job-row-access.mjs';
import {randomUUID} from 'node:crypto';
import {
  resolveJobId,
  resolveJobIds,
  jobIdMatches,
  projectJobApplication,
  findAssociatedApplication,
} from "./domain/job-resolution.mjs";
import {
  selectVersionJobFact,
  selectMatchingEvaluation,
} from "./domain/job-facts.mjs";
import { normalizeRecord } from "./domain/record.mjs";
import { upgradeWorkspace } from "./infrastructure/storage/upgrade-workspace.mjs";
import {
  createJobService,
  resolveStoredJobId,
} from "./application/job-service.mjs";
export const STATUSES = APPLICATION_STATUSES;
export const STATUS_LABELS = {
  new: "未处理",
  seen: "已看过",
  interested: "感兴趣",
  applied: "已投递",
  interviewing: "面试中",
  offer: "已录用",
  rejected: "已拒",
  ignored: "不感兴趣",
};
export const INDEX_PATH = path.join(DATA_ROOT, "workspace.v2.json");
let ready;
async function context(provided) {
  if(provided)return provided;
  ready ||= (async () => {
    const app=await getDefaultApplicationContext((await import('./config.mjs')).loadConfig({quiet:true}));return {...app,service:app.jobService};
  })();
  return ready;
}
function view(w) {
  const jobs = {};
  for (const job of Object.values(w.jobs)) {
    const legacy = Object.entries(w.identityAliases).find(
      ([key, ids]) =>
        !key.startsWith("id:") &&
        !key.startsWith("url:") &&
        !key.startsWith("fields:") &&
        !key.startsWith("content:") &&
        !key.startsWith("input:") &&
        resolveJobIds(w, ids, { allowMissing: true }).length === 1 &&
        resolveJobId(w, ids[0], { allowMissing: true }) === job.jobId,
    )?.[0];
    const id = legacy || job.jobId;
    const evaluations = Object.values(w.evaluations)
      .filter((e) => jobIdMatches(w, e.jobId, job.jobId))
      .sort((a, b) =>
        String(b.createdAt || "").localeCompare(a.createdAt || ""),
      );
    const fact = selectVersionJobFact(w, { jobId: job.jobId }),
      evaluation = selectMatchingEvaluation(w, {
        jobId: job.jobId,
        factContentHash: fact.factContentHash,
      }),
      application = projectJobApplication(w, job.jobId);
    jobs[id] = {
      ...job.canonical,
      id,
      jobId: job.jobId,
      city: job.canonical.cities.join(" / "),
      source: job.canonical.sourceId,
      firstSeen: job.firstSeen,
      lastSeen: job.lastSeen,
      seenCount: new Set(
        Object.values(w.observations)
          .filter((o) => jobIdMatches(w, o.jobId, job.jobId))
          .map((o) => o.runId),
      ).size,
      score: evaluation?.score ?? null,
      scoreHistory: evaluations.map((e) => ({
        at: e.createdAt,
        score: e.score,
      })),
      status: application.status,
      note: application.note,
      lifecycle: job.lifecycle,
    };
  }
  return {
    version: 1,
    jobs,
    runs: Object.values(w.runs),
    updatedAt:
      Object.values(w.jobs)
        .map((j) => j.lastSeen)
        .sort()
        .at(-1) || "",
  };
}
export async function loadIndex({scope,context:provided,targetRevisionId,targetId}={}) {
  const ctx=await context(provided),selected=await resolveLegacyScopeFromRepository({scope,targetRevisionId,targetId},ctx.repository);
  return view(selected?await exportLegacyOwner(ctx.repository,selected):await ctx.repository.read());
}
export async function saveIndex(index,{scope,context:provided,targetRevisionId,targetId}={}) {
  const ctx=await context(provided),{repository}=ctx;
  if(await repository.getMeta('schemaVersion')===3){
    const selected=await resolveLegacyScopeFromRepository({scope,targetRevisionId,targetId},repository),service=ctx.jobService||ctx.service;
    for(const rec of Object.values(index.jobs||{}))await service.updateJobApplication(rec.jobId||rec.id,{...(Object.hasOwn(rec,'status')?{status:rec.status}:{}),...(Object.hasOwn(rec,'note')?{note:rec.note}:{})},selected);
    await guardLegacyScope(repository,selected);return {ok:true};
  }
  await repository.mutateWorkspace((w) => {
    for (const rec of Object.values(index.jobs || {})) {
      const id = resolveStoredJobId(w, rec.jobId || rec.id);
      const a = findAssociatedApplication(w, id) || {
        jobId: id,
        status: "new",
        note: "",
        events: [],
      };
      const changes = {};
      for (const key of ["status", "note"])
        if (Object.hasOwn(rec, key) && a[key] !== rec[key]) {
          changes[key] = { from: a[key], to: rec[key] };
          a[key] = rec[key];
        }
      if (Object.keys(changes).length)
        a.events.push({
          type: "application_updated",
          at: new Date().toISOString(),
          changes,
        });
      w.applications[a.jobId] = a;
    }
  });
  return { ok: true };
}
export async function upsert(
  jobs = [],
  {
    runId = "",
    at = new Date().toISOString(),
    persist = true,
    operationLease,
    scope,
    context:provided,
  } = {},
) {
  const ctx = await context(provided);
  if(await ctx.repository.getMeta('schemaVersion')===3)return upsertOwned(jobs,{runId,at,persist,operationLease,scope,context:ctx});

  if (persist && !operationLease)
    return ctx.operationGate.withOperation("legacy", {scope}, (lease) =>
      upsert(jobs, { runId, at, persist, operationLease: lease,scope,context:ctx }),
    );
  const before = await ctx.repository.read();
  let repository = ctx.repository;
  if (!persist) {
    let state = structuredClone(before);
    repository = {
      ...repository,
      read: async () => structuredClone(state),
      mutateWorkspace: async (fn) => {
        const result = await fn(state);
        state.revision++;
        return { revision: state.revision, result };
      },
    };
  }
  const service = createJobService({ repository });
  const valid = jobs.filter((j) => j.title && j.url);
  const { jobIds } = await service.ingestRecords({
    runId: runId || "legacy-" + Date.now(),
    records: valid,
    observedAt: at,
    scope,
  });
  const evaluations = valid.flatMap((j, i) =>
    typeof j.score === "number"
      ? [
          {
            evaluationId:
              "legacy-" + contentHash([runId, jobIds[i], j.score]).slice(0, 24),
            jobId: jobIds[i],
            jdHash: contentHash(normalizeRecord(j).description || ""),
            score: j.score,
            status: "legacy",
            targetRevisionId: null,
            createdAt: at,
          },
        ]
      : [],
  );
  if (evaluations.length&&before.schemaVersion!==3) await service.saveEvaluations(evaluations);
  const added = [],
    ongoing = [];
  const counted = new Set();
  valid.forEach((j, i) => {
    if (counted.has(jobIds[i])) return;
    counted.add(jobIds[i]);
    (resolveJobId(before, jobIds[i], { allowMissing: true })
      ? ongoing
      : added
    ).push(j.id || jobIds[i]);
  });
  const updated=await repository.read(),index = view(updated);
  return {
    added,
    ongoing,
    disappeared: [],
    saved: { ok: true },
    stats: {
      total: Object.keys(index.jobs).length,
      added: added.length,
      ongoing: ongoing.length,
      disappeared: 0,
      pruned: 0,
      persisted: persist,
    },
    index,
  };
}
export async function annotate(jobs = [], diff, { now = Date.now(),scope,context:provided } = {}) {
  const ctx=await context(provided),selected=await resolveLegacyScopeFromRepository({scope},ctx.repository);
  const resolvedJobIds = new Map();
  let w,index;
  if(selected){
    const ids=[];
    for(const job of jobs){const requested=job.jobId||job.id,resolved=await resolveOwnedJobId(ctx.repository,selected,requested);resolvedJobIds.set(requested,resolved);ids.push(resolved);}
    const rows=[];
    for(let offset=0;offset<ids.length;offset+=200)rows.push(...(await legacyTrackingPage(ctx.repository,selected,{jobIds:ids.slice(offset,offset+200),pageSize:200})).items);
    index={jobs:Object.fromEntries(rows.map(row=>[row.id,row]))};
  }else{w=await ctx.repository.read();index=diff.index||view(w);}
  for (const j of jobs) {
    const rec =
      (selected ? Object.values(index.jobs).find(r => r.jobId === resolvedJobIds.get(j.jobId || j.id)) : index.jobs[j.id]) ||
      Object.values(index.jobs).find((r) =>
        selected?r.jobId===(j.jobId||j.id)||r.id===(j.jobId||j.id):jobIdMatches(w, r.jobId, j.jobId || j.id),
      );
    j.tracking = {
      isNew: diff.added.includes(j.id || j.jobId),
      firstSeen: rec?.firstSeen || "",
      lastSeen: rec?.lastSeen || "",
      seenCount: rec?.seenCount || 1,
      status: rec?.status || "new",
      statusLabel: STATUS_LABELS[rec?.status || "new"],
      daysListed: rec?.firstSeen
        ? Math.max(0, Math.floor((now - Date.parse(rec.firstSeen)) / 864e5))
        : 0,
    };
  }
  return { jobs, disappearedIds: [] };
}
export async function setStatus(id, status, note,{scope,context:provided}={}) {
  const ctx=await context(provided),service=ctx.jobService||ctx.service,{scope:selected,isApplication}=await resolveLegacyApplicationReference(id,{scope},ctx.repository);
  const patch={status};if(note!==undefined)patch.note=note;
  return selected?(isApplication?service.updateApplication(id,patch,selected):service.updateJobApplication(id,patch,selected)):service.updateApplication(id,patch);
}
export async function summary(options={}) {
  const ctx=await context(options.context),selected=await resolveLegacyScopeFromRepository(options,ctx.repository);
  if(selected){
    const result=await ctx.repository.queryLegacyTrackingSummary({ownerPackageId:selected.packageId},{scope:selected});
    const byStatus=Object.fromEntries(STATUSES.map(status=>[status,0]));let total=0,staleCount=0,updatedAt='';
    for(const row of result.statuses){byStatus[row.status]=(byStatus[row.status]||0)+row.n;total+=row.n;staleCount+=options.staleMode==='lifecycle'?row.lifecycleStale:row.seenStale;if((row.updatedAt||'')>updatedAt)updatedAt=row.updatedAt;}
    return {total,byStatus,statusLabels:STATUS_LABELS,staleCount,runs:result.runs,updatedAt};
  }
  const index = await loadIndex({...options,context:ctx});
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const rec of Object.values(index.jobs)) byStatus[rec.status]++;
  return {
    total: Object.keys(index.jobs).length,
    byStatus,
    statusLabels: STATUS_LABELS,
    staleCount: Object.values(index.jobs).filter(
      (r) => options.staleMode==='lifecycle'?r.lifecycle==='notRecentlySeen':r.seenCount >= 5 && ["new", "seen"].includes(r.status),
    ).length,
    runs: index.runs.filter(r=>r.collectionRole!=='collection_root').length,
    updatedAt: index.updatedAt,
  };
}
export async function listJobs({ status = "", limit = 200,...options } = {}) {
  const ctx=await context(options.context),selected=await resolveLegacyScopeFromRepository(options,ctx.repository);
  if(selected){
    const items=[];let page=1;
    while(items.length<limit){const next=await legacyTrackingPage(ctx.repository,selected,{status:status||undefined,page,pageSize:Math.min(200,Math.max(1,limit))});items.push(...next.items);if(!next.items.length||items.length>=next.total)break;page++;}
    return items.slice(0,limit);
  }
  return Object.values((await loadIndex({...options,context:ctx})).jobs)
    .filter((r) => !status || r.status === status)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, limit);
}

async function upsertOwned(jobs,{runId,at,persist,operationLease,scope,context:ctx}) {
  const repository=ctx.repository,existing=runId?(await repository.discoverLegacyOwners({kind:'run',id:runId})).owners:[];
  scope=await resolveLegacyScopeFromRepository({scope,...(existing.length?{runId}:{})},repository);
  if(persist&&!operationLease)return ctx.operationGate.withOperation('legacy',{scope},lease=>upsertOwned(jobs,{runId,at,persist,operationLease:lease,scope,context:ctx}));
  const valid=jobs.filter(job=>job.title&&job.url);runId ||= 'legacy-'+randomUUID();
  const target=await repository.getRow({collection:'targets',id:scope.targetRevisionId,ownerPackageId:scope.packageId},{scope});
  const header={runId,recordId:randomUUID(),ownerPackageId:scope.packageId,status:'completed',lastSeq:0,createdAt:at,counts:{},usage:{},snapshotRef:null};
  let result,index;
  if(!persist){
    const workspace=await exportLegacyOwner(repository,scope);
    workspace.runs[runId] ||= {...header,targetSnapshot:target,events:[],issues:[]};
    result=ingestRecordsDraft(workspace,{scope,runId,records:valid,observedAt:at});index=view(workspace);
  }else{
    const prior=await repository.getRow({collection:'runs',id:runId,ownerPackageId:scope.packageId},{scope});
    if(!prior)await repository.transaction({select:[{collection:'runs',ownerPackageId:scope.packageId,ids:[runId]},{collection:'runSnapshots',ownerPackageId:scope.packageId,ids:[rowKey(runId,'targetSnapshot','value')]}]},tx=>{
      if(!tx.getRow({collection:'runs',id:runId})){tx.putRow({collection:'runs',id:runId,ownerPackageId:scope.packageId,value:header});tx.putRow({collection:'runSnapshots',id:rowKey(runId,'targetSnapshot','value'),ownerPackageId:scope.packageId,parent:{collection:'runs',id:runId,path:'targetSnapshot'},value:target});}
    },{scope,operationLease});
    const service=ctx.jobService||ctx.service||createJobService({repository}),jobIds=[],newForTarget=[];
    for(let offset=0;offset<valid.length;offset+=1000){const batch=await service.ingestRecords({scope,runId,records:valid.slice(offset,offset+1000),observedAt:at,operationLease});jobIds.push(...batch.jobIds);newForTarget.push(...batch.newForTarget);}
    result={jobIds,newForTarget};index=view(await exportLegacyOwner(repository,scope));
  }
  const added=[],ongoing=[],counted=new Set(),fresh=new Set(result.newForTarget);
  valid.forEach((job,i)=>{const id=result.jobIds[i];if(counted.has(id))return;counted.add(id);(fresh.has(id)?added:ongoing).push(job.id||id);});
  return {added,ongoing,disappeared:[],saved:{ok:true},stats:{total:Object.keys(index.jobs).length,added:added.length,ongoing:ongoing.length,disappeared:0,pruned:0,persisted:persist},index};
}
