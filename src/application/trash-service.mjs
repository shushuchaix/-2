import { randomUUID } from "node:crypto";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import {
  archiveDeadline,
  requirePackage,
  isExpired,
  packageError,
  PACKAGE_KINDS,
} from "../domain/packages.mjs";
import {
  countPackageRecords,
  packageRecords,
} from "../domain/package-ownership.mjs";
import { assertOwned } from "../domain/packages.mjs";
import { normalizeCollectionRun } from "../domain/collection.mjs";
function pauseOwnedCollections(w, packageId) {
  for (const [id, run] of Object.entries(w.runs))
    if (
      run.ownerPackageId === packageId &&
      run.collectionRole === "collection_root"
    ) {
      const normalized = normalizeCollectionRun(run, { restored: true });
      normalized.collectionProgress.refreshReady = false;
      normalized.collectionProgress.manualPaused = true;
      normalized.collectionProgress.resumeRequests = {};
      w.runs[id] = normalized;
    }
  if (w.packages[packageId].collectionSettings) {
    w.packages[packageId].collectionSettings.sessionRefs = {};
    w.packages[packageId].collectionSettings.refreshEnabled = false;
  }
}

const COUNT_KEYS = [
  "profiles",
  "targets",
  "jobs",
  "observations",
  "evaluations",
  "runs",
  "applications",
  "events",
  "files",
];
const sum = (counts) =>
  Object.fromEntries(
    COUNT_KEYS.map((k) => [k, counts.reduce((n, c) => n + (c[k] || 0), 0)]),
  );
const stale = () =>
  packageError(
    "trash_preview_stale",
    "回收站内容或归档实例已变化，请重新预览。",
  );
