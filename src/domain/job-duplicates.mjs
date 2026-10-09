import { createHash } from "node:crypto";
import {
  resolveJobId,
  resolveApplicationAssociation,
} from "./job-resolution.mjs";
import { jobFactHash } from "./job-facts.mjs";
import {
  recruitmentConflicts,
  sharedVerifiedJobLocator,
  mergeRecruitmentFacts,
  mergeSourceEvidenceDraft,
  conditionIdentity,
} from "./duplicate-candidates.mjs";
export const identityText = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
export const identityCities = (r) =>
  [
    ...new Set(
      (r.cities || [r.city])
        .filter(Boolean)
        .map((x) => identityText(x).replace(/市$/u, ""))
        .filter((x) => !["全国", "不限", "远程"].includes(x)),
    ),
  ].sort();
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, stable(value[k])]),
        )
      : value;
const businessFields = [
  "kind",
  "title",
  "company",
  "cities",
  "jobType",
  "graduationYear",
  "cohort",
  "batch",
  "recruitmentBatch",
  "recruitmentYear",
  "level",
  "degree",
  "experience",
  "requiredCertificates",
  "workMode",
  "employmentMode",
  "contractType",
  "major",
  "majorRequired",
  "requirements",
  "description",
  "publishedAt",
  "deadlineAt",
  "salary",
  "account",
  "platform",
];
export function jobBusinessContent(r) {
  return {
    ...Object.fromEntries(businessFields.map((k) => [k, r[k] ?? null])),
    conditions: (r.conditions || []).map(conditionIdentity),
  };
}
export function jobBusinessFingerprint(r) {
  return createHash("sha256")
    .update(JSON.stringify(stable(jobBusinessContent(r))))
    .digest("hex");
}
export function canonicalizeSourceUrl(value, policy = {}) {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw Error("Invalid job url");
  for (const key of [...u.searchParams.keys()])
    if (/^utm_/i.test(key) || (policy.trackingParams || []).includes(key))
      u.searchParams.delete(key);
  u.searchParams.sort();
  if (policy.preserveHash === false) u.hash = "";
  return u.href;
}
const source = (r) => r.sourceId || r.source || "unknown";
const scope = (r) => r.identityScope || r.siteId || source(r);
const known = (v) =>
  v !== null && v !== undefined && v !== "" && v !== "unknown";
const batch = (r) => r.batch || r.recruitmentBatch || r.extra?.batch || null;
const year = (r) =>
  r.recruitmentYear ||
  (r.publishedAt && /^\d{4}/.test(r.publishedAt)
    ? String(r.publishedAt).slice(0, 4)
    : null);
const level = (r) =>
  r.level ||
  String(r.title || "").match(
    /高级|资深|初级|中级|实习|(?:^|[^A-Za-z])([PMLT][0-9]{1,2})(?:$|[^0-9A-Za-z])/u,
  )?.[0] ||
  null;
const certificates = (r) =>
  [
    ...new Set(
      (r.requiredCertificates || []).map((x) =>
        identityText(typeof x === "string" ? x : x.name),
      ),
    ),
  ].sort();
