import { randomUUID } from "node:crypto";
import { hasLiveOwner } from "../infrastructure/storage/process-owner.mjs";
import { versionAvailability } from "../domain/version-references.mjs";
import {assertScope,requirePackage,packageError} from '../domain/packages.mjs';
export const SHARED_OPERATION_KINDS = new Set([
  "collect",
  "evaluate",
  "import",
  "legacy",
  "backup",
]);
export const EXCLUSIVE_OPERATION_KINDS = new Set([
  "cleanup",
  "permanent-delete",
  "restore",
  "upgrade",
]);
export const operationBusy = () =>
  Object.assign(Error("工作区仍有活动操作，请等待结束后重试。"), {
    status: 409,
    code: "workspace_operation_busy",
  });
export const invalidLease = () =>
  Object.assign(Error("操作授权已失效，请重新开始。"), {
    status: 409,
    code: "invalid_operation_lease",
  });
export function assertOperationWriteAllowed(
  w,
  { operationLease = null, operationMaintenance = false } = {},
) {
  if (operationMaintenance) return;
  if (
    operationLease &&
    (!w.operationLeases?.[operationLease.operationId] ||
      w.operationLeases[operationLease.operationId].token !==
        operationLease.token)
  )
    throw invalidLease();
  const exclusive = Object.values(w.operationLeases || {}).find((l) =>
    EXCLUSIVE_OPERATION_KINDS.has(l.kind),
  );
  if (
    exclusive &&
    (!operationLease || exclusive.operationId !== operationLease.operationId)
  )
    throw operationBusy();
}

