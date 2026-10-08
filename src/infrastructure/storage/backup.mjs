import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash } from "./repository.mjs";
import { writeAtomicJson } from "./atomic.mjs";
import { assertWorkspace } from "../../domain/contracts.mjs";
import { redactBusiness } from "../../domain/redact.mjs";
import { normalizeWorkspaceExtensions } from "../../domain/workspace-management.mjs";
import { backfillTargetMembers } from "../../domain/job-facts.mjs";
import { createWorkspaceOperationGate } from "../../application/workspace-operations.mjs";
import { filterBackup } from "./backup-filter.mjs";
import { createTrashService } from "../../application/trash-service.mjs";
import { createPurgeService } from "../../application/purge-service.mjs";
import { isExpired, packageError } from "../../domain/packages.mjs";
export async function createBackup({
  repository,
  clock = repository.clock,
  workspaceSnapshot,
  snapshotReader,
}) {
  if (!workspaceSnapshot && (await repository.read()).schemaVersion === 3)
    return repository.withMaintenanceTransaction(
      (tx) =>
        createBackup({
          repository,
          clock,
          workspaceSnapshot: tx.workspace,
          snapshotReader: (id) => tx.readSnapshot(id),
        }),
      { operationMaintenance: true },
    );
  const workspace = redactBusiness(
      workspaceSnapshot || (await repository.read()),
    ),
    runSnapshots = {};
  if (workspace.operationLeases !== undefined) workspace.operationLeases = {};
  for (const run of Object.values(workspace.runs)) {
    if (run.snapshotRef) {
      const snapshot = redactBusiness(
        await (snapshotReader || repository.readRunSnapshot)(run.runId),
      );
      if (contentHash(snapshot) !== run.snapshotRef.hash)
        throw Error("Snapshot hash mismatch " + run.runId);
      runSnapshots[run.runId] = snapshot;
    } else if (run.legacy) {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(run.runId))
        throw Error("Unsafe legacy run id");
      const legacyResult = redactBusiness(
        JSON.parse(
          await fs.readFile(
            path.join(repository.dataDir, "runs", run.runId + ".json"),
            "utf8",
          ),
        ),
      );
      if (!Array.isArray(legacyResult.jobs || legacyResult.results))
        throw Error("Invalid legacy run archive");
      const snapshot = { run: { ...run, snapshotRef: null }, legacyResult };
      runSnapshots[run.runId] = snapshot;
      run.snapshotRef = {
        path: "runs-v2/" + run.runId + ".json",
        hash: contentHash(snapshot),
      };
    }
  }
  const manifest = {
    version: 1,
    schemaVersion: workspace.schemaVersion,
    createdAt: new Date(clock.now()).toISOString(),
    workspaceHash: contentHash(workspace),
    snapshots: Object.fromEntries(
      Object.entries(runSnapshots).map(([id, s]) => [id, contentHash(s)]),
    ),
  };
  const filename = path.join(
    repository.dataDir,
    "backups",
    "workspace-" + Date.now() + "-" + randomUUID() + ".json",
  );
  await writeAtomicJson(filename, { manifest, workspace, runSnapshots });
  return { path: filename, backupId: path.basename(filename), manifest };
}
export function validateBackupArchive(archive) {
  if (archive?.manifest?.version !== 1)
    throw Error("Unsupported backup manifest");
  assertWorkspace(archive.workspace);
  if (contentHash(archive.workspace) !== archive.manifest.workspaceHash)
    throw Error("Backup workspace hash mismatch");
  const snapshots = archive.runSnapshots || {};
  for (const [id, snapshot] of Object.entries(snapshots)) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw Error("Unsafe snapshot path");
    if (contentHash(snapshot) !== archive.manifest.snapshots?.[id])
      throw Error("Backup snapshot hash mismatch");
  }
  for (const run of Object.values(archive.workspace.runs))
    if (run.snapshotRef) {
      if (
        run.snapshotRef.path !== "runs-v2/" + run.runId + ".json" ||
        !snapshots[run.runId] ||
        contentHash(snapshots[run.runId]) !== run.snapshotRef.hash
      )
        throw Error("Invalid snapshot reference/hash");
    }
  return archive;
}
export async function restoreBackup({
  repository,
  archivePath,
  operationLease,
  trashService,
  purgeService,
  fsAdapter = fs,
  validatedArchive,
}) {
  const source =
    validatedArchive ||
    validateBackupArchive(
      JSON.parse(await fsAdapter.readFile(archivePath, "utf8")),
    );
  if ((await repository.read()).schemaVersion === 3) {
    if (!operationLease)
      return createWorkspaceOperationGate({ repository }).withOperation(
        "restore",
        {},
        (lease) =>
          restoreBackup({
            repository,
            archivePath,
            operationLease: lease,
            trashService,
            purgeService,
            fsAdapter,
            validatedArchive: source,
          }),
      );
    const trash = trashService || createTrashService({ repository }),
      purge =
        purgeService || createPurgeService({ repository, trash, fsAdapter });
    const resumed = await purge.resumePending({ operationLease });
    if (resumed.pending.length)
      throw packageError(
        "purge_pending",
        "永久清理尚未完成，暂时不能恢复备份。",
        503,
      );
    const expired = await trash.preview({ expiredOnly: true });
    if (expired.candidates.length) {
      const result = await purge.execute(expired, {
        reason: "expired",
        operationLease,
      });
      if (result.pending.length)
        throw packageError(
          "purge_pending",
          "已到期版本尚未清理完成，暂时不能恢复备份。",
          503,
        );
    }
    return repository.withMaintenanceTransaction(
      async (tx) => {
        const local = tx.workspace,
          filtered = filterBackup({
            workspace: source.workspace,
            snapshots: source.runSnapshots,
            control: tx.control,
            now: repository.clock.now(),
            currentWorkspace: local,
          }),
          restored = filtered.workspace,
          snapshots = filtered.snapshots;
        // Unexpired local trash is authoritative. A backup restore cannot act as trash.restore.
        for (const p of Object.values(local.packages).filter(
          (p) => p.state === "trashed" && !isExpired(p, repository.clock.now()),
        )) {
          restored.packages[p.packageId] = structuredClone(p);
          for (const kind of ["profiles", "targets"]) {
            for (const [id, list] of Object.entries(restored[kind])) {
              restored[kind][id] = list.filter(
                (r) => r.ownerPackageId !== p.packageId,
              );
              if (!restored[kind][id].length) delete restored[kind][id];
            }
            for (const [id, list] of Object.entries(local[kind])) {
              const owned = list.filter(
                (r) => r.ownerPackageId === p.packageId,
              );
              if (owned.length) {
                restored[kind][id] ||= [];
                restored[kind][id].push(...structuredClone(owned));
                for (const r of owned)
                  restored.versionMetadata[r.revisionId] = structuredClone(
                    local.versionMetadata[r.revisionId],
                  );
              }
            }
          }
          for (const key of [
            "jobs",
            "observations",
            "evaluations",
            "runs",
            "applications",
            "events",
            "files",
          ]) {
            for (const [id, r] of Object.entries(restored[key]))
              if (r.ownerPackageId === p.packageId) delete restored[key][id];
            for (const [id, r] of Object.entries(local[key]))
              if (r.ownerPackageId === p.packageId)
                restored[key][id] = structuredClone(r);
          }
          if (local.targetMembers[p.versionId])
            restored.targetMembers[p.versionId] = structuredClone(
              local.targetMembers[p.versionId],
            );
          for (const r of Object.values(local.runs).filter(
            (r) => r.ownerPackageId === p.packageId && r.snapshotRef,
          ))
            snapshots[r.runId] = await tx.readSnapshot(r.runId);
        }
        restored.operationLeases = {
          [operationLease.operationId]: structuredClone(
            local.operationLeases[operationLease.operationId],
          ),
        };
        const at = new Date(repository.clock.now()).toISOString();
        for (const run of Object.values(restored.runs))
          if (["queued", "running"].includes(run.status)) {
            run.status = "interrupted";
            run.stage = "finished";
            run.finishedAt = at;
            run.ownerPid = null;
            run.cancelRequestedAt = null;
            run.snapshotRef = null;
            run.issues = [
              ...(run.issues || []),
              {
                code: "restored_unfinished_run",
                message: "恢复的未完成任务已中断，请重新更新来源。",
              },
            ];
          }
        assertWorkspace(restored);
        await tx.commitControl(filtered.control);
        // Validate the complete clean object before writing a single snapshot. The internal replacement
        // uses the existing exclusive lease and stable identity; no nested workspace lock is taken.
        for (const [id, snapshot] of Object.entries(snapshots)) {
          if (!restored.runs[id]?.snapshotRef) continue;
          const old = tx.workspace;
          tx.workspace = restored;
          try {
            await tx.replaceSnapshot(id, snapshot);
          } finally {
            tx.workspace = old;
          }
        }
        await tx.commitWorkspace(restored);
        return { revision: tx.workspace.revision, recovered: true };
      },
      { operationLease },
    );
  }
  if (!operationLease)
    return createWorkspaceOperationGate({ repository }).withOperation(
      "restore",
      {},
      (lease) =>
        restoreBackup({ repository, archivePath, operationLease: lease }),
    );
  const archive = source;
  const snapshots = archive.runSnapshots || {};
  await createBackup({ repository });
  for (const [id, snapshot] of Object.entries(snapshots))
    await repository.writeRunSnapshot(id, snapshot, { operationLease });
  const result = await repository.mutateWorkspace(
    (w) => {
      const revision = w.revision;
      const restored = normalizeWorkspaceExtensions(
        redactBusiness(archive.workspace),
      );
      backfillTargetMembers(restored);
      restored.operationLeases = operationLease
        ? {
            [operationLease.operationId]:
              w.operationLeases[operationLease.operationId],
          }
        : {};
      for (const key of Object.keys(w)) delete w[key];
      Object.assign(w, restored);
      w.revision = revision;
      const at = new Date(repository.clock.now()).toISOString();
      for (const run of Object.values(w.runs)) {
        if (!["queued", "running"].includes(run.status)) continue;
        run.status = "interrupted";
        run.stage = "finished";
        run.finishedAt = at;
        run.ownerPid = null;
        run.cancelRequestedAt = null;
        run.snapshotRef = null;
        run.issues = [
          ...(run.issues || []),
          {
            code: "restored_unfinished_run",
            message: "恢复的未完成任务已中断；已保存事实保留，请重新更新来源。",
          },
        ];
        w.recoveryRecords.push({
          type: "restored_unfinished_run",
          runId: run.runId,
          at,
        });
      }
      return { recovered: true };
    },
    { operationLease },
  );
  return { revision: result.revision, recovered: true };
}
