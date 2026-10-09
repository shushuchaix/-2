import { createHash } from "node:crypto";
import { classifyJobDuplicate } from "./job-duplicates.mjs";
import { packageError } from "./packages.mjs";
const norm = (v) =>
  String(v ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
const key = (v) => JSON.stringify(stable(v));
const hash = (v) => createHash("sha256").update(key(v)).digest("hex");
const known = (v) =>
  v !== null &&
  v !== undefined &&
  v !== "" &&
  v !== "unknown" &&
  (!Array.isArray(v) || v.length > 0);
export const conditionIdentity = (c) => ({
  type: c.type,
  operator: c.operator,
  values: (c.values || []).map(norm).sort(),
  required: c.required !== false,
  preferred: c.preferred === true,
  grade: c.grade || null,
  registrationRequired: c.registrationRequired === true,
});
const majors = (r) =>
  [
    ...new Set(
      [
        ...(Array.isArray(r.major) ? r.major : [r.major]).filter(Boolean),
        ...(r.conditions || [])
          .filter(
            (c) => c.type === "major" && c.required !== false && !c.preferred,
          )
          .flatMap((c) => c.values || []),
      ].map(norm),
    ),
  ].sort();
const certificates = (r) =>
  [
    ...(r.requiredCertificates || []).map((c) =>
      typeof c === "string"
        ? { name: norm(c), required: true, preferred: false }
        : {
            name: norm(c.name),
            grade: c.grade || null,
            required: c.required !== false,
            preferred: c.preferred === true,
            registrationRequired: c.registrationRequired === true,
          },
    ),
    ...(r.conditions || [])
      .filter((c) => c.type === "certificate")
      .map((c) => ({
        ...conditionIdentity(c),
        name: (c.values || []).map(norm).join("|"),
      })),
  ]
    .map(key)
    .sort();
export function recruitmentConflicts(a, b) {
  const conflicts = [];
  for (const field of ["workMode", "employmentMode", "contractType"])
    if (known(a[field]) && known(b[field]) && norm(a[field]) !== norm(b[field]))
      conflicts.push({
        field,
        decision: "distinct",
        code: "different_" + field,
      });
  const am = majors(a),
    bm = majors(b);
  if (am.length && bm.length && key(am) !== key(bm))
    conflicts.push({
      field: "major",
      decision: "review",
      code: "conflicting_major",
    });
  const ac = certificates(a),
    bc = certificates(b);
  if (ac.length && bc.length && key(ac) !== key(bc))
    conflicts.push({
      field: "certificate",
      decision: "review",
      code: "conflicting_certificate",
    });
  if (
    (a.certificateRequirementStatus === "none" && bc.length) ||
    (b.certificateRequirementStatus === "none" && ac.length)
  )
    conflicts.push({
      field: "certificate",
      decision: "review",
      code: "conflicting_certificate",
    });
  const ab = a.batch || a.recruitmentBatch,
    bb = b.batch || b.recruitmentBatch;
  if (!!ab !== !!bb)
    conflicts.push({
      field: "batch",
      decision: "review",
      code: "batch_unknown",
    });
  return conflicts;
}
const canonical = (url) => {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()])
      if (/^utm_/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return u.href;
  } catch {
    return null;
  }
};
export function sharedVerifiedJobLocator(a, b) {
  if (
    norm(a.title) !== norm(b.title) ||
    !norm(a.company) ||
    norm(a.company) !== norm(b.company) ||
    a.kind !== "job" ||
    b.kind !== "job"
  )
    return false;
  const urls = (r) =>
    [
      ...(["job_detail"].includes(r.urlKind) ? [canonical(r.url)] : []),
      ...(r.verifiedJobLocator?.verified === true &&
      r.verifiedJobLocator.kind === "job_detail" &&
      norm(r.verifiedJobLocator.title) === norm(r.title) &&
      norm(r.verifiedJobLocator.company) === norm(r.company)
        ? [canonical(r.verifiedJobLocator.url)]
        : []),
    ].filter(Boolean);
  return urls(a).some((url) => urls(b).includes(url));
}
export function compareRecruitmentFacts(a, b) {
  const c = classifyJobDuplicate(a, b);
  return {
    decision:
      c.relation === "confirmed"
        ? "same"
        : c.relation === "distinct"
          ? "distinct"
          : "review",
    conflicts: c.reasonCodes,
  };
}
function simHash(text) {
  const grams = [...norm(text)].slice(0, 12000),
    weights = Array(64).fill(0);
  for (let i = 0; i < grams.length - 1; i++) {
    const n = BigInt(
      "0x" +
        createHash("sha256")
          .update(grams[i] + grams[i + 1])
          .digest("hex")
          .slice(0, 16),
    );
    for (let bit = 0; bit < 64; bit++)
      weights[bit] += (n >> BigInt(bit)) & 1n ? 1 : -1;
  }
  return weights.reduce(
    (n, v, bit) => (v >= 0 ? n | (1n << BigInt(bit)) : n),
    0n,
  );
}
const distance = (a, b) => {
  let n = a ^ b,
    count = 0;
  while (n) {
    n &= n - 1n;
    count++;
  }
  return count;
};
export function findDuplicateCandidates({ records, existingJobs }) {
  const pairs = [];
  for (const [recordIndex, r] of records.entries()) {
    let rh;
    for (const job of existingJobs) {
      const other = job.canonical || job;
      if (
        r.ownerPackageId &&
        job.ownerPackageId &&
        r.ownerPackageId !== job.ownerPackageId
      )
        continue;
      const fields =
        norm(r.company) &&
        norm(r.company) === norm(other.company) &&
        norm(r.title) === norm(other.title);
      let reason = fields
        ? "company_title"
        : sharedVerifiedJobLocator(r, other)
          ? "verified_locator"
          : null;
      if (
        !reason &&
        String(r.description || "").length >= 30 &&
        String(other.description || "").length >= 30 &&
        norm(r.company) === norm(other.company)
      ) {
        rh ??= simHash(r.description);
        if (distance(rh, simHash(other.description)) <= 3)
          reason = "simhash_candidate";
      }
      if (reason) pairs.push({ recordIndex, existingJobId: job.jobId, reason });
    }
  }
  return pairs;
}
export function mergeRecruitmentFacts(older, newer) {
  const result = structuredClone(older);
  const identityFields = new Set([
    "sourceId",
    "siteId",
    "identityScope",
    "sourceRecordId",
    "sourceRecordIdKind",
    "url",
    "urlKind",
    "parserVersion",
  ]);
  const upgrade =
    (newer.sourceRecordIdKind === "authority" &&
      known(newer.sourceRecordId) &&
      !(
        older.sourceRecordIdKind === "authority" && known(older.sourceRecordId)
      )) ||
    (newer.urlKind === "job_detail" &&
      !["job_detail", "job_apply"].includes(older.urlKind) &&
      !(
        older.sourceRecordIdKind === "authority" && known(older.sourceRecordId)
      ));
  for (const [field, value] of Object.entries(newer))
    if ((!identityFields.has(field) || upgrade) && known(value))
      result[field] = structuredClone(value);
  if (
    newer.bodyIncomplete ||
    ["pending", "restricted", "discovery_only"].includes(newer.detailStatus) ||
    !newer.description
  ) {
    for (const field of [
      "description",
      "detailStatus",
      "bodyStatus",
      "bodyIncomplete",
    ])
      if (older[field] !== undefined)
        result[field] = structuredClone(older[field]);
  }
  const dedup = (array, projection = (v) => v) => [
    ...new Map(array.map((v) => [hash(projection(v)), v])).values(),
  ];
  result.sourceEvidence = dedup(
    [...(older.sourceEvidence || []), ...(newer.sourceEvidence || [])],
    ({ observedAt, evidenceId, ...e }) => e,
  );
  result.evidence = dedup([
    ...(older.evidence || []),
    ...(newer.evidence || []),
  ]);
  result.evidenceConflicts = dedup([
    ...(older.evidenceConflicts || []),
    ...(newer.evidenceConflicts || []),
  ]);
  result.conditions = dedup(
    [...(older.conditions || []), ...(newer.conditions || [])],
    conditionIdentity,
  ).map((c) => ({
    ...c,
    evidenceRefs: [
      ...new Set(
        [...(older.conditions || []), ...(newer.conditions || [])]
          .filter(
            (x) => key(conditionIdentity(x)) === key(conditionIdentity(c)),
          )
          .flatMap((x) => x.evidenceRefs || []),
      ),
    ],
  }));
  return result;
}
export function mergeSourceEvidenceDraft(
  w,
  { scope, keptJobId, mergedJobId, evidence = [] },
) {
  const kept = w.jobs[keptJobId],
    removed = w.jobs[mergedJobId];
  if (!kept || !removed) throw Error("Duplicate entity disappeared");
  if (w.schemaVersion === 3) {
    const pkg = w.packages[scope?.packageId];
    if (
      !pkg ||
      pkg.versionId !== scope.targetRevisionId ||
      kept.ownerPackageId !== scope.packageId ||
      removed.ownerPackageId !== scope.packageId
    )
      throw packageError("package_scope_mismatch", "不能跨版本合并岗位证据。");
    for (const type of [
      "observations",
      "evaluations",
      "applications",
      "events",
    ])
      for (const r of Object.values(w[type] || {}))
        if (
          [keptJobId, mergedJobId].includes(r.jobId) &&
          r.ownerPackageId !== scope.packageId
        )
          throw packageError(
            "package_scope_mismatch",
            "岗位关联记录归属不一致。",
          );
  }
  if (
    compareRecruitmentFacts(kept.canonical, removed.canonical).decision !==
    "same"
  )
    throw packageError(
      "duplicate_evidence_conflict",
      "条件冲突或身份未核实，不能自动合并。",
    );
  kept.canonical = mergeRecruitmentFacts(kept.canonical, {
    ...removed.canonical,
    sourceEvidence: [...(removed.canonical.sourceEvidence || []), ...evidence],
  });
  return kept;
}
