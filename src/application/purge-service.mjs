import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveDataLayout } from "../infrastructure/storage/layout.mjs";
import {
  planPackageFiles,
  removeManagedFiles,
  assertManagedPath,
} from "../infrastructure/storage/purge-files.mjs";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import {
  sanitizeManagedBackup,
  filterBackup,
} from "../infrastructure/storage/backup-filter.mjs";
import { writeAtomicJson } from "../infrastructure/storage/atomic.mjs";
import {
  packageRecords,
  countPackageRecords,
} from "../domain/package-ownership.mjs";
import { applyDeletionLedger } from "../infrastructure/storage/package-control.mjs";
import { createWorkspaceOperationGate } from "./workspace-operations.mjs";
import { isExpired, packageError, UUID_RE } from "../domain/packages.mjs";
import { activePackageOperations } from "./trash-service.mjs";
import { versionNameHash } from "../domain/version-names.mjs";

export function createPurgeService({
  repository,
  trash,
  operationGate = createWorkspaceOperationGate({ repository }),
  clock = repository.clock,
  fsAdapter = fs,
  diagnostics,
  cleanupPackage,
}) {
  const layout = resolveDataLayout(repository.dataDir),
    now = () => new Date(clock.now()).toISOString();
  const empty = () => ({ completed: [], pending: [], failed: [] });
  const view = (t) => ({
    operationId: t.operationId,
    phase: t.phase,
    counts: t.counts,
    code: t.code || null,
    ...(t.nextRetryAt ? { nextRetryAt: t.nextRetryAt } : {}),
  });
  async function includeOrphanFiles(filePlan, tx) {
    const identities = new Set(Object.values(tx.control.identityIndex.record));
    for (const name of await fsAdapter.readdir(layout.runs).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      if (!/^[A-Za-z0-9_-]{1,160}\.json$/.test(name))
        throw packageError(
          "purge_file_failed",
          "存在无法验证的运行文件。",
          503,
        );
      const relative = "runs-v2/" + name;
      if (filePlan.files.some((f) => f.path === relative)) continue;
      const filename = path.join(layout.runs, name);
      await assertManagedPath(layout, filename, { fsAdapter });
      const snapshot = JSON.parse(await fsAdapter.readFile(filename, "utf8"));
      if (
        !UUID_RE.test(snapshot.recordId) ||
        !UUID_RE.test(snapshot.ownerPackageId) ||
        (!tx.workspace.packages[snapshot.ownerPackageId] &&
          !Object.values(tx.control.identityIndex.package).includes(
            snapshot.ownerPackageId,
          ) &&
          !tx.control.deletionLedger[snapshot.ownerPackageId])
      )
        throw packageError(
          "purge_file_failed",
          "存在无法验证归属的孤立快照。",
          503,
        );
      const intent = tx.control.ownershipTransfers[snapshot.recordId],
        owner = intent?.to || snapshot.ownerPackageId;
      if (owner !== filePlan.packageId) continue;
      if (
        !UUID_RE.test(snapshot.recordId) ||
        !identities.has(snapshot.recordId)
      )
        throw packageError(
          "purge_file_failed",
          "孤立快照缺少可验证的持久身份。",
          503,
        );
      const fileId =
        tx.control.identityIndex.record[
          "snapshot-file:" + contentHash(name.slice(0, -5))
        ] || snapshot.recordId;
      filePlan.files.push({
        recordId: fileId,
        snapshotRecordId: snapshot.recordId,
        ownerPackageId: snapshot.ownerPackageId,
        path: relative,
        hash: contentHash(snapshot),
        acceptedHashes: [contentHash(snapshot)],
        acceptedOwnerPackageIds: [snapshot.ownerPackageId],
      });
    }
    return filePlan;
  }
  async function sanitizeFiles(tx) {
    try {
      await assertManagedPath(layout, layout.previous, {
        fsAdapter,
        allowMissing: true,
      });
      const previous = JSON.parse(
        await fsAdapter.readFile(layout.previous, "utf8"),
      );
      // The previous copy has no embedded snapshots. Its run references remain valid managed paths.
      if (previous.schemaVersion === 2) {
        const filtered=filterBackup({workspace:previous,control:tx.control,now:clock.now(),currentWorkspace:tx.workspace});
        // The previous JSON is a managed historical copy. Reserve every stable
        // legacy identity before replacing it; never make it a business writer.
        await tx.commitControl(filtered.control);
        await writeAtomicJson(layout.previous,filtered.workspace,{fsAdapter});
      } else if (previous.schemaVersion !== 3)
        throw packageError(
          "backup_integrity_failed",
          "上一版本未完成归属升级。",
          503,
        );
      else {
        const clean = applyDeletionLedger(previous, tx.control);
        for (const id of Object.keys(tx.control.deletionLedger))
          delete clean.packages[id];
        await writeAtomicJson(layout.previous, clean, { fsAdapter });
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    for (const name of await fsAdapter.readdir(layout.backups).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    })) {
      const filename = path.join(layout.backups, name);
      await assertManagedPath(layout, filename, { fsAdapter });
      if (/^workspace-[A-Za-z0-9_.-]+\.json$/.test(name))
        await sanitizeManagedBackup({
          archivePath: filename,
          layout,
          control: tx.control,
          now: clock.now(),
          currentWorkspace: tx.workspace,
          fsAdapter,
          commitControl: (c) => tx.commitControl(c),
        });
      else if (/^v1-[a-f0-9]+$/.test(name)) {
        const { sanitizeLegacyBackup } = await import(
          "../infrastructure/storage/legacy-backup-sanitize.mjs"
        );
        await sanitizeLegacyBackup({
          archivePath: filename,
          control: tx.control,
          now: clock.now(),
          currentWorkspace: tx.workspace,
          fsAdapter,
          commitControl: (c) => tx.commitControl(c),
          filterBackup,
        });
      } else
        throw packageError(
          "backup_integrity_failed",
          "存在无法识别的管理备份，清理保持待处理。",
          503,
        );
    }
  }
  async function finish(tx, operationId) {
    const task = tx.control.purgeTasks[operationId];
    if (task.phase === "completed") return true;
    try {
      const filePlan = await includeOrphanFiles(
        { packageId: task.packageId, files: structuredClone(task.files) },
        tx,
      );
      if (contentHash(filePlan.files) !== contentHash(task.files)) {
        const prepared = structuredClone(tx.control);
        prepared.purgeTasks[operationId].files = filePlan.files;
        prepared.deletionLedger[task.packageId].recordIds = [
          ...new Set([
            ...prepared.deletionLedger[task.packageId].recordIds,
            ...filePlan.files.flatMap((f) => [f.recordId, f.snapshotRecordId]),
          ]),
        ];
        await tx.commitControl(prepared);
        task.files = filePlan.files;
      }
      await tx.commitWorkspace(applyDeletionLedger(tx.workspace, tx.control));
      const compacted=await repository.compact();
      if(!compacted.complete)throw packageError('purge_sqlite_busy','数据库仍有读取者，物理清理保持待处理。',503);
      await removeManagedFiles({
        layout,
        filePlan: { packageId: task.packageId, files: task.files },
        fsAdapter,
      });
      await sanitizeFiles(tx);
      // Completion is durable only after all owned bodies and file copies have been verified absent.
      if (
        packageRecords(tx.workspace).some(
          (n) =>
            n.record.ownerPackageId === task.packageId ||
            tx.control.deletionLedger[task.packageId].recordIds.includes(
              n.record.recordId,
            ),
        )
      )
        throw packageError(
          "purge_verification_failed",
          "私有记录清理校验未通过。",
          503,
        );
      if (cleanupPackage) {
        const cleaned = await cleanupPackage(task.packageId);
        if (cleaned?.status === "cleanup_pending")
          throw packageError(
            "attachment_cleanup_pending",
            "版本临时文件仍待清理。",
            503,
          );
      }
      const c = structuredClone(tx.control);
      c.purgeTasks[operationId] = {
        ...c.purgeTasks[operationId],
        phase: "verified",
        code: null,
        nextRetryAt: null,
      };
      await tx.commitControl(c);
      const finalWorkspace = applyDeletionLedger(tx.workspace, tx.control);
      delete finalWorkspace.packages[task.packageId];
      await tx.commitWorkspace(finalWorkspace);
      // commitWorkspace creates a sanitized previous copy; remove its pending reservation as well.
      await sanitizeFiles(tx);
      const done = structuredClone(tx.control);
      done.deletionLedger[task.packageId].phase = "purged";
      done.deletionLedger[task.packageId].purgedAt = now();
      done.purgeTasks[operationId].phase = "completed";
      done.purgeTasks[operationId].files = [];
      done.purgeTasks[operationId].completedAt = now();
      delete done.purgeTasks[operationId].nameHash;
      await tx.commitControl(done);
      return true;
    } catch (error) {
      const c = structuredClone(tx.control),
        t = c.purgeTasks[operationId];
      t.phase = "purge_pending";
      t.code = error.code==='purge_sqlite_busy'?'purge_sqlite_busy':error.code?.startsWith("backup_")
        ? error.code
        : "purge_file_failed";
      t.attempts = (t.attempts || 0) + 1;
      t.nextRetryAt = new Date(clock.now() + 300000).toISOString();
      await tx.commitControl(c);
      return false;
    }
  }
  async function runTasks(ids, lease) {
    const result = empty();
    for (const id of ids) {
      // Long file scans and reverse browser/attachment cleanup run between short
      // fenced commits. The exclusive durable lease protects this maintenance
      // task; it does not occupy the lock needed by reverse ledger settlement.
      let control=await repository.readControl(),workspace=await repository.exportWorkspace();
      const task=control.purgeTasks[id];if(!task)continue;
      const tx={
        get workspace(){return workspace;},get control(){return control;},
        async commitControl(next){
          const previous=contentHash(control);
          await repository.withMaintenanceTransaction(async current=>{
            if(contentHash(current.control)!==previous)throw packageError('purge_state_changed','清理控制状态已变化，将从持久阶段重试。',503);
            await current.commitControl(next);control=structuredClone(current.control);
          },{operationLease:lease});
        },
        async commitWorkspace(next){
          await repository.withMaintenanceTransaction(async current=>{
            await current.commitWorkspace(next);workspace=structuredClone(current.workspace);control=structuredClone(current.control);
          },{operationLease:lease});
        },
      };
      if(await finish(tx,id))result.completed.push(task.packageId);
      else{result.pending.push(task.packageId);result.failed.push(view(tx.control.purgeTasks[id]));}
    }
    return result;
  }
  function planningRows(fence, section, packageId) {
    const rows=[];let after;
    do{
      const page=fence.queryPurgePlanningPage({section,packageId,limit:200,...(after?{after}:{})});
      rows.push(...page.rows);after=page.hasMore?page.nextCursor:null;
    }while(after);
    return rows;
  }
  async function prepare(tx,preview,reason,operationLease,typed) {
    if(!typed)tx.operationLease=operationLease;
    const packages=typed?trash.validatePreviewRows(tx,preview):trash.validatePreview(tx,preview),
      c=structuredClone(tx.control),ids=[];
    const state=typed?tx.readOperationState():null;
    if(state?.hasMore)throw packageError('workspace_operation_busy','活动操作超过安全上限。',409);
    // Exactly one guard per nonempty prepare, before ledger visibility/owner
    // filters can hide a physically misrouted row or a peer's conflicting file.
    if(typed&&packages.length)tx.assertPurgePlanningIdentity(packages[0].packageId);
    let fileHeads;
    for(const p of packages){
      if(reason==='expired'&&!isExpired(p,clock.now()))throw packageError('trash_preview_stale','自动清理范围包含未到期版本。');
      const runs=typed?planningRows(tx,'runHeads',p.packageId):null;
      const w=typed?{packages:{[p.packageId]:p},runs:Object.fromEntries(runs.map(r=>[r.id,r])),
        operationLeases:Object.fromEntries(state.leases.map(l=>[l.operationId,l]))}:tx.workspace;
      const active=activePackageOperations(w,p.packageId);
      if(active.runs.length||active.leases.some(l=>l.operationId!==operationLease.operationId))
        throw packageError('workspace_operation_busy','版本仍有活动操作。');
      const existing=c.deletionLedger[p.packageId];
      if(existing){ids.push(existing.operationId);continue;}
      if(typed){
        // All file heads are needed for effective-owner migration and same-path
        // peer conflicts. No global private business value is decoded here.
        fileHeads||=planningRows(tx,'fileHeads',p.packageId);
        w.files=Object.fromEntries(fileHeads.map(f=>[f.id,f]));
      }
      const filePlan=planPackageFiles({layout,workspace:w,control:c,packageId:p.packageId}),
        operationId=randomUUID(),
        records=typed?planningRows(tx,'recordHeads',p.packageId).map(r=>r.recordId):packageRecords(w)
          .filter(n=>n.record.ownerPackageId===p.packageId).map(n=>n.record.recordId),
        transferred=Object.entries(c.ownershipTransfers).filter(([,i])=>i.to===p.packageId).map(([id])=>id),
        recordIds=[...new Set([...records,...filePlan.files.map(f=>f.snapshotRecordId),...transferred])],
        counts=typed?tx.getPurgePlanningCounts(p.packageId):countPackageRecords(w,p.packageId);
      c.deletionLedger[p.packageId]={phase:'purge_pending',recordIds,archiveId:p.archiveId,archivedAt:p.archivedAt,
        purgeAt:p.purgeAt,operationId,createdAt:now(),counts};
      c.purgeTasks[operationId]={operationId,packageId:p.packageId,phase:'prepared',createdAt:now(),counts,
        nameHash:versionNameHash(p.kind,p.versionName),files:filePlan.files.map(f=>({recordId:f.recordId,
          snapshotRecordId:f.snapshotRecordId,ownerPackageId:f.ownerPackageId,path:f.path,hash:f.hash,
          acceptedOwnerPackageIds:f.acceptedOwnerPackageIds,acceptedHashes:f.acceptedHashes})),code:null,attempts:0};
      ids.push(operationId);
    }
    await tx.commitControl(c);return ids;
  }
  const service = {
    async execute(preview, { reason = "manual", operationLease } = {}) {
      if (!["manual", "empty", "expired"].includes(reason))
        throw packageError("validation_failed", "永久清理原因无效。", 400);
      // Validate even an empty submitted preview without acquiring or changing a workspace lease.
      if (!preview?.candidates?.length) {
        if((await repository.getMeta('schemaVersion'))===3)
          await repository.withWriteFence(fence=>trash.validatePreviewRows(fence,preview),{operationMaintenance:true});
        else await repository.withMaintenanceTransaction(tx=>trash.validatePreview(tx,preview),{operationMaintenance:true});
        return empty();
      }
      if (!operationLease)
        return operationGate.withOperation(
          "permanent-delete",
          {
            expectedWorkspaceRevision: preview.workspaceRevision,
            packageIds: preview.candidates.map((p) => p.packageId),
          },
          (lease) =>
            service.execute(preview, { reason, operationLease: lease }),
        );
      const typed=(await repository.getMeta('schemaVersion'))===3;
      const ids=typed?await repository.withWriteFence(fence=>prepare(fence,preview,reason,operationLease,true),{operationLease}):
        await repository.withMaintenanceTransaction(tx=>prepare(tx,preview,reason,operationLease,false),{operationLease});
      // Full workspace/body assertion remains in runTasks/exportWorkspace before
      // any destructive finish step. A prepared intent is not physical completion.
      return runTasks(ids, operationLease);
    },
    async resumePending({ operationLease } = {}) {
      const pending = Object.values((await repository.readControl()).purgeTasks)
            .filter((t) => t.phase !== "completed")
            .map((t) => t.operationId);
      if (!pending.length) return empty();
      if (!operationLease)
        return operationGate.withOperation("permanent-delete", {}, (lease) =>
          service.resumePending({ operationLease: lease }),
        );
      return runTasks(pending, operationLease);
    },
    async getStatus(operationId) {
          const t = (await repository.readControl()).purgeTasks[operationId];
          if (!t)
            throw packageError(
              "purge_operation_not_found",
              "清理任务不存在。",
              404,
            );
          return view(t);
    },
  };
  return service;
}