function substantive(r) {
  const text = String(r.description || "").trim();
  return (
    text.length >= 30 &&
    !/^(?:点击|请点击|详情请|登录后|招聘信息|岗位详情|欢迎加入|公司招聘|请填写|暂无|待补充|验证码|人机验证)/u.test(
      text,
    ) &&
    /职责|负责|要求|学历|本科|硕士|经验|证书|毕业|专业|资格|任职|工作内容|responsibilit|qualification|requirement|degree|experience/i.test(
      text,
    )
  );
}
function similarity(a, b) {
  const grams = (s) =>
      new Set([...s].slice(1).map((_, i) => s.slice(i, i + 2))),
    x = grams(a),
    y = grams(b);
  const common = [...x].filter((g) => y.has(g)).length;
  return common / Math.max(1, x.size + y.size - common);
}
export function classifyJobDuplicate(
  left,
  right,
  { leftProvenance = left, rightProvenance = right } = {},
) {
  const evidenceConflicts = recruitmentConflicts(left, right);
  const conflicts = [];
  for (const [field, a, b] of [
    ["kind", left.kind, right.kind],
    ["company", left.company, right.company],
    [
      "cohort",
      left.graduationYear || left.cohort,
      right.graduationYear || right.cohort,
    ],
    ["batch", batch(left), batch(right)],
    ["year", year(left), year(right)],
    ["job_type", left.jobType, right.jobType],
    ["level", level(left), level(right)],
    ["degree", left.degree, right.degree],
    ["experience", left.experience, right.experience],
    ["work_mode", left.workMode, right.workMode],
  ])
    if (known(a) && known(b) && identityText(a) !== identityText(b))
      conflicts.push("different_" + field);
  const aCities = identityCities(left),
    bCities = identityCities(right);
  if (
    aCities.length &&
    bCities.length &&
    JSON.stringify(aCities) !== JSON.stringify(bCities)
  )
    conflicts.push("different_cities");
  // Missing certificates are unknown, not an explicit contradictory requirement.
  const authorityA =
    leftProvenance.sourceRecordIdKind === "authority" &&
    known(left.sourceRecordId);
  const authorityB =
    rightProvenance.sourceRecordIdKind === "authority" &&
    known(right.sourceRecordId);
  const sameAuthorityScope =
    authorityA &&
    authorityB &&
    source(left) === source(right) &&
    scope(left) === scope(right);
  if (
    sameAuthorityScope &&
    String(left.sourceRecordId) !== String(right.sourceRecordId)
  )
    conflicts.push("different_recruitment_ids");
  const company = identityText(left.company),
    title = identityText(left.title),
    rightTitle = identityText(right.title);
  if (title && rightTitle && title !== rightTitle)
    conflicts.push("different_title");
  if (conflicts.length) {
    const fuzzy =
      conflicts.length === 1 &&
      conflicts[0] === "different_title" &&
      company &&
      company === identityText(right.company) &&
      similarity(title, rightTitle) >= 0.82;
    return {
      relation: fuzzy ? "possible" : "distinct",
      reasonCodes: fuzzy ? ["similar_company_title"] : conflicts,
    };
  }
  if (evidenceConflicts.length)
    return {
      relation: evidenceConflicts.some((c) => c.decision === "distinct")
        ? "distinct"
        : "possible",
      reasonCodes: evidenceConflicts.map((c) => c.code),
    };
  const fieldsMatch =
    company &&
    company === identityText(right.company) &&
    title &&
    title === rightTitle;
  const sameAuthority =
    sameAuthorityScope &&
    String(left.sourceRecordId) === String(right.sourceRecordId);
  let specificUrl = false;
  const specificKinds =
    left.kind === "recruitment_notice"
      ? ["notice_detail"]
      : ["job_detail", "job_apply"];
  if (
    fieldsMatch &&
    specificKinds.includes(leftProvenance.urlKind) &&
    specificKinds.includes(rightProvenance.urlKind)
  )
    try {
      // urlKind describes only the primary source URL. A separate application
      // form has no specificity proof and cannot inherit the detail URL's role.
      specificUrl =
        canonicalizeSourceUrl(left.url, left.urlPolicy) ===
        canonicalizeSourceUrl(right.url, right.urlPolicy);
    } catch {
      /* invalid URL is not proof */
    }
  if (
    sameAuthority &&
    (!company ||
      !identityText(right.company) ||
      company === identityText(right.company)) &&
    (!title || !rightTitle || title === rightTitle)
  )
    return { relation: "confirmed", reasonCodes: ["authority_id"] };
  if (fieldsMatch && specificUrl)
    return { relation: "confirmed", reasonCodes: ["specific_job_url"] };
  if (fieldsMatch && sharedVerifiedJobLocator(left, right))
    return { relation: "confirmed", reasonCodes: ["verified_job_locator"] };
  const exactBusiness =
    jobBusinessFingerprint(left) === jobBusinessFingerprint(right);
  const manual =
    source(left) === "manual" &&
    source(right) === "manual" &&
    !left.url &&
    !right.url;
  if (
    exactBusiness &&
    substantive(left) &&
    (manual || (fieldsMatch && aCities.length && known(left.jobType)))
  )
    return {
      relation: "confirmed",
      reasonCodes: [
        manual ? "identical_manual_input" : "identical_complete_content",
      ],
    };
  if (fieldsMatch || (manual && exactBusiness))
    return {
      relation: "possible",
      reasonCodes: ["insufficient_identity_evidence"],
    };
  return {
    relation: "distinct",
    reasonCodes: ["insufficient_identity_evidence"],
  };
}
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
  !!a.events?.length;
function manualAssociations(w) {
  return Object.values(w.applications || {})
    .filter(hasManualRecord)
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
  const jobs = Object.values(w.jobs),
    manual = manualAssociations(w),
    manualIds = new Set(manual.flatMap((a) => a.jobIds));
  const rank = (a, b) =>
    Number(manualIds.has(b.jobId)) - Number(manualIds.has(a.jobId)) ||
    Number(b.canonical.sourceRecordIdKind === "authority") -
      Number(a.canonical.sourceRecordIdKind === "authority") ||
    completeness(b.canonical) - completeness(a.canonical) ||
    String(a.firstSeen || "").localeCompare(String(b.firstSeen || "")) ||
    a.jobId.localeCompare(b.jobId);
  jobs.sort(rank);
  const indexes = new Map(),
    pairs = new Map(),
    possiblePairs = [];
  const keys = (r) => {
    const values = [
      "fields:" +
        JSON.stringify([identityText(r.company), identityText(r.title)]),
    ];
    if (identityText(r.company))
      values.push("company:" + identityText(r.company));
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
  for (const job of jobs) {
    const candidates = new Set(
      keys(job.canonical).flatMap((k) => indexes.get(k) || []),
    );
    for (const other of candidates) {
      const result = classifyJobDuplicate(job.canonical, other.canonical);
      pairs.set(pairKey(job.jobId, other.jobId), result);
      if (result.relation === "possible")
        possiblePairs.push({
          jobIds: [job.jobId, other.jobId].sort(),
          reasonCodes: result.reasonCodes,
        });
    }
    for (const key of keys(job.canonical)) {
      if (!indexes.has(key)) indexes.set(key, []);
      indexes.get(key).push(job);
    }
  }
  const used = new Set(),
    groups = [];
  for (const root of jobs) {
    if (used.has(root.jobId)) continue;
    const members = [root];
    for (const candidate of jobs) {
      if (candidate === root || used.has(candidate.jobId)) continue;
      if (
        members.every(
          (m) =>
            pairs.get(pairKey(m.jobId, candidate.jobId))?.relation ===
            "confirmed",
        )
      )
        members.push(candidate);
    }
    if (members.length < 2) continue;
    members.forEach((j) => used.add(j.jobId));
    const ids = members.map((j) => j.jobId),
      applications = manual.filter((a) =>
        a.jobIds.some((id) => ids.includes(id)),
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
          members
            .slice(1)
            .flatMap(
              (m) => pairs.get(pairKey(root.jobId, m.jobId)).reasonCodes,
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
    planHash: workspaceDuplicateHash(w),
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
            jobId: g.keepJobId,
            sourceKind: "combined_evidence",
            derivedFromObservationIds: original.map((o) => o.observationId),
            fields: combined,
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
