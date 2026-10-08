import {
  normalizeWorkspaceExtensions,
  needsWorkspaceUpgrade,
} from "../../domain/workspace-management.mjs";
import { createBackup } from "./backup.mjs";
import { backfillTargetMembers } from "../../domain/job-facts.mjs";
import { createWorkspaceOperationGate } from "../../application/workspace-operations.mjs";
export async function upgradeWorkspace({
  repository,
  clock = repository.clock,
  operationGate = createWorkspaceOperationGate({ repository }),
}) {
  const before = await repository.read();
  if (!needsWorkspaceUpgrade(before)) return { changed: false, backupId: null };
  return operationGate.withOperation(
    "upgrade",
    { expectedWorkspaceRevision: before.revision },
    async (operationLease) => {
      return (
        await repository.mutateWorkspace(
          async (w) => {
            if (!needsWorkspaceUpgrade(w))
              return { changed: false, backupId: null };
            const normalized = normalizeWorkspaceExtensions(w);
            backfillTargetMembers(normalized);
            const backup =
          before.revision > 0
                ? await createBackup({
                    repository,
                    clock,
                    workspaceSnapshot: before,
                  })
                : null;
            Object.assign(w, normalized);
            return { changed: true, backupId: backup?.backupId || null };
          },
          { operationLease },
        )
      ).result;
    },
  );
}
