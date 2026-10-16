import { createWorkspaceOperationGate } from "./workspace-operations.mjs";
import {
  buildWorkspaceDuplicatePlan,
  applyWorkspaceDuplicatePlan,
  workspaceDuplicateHash,
} from "../domain/job-duplicates.mjs";
import { createBackup } from "../infrastructure/storage/backup.mjs";
const stale = () =>
  Object.assign(Error("岗位或人工记录已变化，请重新预览后确认。"), {
    status: 409,
    code: "duplicate_plan_stale",
  });
const invalid = () =>
  Object.assign(Error("选中的重复组无效或受人工记录保护，请重新预览。"), {
    status: 400,
    code: "invalid_duplicate_selection",
  });
export function createJobCleanupService({
  repository,
  operationGate = createWorkspaceOperationGate({ repository }),
  clock = repository.clock,
}) {
  const previews=new Map();
  return {
    async preview(options={}) {
      const p=buildWorkspaceDuplicatePlan(await repository.read(),{...options,now:clock.now()});previews.set(p.planHash,options);return p;
    },
    async apply({ workspaceRevision, planHash, selectedGroupIds }) {
      if (
        !Number.isSafeInteger(workspaceRevision) ||
        typeof planHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(planHash) ||
        !Array.isArray(selectedGroupIds) ||
        selectedGroupIds.some((id) => typeof id !== "string") ||
        new Set(selectedGroupIds).size !== selectedGroupIds.length
      )
        throw invalid();
      try {
        return await operationGate.withOperation(
          "cleanup",
          { expectedWorkspaceRevision: workspaceRevision,...(previews.get(planHash)?.packageIds?{packageIds:previews.get(planHash).packageIds}:{}) },
          async (lease) => {
            return (
              await repository.mutateWorkspace(
                async (w,tx) => {
                  const fresh = buildWorkspaceDuplicatePlan(w,{...previews.get(planHash),now:clock.now()});
                  if (
                    w.revision !== lease.acquiredRevision ||
                    (w.schemaVersion===3?fresh.planHash:workspaceDuplicateHash(w)) !== planHash
                  )
                    throw stale();
                  const groups = selectedGroupIds.map((id) =>
                      fresh.groups.find((g) => g.groupId === id),
                    );
                  if (groups.some((g) => !g || g.protected)) throw invalid();
                  if (!groups.length){
                    const counts={confirmedGroups:0,removedEntities:0,collapsedVersionEntries:0,affectedVersions:0,possiblePairs:fresh.counts.possiblePairs,protectedGroups:fresh.counts.protectedGroups};return {
                      operationId: null,
                      counts: {
                        confirmedGroups: 0,
                        removedEntities: 0,
                        collapsedVersionEntries: 0,
                        affectedVersions: 0,
                        possiblePairs: fresh.counts.possiblePairs,
                        protectedGroups: fresh.counts.protectedGroups,
                      },
                      backupId: null,
                      ...(w.schemaVersion===3?{totals:counts,packages:fresh.packages.map(p=>({packageId:p.packageId,kind:p.kind,versionName:p.versionName,archiveId:p.archiveId,purgeAt:p.purgeAt,counts:{...p.counts,confirmedGroups:0,removedEntities:0}}))}:{}),
                    };
                  }
                  const backup = await createBackup({
                    repository:w.schemaVersion===3?{...repository,readRunSnapshot:id=>tx.readSnapshot(id)}:repository,
                    clock,
                    workspaceSnapshot: w,
                  });
                  const at = new Date(clock.now()).toISOString(),
                    counts = applyWorkspaceDuplicatePlan(
                      w,
                      { ...fresh, groups },
                      { operationId: lease.operationId, at },
                    );
                  w.dedupOperations ||= {};
                  w.dedupOperations[lease.operationId] = {
                    operationId: lease.operationId,
                    planHash,
                    counts,
                    backupId: backup.backupId,
                    at,
                  };
                  return {
                    operationId: lease.operationId,
                    counts,
                    backupId: backup.backupId,
                    ...(w.schemaVersion===3?{totals:counts,packages:fresh.packages.map(p=>{const selected=groups.filter(g=>g.packageId===p.packageId);return {packageId:p.packageId,kind:p.kind,versionName:p.versionName,archiveId:p.archiveId,purgeAt:p.purgeAt,counts:{...p.counts,confirmedGroups:selected.length,removedEntities:selected.reduce((n,g)=>n+g.removeJobIds.length,0)}};})}:{}),
                  };
                },
                { operationLease: lease },
              )
            ).result;
          },
        );
      } catch (error) {
        if (["duplicate_preview_stale","package_expired"].includes(error.code)) throw stale();
        throw error;
      }
    },
  };
}
