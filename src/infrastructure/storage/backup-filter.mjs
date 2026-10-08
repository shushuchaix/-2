import fs from "node:fs/promises";
import { normalizeBackupOwnership } from "./package-migration.mjs";
import { applyDeletionLedger } from "./package-control.mjs";
import { contentHash } from "./repository.mjs";
import { writeAtomicJson } from "./atomic.mjs";
import { packageRecords } from "../../domain/package-ownership.mjs";
import { assertWorkspace } from "../../domain/contracts.mjs";
import { addTargetMemberFact } from "../../domain/job-facts.mjs";
import { packageError } from "../../domain/packages.mjs";
import { assertManagedPath } from "./purge-files.mjs";

export function filterBackup({
  workspace,
  snapshots = {},
  control,
  now = Date.now(),
  currentWorkspace,
}) {
  const result = normalizeBackupOwnership({
      workspace,
      snapshots,
      control,
      now,
      applyLedger: false,
    }),
    c = result.control;
  let w = result.workspace;
  const deleted = new Set(
    Object.values(c.deletionLedger).flatMap((e) => e.recordIds),
  );
  const transfers = c.ownershipTransfers || {};
  for (const { record: r } of packageRecords(w)) {
    const intent = transfers[r.recordId];
    if (!intent || deleted.has(r.recordId) || c.deletionLedger[intent.to])
      continue;
    if (![intent.from, intent.to].includes(r.ownerPackageId))
      throw packageError(
        "backup_ownership_conflict",
        "备份记录归属与转移索引冲突。",
        503,
      );
    if (!w.packages[intent.to]) {
      const pkg = currentWorkspace?.packages?.[intent.to],
        target = Object.values(currentWorkspace?.targets || {})
          .flat()
          .find((t) => t.ownerPackageId === intent.to);
      if (!pkg || !target?.profileSnapshot)
        throw packageError(
          "backup_ownership_conflict",
          "备份缺少可验证的目标归属。",
          503,
        );
      w.packages[intent.to] = structuredClone(pkg);
      w.targets[target.targetId] ||= [];
      w.targets[target.targetId].push(structuredClone(target));
      w.versionMetadata[target.revisionId] = structuredClone(
        currentWorkspace.versionMetadata[target.revisionId],
      );
    }
    r.ownerPackageId = intent.to;
    const pkg = w.packages[intent.to],
      t = Object.values(w.targets)
        .flat()
        .find((t) => t.ownerPackageId === intent.to);
    if (
      ["observations", "evaluations", "applications"].some((k) =>
        Object.values(w[k]).includes(r),
      )
    )
      r.targetRevisionId = pkg.versionId;
    if (r.resumeRevisionId) r.resumeRevisionId = t.profileSnapshot.revisionId;
    if (r.profileRevisionId) r.profileRevisionId = t.profileSnapshot.revisionId;
    if (r.runId && w.runs[r.runId] === r) {
      r.targetSnapshot = structuredClone(t);
      r.profileSnapshot = structuredClone(t.profileSnapshot);
    }
  }
  // Membership is derived from owned facts after authoritative transfer, never from an old global list.
  for (const [revision, members] of Object.entries(w.targetMembers || {})) {
    const target = Object.values(w.targets)
      .flat()
      .find((t) => t.revisionId === revision);
    for (const [id] of Object.entries(members))
      if (!target || w.jobs[id]?.ownerPackageId !== target.ownerPackageId)
        delete members[id];
  }
  for (const o of Object.values(w.observations)) {
    const pkg = w.packages[o.ownerPackageId];
    if (
      transfers[o.recordId] &&
      pkg?.kind === "target" &&
      w.jobs[o.jobId]?.ownerPackageId === pkg.packageId
    )
      addTargetMemberFact(w, {
        targetRevisionId: pkg.versionId,
        jobId: o.jobId,
        observationId: o.observationId,
      });
  }
  w = applyDeletionLedger(w, c);
  for (const id of Object.keys(c.deletionLedger)) delete w.packages[id];
  const kept = {};
  for (const [id, s] of Object.entries(result.snapshots)) {
    if (
      !w.runs[id] ||
      deleted.has(s.recordId) ||
      c.deletionLedger[w.runs[id].ownerPackageId]
    )
      continue;
    const run = w.runs[id],
      snapshot = structuredClone(s);
    const affected =
      s.ownerPackageId !== run.ownerPackageId ||
      (JSON.stringify(s).includes('"recordId"') &&
        Object.keys(transfers).some((rid) => JSON.stringify(s).includes(rid)));
    snapshot.ownerPackageId = run.ownerPackageId;
    const visit = (v) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) {
          const effectiveOwner =
            transfers[v[i]?.recordId]?.to || v[i]?.ownerPackageId;
          if (deleted.has(v[i]?.recordId) || c.deletionLedger[effectiveOwner])
            v.splice(i, 1);
          else visit(v[i]);
        }
        return;
      }
      if (v.recordId && transfers[v.recordId])
        v.ownerPackageId = transfers[v.recordId].to;
      for (const value of Object.values(v)) visit(value);
    };
    visit(snapshot);
    if (affected) {
      if (snapshot.run)
        snapshot.run = structuredClone({ ...run, snapshotRef: null });
      if (snapshot.targetSnapshot)
        snapshot.targetSnapshot = structuredClone(run.targetSnapshot);
      if (snapshot.profileSnapshot)
        snapshot.profileSnapshot = structuredClone(
          run.profileSnapshot || run.targetSnapshot?.profileSnapshot,
        );
    }
    kept[id] = snapshot;
    run.snapshotRef = {
      path: "runs-v2/" + id + ".json",
      hash: contentHash(snapshot),
    };
    for (const file of Object.values(w.files))
      if (file.runId === id) file.hash = run.snapshotRef.hash;
  }
  w.operationLeases = {};
  assertWorkspace(w);
  return { workspace: w, snapshots: kept, control: c };
}
export function archiveFromFiltered({ workspace, snapshots }, manifest = {}) {
  return {
    manifest: {
      ...manifest,
      version: 1,
      schemaVersion: workspace.schemaVersion,
      workspaceHash: contentHash(workspace),
      snapshots: Object.fromEntries(
        Object.entries(snapshots).map(([id, s]) => [id, contentHash(s)]),
      ),
    },
    workspace,
    runSnapshots: snapshots,
  };
}
export function validateManagedArchive(a) {
  if (
    a?.manifest?.version !== 1 ||
    contentHash(a.workspace) !== a.manifest.workspaceHash
  )
    throw packageError(
      "backup_integrity_failed",
      "管理备份校验失败，清理保持待处理。",
      503,
    );
  assertWorkspace(a.workspace);
  const snapshots = a.runSnapshots || {};
  if (Object.keys(a.manifest.snapshots || {}).some((id) => !snapshots[id]))
    throw packageError("backup_integrity_failed", "管理备份缺少快照。", 503);
  for (const [id, s] of Object.entries(snapshots))
    if (
      !/^[A-Za-z0-9_-]{1,160}$/.test(id) ||
      contentHash(s) !== a.manifest.snapshots?.[id]
    )
      throw packageError(
        "backup_integrity_failed",
        "管理备份快照校验失败。",
        503,
      );
  for (const r of Object.values(a.workspace.runs))
    if (
      r.snapshotRef &&
      (r.snapshotRef.path !== "runs-v2/" + r.runId + ".json" ||
        contentHash(snapshots[r.runId]) !== r.snapshotRef.hash)
    )
      throw packageError(
        "backup_integrity_failed",
        "管理备份引用校验失败。",
        503,
      );
  return a;
}
export async function sanitizeManagedBackup({
  archivePath,
  layout,
  control,
  now,
  currentWorkspace,
  fsAdapter = fs,
  commitControl,
}) {
  await assertManagedPath(layout, archivePath, { fsAdapter });
  const archive = validateManagedArchive(
    JSON.parse(await fsAdapter.readFile(archivePath, "utf8")),
  );
  const filtered = filterBackup({
    workspace: archive.workspace,
    snapshots: archive.runSnapshots,
    control,
    now,
    currentWorkspace,
  });
  if (contentHash(filtered.control) !== contentHash(control)) {
    if (!commitControl)
      throw packageError(
        "control_state_invalid",
        "备份身份准备未持久化。",
        503,
      );
    await commitControl(filtered.control);
  }
  const clean = archiveFromFiltered(filtered, archive.manifest);
  if (contentHash(clean) !== contentHash(archive))
    await writeAtomicJson(archivePath, clean, { fsAdapter });
  validateManagedArchive(
    JSON.parse(await fsAdapter.readFile(archivePath, "utf8")),
  );
  return { completed: true, control: filtered.control };
}
