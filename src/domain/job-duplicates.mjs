import { createHash, randomUUID } from "node:crypto";
import {
  resolveJobId,
  resolveApplicationAssociation,
} from "./job-resolution.mjs";
import { jobFactHash } from "./job-facts.mjs";
import {
  mergeRecruitmentFacts,
  mergeSourceEvidenceDraft,
} from "./duplicate-candidates.mjs";
import {
  identityText,
  identityCities,
  jobBusinessContent,
  jobBusinessFingerprint,
  canonicalizeSourceUrl,
  classifyJobDuplicate,
  stableIdentityValue as stable,
  identitySource as source,
  identityScope as scope,
  isKnownIdentityValue as known,
} from "./job-identity.mjs";
export {
  identityText,
  identityCities,
  jobBusinessContent,
  jobBusinessFingerprint,
  canonicalizeSourceUrl,
  classifyJobDuplicate,
};
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
export const workspaceDuplicateHash = (w) =>
  digest({ ...w, revision: undefined, operationLeases: undefined });
const hasManualRecord = (a) =>
  (a.status && a.status !== "new") ||
  !!a.note ||
  !!a.appliedAt ||
  !!a.followUpAt ||
  !!a.resumeRevisionId ||
  a.manualHistory === true ||
  !!a.events?.length;
