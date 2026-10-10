import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash } from "./repository.mjs";
import { hasLiveOwner } from "./process-owner.mjs";
import { createWorkspaceOperationGate } from "../../application/workspace-operations.mjs";
export async function recoverWorkspace(
  repository,
  { operationGate = createWorkspaceOperationGate({ repository }) } = {},
) {
  await operationGate.recover();
  const w = await repository.read(),
    interruptedRunIds = [],
    orphanSnapshots = [],
    issues = [];
  const names = await fs
    .readdir(path.join(repository.dataDir, "runs-v2"))
    .catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
  for (const run of Object.values(w.runs)) {
    if (
      run.mode &&
      !run.snapshotRef &&
      ["completed", "partial", "failed", "cancelled"].includes(run.status)
    )
      issues.push({
        code: "missing_snapshot",
        runId: run.runId,
        message: "Terminal v2 run has no snapshot reference",
      });
    if (["queued", "running"].includes(run.status) && !hasLiveOwner(run))
      interruptedRunIds.push(run.runId);
    if (run.snapshotRef) {
      try {
        if (run.snapshotRef.path !== "runs-v2/" + run.runId + ".json")
          throw Error("Unsafe snapshot reference");
        const s =
          w.schemaVersion === 3
            ? await repository.withMaintenanceTransaction(
                (tx) => tx.readSnapshot(run.runId),
                { operationMaintenance: true },
              )
            : await repository.readRunSnapshot(run.runId);
        if (contentHash(s) !== run.snapshotRef.hash)
          throw Error("Snapshot hash mismatch");
      } catch (e) {
        issues.push({
          code: e.code === "ENOENT" ? "missing_snapshot" : "invalid_snapshot",
          runId: run.runId,
          message:
            w.schemaVersion === 3 ? "运行快照未通过完整性检查。" : e.message,
        });
      }
    }
  }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const id = name.slice(0, -5);
    if (!w.runs[id]?.snapshotRef) orphanSnapshots.push(id);
  }
  if (interruptedRunIds.length || issues.length || orphanSnapshots.length)
    await repository.mutateWorkspace((draft) => {
      for (const id of interruptedRunIds) {
        draft.runs[id].status = "interrupted";
        draft.runs[id].stage = "interrupted";
        draft.runs[id].finishedAt = new Date(
          repository.clock.now(),
        ).toISOString();
      }
      for (const issue of [
        ...issues,
        ...orphanSnapshots.map((runId) => ({ code: "orphan_snapshot", runId })),
      ])
        if (
          !draft.recoveryRecords.some(
            (i) => i.code === issue.code && i.runId === issue.runId,
          )
        )
          draft.recoveryRecords.push(
            w.schemaVersion === 3 && draft.runs[issue.runId]
              ? {
                  ...issue,
                  recordId: randomUUID(),
                  ownerPackageId: draft.runs[issue.runId].ownerPackageId,
                }
              : issue,
          );
    });
  return { interruptedRunIds, orphanSnapshots, issues };
}
