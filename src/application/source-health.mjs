// Keep proven capability separate from the latest transient attempt.
export function recordSourceHealth(workspace, result, milliseconds) {
  const key = result.sourceId + "/" + result.siteId;
  const stored = workspace.sourceHealth[key] || {};
  const fields = [
    "sourceId",
    "siteId",
    "status",
    "checkedAt",
    "lastAttemptAt",
    "lastSuccessAt",
    "backoffUntil",
    "sampleCount",
    "capabilities",
  ];
  const previous = Object.fromEntries(
    fields.filter((k) => stored[k] !== undefined).map((k) => [k, stored[k]]),
  );
  const safe = Object.fromEntries(
    fields.filter((k) => result[k] !== undefined).map((k) => [k, result[k]]),
  );
  for (const object of [previous, safe])
    if (object.capabilities)
      object.capabilities = Object.fromEntries(
        ["list", "body", "date", "attachments", "apply"]
          .filter((k) =>
            ["verified", "unverified"].includes(object.capabilities[k]),
          )
          .map((k) => [k, object.capabilities[k]]),
      );
  const at = new Date(milliseconds).toISOString();
  const health = {
    ...previous,
    ...safe,
    checkedAt: at,
    lastAttemptAt: at,
    lastSuccessAt:
      result.status === "ready"
        ? at
        : previous.lastSuccessAt ||
          (previous.status === "ready" ? previous.checkedAt : null),
    backoffUntil: ["restricted", "unavailable"].includes(result.status)
      ? new Date(Number(milliseconds) + 300000).toISOString()
      : null,
  };
  workspace.sourceHealth[key] = health;
  return health;
}
