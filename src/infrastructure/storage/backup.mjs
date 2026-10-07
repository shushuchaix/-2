import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash } from "./repository.mjs";
import { writeAtomicJson } from "./atomic.mjs";
import { assertWorkspace } from "../../domain/contracts.mjs";
import { redactBusiness } from "../../domain/redact.mjs";
import {normalizeWorkspaceExtensions} from '../../domain/workspace-management.mjs';
export async function createBackup({ repository, clock = repository.clock, workspaceSnapshot }) {
  const workspace = redactBusiness(workspaceSnapshot || await repository.read()),
    runSnapshots = {};
  if (workspace.operationLeases !== undefined) workspace.operationLeases = {};
  for (const run of Object.values(workspace.runs)) {
    if (run.snapshotRef) {
      const snapshot = redactBusiness(
        await repository.readRunSnapshot(run.runId),
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
    schemaVersion: 2,
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
export async function restoreBackup({ repository, archivePath, operationLease }) {
  const archive = validateBackupArchive(
    JSON.parse(await fs.readFile(archivePath, "utf8")),
  );
  const snapshots = archive.runSnapshots || {};
  await createBackup({ repository });
  for (const [id, snapshot] of Object.entries(snapshots))
    await repository.writeRunSnapshot(id, snapshot, {operationLease});
  const result = await repository.mutateWorkspace((w) => {
    const revision = w.revision;
    const restored = normalizeWorkspaceExtensions(redactBusiness(archive.workspace));
    restored.operationLeases = operationLease ? {[operationLease.operationId]:w.operationLeases[operationLease.operationId]} : {};
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
  }, {operationLease});
  return { revision: result.revision, recovered: true };
}
