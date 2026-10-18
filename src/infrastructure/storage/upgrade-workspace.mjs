import {
  normalizeWorkspaceExtensions,
  needsWorkspaceUpgrade,
} from "../../domain/workspace-management.mjs";
import { createBackup } from "./backup.mjs";
import { backfillTargetMembers } from "../../domain/job-facts.mjs";
import { createWorkspaceOperationGate } from "../../application/workspace-operations.mjs";
import { assertSnapshotOwner } from "./managed-snapshots.mjs";
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
          async (w, tx) => {
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
                    snapshotReader: async (id) => {
                      const snapshot = await tx.readSnapshot(id);
                      if (w.schemaVersion === 3)
                        assertSnapshotOwner(w, id, snapshot, clock);
                      return snapshot;
                    },
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