export function activePackageOperations(w, packageId) {
  const p = w.packages[packageId];
  const leases = Object.entries(w.operationLeases || {})
    .filter(([, l]) => {
      const ids =
        l.packageIds ||
        (l.packageId
          ? [l.packageId]
          : l.scope?.packageId
            ? [l.scope.packageId]
            : null);
      if (ids) return ids.includes(packageId);
      return (
        l.targetRevisionId === p?.versionId ||
        (p?.kind === "profile" &&
          !l.targetRevisionId &&
          l.profileRevisionId === p.versionId)
      );
    })
    .map(([operationId, l]) => ({ ...l, operationId }));
  const runs = Object.values(w.runs).filter(
    (r) =>
      r.ownerPackageId === packageId &&
      ["queued", "running"].includes(r.status),
  );
  return { leases, runs, busy: leases.length > 0 || runs.length > 0 };
}
function scopeOf({ packageIds, emptyAll = false, expiredOnly = false } = {}) {
  if (
    typeof emptyAll !== "boolean" ||
    typeof expiredOnly !== "boolean" ||
    (packageIds !== undefined && !Array.isArray(packageIds)) ||
    Number(emptyAll) +
      Number(expiredOnly) +
      Number(packageIds !== undefined) !==
      1
  )
    throw packageError(
      "trash_scope_required",
      "请选择要删除的版本、整个回收站或已到期版本。",
      400,
    );
  if (packageIds?.some((id) => typeof id !== "string" || !id))
    throw packageError("trash_scope_required", "所选数据包标识无效。", 400);
  return {
    emptyAll,
    expiredOnly,
    ...(packageIds !== undefined
      ? { packageIds: [...new Set(packageIds)].sort() }
      : {}),
  };
}
function buildPreview(w, control, scope, now, countsByPackage) {
  const selected = scope.packageIds
    ? scope.packageIds.map((id) => {
        const p = w.packages[id];
        if (!p)
          throw packageError("package_not_found", "所选版本已不存在。", 404);
        if (!["trashed", "purge_pending"].includes(p.state))
          throw packageError(
            "package_scope_mismatch",
            "只能清理回收站内的版本。",
          );
        return p;
      })
    : Object.values(w.packages).filter((p) =>
        scope.expiredOnly
          ? isExpired(p, now)
          : ["trashed", "purge_pending"].includes(p.state),
      );
  const candidates = selected
    .sort((a, b) => a.packageId.localeCompare(b.packageId))
    .map((p) => ({
      packageId: p.packageId,
      archiveId: p.archiveId,
      purgeAt: p.purgeAt,
      archivedAt: p.archivedAt,
      state: p.state,
      expired: isExpired(p, now),
      kind: p.kind,
      ...(p.state === "trashed" ? { versionName: p.versionName } : {}),
      counts:
        p.state === "purge_pending"
          ? sum([control.deletionLedger[p.packageId]?.counts || {}])
          : (countsByPackage?.[p.packageId] || countPackageRecords(w, p.packageId)),
    }));
  const preview = {
    workspaceRevision: w.revision,
    scope,
    candidates,
    totals: sum(candidates.map((p) => p.counts)),
    packageCount: candidates.length,
  };
  return { ...preview, planHash: contentHash(preview) };
}
export function createTrashService({
  repository,
  clock = repository.clock,
  cancelPackageAndWait,
  purgeService,
  cleanupPackage,
}) {
  let purge = purgeService;
  const at = () => new Date(clock.now()).toISOString();
  async function packageMetadataRows(){
    const result=[];let afterId;
    do{const page=await repository.queryRows({collection:'packages',limit:200,...(afterId?{afterId}:{})});result.push(...page.rows.map(r=>r.value));afterId=page.hasMore?page.nextCursor:null;}while(afterId);
    const control=await repository.readControl();
    return result.filter(p=>control.deletionLedger[p.packageId]?.phase!=='purged').map(p=>{
      const ledger=control.deletionLedger[p.packageId];
      return ledger?{...p,state:'purge_pending',archiveId:ledger.archiveId,archivedAt:ledger.archivedAt,purgeAt:ledger.purgeAt}:p;
    });
  }
  async function finishArchive(packageId){
    const task=(await repository.readControl()).migrationJournal.archives?.[packageId];if(!task||task.phase!=='prepared')return;
    if(cleanupPackage){const cleaned=await cleanupPackage(packageId);if(cleaned?.status==='cleanup_pending')throw packageError('attachment_cleanup_pending','临时文件仍被占用，请重试归档。',503);}
    return repository.withWriteFence(async fence=>{
      const p=fence.getRow({collection:'packages',id:packageId}),current=fence.control.migrationJournal.archives?.[packageId];
      if(!p||!current||current.phase!=='prepared')throw packageError('package_not_found','归档版本不存在。',404);
      if(p.state!=='trashed'){
        const state=fence.readOperationState();if(state.hasMore||state.runs.some(r=>r.ownerPackageId===packageId)||state.leases.some(l=>(l.packageIds||[]).includes(packageId)))throw packageError('workspace_operation_busy','该版本仍有活动操作。');
        const roots=fence.queryRows({collection:'runs',ownerPackageId:packageId,where:{kind:'collection_root'},limit:200});if(roots.hasMore)throw packageError('workspace_operation_busy','活动数量超过安全上限。');
        Object.assign(p,current.episode,{state:'trashed'});if(p.collectionSettings){p.collectionSettings.sessionRefs={};p.collectionSettings.refreshEnabled=false;}
        const meta=fence.getRow({collection:'versionMetadata',id:p.versionId});
        fence.transaction({select:[{collection:'packages',ids:[packageId]},{collection:'versionMetadata',ids:[p.versionId]},{collection:'runs',ownerPackageId:packageId,ids:roots.rows.map(r=>r.id)}]},tx=>{
          tx.putRow({collection:'packages',id:packageId,value:p});if(meta)tx.putRow({collection:'versionMetadata',id:p.versionId,ownerPackageId:packageId,value:{...meta,archivedAt:p.archivedAt,updatedAt:p.archivedAt}});
          for(const row of roots.rows){const run=normalizeCollectionRun(row.value,{restored:true});run.collectionProgress.refreshReady=false;run.collectionProgress.manualPaused=true;run.collectionProgress.resumeRequests={};tx.putRow({collection:'runs',id:row.id,ownerPackageId:packageId,value:run});}
        });
      }
      const completed=fence.control;completed.migrationJournal.archives[packageId].phase='complete';await fence.commitControl(completed);return structuredClone(p);
    },{operationMaintenance:true,access:'management'});
  }
  const service = {
    setPurgeService(value) {
      purge = value;
    },
    async archive({packageId,cancelActive=false}) {
      if(typeof cancelActive!=='boolean')throw packageError('validation_failed','取消活动任务选项无效。',400);
      const initial=await repository.withWriteFence(fence=>{
        const p=fence.getRow({collection:'packages',id:packageId});requirePackage({packages:p?{[packageId]:p}:{}},packageId,{access:'management',now:clock.now()});
        const state=fence.readOperationState();if(state.hasMore)throw packageError('workspace_operation_busy','活动操作超过安全上限。');
        return {p,busy:state.runs.some(r=>r.ownerPackageId===packageId)||state.leases.some(l=>(l.packageIds||[]).includes(packageId)||['restore','upgrade','cleanup','permanent-delete'].includes(l.kind))};
      },{operationMaintenance:true,access:'management'});
      if(initial.p.state==='trashed')return initial.p;
      if(initial.busy){if(!cancelActive||!cancelPackageAndWait)throw packageError('workspace_operation_busy','该版本仍有检索、评分或导入操作。');await cancelPackageAndWait(packageId);}
      await repository.withWriteFence(async fence=>{
        const p=fence.getRow({collection:'packages',id:packageId});requirePackage({packages:{[packageId]:p}},packageId,{access:'management',now:clock.now()});
        const state=fence.readOperationState();if(state.hasMore||state.runs.some(r=>r.ownerPackageId===packageId)||state.leases.some(l=>(l.packageIds||[]).includes(packageId)||['restore','upgrade','cleanup','permanent-delete'].includes(l.kind)))throw packageError('workspace_operation_busy','版本活动操作尚未结束。');
        const c=fence.control;c.migrationJournal.archives||={};
        if(c.migrationJournal.archives[packageId]?.phase==='prepared')return;
        const archivedAt=at(),archiveId=randomUUID(),episode={packageId,archiveId,archivedAt,purgeAt:archiveDeadline(archivedAt),legacy:false};
        c.archiveEpisodes[archiveId]=episode;c.migrationJournal.archives[packageId]={phase:'prepared',episode};await fence.commitControl(c);
      },{operationMaintenance:true,access:'management'});
      // File/window/attachment draining never holds the fence: reverse ledger RPC
      // remains able to settle while the persisted archive intent blocks new work.
      return finishArchive(packageId);
    },
    async restore({packageId,archiveId}){
      return repository.withWriteFence(async fence=>{
        const p=fence.getRow({collection:'packages',id:packageId});requirePackage({packages:p?{[packageId]:p}:{}},packageId,{access:'trash_read',now:clock.now()});
        if(p.archiveId!==archiveId)throw stale();
        const state=fence.readOperationState();if(state.hasMore||state.runs.some(r=>r.ownerPackageId===packageId)||state.leases.some(l=>(l.packageIds||[]).includes(packageId)))throw packageError('workspace_operation_busy','该版本仍有活动操作。');
        const roots=fence.queryRows({collection:'runs',ownerPackageId:packageId,where:{kind:'collection_root'},limit:200});if(roots.hasMore)throw packageError('workspace_operation_busy','活动数量超过安全上限。');
        const meta=fence.getRow({collection:'versionMetadata',id:p.versionId});
        Object.assign(p,{state:'active',archiveId:null,archivedAt:null,purgeAt:null});
        if(p.collectionSettings){p.collectionSettings.sessionRefs={};p.collectionSettings.refreshEnabled=false;}
        const selection={select:[{collection:'packages',ids:[packageId]},{collection:'versionMetadata',ids:[p.versionId]},
          {collection:'runs',ownerPackageId:packageId,ids:roots.rows.map(r=>r.id)}]};
        fence.transaction(selection,tx=>{
          tx.putRow({collection:'packages',id:packageId,value:p});
          if(meta)tx.putRow({collection:'versionMetadata',id:p.versionId,ownerPackageId:packageId,value:{...meta,archivedAt:null,updatedAt:at()}});
          for(const row of roots.rows){const run=normalizeCollectionRun(row.value,{restored:true});run.collectionProgress.refreshReady=false;run.collectionProgress.manualPaused=true;run.collectionProgress.resumeRequests={};tx.putRow({collection:'runs',id:row.id,ownerPackageId:packageId,value:run});}
        });return structuredClone(p);
      },{operationMaintenance:true,access:'trash_read'});
    },
    async resumePending(){
      const control=await repository.readControl(),pending=[];
      for(const [id,task]of Object.entries(control.migrationJournal.archives||{}))if(task.phase==='prepared'){
        try{await finishArchive(id);}catch{pending.push(id);}
      }return {pending};
    },
    async list({ kind, search = "", sort = "purgeAt" } = {}) {
      if (kind && !PACKAGE_KINDS.includes(kind))
        throw packageError("validation_failed", "版本种类无效。", 400);
      if (
        typeof search !== "string" ||
        search.length > 200 ||
        !["purgeAt", "archivedAt", "name"].includes(sort)
      )
        throw packageError("validation_failed", "回收站筛选条件无效。", 400);
      const packages=await packageMetadataRows(),control=await repository.readControl(),result=[];
      for(const p of packages.filter(p=>['trashed','purge_pending'].includes(p.state)).filter(p=>!kind||p.kind===kind).filter(p=>p.state==='purge_pending'||p.versionName.toLowerCase().includes(search.trim().toLowerCase()))){
        if(p.state==='purge_pending'){
          const ledger=control.deletionLedger[p.packageId],task=control.purgeTasks[ledger?.operationId];
          result.push({packageId:p.packageId,kind:p.kind,state:p.state,status:'purge_pending',operationId:ledger?.operationId,phase:task?.phase||'purge_pending',counts:sum([ledger?.counts||{}]),code:task?.code||ledger?.code||null,canReadBody:false,canRestore:false});
        }else{
          const expired=isExpired(p,clock.now());
          result.push({packageId:p.packageId,kind:p.kind,versionId:p.versionId,versionName:p.versionName,enabled:p.enabled,state:p.state,archiveId:p.archiveId,archivedAt:p.archivedAt,purgeAt:p.purgeAt,
            status:expired?'expired':'trashed',counts:await repository.getPackageCounts(p.packageId),canReadBody:!expired,canRestore:!expired});
        }
      }
      return result.sort((a,b)=>String(a[sort==='name'?'versionName':sort]||'').localeCompare(String(b[sort==='name'?'versionName':sort]||'')));
    },
    async get(packageId){
      const workspace=await repository.exportPackage(packageId,{access:'trash_read'}),p=workspace.packages[packageId];
      requirePackage(workspace,packageId,{access:'trash_read',now:clock.now()});
      const result={package:{packageId:p.packageId,kind:p.kind,versionId:p.versionId,versionName:p.versionName,enabled:p.enabled,state:p.state,archiveId:p.archiveId,archivedAt:p.archivedAt,purgeAt:p.purgeAt},counts:await repository.getPackageCounts(packageId)};
      for(const key of COUNT_KEYS)result[key]=key==='profiles'||key==='targets'?Object.values(workspace[key]).flat():Object.values(workspace[key]||{});
      result.snapshots=[];
      for(const run of result.runs)if(run.snapshotRef){
        const snapshot=await repository.readRunSnapshot(run.runId,{ownerPackageId:packageId,access:'trash_read'});
        assertOwned(workspace,snapshot,packageId);if(contentHash(snapshot)!==run.snapshotRef.hash)throw packageError('snapshot_integrity_failed','检索快照校验失败。',503);result.snapshots.push(snapshot);
      }
      await repository.getRow({collection:'packages',id:packageId},{access:'trash_read'});return result;
    },
    async preview(options){
      const scope=scopeOf(options),packages=await packageMetadataRows(),control=await repository.readControl(),counts={};
      for(const p of packages)if(['trashed','purge_pending'].includes(p.state))counts[p.packageId]=await repository.getPackageCounts(p.packageId);
      const empty={profiles:{},targets:{},jobs:{},observations:{},evaluations:{},runs:{},applications:{},events:{},files:{}};
      return buildPreview({...empty,revision:await repository.getMeta('revision'),packages:Object.fromEntries(packages.map(p=>[p.packageId,p]))},control,scope,clock.now(),counts);
    },
    validatePreviewRows(fence, preview, now = clock.now()) {
      if(!preview||typeof preview.planHash!=='string'||!Number.isSafeInteger(preview.workspaceRevision)||!Array.isArray(preview.candidates))throw stale();
      const revision=fence.getMeta('revision');
      const leases=preview.candidates.map(p=>fence.assertPurgeLease(p?.packageId));
      if(revision!==preview.workspaceRevision&&!(leases.length&&leases.every(l=>l.acquiredRevision===revision)&&preview.workspaceRevision+1===revision))throw stale();
      const packages=[],control=fence.control,counts={};let after;
      do{
        const page=fence.queryPurgePlanningPage({section:'packages',...(after?{after}:{}),limit:200});
        packages.push(...page.rows.filter(Boolean));after=page.hasMore?page.nextCursor:null;
      }while(after);
      for(const p of packages)if(p.state==='trashed')counts[p.packageId]=fence.getPurgePlanningCounts(p.packageId);
      const scope=scopeOf(preview.scope),w={revision,packages:Object.fromEntries(packages.map(p=>[p.packageId,p]))},
        current=buildPreview(w,control,scope,now,counts);
      current.workspaceRevision=preview.workspaceRevision;
      const {planHash:ignored,...data}=current;current.planHash=contentHash(data);
      const {planHash,...input}=preview;
      if(contentHash(input)!==planHash||current.planHash!==planHash)throw stale();
      return current.candidates.map(p=>w.packages[p.packageId]);
    },
    validatePreview(tx, preview, now = clock.now()) {
      if (
        !preview ||
        typeof preview.planHash !== "string" ||
        !Number.isSafeInteger(preview.workspaceRevision)
      )
        throw stale();
      if (
        tx.workspace.revision !== preview.workspaceRevision &&
        !(
          tx.operationLease &&
          tx.operationLease.acquiredRevision === tx.workspace.revision &&
          preview.workspaceRevision + 1 === tx.workspace.revision
        )
      )
        throw stale();
      const scope = scopeOf(preview.scope),
        current = buildPreview(tx.workspace, tx.control, scope, now);
      current.workspaceRevision = preview.workspaceRevision;
      const { planHash: ignored, ...data } = current;
      current.planHash = contentHash(data);
      const { planHash, ...input } = preview;
      if (contentHash(input) !== planHash || current.planHash !== planHash)
        throw stale();
      return current.candidates.map((p) => tx.workspace.packages[p.packageId]);
    },
    async purgeOne({ packageId }) {
      if (!purge)
        throw packageError("purge_unavailable", "永久清理服务尚未就绪。", 503);
      return purge.execute(await service.preview({ packageIds: [packageId] }), {
        reason: "manual",
      });
    },
  };
  return service;
}
