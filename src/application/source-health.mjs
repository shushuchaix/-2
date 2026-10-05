// Keep proven capability separate from the latest transient attempt.
export function recordSourceHealth(workspace, result, milliseconds) {
  const key = result.sourceId + "/" + result.siteId;
  const previous = workspace.sourceHealth[key] || {};
  const at = new Date(milliseconds).toISOString();
  const health = {
    ...previous,
    ...result,
    checkedAt: at,
    lastAttemptAt: at,
    lastSuccessAt:
      result.status === "ready"
        ? at
        : previous.lastSuccessAt ||
          (previous.status === "ready" ? previous.checkedAt : null),
    backoffUntil: ["restricted", "unavailable"].includes(result.status)
      ? new Date(milliseconds + 300000).toISOString()
      : null,
  };
  workspace.sourceHealth[key] = health;
  return health;
}
