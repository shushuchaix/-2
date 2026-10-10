export function countVersionReferences(
  w,
  { kind, revisionId, excludeOperationId = null },
) {
  if (w.schemaVersion === 3) {
    const owner = Object.values(w.packages).find(
      (p) => p.kind === kind && p.versionId === revisionId,
    )?.packageId;
    const own = (r) => r.ownerPackageId === owner;
    return {
      targets: 0,
      runs: Object.values(w.runs).filter(own).length,
      evaluations: Object.values(w.evaluations).filter(own).length,
      members: Object.values(w.jobs).filter(own).length,
      applications: Object.values(w.applications).filter(own).length,
      applicationEvents: Object.values(w.applications)
        .filter(own)
        .reduce((n, a) => n + (a.events || []).length, 0),
      activeOperations: Object.entries(w.operationLeases || {}).filter(
        ([id, l]) =>
          id !== excludeOperationId &&
          (l.packageIds || [l.packageId]).includes(owner),
      ).length,
    };
  }
  const refs = {
    targets: 0,
    runs: 0,
    evaluations: 0,
    members: 0,
    applications: 0,
    applicationEvents: 0,
    activeOperations: 0,
  };
  const field = kind === "profile" ? "profileRevisionId" : "targetRevisionId";
  if (kind === "profile")
    refs.targets = Object.values(w.targets)
      .flat()
      .filter((t) => t.profileRevisionId === revisionId).length;
  refs.runs = Object.values(w.runs).filter(
    (r) =>
      r[field] === revisionId ||
      (kind === "profile"
        ? r.targetSnapshot?.profileRevisionId === revisionId
        : r.targetSnapshot?.revisionId === revisionId),
  ).length;
  refs.evaluations = Object.values(w.evaluations).filter(
    (e) => e[field] === revisionId,
  ).length;
  if (kind === "target")
    refs.members = Object.keys(w.targetMembers?.[revisionId] || {}).length;
  if (kind === "profile")
    for (const a of Object.values(w.applications)) {
      if (a.resumeRevisionId === revisionId) refs.applications++;
      refs.applicationEvents += (a.events || []).filter((e) =>
        Object.values(e.changes || {}).some(
          (change) =>
            change &&
            typeof change === "object" &&
            (change.from === revisionId || change.to === revisionId),
        ),
      ).length;
    }
  refs.activeOperations = Object.entries(w.operationLeases || {}).filter(
    ([id, l]) =>
      id !== excludeOperationId &&
      (l[field] === revisionId ||
        (kind === "profile" &&
          Object.values(w.targets)
            .flat()
            .some(
              (t) =>
                t.revisionId === l.targetRevisionId &&
                t.profileRevisionId === revisionId,
            ))),
  ).length;
  // Old processes may predate operation leases. Their active runs still protect versions.
  refs.activeOperations += Object.values(w.runs).filter(
    (r) =>
      ["queued", "running"].includes(r.status) &&
      (r[field] === revisionId ||
        (kind === "profile"
          ? r.targetSnapshot?.profileRevisionId === revisionId
          : r.targetSnapshot?.revisionId === revisionId)) &&
      !Object.values(w.operationLeases || {}).some(
        (l) => l.targetRevisionId === r.targetSnapshot?.revisionId,
      ),
  ).length;
  return refs;
}
export function versionAvailability(w, target) {
  if (w.schemaVersion === 3) {
    const p = w.packages[target.ownerPackageId];
    if (p?.state !== "active")
      return {
        canCollect: false,
        canRescore: false,
        reasonCode: "target_archived",
      };
    if (target.incomplete || !target.profileSnapshot)
      return {
        canCollect: false,
        canRescore: false,
        reasonCode: "target_profile_unverified",
      };
    return {
      canCollect: p.enabled,
      canRescore: true,
      reasonCode: p.enabled ? null : "target_disabled",
    };
  }
  const meta = w.versionMetadata?.[target.revisionId];
  if (meta?.archivedAt)
    return {
      canCollect: false,
      canRescore: false,
      reasonCode: "target_archived",
    };
  if (w.versionMetadata?.[target.profileRevisionId]?.archivedAt)
    return {
      canCollect: false,
      canRescore: false,
      reasonCode: "profile_archived",
    };
  const enabled = meta?.enabled ?? target.enabled !== false;
  return {
    canCollect: enabled,
    canRescore: true,
    reasonCode: enabled ? null : "target_disabled",
  };
}
