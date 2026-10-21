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
import { normalizeCollectionWorkspace } from "../../domain/collection.mjs";
import { assertSnapshotPath, snapshotPath } from './managed-snapshots.mjs';
export async function createBackup({
  repository,
  clock = repository.clock,
  workspaceSnapshot,
  snapshotReader,
  fsAdapter = fs,
}) {
  if(!workspaceSnapshot&&(await repository.getMeta('schemaVersion'))===3)
    return createWorkspaceOperationGate({repository}).withOperation('backup',{},async()=>{
      const source=await repository.exportWorkspace();
      return createBackup({repository,clock,workspaceSnapshot:source,fsAdapter,snapshotReader:async id=>{
        const filename=snapshotPath(repository.dataDir,id);await assertSnapshotPath(repository.dataDir,filename,fsAdapter);
        return JSON.parse(await fsAdapter.readFile(filename,'utf8'));
      }});
    });
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
  normalizeCollectionWorkspace(workspace, {
    restored: true,
    clearSessions: true,
  });
  for (const [id, snapshot] of Object.entries(runSnapshots))
    if (workspace.runs[id]?.collectionRole) {
      if (snapshot.run)
        snapshot.run = structuredClone({
          ...workspace.runs[id],
          snapshotRef: null,
        });
      workspace.runs[id].snapshotRef.hash = contentHash(snapshot);
      for (const file of Object.values(workspace.files || {}))
        if (file.runId === id) file.hash = workspace.runs[id].snapshotRef.hash;
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
  await writeAtomicJson(filename, { manifest, workspace, runSnapshots }, {fsAdapter});
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
  faultInjector,
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
            faultInjector,
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
    const {restoreWorkspaceWithIntent}=await import('./restore-maintenance.mjs');
    return restoreWorkspaceWithIntent({repository,source,operationLease,fsAdapter,faultInjector});
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
