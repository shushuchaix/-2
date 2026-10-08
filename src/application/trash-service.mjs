import { randomUUID } from "node:crypto";
import { contentHash } from "../infrastructure/storage/repository.mjs";
import {
  archiveDeadline,
  requirePackage,
  isExpired,
  packageError,
  PACKAGE_KINDS,
} from "../domain/packages.mjs";
import {
  countPackageRecords,
  packageRecords,
} from "../domain/package-ownership.mjs";
import { assertOwned } from "../domain/packages.mjs";

const COUNT_KEYS = [
  "profiles",
  "targets",
  "jobs",
  "observations",
  "evaluations",
  "runs",
  "applications",
  "events",
  "files",
];
const sum = (counts) =>
  Object.fromEntries(
    COUNT_KEYS.map((k) => [k, counts.reduce((n, c) => n + (c[k] || 0), 0)]),
  );
const stale = () =>
  packageError(
    "trash_preview_stale",
    "回收站内容或归档实例已变化，请重新预览。",
  );
export function activePackageOperations(w, packageId) {
  const p = w.packages[packageId];
  const leases = Object.entries(w.operationLeases || {})
    .filter(([, l]) => {
      const ids =
        l.packageIds ||
        (l.packageId
          ? [l.packageId]
          : l.scope?.packageId
            ? [l.scope.packageId]
            : null);
      if (ids) return ids.includes(packageId);
      return (
        l.targetRevisionId === p?.versionId ||
        (p?.kind === "profile" &&
          !l.targetRevisionId &&
          l.profileRevisionId === p.versionId)
      );
    })
    .map(([operationId, l]) => ({ ...l, operationId }));
  const runs = Object.values(w.runs).filter(
    (r) =>
      r.ownerPackageId === packageId &&
      ["queued", "running"].includes(r.status),
  );
  return { leases, runs, busy: leases.length > 0 || runs.length > 0 };
}
function scopeOf({ packageIds, emptyAll = false, expiredOnly = false } = {}) {
  if (
    typeof emptyAll !== "boolean" ||
    typeof expiredOnly !== "boolean" ||
    (packageIds !== undefined && !Array.isArray(packageIds)) ||
    Number(emptyAll) +
      Number(expiredOnly) +
      Number(packageIds !== undefined) !==
      1
  )
    throw packageError(
      "trash_scope_required",
      "请选择要删除的版本、整个回收站或已到期版本。",
      400,
    );
  if (packageIds?.some((id) => typeof id !== "string" || !id))
    throw packageError("trash_scope_required", "所选数据包标识无效。", 400);
  return {
    emptyAll,
    expiredOnly,
    ...(packageIds !== undefined
      ? { packageIds: [...new Set(packageIds)].sort() }
      : {}),
  };
}
function buildPreview(w, control, scope, now) {
  const selected = scope.packageIds
    ? scope.packageIds.map((id) => {
        const p = w.packages[id];
        if (!p)
          throw packageError("package_not_found", "所选版本已不存在。", 404);
        if (!["trashed", "purge_pending"].includes(p.state))
          throw packageError(
            "package_scope_mismatch",
            "只能清理回收站内的版本。",
          );
        return p;
      })
    : Object.values(w.packages).filter((p) =>
        scope.expiredOnly
          ? isExpired(p, now)
          : ["trashed", "purge_pending"].includes(p.state),
      );
  const candidates = selected
    .sort((a, b) => a.packageId.localeCompare(b.packageId))
    .map((p) => ({
      packageId: p.packageId,
      archiveId: p.archiveId,
      purgeAt: p.purgeAt,
      archivedAt: p.archivedAt,
      state: p.state,
      expired: isExpired(p, now),
      kind: p.kind,
      ...(p.state === "trashed" ? { versionName: p.versionName } : {}),
      counts:
        p.state === "purge_pending"
          ? sum([control.deletionLedger[p.packageId]?.counts || {}])
          : countPackageRecords(w, p.packageId),
    }));
  const preview = {
    workspaceRevision: w.revision,
    scope,
    candidates,
    totals: sum(candidates.map((p) => p.counts)),
    packageCount: candidates.length,
  };
  return { ...preview, planHash: contentHash(preview) };
}
export function createTrashService({
  repository,
  clock = repository.clock,
  cancelPackageAndWait,
  purgeService,
}) {
  let purge = purgeService;
  const at = () => new Date(clock.now()).toISOString();
  const reads = (action) =>
    repository.withMaintenanceTransaction(action, {
      operationMaintenance: true,
    });
  function metadata(w, p) {
    const r = Object.values(w.profiles)
      .flat()
      .concat(Object.values(w.targets).flat())
      .find((r) => r.ownerPackageId === p.packageId);
    return r ? w.versionMetadata[r.revisionId] : null;
  }
  const service = {
    setPurgeService(value) {
      purge = value;
    },
    async archive({ packageId, cancelActive = false }) {
      if (typeof cancelActive !== "boolean")
        throw packageError("validation_failed", "取消活动任务选项无效。", 400);
      const initial = await repository.read();
      requirePackage(initial, packageId, {
        access: "management",
        now: clock.now(),
      });
      if (initial.packages[packageId].state === "trashed")
        return initial.packages[packageId];
      if (activePackageOperations(initial, packageId).busy) {
        if (!cancelActive || !cancelPackageAndWait)
          throw packageError(
            "workspace_operation_busy",
            "该版本仍有检索、评分或导入操作，请等待结束或取消后归档。",
          );
        await cancelPackageAndWait(packageId);
      }
      return repository.withMaintenanceTransaction(async (tx) => {
        const w = structuredClone(tx.workspace),
          p = requirePackage(w, packageId, {
            access: "management",
            now: clock.now(),
          });
        if (p.state === "trashed") return p;
        if (activePackageOperations(w, packageId).busy)
          throw packageError(
            "workspace_operation_busy",
            "该版本的活动操作尚未结束，请重试。",
          );
        const c = structuredClone(tx.control),
          archivedAt = at(),
          archiveId = randomUUID(),
          episode = {
            packageId,
            archiveId,
            archivedAt,
            purgeAt: archiveDeadline(archivedAt),
            legacy: false,
          };
        c.archiveEpisodes[archiveId] = episode;
        await tx.commitControl(c);
        Object.assign(p, episode, { state: "trashed" });
        const m = metadata(w, p);
        if (m) {
          m.archivedAt = archivedAt;
          m.updatedAt = archivedAt;
        }
        await tx.commitWorkspace(w);
        return structuredClone(tx.workspace.packages[packageId]);
      });
    },
    async restore({ packageId, archiveId }) {
      return repository.withMaintenanceTransaction(async (tx) => {
        const w = structuredClone(tx.workspace),
          p = requirePackage(w, packageId, {
            access: "trash_read",
            now: clock.now(),
          });
        if (p.archiveId !== archiveId) throw stale();
        if (activePackageOperations(w, packageId).busy)
          throw packageError(
            "workspace_operation_busy",
            "该版本仍有活动操作。",
          );
        Object.assign(p, {
          state: "active",
          archiveId: null,
          archivedAt: null,
          purgeAt: null,
        });
        const m = metadata(w, p);
        if (m) {
          m.archivedAt = null;
          m.updatedAt = at();
        }
        await tx.commitWorkspace(w);
        return structuredClone(tx.workspace.packages[packageId]);
      });
    },
    async list({ kind, search = "", sort = "purgeAt" } = {}) {
      if (kind && !PACKAGE_KINDS.includes(kind))
        throw packageError("validation_failed", "版本种类无效。", 400);
      if (
        typeof search !== "string" ||
        search.length > 200 ||
        !["purgeAt", "archivedAt", "name"].includes(sort)
      )
        throw packageError("validation_failed", "回收站筛选条件无效。", 400);
      return reads((tx) =>
        Object.values(tx.workspace.packages)
          .filter((p) => ["trashed", "purge_pending"].includes(p.state))
          .filter((p) => !kind || p.kind === kind)
          .filter(
            (p) =>
              p.state === "purge_pending" ||
              p.versionName.toLowerCase().includes(search.trim().toLowerCase()),
          )
          .map((p) => {
            if (p.state === "purge_pending") {
              const ledger = tx.control.deletionLedger[p.packageId],
                task = tx.control.purgeTasks[ledger?.operationId];
              return {
                packageId: p.packageId,
                kind: p.kind,
                state: p.state,
                status: "purge_pending",
                operationId: ledger?.operationId,
                phase: task?.phase || "purge_pending",
                counts: sum([ledger?.counts || {}]),
                code: task?.code || ledger?.code || null,
                canReadBody: false,
                canRestore: false,
              };
            }
            const expired = isExpired(p, clock.now());
            return {
              ...p,
              status: expired ? "expired" : "trashed",
              counts: countPackageRecords(tx.workspace, p.packageId),
              canReadBody: !expired,
              canRestore: !expired,
            };
          })
          .sort((a, b) =>
            String(
              a[sort === "name" ? "versionName" : sort] || "",
            ).localeCompare(
              String(b[sort === "name" ? "versionName" : sort] || ""),
            ),
          ),
      );
    },
    async get(packageId) {
      return reads(async (tx) => {
        const p = requirePackage(tx.workspace, packageId, {
          access: "trash_read",
          now: clock.now(),
        });
        const result = {
          package: structuredClone(p),
          counts: countPackageRecords(tx.workspace, packageId),
        };
        for (const key of COUNT_KEYS)
          result[key] =
            key === "profiles" || key === "targets"
              ? Object.values(tx.workspace[key])
                  .flat()
                  .filter((r) => r.ownerPackageId === packageId)
              : Object.values(tx.workspace[key] || {}).filter(
                  (r) => r.ownerPackageId === packageId,
                );
        result.snapshots = [];
        for (const run of result.runs)
          if (run.snapshotRef) {
            const snapshot = await tx.readSnapshot(run.runId);
            assertOwned(tx.workspace, snapshot, packageId);
            if (contentHash(snapshot) !== run.snapshotRef.hash)
              throw packageError(
                "snapshot_integrity_failed",
                "检索快照校验失败。",
                503,
              );
            result.snapshots.push(snapshot);
          }
        return structuredClone(result);
      });
    },
    async preview(options) {
      const scope = scopeOf(options);
      return reads((tx) =>
        buildPreview(tx.workspace, tx.control, scope, clock.now()),
      );
    },
    validatePreview(tx, preview, now = clock.now()) {
      if (
        !preview ||
        typeof preview.planHash !== "string" ||
        !Number.isSafeInteger(preview.workspaceRevision)
      )
        throw stale();
      if (
        tx.workspace.revision !== preview.workspaceRevision &&
        !(
          tx.operationLease &&
          tx.operationLease.acquiredRevision === tx.workspace.revision &&
          preview.workspaceRevision + 1 === tx.workspace.revision
        )
      )
        throw stale();
      const scope = scopeOf(preview.scope),
        current = buildPreview(tx.workspace, tx.control, scope, now);
      current.workspaceRevision = preview.workspaceRevision;
      const { planHash: ignored, ...data } = current;
      current.planHash = contentHash(data);
      const { planHash, ...input } = preview;
      if (contentHash(input) !== planHash || current.planHash !== planHash)
        throw stale();
      return current.candidates.map((p) => tx.workspace.packages[p.packageId]);
    },
    async purgeOne({ packageId }) {
      if (!purge)
        throw packageError("purge_unavailable", "永久清理服务尚未就绪。", 503);
      return purge.execute(await service.preview({ packageIds: [packageId] }), {
        reason: "manual",
      });
    },
  };
  return service;
}
