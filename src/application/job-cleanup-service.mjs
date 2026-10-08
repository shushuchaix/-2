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
  return {
    async preview() {
      return buildWorkspaceDuplicatePlan(await repository.read());
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
          { expectedWorkspaceRevision: workspaceRevision },
          async (lease) => {
            return (
              await repository.mutateWorkspace(
                async (w) => {
                  if (
                    w.revision !== lease.acquiredRevision ||
                    workspaceDuplicateHash(w) !== planHash
                  )
                    throw stale();
                  const fresh = buildWorkspaceDuplicatePlan(w),
                    groups = selectedGroupIds.map((id) =>
                      fresh.groups.find((g) => g.groupId === id),
                    );
                  if (groups.some((g) => !g || g.protected)) throw invalid();
                  if (!groups.length)
                    return {
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
                    };
                  const backup = await createBackup({
                    repository,
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
                  };
                },
                { operationLease: lease },
              )
            ).result;
          },
        );
      } catch (error) {
        if (error.code === "duplicate_preview_stale") throw stale();
        throw error;
      }
    },
  };
}
