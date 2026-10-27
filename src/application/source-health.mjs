import {
  normalizeSourceStatus,
  safeSourceIssues,
} from "../sources/source-status.mjs";
// Keep proven capability separate from the latest transient attempt.
export function recordSourceHealth(workspace, result, milliseconds) {
  const key = result.sourceId + "/" + result.siteId;
  const stored = workspace.sourceHealth[key] || {};
  const health = mergeSourceHealth(stored, result, milliseconds);
  workspace.sourceHealth[key] = health;
  return health;
}
export function mergeSourceHealth(stored = {}, result, milliseconds) {
  stored ||= {};
  if (
    Date.parse(stored.lastAttemptAt || stored.checkedAt) > Number(milliseconds)
  )
    return structuredClone(stored);
  const fields = [
    "projectionVersion",
    "depth",
    "bodySampleCount",
    "applicationSampleCount",
    "evidenceCheckedAt",
    "sourceId",
    "siteId",
    "status",
    "checkedAt",
    "lastAttemptAt",
    "lastSuccessAt",
    "backoffUntil",
    "sampleCount",
    "capabilities",
    "lastSuccessCapabilities",
  ];
  const previous = Object.fromEntries(
    fields.filter((k) => stored[k] !== undefined).map((k) => [k, stored[k]]),
  );
  const safe = Object.fromEntries(
    fields.filter((k) => result[k] !== undefined).map((k) => [k, result[k]]),
  );
  for (const object of [previous, safe])
    for (const field of ["capabilities", "lastSuccessCapabilities"])
      if (object[field])
        object[field] = Object.fromEntries(
          ["list", "body", "date", "attachments", "apply"]
            .filter((k) =>
              ["verified", "unverified"].includes(object[field][k]),
            )
            .map((k) => [k, object[field][k]]),
        );
  const at = new Date(milliseconds).toISOString();
  const evidenceTime = Date.parse(result.evidenceCheckedAt),
    evidenceAt =
      Number.isFinite(evidenceTime) && evidenceTime <= Number(milliseconds)
        ? new Date(evidenceTime).toISOString()
        : at;
  const status = normalizeSourceStatus(result);
  const lastSuccess = [
    previous.lastSuccessAt,
    result.lastSuccessAt,
    ...(previous.status === "ready" ? [previous.checkedAt] : []),
  ]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value) && value <= Number(milliseconds))
    .sort((a, b) => b - a)[0];
  const health = {
    ...previous,
    ...safe,
    status,
    issues: safeSourceIssues(result.issues, result.sourceId, result.siteId),
    checkedAt: at,
    evidenceCheckedAt: evidenceAt,
    lastAttemptAt: at,
    lastSuccessAt:
      status === "ready"
        ? at
        : lastSuccess !== undefined
          ? new Date(lastSuccess).toISOString()
          : null,
    lastSuccessCapabilities:
      status === "ready"
        ? safe.capabilities || previous.capabilities || {}
        : safe.lastSuccessCapabilities ||
          previous.lastSuccessCapabilities ||
          (previous.status === "ready" ? previous.capabilities : {}) ||
          {},
    backoffUntil: ["restricted", "unavailable"].includes(status)
      ? new Date(Number(milliseconds) + 300000).toISOString()
      : null,
  };
  return health;
}
