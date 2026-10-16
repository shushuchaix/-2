import { deriveCollectionSourceHealth } from "./collection-source-health.mjs";
import { recordSourceHealth } from "./source-health.mjs";
import {
  normalizeSourceStatus,
  safeSourceIssues,
  isVersionPrivateSource,
} from "../sources/source-status.mjs";

const validTime = (value) => Number.isFinite(Date.parse(value));

// Recover missing health from persisted facts. This projection performs no writes,
// requests, or imports of validation reports; private sources remain version owned.
export function projectSourceHealth(workspace, { registry, scope } = {}) {
  const events = [],
    destination = { sourceHealth: {} };
  const include = (sourceId, packageId) =>
    !isVersionPrivateSource(registry.get(sourceId) || { id: sourceId }) ||
    (!!scope && packageId === scope.packageId);
  for (const [packageId, healthMap] of [
    [null, workspace.sourceHealth],
    ...(scope
      ? [
          [
            scope.packageId,
            workspace.packages?.[scope.packageId]?.collectionSettings
              ?.sourceVerification,
          ],
        ]
      : []),
  ]) {
    for (const health of Object.values(healthMap || {})) {
      if (!include(health.sourceId, packageId)) continue;
      const time = health.lastAttemptAt || health.checkedAt;
      if (!validTime(time)) continue;
      events.push({
        time,
        priority: 1,
        result: {
          ...health,
          status: normalizeSourceStatus(health),
          issues: safeSourceIssues(
            health.issues,
            health.sourceId,
            health.siteId,
          ),
        },
      });
    }
  }
  const roots = Object.values(workspace.runs || {}).filter(
    (r) =>
      r.collectionRole === "collection_root" &&
      workspace.packages?.[r.ownerPackageId]?.state === "active",
  );
  const rootsById = new Map(roots.map((r) => [r.runId, r]));
  const groups = new Map();
  for (const observation of Object.values(workspace.observations || {})) {
    const child = workspace.runs?.[observation.runId],
      root = rootsById.get(child?.collectionActivityId);
    if (
      child?.collectionRole !== "collection_slice" ||
      !root ||
      child.ownerPackageId !== root.ownerPackageId ||
      observation.targetRevisionId !==
        workspace.packages[root.ownerPackageId].versionId ||
      !include(observation.sourceId, root.ownerPackageId) ||
      !validTime(observation.observedAt)
    )
      continue;
    const unit = Object.values(root.collectionProgress?.units || {}).find(
      (u) =>
        u.sourceId === observation.sourceId &&
        u.siteId === observation.siteId &&
        u.committedPages > 0,
    );
    if (!unit) continue;
    const key = JSON.stringify([
      root.runId,
      observation.sourceId,
      observation.siteId,
      observation.observedAt,
    ]);
    if (!groups.has(key))
      groups.set(key, {
        sourceId: observation.sourceId,
        siteId: observation.siteId,
        time: observation.observedAt,
        records: [],
        issues: (child.issues || []).filter(
          (i) =>
            i.sourceId === observation.sourceId &&
            (!i.siteId || i.siteId === observation.siteId),
        ),
      });
    const record = observation.fields || observation.record;
    if (record) groups.get(key).records.push(record);
  }
  for (const group of groups.values())
    events.push({
      time: group.time,
      result: deriveCollectionSourceHealth({
        ...group,
        now: Date.parse(group.time),
      }),
    });
  for (const root of roots)
    for (const unit of Object.values(root.collectionProgress?.units || {})) {
      if (
        !include(unit.sourceId, root.ownerPackageId) ||
        !validTime(unit.lastAttemptAt)
      )
        continue;
      if (unit.lastErrorCode && unit.lastErrorCode !== "page_limit_reached")
        events.push({
          time: unit.lastAttemptAt,
          result: deriveCollectionSourceHealth({
            sourceId: unit.sourceId,
            siteId: unit.siteId,
            issues: [{ code: unit.lastErrorCode }],
            now: Date.parse(unit.lastAttemptAt),
          }),
        });
    }
  events.sort(
    (a, b) =>
      Date.parse(a.time) - Date.parse(b.time) ||
      (a.priority || 0) - (b.priority || 0),
  );
  for (const event of events)
    recordSourceHealth(destination, event.result, Date.parse(event.time));
  return destination.sourceHealth;
}
