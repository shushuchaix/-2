import { randomUUID } from "node:crypto";
import { assertScope, assertOwned, packageError } from "../domain/packages.mjs";
import {
  packageWorkspace,
  mergePackageWorkspace,
} from "./package-job-service.mjs";
import { contentHash } from "../infrastructure/storage/content-hash.mjs";
import { assertCollectionWrite } from "../domain/collection.mjs";
export const exactScope = (s) => ({
  packageId: s.packageId,
  targetRevisionId: s.targetRevisionId,
});
export function runtimeRepository(repository, scope) {
  const selected = exactScope(scope);
  const legacyOnly = async () => {
    if (repository.getMeta && (await repository.getMeta("schemaVersion")) === 3)
      throw packageError(
        "sqlite_legacy_maintenance_only",
        "整包运行视图只供历史schema2维护。",
      );
  };
  function view(w) {
    assertScope(w, selected, repository.clock.now());
    const v = packageWorkspace(w, selected.packageId),
      target = Object.values(v.targets).flat()[0];
    if (!target?.profileSnapshot)
      throw packageError("version_fact_unavailable", "目标缺少自有简历画像。");
    const p = structuredClone(target.profileSnapshot);
    v.profiles = { [p.profileId]: [p] };
    target.profileRevisionId = p.revisionId;
    return v;
  }
  return {
    ...repository,
    async read() {
      await legacyOnly();
      return view(await repository.read());
    },
    async mutateWorkspace(action, options) {
      await legacyOnly();
      return repository.mutateWorkspace(async (w) => {
        const v = view(w);
        if (options?.collectionGuard)
          assertCollectionWrite(w, options.collectionGuard);
        const result = await action(v);
        mergePackageWorkspace(w, v, selected.packageId);
        w.sources = v.sources;
        return result;
      }, options);
    },
    async writeRunSnapshot(id, snapshot, options) {
      if (
        repository.getMeta &&
        (await repository.getMeta("schemaVersion")) === 3
      )
        return repository.writeOwnedRunSnapshot(id, snapshot, {
          ...options,
          scope: selected,
        });
      return repository.withMaintenanceTransaction(async (tx) => {
        assertScope(tx.workspace, selected, repository.clock.now());
        assertOwned(tx.workspace, tx.workspace.runs[id], selected.packageId);
        const existing = Object.values(tx.workspace.files).find(
          (f) => f.runId === id && f.kind === "run_snapshot",
        );
        if (existing) assertOwned(tx.workspace, existing, selected.packageId);
        const rootKey = "snapshot:" + contentHash(id),
          fileKey = "snapshot-file:" + contentHash(id),
          control = structuredClone(tx.control),
          index = control.identityIndex.record;
        const recordId =
            index[rootKey] || existing?.snapshotRecordId || randomUUID(),
          fileId = index[fileKey] || existing?.recordId || randomUUID();
        if (
          existing &&
          (existing.snapshotRecordId !== recordId ||
            existing.recordId !== fileId)
        )
          throw packageError(
            "snapshot_identity_conflict",
            "快照登记与持久身份不一致。",
          );
        if (!index[rootKey] || !index[fileKey]) {
          index[rootKey] = recordId;
          index[fileKey] = fileId;
          await tx.commitControl(control);
        }
        // Identity preparation precedes the physical file. A failed main commit leaves
        // enough durable evidence for a retry or permanent package cleanup.
        snapshot.ownerPackageId = selected.packageId;
        snapshot.recordId = recordId;
        const owned = structuredClone(snapshot);
        const ref = await tx.writeSnapshot(id, owned),
          w = structuredClone(tx.workspace);
        w.files[fileId] = {
          fileId,
          recordId: fileId,
          snapshotRecordId: recordId,
          ownerPackageId: selected.packageId,
          runId: id,
          path: ref.path,
          hash: ref.hash,
          kind: "run_snapshot",
        };
        await tx.commitWorkspace(w);
        return ref;
      }, options);
    },
    async readRunSnapshot(id) {
      if (
        repository.getMeta &&
        (await repository.getMeta("schemaVersion")) === 3
      )
        return repository.readRunSnapshot(id, { scope: selected });
      const w = await repository.read();
      assertScope(w, selected, repository.clock.now());
      assertOwned(w, w.runs[id], selected.packageId);
      return repository.readRunSnapshot(id);
    },
  };
}
export function runtimeGate(gate, scope) {
  return {
    ...gate,
    acquire(kind, options = {}) {
      return gate.acquire(kind, { ...options, scope: exactScope(scope) });
    },
    withOperation(kind, options, action) {
      return gate.withOperation(
        kind,
        { ...options, scope: exactScope(scope) },
        action,
      );
    },
  };
}
export async function assertRuntimeJobs(repository, scope, jobIds, runId) {
  if (repository.getMeta && (await repository.getMeta("schemaVersion")) === 3) {
    if (
      !Array.isArray(jobIds) ||
      jobIds.length > 5000 ||
      jobIds.some((id) => typeof id !== "string")
    )
      throw packageError("validation_failed", "岗位选择无效。", 400);
    const select = [
      {
        collection: "targets",
        ownerPackageId: scope.packageId,
        ids: [scope.targetRevisionId],
      },
      {
        collection: "profileCopies",
        ownerPackageId: scope.packageId,
        where: { parentId: scope.targetRevisionId },
        limit: 2,
      },
      ...(runId
        ? [
            {
              collection: "runs",
              ownerPackageId: scope.packageId,
              ids: [runId],
            },
          ]
        : []),
    ];
    for (let offset = 0; offset < jobIds.length; offset += 1000) {
      const ids = jobIds.slice(offset, offset + 1000);
      select.push(
        { collection: "jobs", ownerPackageId: scope.packageId, ids },
        { collection: "jobRedirects", ownerPackageId: scope.packageId, ids },
      );
    }
    const view = await repository.readView({ select }, { scope });
    for (const id of jobIds)
      if (!view.rows.jobs?.[id] && !view.rows.jobRedirects?.[id])
        throw packageError("job_not_found", "岗位不存在。", 404);
    if (runId && !view.rows.runs?.[runId])
      throw packageError("run_not_found", "运行不存在。", 404);
    return {
      ...view.rows.targets[scope.targetRevisionId],
      profileSnapshot: Object.values(view.rows.profileCopies || {})[0],
    };
  }
  const w = await repository.read();
  assertScope(w, scope, repository.clock.now());
  for (const id of jobIds || [])
    if (w.jobs[id]) assertOwned(w, w.jobs[id], scope.packageId);
    else if (!packageWorkspace(w, scope.packageId).jobRedirects[id])
      throw packageError("job_not_found", "岗位不存在。", 404);
  if (runId) assertOwned(w, w.runs[runId], scope.packageId);
  return Object.values(w.targets)
    .flat()
    .find((t) => t.revisionId === scope.targetRevisionId);
}
