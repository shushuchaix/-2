// Source/network failures must not swallow lifecycle, authorization or durable
// storage failures. Keep this production vocabulary explicit and content-free.
const CONTROL_CODES = new Set([
  "source_budget_exhausted", "model_budget_exhausted", "collection_route_forbidden",
  "workspace_write_failed", "workspace_repository_closed", "workspace_operation_busy",
  "workspace_maintenance_pending", "workspace_control_changed", "workspace_fence_closed",
  "workspace_fence_nested", "workspace_fence_busy", "workspace_upgrade_required", "workspace_migration_busy",
  "control_state_invalid", "invalid_operation_lease",
  "collection_stale_epoch", "collection_queue_conflict",
  "collection_scope", "collection_terminal", "collection_draining", "collection_cancelled",
  "collection_diagnostic_replayed",
  "package_not_found", "package_purge_pending", "package_expired", "package_archived",
  "package_scope_mismatch", "package_invalid_date",
  "version_scope_required", "version_not_found", "version_disabled", "version_archived",
]);
export function isOperationControlError(error) {
  return error?.runFatal === true || error?.name === "AbortError" || CONTROL_CODES.has(error?.code);
}
// Only explicit result-aggregation boundaries may consume an ordinary source
// budget stop. A fatal/abort carrying that same code is never a budget result.
export function isOrdinarySourceBudgetError(error, signal) {
  return error?.code === "source_budget_exhausted" && error?.runFatal !== true &&
    error?.name !== "AbortError" && !signal?.aborted;
}
