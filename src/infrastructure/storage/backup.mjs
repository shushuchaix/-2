import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash } from "./repository.mjs";
import { writeAtomicJson } from "./atomic.mjs";
import { assertWorkspace } from "../../domain/contracts.mjs";
import { redactBusiness } from "../../domain/redact.mjs";
import { normalizeWorkspaceExtensions } from "../../domain/workspace-management.mjs";
import { backfillTargetMembers } from "../../domain/job-facts.mjs";
import { createWorkspaceOperationGate, invalidLease, operationBusy } from "../../application/workspace-operations.mjs";
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
const restorePurgePreflightErrors = new WeakSet();
const purgePreflightPending = () => {
  const error=packageError('purge_pending','永久清理尚未完成，请在回收站完成清理后重试恢复备份。',409);
  restorePurgePreflightErrors.add(error);return error;
};
// Provenance is process-local, not a caller-controlled code/flag. Only errors
// raised before restoreWorkspaceWithIntent may preserve the current credential.
export const isRestorePurgePreflightError = error => restorePurgePreflightErrors.has(error);
const hasRestoreIntent = control => Object.values(control.migrationJournal.maintenance||{})
  .some(task=>task?.kind==='restore'&&task.phase!=='complete'&&task.phase!=='aborted');
async function assertRestorePurgePreflight(repository, operationLease) {
  await repository.withWriteFence(fence=>{
    const lease=operationLease&&fence.getRow({collection:'operationLeases',id:operationLease.operationId});
    if(!lease||lease.operationId!==operationLease.operationId||lease.token!==operationLease.token||lease.kind!=='restore')throw invalidLease();
    if(fence.readOperationState().hasMore)throw operationBusy();
    const control=fence.control;
    // This is a resume, not an unstarted restore. The kernel must match the
    // source/plan and its persisted trash authority; it must not gain a WeakSet
    // preflight exemption or borrow this lease to delete newly expired data.
    if(hasRestoreIntent(control))return;
    if(Object.values(control.purgeTasks).some(task=>task?.phase!=='completed')||
      Object.values(control.deletionLedger).some(entry=>entry.phase!=='purged'))throw purgePreflightPending();
    let after;
    do{
      const page=fence.queryPurgePlanningPage({section:'packages',limit:200,...(after?{after}:{})});
      if(page.rows.some(pkg=>pkg&&(pkg.state==='purge_pending'||isExpired(pkg,repository.clock.now()))))throw purgePreflightPending();
      after=page.hasMore?page.nextCursor:null;
    }while(after);
  },{operationLease});
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
  // Validate even the internal recursion's supplied archive before any cleanup,
  // lease acquisition or durable restore intent. Never let a flag bypass hashes.
  const source=validateBackupArchive(validatedArchive||JSON.parse(await fsAdapter.readFile(archivePath,'utf8')));
  if ((await repository.getMeta('schemaVersion')) === 3) {
    const trash=trashService||createTrashService({repository}),
      purge=purgeService||createPurgeService({repository,trash,fsAdapter});
    if (!operationLease) {
      // Purge owns its real permanent-delete lease. It must finish before this
      // function takes restore's exclusive lease; borrowing it would deadlock or
      // violate the typed planning capability's permanent-delete kind check.
      if(!hasRestoreIntent(await repository.readControl())){
        const resumed=await purge.resumePending();
        if(resumed.pending.length)throw purgePreflightPending();
        const expired=await trash.preview({expiredOnly:true});
        if(expired.candidates.length){
          const result=await purge.execute(expired,{reason:'expired'});
          if(result.pending.length)throw purgePreflightPending();
        }
      }
      return createWorkspaceOperationGate({ repository }).withOperation(
        "restore",
        {},
        (lease) =>
          restoreBackup({
            repository,
            archivePath,
            operationLease: lease,
            trashService:trash,
            purgeService:purge,
            fsAdapter,
            validatedArchive: source,
            faultInjector,
          }),
      );
    }
    // Caller-owned leases are never released or lent to purge. This fresh held
    // fence also closes state changes between cleanup and our own restore lease.
    await assertRestorePurgePreflight(repository,operationLease);
    const {restoreWorkspaceWithIntent}=await import('./restore-maintenance.mjs');
    return restoreWorkspaceWithIntent({repository,source,operationLease,fsAdapter,faultInjector});
  }
  if (!operationLease)
    return createWorkspaceOperationGate({ repository }).withOperation(
      "restore",
      {},
      (lease) =>
        restoreBackup({ repository, archivePath, operationLease: lease,fsAdapter,validatedArchive:source,faultInjector }),
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