function manualAssociations(w) {
  return Object.values(w.applications || {})
    .filter(application => hasManualRecord(application) || w.jobProjections?.[application.jobId]?.manualApplication === true)
    .map((application) => ({
      applicationId: application.jobId,
      jobIds: resolveApplicationAssociation(w, application).jobIds,
    }));
}
function completeness(record) {
  return (
    Object.values(jobBusinessContent(record)).filter(
      (v) => v !== null && v !== "" && (!Array.isArray(v) || v.length),
    ).length +
    Math.min(1000, String(record.description || "").length) / 1000
  );
}
export function buildWorkspaceDuplicatePlan(w, options = {}) {
  if (w.schemaVersion === 3 && !w._scope)
    return buildOwnedDuplicatePlan(w, options);
  const allJobs = Object.values(w.jobs),
    manual = manualAssociations(w),
    manualIds = new Set(manual.flatMap((a) => a.jobIds));
  const completenessById = new Map(allJobs.map(job => [job.jobId, completeness(job.canonical)]));
  const rank = (a, b) =>
    Number(manualIds.has(b.jobId)) - Number(manualIds.has(a.jobId)) ||
    Number(b.canonical.sourceRecordIdKind === "authority") -
      Number(a.canonical.sourceRecordIdKind === "authority") ||
    completenessById.get(b.jobId) - completenessById.get(a.jobId) ||
    String(a.firstSeen || "").localeCompare(String(b.firstSeen || "")) ||
    a.jobId.localeCompare(b.jobId);
  allJobs.sort(rank);
  // Exact canonical equality is an equivalence proof for every classifier
  // input. Compare one representative, then expand its members in the plan.
  // A self-confirmation is required: equal weak records can still be possible.
  const equivalent = new Map(), representativeOf = new Map(), selfProof = new Map(), canonicalBuckets = new Map(), jobs = [];
  for (const job of allJobs) {
    const canonical = options.preclassifiedRelations ? null : JSON.stringify(stable(job.canonical));
    const bucket = canonical === null ? null : canonicalBuckets.get(canonical);
    if (bucket?.confirmed) { bucket.members.push(job); representativeOf.set(job.jobId, bucket.root.jobId); continue; }
    const members = [job], proof = canonical !== null ? classifyJobDuplicate(job.canonical, job.canonical) : null, confirmed = proof?.relation === 'confirmed';
    if (confirmed) selfProof.set(job.jobId, proof.reasonCodes);
    if (canonical !== null) canonicalBuckets.set(canonical, { root: job, members, confirmed });
    equivalent.set(job.jobId, members); representativeOf.set(job.jobId, job.jobId); jobs.push(job);
  }
  const indexes = new Map(), confirmed = new Map(), byId = new Map(jobs.map(job => [job.jobId, job])),
    pairs = new Map(),
    possiblePairs = [];
  const keys = (r) => {
    const values = [
      "fields:" +
        JSON.stringify([identityText(r.company), identityText(r.title)]),
    ];
    if (identityText(r.company)) {
      const title = identityText(r.title);
      for (const gram of new Set([...title].slice(1).map((_, index) => title.slice(index, index + 2)))) values.push('titlegram:' + JSON.stringify([identityText(r.company), gram]));
    }
    if (r.sourceRecordIdKind === "authority")
      values.push(
        "id:" + JSON.stringify([source(r), scope(r), String(r.sourceRecordId)]),
      );
    if (r.url)
      try {
        values.push("url:" + canonicalizeSourceUrl(r.url, r.urlPolicy));
      } catch {
        /* invalid hints do not prove identity */
      }
    return values;
  };
  const pairKey = (a, b) => JSON.stringify([a, b].sort());
  const compactGroupByJob = new Map(), compactGroups = new Map();
  for (const group of options.preclassifiedGroups || []) {
    const members = group.jobIds.filter(id => byId.has(id));
    compactGroups.set(group.groupId, { ...group, jobIds: members });
    for (const id of members) compactGroupByJob.set(id, group.groupId);
  }
  const pairResult = (a, b) => pairs.get(pairKey(a, b)) || (compactGroupByJob.get(a) && compactGroupByJob.get(a) === compactGroupByJob.get(b) ? { relation: 'confirmed', reasonCodes: compactGroups.get(compactGroupByJob.get(a)).reasonCodes } : null);
  if (options.preclassifiedRelations) {
    for (const relation of options.preclassifiedRelations) {
      if (!byId.has(relation.jobId) || !byId.has(relation.otherJobId) || relation.jobId === relation.otherJobId) continue;
      const id = pairKey(relation.jobId, relation.otherJobId);
      if (pairs.has(id)) continue;
      pairs.set(id, { relation: relation.relation, reasonCodes: relation.reasonCodes || [] });
      if (relation.relation === 'confirmed') {
        (confirmed.get(relation.jobId) || (confirmed.set(relation.jobId, []), confirmed.get(relation.jobId))).push(relation.otherJobId);
        (confirmed.get(relation.otherJobId) || (confirmed.set(relation.otherJobId, []), confirmed.get(relation.otherJobId))).push(relation.jobId);
      } else if (relation.relation === 'possible') possiblePairs.push({ jobIds: [relation.jobId, relation.otherJobId].sort(), reasonCodes: relation.reasonCodes || [] });
    }
  } else {
  for (const job of jobs) {
    const candidates = new Set(
      keys(job.canonical).flatMap((k) => indexes.get(k) || []),
    );
    for (const other of candidates) {
      const result = classifyJobDuplicate(job.canonical, other.canonical);
      if (result.relation !== 'distinct') pairs.set(pairKey(job.jobId, other.jobId), result);
      if (result.relation === 'confirmed') {
        (confirmed.get(job.jobId) || (confirmed.set(job.jobId, []), confirmed.get(job.jobId))).push(other.jobId);
        (confirmed.get(other.jobId) || (confirmed.set(other.jobId, []), confirmed.get(other.jobId))).push(job.jobId);
      }
      if (result.relation === "possible")
        for (const a of equivalent.get(job.jobId)) for (const b of equivalent.get(other.jobId)) possiblePairs.push({ jobIds: [a.jobId, b.jobId].sort(), reasonCodes: result.reasonCodes });
    }
    for (const key of keys(job.canonical)) {
      if (!indexes.has(key)) indexes.set(key, []);
      indexes.get(key).push(job);
    }
  }
  }
  const used = new Set(),
    groups = [];
  for (const root of jobs) {
    if (used.has(root.jobId)) continue;
    const members = [root], memberBuckets = new Map([[compactGroupByJob.get(root.jobId) || 'job:' + root.jobId, [root]]]);
    const neighbors = new Set([...(confirmed.get(root.jobId) || []), ...(compactGroups.get(compactGroupByJob.get(root.jobId))?.jobIds || [])]);
    for (const candidate of [...neighbors].map(id => byId.get(id)).sort(rank)) {
      if (candidate === root || used.has(candidate.jobId)) continue;
      if (
        [...memberBuckets].every(([bucket, bucketMembers]) => compactGroupByJob.get(candidate.jobId) === bucket || bucketMembers.every(m => pairResult(m.jobId, candidate.jobId)?.relation === 'confirmed'))
      ) {
        members.push(candidate);
        const bucket = compactGroupByJob.get(candidate.jobId) || 'job:' + candidate.jobId;
        (memberBuckets.get(bucket) || (memberBuckets.set(bucket, []), memberBuckets.get(bucket))).push(candidate);
      }
    }
    const expanded = members.flatMap(member => equivalent.get(member.jobId)).sort(rank);
    if (expanded.length < 2) continue;
    expanded.forEach((j) => used.add(j.jobId));
    const ids = expanded.map((j) => j.jobId), idSet = new Set(ids),
      applications = manual.filter((a) =>
        a.jobIds.some((id) => idSet.has(id)),
      );
    const targetRevisionIds = Object.entries(w.targetMembers || {})
      .filter(([, m]) => ids.some((id) => m[id]))
      .map(([id]) => id)
      .sort();
    groups.push({
      groupId: "dg-" + digest([...ids].sort()).slice(0, 24),
      keepJobId: root.jobId,
      removeJobIds: ids.slice(1).sort(),
      reasonCodes: [
        ...new Set(
          expanded
            .slice(1)
            .flatMap(
              (m) => representativeOf.get(m.jobId) === root.jobId ? selfProof.get(root.jobId) : pairResult(root.jobId, representativeOf.get(m.jobId)).reasonCodes,
            ),
        ),
      ].sort(),
      targetRevisionIds,
      protected: applications.length > 1,
      protectedReason:
        applications.length > 1 ? "multiple_manual_applications" : null,
      manualApplicationCount: applications.length,
    });
  }
  const protectedGroups = groups.filter((g) => g.protected),
    eligible = groups.filter((g) => !g.protected);
  const collapsed = (g) =>
    Object.values(w.targetMembers || {}).reduce(
      (n, m) =>
        n +
        Math.max(
          0,
          [g.keepJobId, ...g.removeJobIds].filter((id) => m[id]).length - 1,
        ),
      0,
    );
  const counts = {
    confirmedGroups: groups.length,
    removedEntities: eligible.reduce((n, g) => n + g.removeJobIds.length, 0),
    collapsedVersionEntries: eligible.reduce((n, g) => n + collapsed(g), 0),
    affectedVersions: new Set(eligible.flatMap((g) => g.targetRevisionIds))
      .size,
    possiblePairs: possiblePairs.length,
    protectedGroups: protectedGroups.length,
  };
  return {
    workspaceRevision: w.revision,
    planHash: options.readModelOnly ? null : workspaceDuplicateHash(w),
    groups,
    possiblePairs: possiblePairs.sort((a, b) =>
      JSON.stringify(a.jobIds).localeCompare(JSON.stringify(b.jobIds)),
    ),
    protectedGroups,
    counts,
  };
}
export function applyWorkspaceDuplicatePlan(w, plan, { operationId, at }) {
  const groups = plan.groups.filter((g) => !g.protected),
    affected = new Set();
  let removedEntities = 0,
    collapsedVersionEntries = 0;
  w.jobRedirects ||= {};
  for (const g of groups) {
    const kept = w.jobs[g.keepJobId],
      ids = [g.keepJobId, ...g.removeJobIds];
    for (const id of g.removeJobIds) {
      const removed = w.jobs[id];
      if (!removed) throw Error("Duplicate entity disappeared");
      mergeSourceEvidenceDraft(w, {
        scope:
          w.schemaVersion === 3
            ? {
                packageId: kept.ownerPackageId,
                targetRevisionId: w.packages[kept.ownerPackageId].versionId,
              }
            : undefined,
        keptJobId: g.keepJobId,
        mergedJobId: id,
      });
      kept.sourceRefs = [
        ...new Map(
          [...(kept.sourceRefs || []), ...(removed.sourceRefs || [])].map(
            (r) => [digest(r), r],
          ),
        ).values(),
      ];
      kept.identityAliases = [
        ...new Set([
          ...(kept.identityAliases || []),
          ...(removed.identityAliases || []),
        ]),
      ];
      if (String(removed.firstSeen || "") < String(kept.firstSeen || ""))
        kept.firstSeen = removed.firstSeen;
      if (String(removed.lastSeen || "") > String(kept.lastSeen || ""))
        kept.lastSeen = removed.lastSeen;
      kept.targetFirstSeen ||= {};
      for (const [target, time] of Object.entries(
        removed.targetFirstSeen || {},
      ))
        if (
          !kept.targetFirstSeen[target] ||
          time < kept.targetFirstSeen[target]
        )
          kept.targetFirstSeen[target] = time;
      w.jobRedirects[id] = {
        toJobId: g.keepJobId,
        operationId,
        mergedAt: at,
        ...(w.schemaVersion === 3
          ? {
              ownerPackageId: kept.ownerPackageId,
              originalRecordId: removed.recordId,
            }
          : {}),
      };
      if (w.schemaVersion === 3) {
        if (removed.ownerPackageId !== kept.ownerPackageId)
          throw Error("Cross package duplicate merge");
        for (const key of [
          "observations",
          "evaluations",
          "applications",
          "events",
        ])
          for (const r of Object.values(w[key] || {}))
            if (r.jobId === id) {
              if (r.ownerPackageId !== kept.ownerPackageId)
                throw Error("Cross package duplicate reference");
              r.originalJobId ||= id;
              r.jobId = g.keepJobId;
            }
      }
      delete w.jobs[id];
      removedEntities++;
    }
    for (const [version, members] of Object.entries(w.targetMembers || {})) {
      const existing = ids.filter((id) => members[id]);
      if (!existing.length) continue;
      affected.add(version);
      collapsedVersionEntries += existing.length - 1;
      const all = existing.map((id) => members[id]),
        factRefs = [
          ...new Map(
            all
              .flatMap((m) => m.factRefs || [])
              .map((ref) => [ref.observationId, ref]),
          ).values(),
        ];
      const observations = factRefs
          .map((r) => w.observations[r.observationId])
          .filter(Boolean)
          .sort(
            (a, b) =>
              String(b.observedAt || "").localeCompare(
                String(a.observedAt || ""),
              ) || b.observationId.localeCompare(a.observationId),
          ),
        current = observations[0];
      if (current) {
        const original = observations.filter(
            (o) => o.sourceKind !== "combined_evidence",
          ),
          combined = original
            .toSorted(
              (a, b) =>
                String(a.observedAt || "").localeCompare(
                  String(b.observedAt || ""),
                ) || (a.factRevision || 0) - (b.factRevision || 0),
            )
            .reduce(
              (r, o) =>
                r
                  ? mergeRecruitmentFacts(r, o.fields || o.record)
                  : structuredClone(o.fields || o.record),
              null,
            );
        if (
          combined &&
          jobFactHash(combined) !==
            jobFactHash(current.fields || current.record)
        ) {
          const oid =
            "z-" + digest([operationId, version, g.keepJobId, combined]);
          w.observations[oid] = {
            ...structuredClone(current),
            observationId: oid,
            recordId: randomUUID(),
            jobId: g.keepJobId,
            sourceKind: "combined_evidence",
            derivedFromObservationIds: original.map((o) => o.observationId),
            fields: combined,
            contentHash: createHash("sha256")
              .update(JSON.stringify(combined))
              .digest("hex"),
            observedAt: at,
            factRevision:
              Math.max(0, ...observations.map((o) => o.factRevision || 0)) + 1,
          };
          factRefs.push({
            observationId: oid,
            provenanceOperationId: operationId,
          });
          observations.unshift(w.observations[oid]);
        }
      }
      const times = all
        .flatMap((m) => [m.firstSeen, m.lastSeen])
        .filter(Boolean)
        .sort();
      members[g.keepJobId] = {
        ...structuredClone(all[0]),
        factRefs,
        currentObservationId: observations[0]?.observationId || null,
        factContentHash: observations[0]
          ? jobFactHash(observations[0].fields || observations[0].record)
          : null,
        firstSeen: times[0] || null,
        lastSeen: times.at(-1) || null,
      };
      for (const id of g.removeJobIds) delete members[id];
    }
  }
  for (const redirect of Object.values(w.jobRedirects))
    redirect.toJobId = resolveJobId(w, redirect.toJobId);
  for (const [alias, ids] of Object.entries(w.identityAliases))
    w.identityAliases[alias] = [
      ...new Set(
        ids
          .map((id) => resolveJobId(w, id, { allowMissing: true }))
          .filter(Boolean),
      ),
    ];
  for (const [groupId, group] of Object.entries(w.duplicateGroups || {})) {
    group.jobIds = [
      ...new Set(
        group.jobIds
          .map((id) => resolveJobId(w, id, { allowMissing: true }))
          .filter(Boolean),
      ),
    ];
    if (group.jobIds.length < 2) delete w.duplicateGroups[groupId];
  }
  for (const job of Object.values(w.jobs))
    job.duplicateGroupIds = Object.values(w.duplicateGroups || {})
      .filter((g) => g.jobIds.includes(job.jobId))
      .map((g) => g.groupId);
  return {
    confirmedGroups: groups.length,
    removedEntities,
    collapsedVersionEntries,
    affectedVersions: affected.size,
    possiblePairs: plan.possiblePairs.length,
    protectedGroups: plan.protectedGroups.length,
  };
}
function ownedDuplicateView(w, packageId) {
  const v = structuredClone(w);
  v._scope = { packageId };
  for (const key of [
    "jobs",
    "observations",
    "evaluations",
    "applications",
    "runs",
    "events",
    "files",
    "jobRedirects",
  ])
    v[key] = Object.fromEntries(
      Object.entries(v[key] || {}).filter(
        ([, r]) => r.ownerPackageId === packageId,
      ),
    );
  for (const key of ["profiles", "targets"])
    v[key] = Object.fromEntries(
      Object.entries(v[key])
        .map(([id, list]) => [
          id,
          list.filter((r) => r.ownerPackageId === packageId),
        ])
        .filter(([, list]) => list.length),
    );
  v.targetMembers = Object.fromEntries(
    Object.entries(v.targetMembers || {}).filter(([id]) =>
      Object.values(v.targets)
        .flat()
        .some((t) => t.revisionId === id),
    ),
  );
  v.identityAliases = Object.fromEntries(
    Object.entries(v.identityAliases)
      .map(([id, ids]) => [
        id,
        ids.filter((jobId) => v.jobs[jobId] || v.jobRedirects[jobId]),
      ])
      .filter(([, ids]) => ids.length),
  );
  return v;
}
function buildOwnedDuplicatePlan(
  w,
  { packageIds, allVersions = true, now = Date.now() } = {},
) {
  const chosen = Object.values(w.packages)
    .filter(
      (p) =>
        ["target", "legacy_unassigned"].includes(p.kind) &&
        (!packageIds || packageIds.includes(p.packageId)) &&
        (p.state === "active" ||
          (p.state === "trashed" && Date.parse(p.purgeAt) > now)),
    )
    .sort((a, b) => a.packageId.localeCompare(b.packageId));
  const packages = chosen.map((p) => {
    const plan = buildWorkspaceDuplicatePlan(
      ownedDuplicateView(w, p.packageId),
    );
    const meta = {
      packageId: p.packageId,
      archiveId: p.archiveId || null,
      purgeAt: p.purgeAt || null,
    };
    return {
      ...meta,
      versionName: p.versionName,
      kind: p.kind,
      counts: plan.counts,
      groups: plan.groups.map((g) => ({ ...g, ...meta })),
      possiblePairs: plan.possiblePairs.map((g) => ({ ...g, ...meta })),
    };
  });
  const groups = packages.flatMap((p) => p.groups),
    possiblePairs = packages.flatMap((p) => p.possiblePairs),
    protectedGroups = groups.filter((g) => g.protected),
    counts = {
      confirmedGroups: 0,
      removedEntities: 0,
      collapsedVersionEntries: 0,
      affectedVersions: 0,
      possiblePairs: 0,
      protectedGroups: 0,
    };
  for (const p of packages)
    for (const [key, n] of Object.entries(p.counts))
      counts[key] = (counts[key] || 0) + n;
  return {
    workspaceRevision: w.revision,
    planHash: digest({
      workspaceHash: workspaceDuplicateHash(w),
      packages: chosen.map((p) => ({
        packageId: p.packageId,
        archiveId: p.archiveId,
        purgeAt: p.purgeAt,
      })),
    }),
    groups,
    possiblePairs,
    protectedGroups,
    packages,
    counts,
    totals: counts,
    packageIds: chosen.map((p) => p.packageId),
    allVersions,
  };
}
