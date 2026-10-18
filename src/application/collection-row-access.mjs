import { packageError } from "../domain/packages.mjs";
import { rowKey } from "../infrastructure/storage/sqlite-records.mjs";

export const collectionPartId = (activityId, path, key) =>
  rowKey(activityId, path, String(key));
export const rowSelector = (collection, scope, ids) => ({
  collection,
  ownerPackageId: scope.packageId,
  ids,
});
export function collectionRoot(view, ref) {
  const root = view.rows.runs?.[ref?.activityId],
    indexes = view.indexes.runs?.[ref?.activityId];
  if (
    !root ||
    root.collectionRole !== "collection_root" ||
    root.ownerPackageId !== ref?.scope?.packageId ||
    indexes?.targetRevisionId !== ref.scope.targetRevisionId
  )
    throw packageError("collection_scope", "采集活动不属于此目标版本。");
  return root;
}
export function collectionLease(view, scope, operationLease) {
  const lease = view.rows.operationLeases?.[operationLease?.operationId];
  if (
    !lease ||
    lease.token !== operationLease?.token ||
    lease.kind !== "collect" ||
    lease.scope?.packageId !== scope.packageId ||
    lease.scope?.targetRevisionId !== scope.targetRevisionId
  )
    throw packageError("invalid_operation_lease", "采集操作授权已失效。");
  return lease;
}
export function collectionToken(progress, token, { revision = false } = {}) {
  if (
    !token ||
    progress.epoch !== token.epoch ||
    progress.activeSliceRunId !== token.sliceRunId ||
    progress.status !== "collecting" ||
    progress.stopIntent ||
    progress.draining ||
    (revision && progress.revision !== token.expectedRevision)
  )
    throw packageError(
      "collection_stale_epoch",
      "活动已停止，不能写入迟到结果。",
    );
}
export const leaseSelector = (operationLease) => ({
  collection: "operationLeases",
  ids: [operationLease?.operationId || "missing-operation-lease"],
});
export async function readCollectionHead(repository, ref) {
  const view = await repository.readView(
    {
      select: [
        rowSelector("runs", ref.scope, [ref.activityId]),
        rowSelector("budgetUsage", ref.scope, [ref.activityId]),
        rowSelector("activityMetrics", ref.scope, [ref.activityId]),
      ],
    },
    { scope: ref.scope },
  );
  return {
    root: collectionRoot(view, ref),
    usage: view.rows.budgetUsage?.[ref.activityId],
    metrics: view.rows.activityMetrics?.[ref.activityId],
    view,
  };
}
export function putCollectionPart(
  tx,
  { collection, ref, path, key, value, ordinal = 0 },
) {
  tx.putRow({
    collection,
    id: collectionPartId(ref.activityId, path, key),
    ownerPackageId: ref.scope.packageId,
    parent: { collection: "runs", id: ref.activityId, path },
    runId: ref.activityId,
    targetRevisionId: ref.scope.targetRevisionId,
    ordinal,
    value,
  });
}