/** Formal schema3 operations coordinate only bounded lease rows and live-run metadata. */
export function createWorkspaceOperationGate(options){
  const {repository,clock=repository.clock,isOwnerAlive=pid=>hasLiveOwner({ownerPid:pid})}=options;
  const legacy=createLegacyWorkspaceOperationGate(options);
  const alive=lease=>{try{return isOwnerAlive(lease.ownerPid)!==false;}catch{return true;}};
  const leaseObject=(value,parent=false)=>({...value,async release(){
    if(parent)return;
    await repository.transaction({select:[{collection:'operationLeases',ids:[value.operationId]}]},tx=>{
      if(tx.getRow({collection:'operationLeases',id:value.operationId})?.token!==value.token)throw invalidLease();
      tx.deleteRow({collection:'operationLeases',id:value.operationId});
    },{operationMaintenance:true});
  }});
  const formal={
    async recover(){
      return repository.withWriteFence(fence=>{
        const state=fence.readOperationState();if(state.hasMore)throw operationBusy();
        const dead=state.leases.filter(lease=>!alive(lease));if(!dead.length)return {removed:0};
        fence.transaction({select:[{collection:'operationLeases',ids:dead.map(lease=>lease.operationId)}]},tx=>{
          for(const lease of dead)tx.deleteRow({collection:'operationLeases',id:lease.operationId});
        });return {removed:dead.length};
      },{operationMaintenance:true});
    },
    async acquire(kind,{targetRevisionId,profileRevisionId,parentLease,expectedWorkspaceRevision,signal,scope,packageIds}={}){
      if(!SHARED_OPERATION_KINDS.has(kind)&&!EXCLUSIVE_OPERATION_KINDS.has(kind))throw Error('Invalid operation kind');
      signal?.throwIfAborted();
      const value=await repository.withWriteFence(fence=>{
        signal?.throwIfAborted();const revision=fence.getMeta('revision');
        if(expectedWorkspaceRevision!==undefined&&expectedWorkspaceRevision!==revision)throw Object.assign(Error('岗位数据已变化，请重新预览后确认清理。'),{status:409,code:'duplicate_preview_stale'});
        const state=fence.readOperationState();if(state.hasMore)throw operationBusy();
        const leases=state.leases.filter(alive),dead=state.leases.filter(lease=>!alive(lease));
        if(scope){
          if(fence.control.migrationJournal?.archives?.[scope.packageId]?.phase==='prepared')throw operationBusy();
          const pkg=fence.getRow({collection:'packages',id:scope.packageId});
          assertScope({packages:pkg?{[pkg.packageId]:pkg}:{}},scope,clock.now());targetRevisionId=pkg.versionId;packageIds=[pkg.packageId];
          const copies=fence.queryRows({collection:'profileCopies',ownerPackageId:pkg.packageId,where:{parentId:targetRevisionId},limit:2});
          profileRevisionId=copies.rows[0]?.value.revisionId||null;
          if(kind==='collect'&&!pkg.enabled)throw packageError('version_disabled','目标版本已停用，请先启用。');
          scope={packageId:pkg.packageId,targetRevisionId};
        }else if(SHARED_OPERATION_KINDS.has(kind)&&kind!=='backup'&&!packageIds?.length)throw packageError('version_scope_required','操作需要明确的数据包范围。');
        for(const id of packageIds||[]){
          if(fence.control.migrationJournal?.archives?.[id]?.phase==='prepared')throw operationBusy();
          const pkg=fence.getRow({collection:'packages',id});
          if(!pkg)throw packageError('package_not_found','数据包不存在。',404);
          if(!['permanent-delete','restore'].includes(kind))requirePackage({packages:{[id]:pkg}},id,{access:SHARED_OPERATION_KINDS.has(kind)?'business':'management',now:clock.now()});
        }
        let parent;
        if(parentLease){
          parent=leases.find(lease=>lease.operationId===parentLease.operationId);
          if(!parent||parent.token!==parentLease.token||!(EXCLUSIVE_OPERATION_KINDS.has(parent.kind)||(SHARED_OPERATION_KINDS.has(parent.kind)&&SHARED_OPERATION_KINDS.has(kind))))throw invalidLease();
          if(scope&&parent.scope&&(scope.packageId!==parent.scope.packageId||scope.targetRevisionId!==parent.scope.targetRevisionId))throw invalidLease();
          if(parent.packageIds?.length&&packageIds?.some(id=>!parent.packageIds.includes(id)))throw invalidLease();
          if(parent.targetRevisionId&&targetRevisionId&&parent.targetRevisionId!==targetRevisionId)throw invalidLease();
          if(parent.profileRevisionId&&profileRevisionId&&parent.profileRevisionId!==profileRevisionId)throw invalidLease();
          parent={...parent,targetRevisionId:parent.targetRevisionId||targetRevisionId||null,profileRevisionId:parent.profileRevisionId||profileRevisionId||null};
        }else{
          const legacyActive=state.runs.some(run=>hasLiveOwner(run)&&!leases.some(lease=>lease.targetRevisionId===run.targetRevisionId));
          if(leases.some(lease=>EXCLUSIVE_OPERATION_KINDS.has(lease.kind))||(EXCLUSIVE_OPERATION_KINDS.has(kind)&&(leases.length||legacyActive)))throw operationBusy();
        }
        const lease=parent||{operationId:'op-'+randomUUID(),kind,token:randomUUID(),ownerPid:process.pid,
          targetRevisionId:targetRevisionId||null,profileRevisionId:profileRevisionId||null,createdAt:new Date(clock.now()).toISOString(),scope:scope||null,packageIds:[...new Set(packageIds||[])]};
        const receipt=fence.transaction({select:[{collection:'operationLeases',ids:[...dead.map(lease=>lease.operationId),lease.operationId]}]},tx=>{
          for(const stale of dead)tx.deleteRow({collection:'operationLeases',id:stale.operationId});
          tx.putRow({collection:'operationLeases',id:lease.operationId,value:lease});
        });return {...lease,acquiredRevision:receipt.revision,...(parent?{parent:true}:{})};
      },{operationMaintenance:true});
      return leaseObject(value,value.parent===true);
    },
    async withOperation(kind,input,action){const lease=await formal.acquire(kind,input);try{return await action(lease);}finally{await lease.release();}},
  };
  return Object.fromEntries(['recover','acquire','withOperation'].map(method=>[method,async(...args)=>
    (await repository.getMeta('schemaVersion'))===3?formal[method](...args):legacy[method](...args)]));
}
function createLegacyWorkspaceOperationGate({
  repository,
  clock = repository.clock,
  isOwnerAlive = (pid) => hasLiveOwner({ ownerPid: pid }),
}) {
  const now = () => new Date(clock.now()).toISOString();
  const alive = (l) => {
    try {
      return isOwnerAlive(l.ownerPid) !== false;
    } catch {
      return true;
    }
  };
  const makeLease = (value, parent = false) => ({
    ...value,
    async release() {
      if (parent) return;
      await repository.mutateWorkspace(
        (w) => {
          if (w.operationLeases?.[value.operationId]?.token !== value.token)
            throw invalidLease();
          delete w.operationLeases[value.operationId];
        },
        { operationMaintenance: true },
      );
    },
  });
  return {
    async recover() {
      const w = await repository.read();
      if (!Object.values(w.operationLeases || {}).some((l) => !alive(l)))
        return { removed: 0 };
      return (
        await repository.mutateWorkspace(
          (w) => {
            let removed = 0;
            for (const [id, l] of Object.entries(w.operationLeases || {}))
              if (!alive(l)) {
                delete w.operationLeases[id];
                removed++;
              }
            return { removed };
          },
          { operationMaintenance: true },
        )
      ).result;
    },
    async acquire(
      kind,
      {
        targetRevisionId,
        profileRevisionId,
        parentLease,
        expectedWorkspaceRevision,
        signal,
        scope,
        packageIds,
      } = {},
    ) {
      if (
        !SHARED_OPERATION_KINDS.has(kind) &&
        !EXCLUSIVE_OPERATION_KINDS.has(kind)
      )
        throw Error("Invalid operation kind");
      signal?.throwIfAborted();
      const value = (
        await repository.mutateWorkspace(
          (w) => {
            signal?.throwIfAborted();
            w.operationLeases ||= {};
            if (
              expectedWorkspaceRevision !== undefined &&
              w.revision !== expectedWorkspaceRevision
            )
              throw Object.assign(
                Error("岗位数据已变化，请重新预览后确认清理。"),
                { status: 409, code: "duplicate_preview_stale" },
              );
            for (const [id, l] of Object.entries(w.operationLeases))
              if (!alive(l)) delete w.operationLeases[id];
            if(w.schemaVersion===3){
              if(scope){const pkg=assertScope(w,scope,clock.now());targetRevisionId=pkg.versionId;profileRevisionId=Object.values(w.targets).flat().find(t=>t.revisionId===targetRevisionId)?.profileSnapshot?.revisionId;packageIds=[pkg.packageId];scope={packageId:pkg.packageId,targetRevisionId};}
              else if(SHARED_OPERATION_KINDS.has(kind)&&!packageIds?.length)throw packageError('version_scope_required','操作需要明确的数据包范围。');
              for(const id of packageIds||[]){if(kind==='permanent-delete'||kind==='restore'){if(!w.packages[id])throw packageError('package_not_found','数据包不存在。',404);}else requirePackage(w,id,{access:SHARED_OPERATION_KINDS.has(kind)?'business':'management',now:clock.now()});}
            }
            if (targetRevisionId) {
              const target = Object.values(w.targets)
                .flat()
                .find((t) => t.revisionId === targetRevisionId);
              if (!target)
                throw Object.assign(Error("目标版本不存在。"), { status: 400 });
              profileRevisionId ||= target.profileRevisionId;
              if(w.schemaVersion===3&&kind==='collect'&&(w.versionMetadata?.[targetRevisionId]?.enabled??target.enabled)===false)throw packageError('version_disabled','目标版本已停用，请先启用。');
              if (w.schemaVersion!==3&&SHARED_OPERATION_KINDS.has(kind)) {
                const availability = versionAvailability(w, target);
                if (availability.reasonCode?.endsWith("_archived"))
                  throw Object.assign(
                    Error("目标或引用简历已移入回收站，请先恢复。"),
                    { status: 409, code: "version_archived" },
                  );
                if (kind === "collect" && !availability.canCollect)
                  throw Object.assign(Error("目标版本已停用，请先启用。"), {
                    status: 409,
                    code: "version_disabled",
                  });
              }
            }
            if (w.schemaVersion!==3&&profileRevisionId && SHARED_OPERATION_KINDS.has(kind)) {
              if (
                !Object.values(w.profiles)
                  .flat()
                  .some((p) => p.revisionId === profileRevisionId)
              )
                throw Object.assign(Error("简历版本不存在。"), { status: 400 });
              if (w.versionMetadata?.[profileRevisionId]?.archivedAt)
                throw Object.assign(Error("简历版本已移入回收站，请先恢复。"), {
                  status: 409,
                  code: "version_archived",
                });
            }
            if (parentLease) {
              const parent = w.operationLeases[parentLease.operationId];
              if (
                !parent ||
                parent.token !== parentLease.token ||
                !(EXCLUSIVE_OPERATION_KINDS.has(parent.kind)||(SHARED_OPERATION_KINDS.has(parent.kind)&&SHARED_OPERATION_KINDS.has(kind)))
              )
                throw invalidLease();
              if(scope&&parent.scope&&(parent.scope.packageId!==scope.packageId||parent.scope.targetRevisionId!==scope.targetRevisionId))throw invalidLease();
              if(parent.packageIds?.length&&packageIds?.some(id=>!parent.packageIds.includes(id)))throw invalidLease();
              if (
                parent.targetRevisionId &&
                targetRevisionId &&
                parent.targetRevisionId !== targetRevisionId
              )
                throw invalidLease();
              if (
                parent.profileRevisionId &&
                profileRevisionId &&
                parent.profileRevisionId !== profileRevisionId
              )
                throw invalidLease();
              parent.targetRevisionId ||= targetRevisionId || null;
              parent.profileRevisionId ||= profileRevisionId || null;
              return {
                ...parent,
                acquiredRevision: w.revision + 1,
                parent: true,
              };
            }
            const leases = Object.values(w.operationLeases);
            const legacyActive = Object.values(w.runs).some(
              (r) =>
                ["queued", "running"].includes(r.status) &&
                hasLiveOwner(r) &&
                !leases.some(
                  (l) => l.targetRevisionId === r.targetSnapshot?.revisionId,
                ),
            );
            if (
              leases.some((l) => EXCLUSIVE_OPERATION_KINDS.has(l.kind)) ||
              (EXCLUSIVE_OPERATION_KINDS.has(kind) &&
                (leases.length || legacyActive))
            )
              throw operationBusy();
            const operationId = "op-" + randomUUID();
            const lease = {
              operationId,
              kind,
              token: randomUUID(),
              ownerPid: process.pid,
              targetRevisionId: targetRevisionId || null,
              profileRevisionId: profileRevisionId || null,
              createdAt: now(),
              ...(w.schemaVersion===3?{scope:scope||null,packageIds:[...new Set(packageIds||[])]}:{}),
            };
            w.operationLeases[operationId] = lease;
            return { ...lease, acquiredRevision: w.revision + 1 };
          },
          { operationMaintenance: true },
        )
      ).result;
      return makeLease(value, value.parent === true);
    },
    async withOperation(kind, options, action) {
      const lease = await this.acquire(kind, options);
      try {
        return await action(lease);
      } finally {
        await lease.release();
      }
    },
  };
}
