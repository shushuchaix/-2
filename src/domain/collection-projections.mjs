/** Durable collection projections. Full rebuild is restricted to import/replace. */
export const COLLECTION_PROJECTION_VERSION = 1;
export const amountMicros = (value) => Math.round((value || 0) * 1_000_000);
const counters = [
  "usedRequests",
  "knownPhysicalRequests",
  "usedDetails",
  "usedAttachments",
  "usedBytes",
  "spentMicros",
  "reservedMicros",
  "unresolvedMicros",
  "usedModelRequests",
  "pricedRequests",
  "uncertainRequests",
  "reservedRequests",
];
export function emptyCollectionUsage() {
  return {
    version: COLLECTION_PROJECTION_VERSION,
    ...Object.fromEntries(counters.map((key) => [key, 0])),
    byKind: {},
    bySource: {},
  };
}
export function reservationContribution(reservation) {
  const r = reservation,
    result = emptyCollectionUsage(),
    pending = r.status !== "settled";
  result.usedRequests = pending
    ? r.requestUpperBound || 0
    : (r.verifiedUsage?.requests ?? r.requestUpperBound ?? 0);
  result.knownPhysicalRequests =
    !pending && r.kind !== "worker" ? (r.verifiedUsage?.requests ?? 0) : 0;
  result.reservedRequests = pending ? result.usedRequests : 0;
  result.usedDetails = r.kind === "detail_credit" ? 1 : 0;
  result.usedAttachments = r.kind === "attachment_credit" ? 1 : 0;
  result.usedBytes = r.bytesUpperBound
    ? pending
      ? r.bytesUpperBound
      : (r.verifiedUsage?.bytes ?? r.bytesUpperBound)
    : 0;
  result.byKind[r.physicalKind || r.kind] = result.usedRequests;
  if (r.kind === "model") {
    result.usedModelRequests = 1;
    if (pending) {
      result.reservedMicros = amountMicros(r.costUpperBoundCny);
      if (r.status === "uncertain") {
        result.unresolvedMicros = result.reservedMicros;
        result.uncertainRequests = 1;
      }
    } else {
      result.spentMicros = amountMicros(r.verifiedUsage.costCny);
      result.pricedRequests = 1;
    }
  }
  if (r.sourceId || r.siteId)
    result.bySource[JSON.stringify([r.sourceId || null, r.siteId || null])] = {
      sourceId: r.sourceId || null,
      siteId: r.siteId || null,
      chargedRequests: result.usedRequests,
      knownPhysicalRequests: result.knownPhysicalRequests,
    };
  return result;
}
export function changeCollectionUsage(usage, before, after) {
  for (const [reservation, direction] of [
    [before, -1],
    [after, 1],
  ]) {
    if (!reservation) continue;
    const contribution = reservationContribution(reservation);
    for (const key of counters) {
      usage[key] += direction * contribution[key];
      if (!Number.isSafeInteger(usage[key]) || usage[key] < 0)
        throw Object.assign(Error("Invalid collection usage aggregate."), {
          code: "collection_usage_invalid",
        });
    }
    for (const [kind, count] of Object.entries(contribution.byKind))
      usage.byKind[kind] = (usage.byKind[kind] || 0) + direction * count;
    usage.bySource ||= {};
    for (const [key, item] of Object.entries(contribution.bySource)) {
      const current = (usage.bySource[key] ||= {
        sourceId: item.sourceId,
        siteId: item.siteId,
        chargedRequests: 0,
        knownPhysicalRequests: 0,
      });
      current.chargedRequests += direction * item.chargedRequests;
      current.knownPhysicalRequests += direction * item.knownPhysicalRequests;
    }
  }
  return usage;
}
export function collectionUsageSnapshot(progress, aggregate) {
  if (aggregate?.version !== COLLECTION_PROJECTION_VERSION)
    throw Object.assign(Error("Collection usage projection is not ready."), {
      code: "collection_projection_not_ready",
    });
  const u = aggregate;
  return {
    ...Object.fromEntries(
      counters
        .filter((key) => !key.endsWith("Micros"))
        .map((key) => [key, u[key]]),
    ),
    unknownRequestUpperBound: u.usedRequests - u.knownPhysicalRequests,
    byKind: structuredClone(u.byKind),
    bySource: structuredClone(u.bySource || {}),
    modelSpendCny: u.spentMicros / 1_000_000,
    reservedCostCny: u.reservedMicros / 1_000_000,
    unresolvedCostCny: u.unresolvedMicros / 1_000_000,
    costUpperBoundCny: (u.spentMicros + u.reservedMicros) / 1_000_000,
    ...progress.limits,
    ledgerRevision: progress.ledger.revision,
    modelRequestLimit: progress.ledger.modelRequestLimit ?? 1000,
    modelIdentity: progress.ledger.modelIdentity || null,
    pricingVersion: progress.ledger.pricingVersion || null,
  };
}
export function buildCollectionProjectionRows(
  workspace,
  { asOf = Date.now() } = {},
) {
  const rows = [];
  if (workspace.schemaVersion !== 3) return rows;
  for (const root of Object.values(workspace.runs || {})) {
    if (root.collectionRole !== "collection_root") continue;
    const aggregate = emptyCollectionUsage();
    for (const reservation of Object.values(
      root.collectionProgress?.ledger?.reservations || {},
    ))
      changeCollectionUsage(aggregate, null, reservation);
    const routing = {
      ownerPackageId: root.ownerPackageId,
      runId: root.runId,
      targetRevisionId:
        root.targetSnapshot?.revisionId ||
        workspace.packages[root.ownerPackageId]?.versionId,
    };
    rows.push({
      collection: "budgetUsage",
      id: root.runId,
      value: aggregate,
      ...routing,
    });
    rows.push({
      collection: "activityMetrics",
      id: root.runId,
      value: {
        version: COLLECTION_PROJECTION_VERSION,
        ...root.collectionProgress.metrics,
        plannedUnits: Object.keys(root.collectionProgress.units || {}).length,
        plannedSites: new Set(
          Object.values(root.collectionProgress.units || {}).map((unit) =>
            JSON.stringify([unit.sourceId, unit.siteId]),
          ),
        ).size,
        asOf: new Date(asOf).toISOString(),
      },
      ...routing,
    });
  }
  return rows;
}
