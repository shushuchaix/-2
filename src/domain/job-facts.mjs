import { createHash } from "node:crypto";
import { jobBusinessContent } from "./job-duplicates.mjs";
import { resolveJobId, jobIdMatches } from "./job-resolution.mjs";
import { packageError } from "./packages.mjs";
const hash = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
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
export const legacyJobFactHash = (record) => {
  const business = Object.fromEntries(
    [
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
      "requirements",
      "description",
      "publishedAt",
      "deadlineAt",
      "salary",
    ].map((k) => [k, record[k] ?? null]),
  );
  delete business.account;
  delete business.platform;
  return "job-fact-v1:" + hash(stable(business));
};
export const jobFactHash = (record) => {
  if (
    !record.conditions &&
    !record.sourceEvidence &&
    !record.applicationVerification &&
    !record.recruitmentEvidence &&
    !record.major &&
    !record.contractType
  )
    return legacyJobFactHash(record);
  const business = jobBusinessContent(record);
  delete business.account;
  delete business.platform;
  return (
    "job-fact-v2:" +
    hash(
      stable({
        ...business,
        applyUrl: record.applyUrl || null,
        longTermRecruiting: record.longTermRecruiting === true,
        conditions: record.conditions || [],
        sourceEvidence: (record.sourceEvidence || []).map(
          ({ observedAt, ...e }) => e,
        ),
        evidenceConflicts: record.evidenceConflicts || [],
        bodyStatus: record.bodyStatus || record.detailStatus || null,
        bodyIncomplete: record.bodyIncomplete === true,
        applicationVerification: record.applicationVerification
          ? {
              status: record.applicationVerification.status,
              formVerified: record.applicationVerification.formVerified,
              challenge: record.applicationVerification.challenge,
            }
          : null,
      }),
    )
  );
};
const fields = (o) => o?.fields || o?.record || null;
const latest = (observations) =>
  observations.sort(
    (a, b) =>
      String(b.observedAt || "").localeCompare(String(a.observedAt || "")) ||
      (b.factRevision || 0) - (a.factRevision || 0) ||
      b.observationId.localeCompare(a.observationId),
  )[0];
function refreshMember(w, member) {
  const observations = member.factRefs
    .map((r) => w.observations[r.observationId])
    .filter((o) => fields(o));
  const current = latest(observations);
  member.currentObservationId = current?.observationId || null;
  member.factContentHash = current ? jobFactHash(fields(current)) : null;
  const times = observations
    .map((o) => o.observedAt)
    .filter(Boolean)
    .sort();
  member.firstSeen = times[0] || member.firstSeen || null;
  member.lastSeen = times.at(-1) || member.lastSeen || null;
}
export function addTargetMemberFact(
  w,
  { targetRevisionId, jobId, observationId, provenanceOperationId = null },
) {
  const target = Object.values(w.targets)
    .flat()
    .find((t) => t.revisionId === targetRevisionId);
  if (!target)
    throw Object.assign(Error("Target revision not found"), { status: 400 });
  jobId = resolveJobId(w, jobId);
  if (w.schemaVersion === 3) {
    const owner = w.jobs[jobId]?.ownerPackageId || w._scope?.packageId;
    if (
      owner !== target.ownerPackageId ||
      (observationId &&
        (w.observations[observationId]?.ownerPackageId ||
          w._scope?.packageId) !== owner)
    )
      throw packageError(
        "package_scope_mismatch",
        "岗位事实只能归入自有目标包。",
      );
  }
  w.targetMembers ||= {};
  const members = (w.targetMembers[targetRevisionId] ||= {});
  const member = (members[jobId] ||= {
    factRefs: [],
    currentObservationId: null,
    factContentHash: null,
  });
  if (
    observationId &&
    !member.factRefs.some((r) => r.observationId === observationId)
  )
    member.factRefs.push({ observationId, provenanceOperationId });
  refreshMember(w, member);
  return member;
}
export function resolveEvaluationFactBasis(w, evaluation) {
  const observations = Object.values(w.observations).filter(
    (o) =>
      jobIdMatches(w, o.jobId, evaluation.jobId) &&
      fields(o) &&
      (!evaluation.observationId ||
        o.observationId === evaluation.observationId),
  );
  const matches = observations.filter((o) => {
    const r = fields(o);
    if (evaluation.factContentHash)
      return (
        jobFactHash(r) === evaluation.factContentHash ||
        (evaluation.factContentHash.startsWith("job-fact-v1:") &&
          legacyJobFactHash(r) === evaluation.factContentHash)
      );
    if (!evaluation.jdHash) return false;
    return [
      hash({ ...r, jobId: evaluation.jobId, retrievedAt: undefined }),
      hash({ ...r, retrievedAt: undefined }),
      hash(r.description || ""),
    ].includes(evaluation.jdHash);
  });
  if (!matches.length)
    return {
      status: "historical",
      factContentHash: null,
      observationIds: [],
      reasonCode: "unverified_fact_basis",
    };
  const hashes = [...new Set(matches.map((o) => jobFactHash(fields(o))))];
  if (hashes.length !== 1)
    return {
      status: "historical",
      factContentHash: null,
      observationIds: [],
      reasonCode: "ambiguous_fact_basis",
    };
  return {
    status: "verified",
    factContentHash: hashes[0],
    observationIds: matches.map((o) => o.observationId),
    reasonCode: "verified_observation",
  };
}
export function backfillTargetMembers(w) {
  const before = JSON.stringify(w.targetMembers || {});
  w.targetMembers ||= {};
  const targets = new Set(
    Object.values(w.targets)
      .flat()
      .map((t) => t.revisionId),
  );
  for (const o of Object.values(w.observations)) {
    const targetRevisionId =
      o.targetRevisionId || w.runs[o.runId]?.targetSnapshot?.revisionId;
    const jobId = resolveJobId(w, o.jobId, { allowMissing: true });
    if (jobId && targets.has(targetRevisionId) && fields(o))
      addTargetMemberFact(w, {
        targetRevisionId,
        jobId,
        observationId: o.observationId,
        provenanceOperationId: o.provenanceOperationId,
      });
  }
  for (const e of Object.values(w.evaluations)) {
    if (!targets.has(e.targetRevisionId)) continue;
    const jobId = resolveJobId(w, e.jobId, { allowMissing: true });
    if (!jobId) continue;
    const basis = resolveEvaluationFactBasis(w, e);
    if (basis.status === "verified")
      for (const observationId of basis.observationIds)
        addTargetMemberFact(w, {
          targetRevisionId: e.targetRevisionId,
          jobId,
          observationId,
        });
    else
      addTargetMemberFact(w, { targetRevisionId: e.targetRevisionId, jobId });
  }
  for (const members of Object.values(w.targetMembers))
    for (const member of Object.values(members)) refreshMember(w, member);
  const assigned = new Set(
    Object.values(w.targetMembers).flatMap((m) => Object.keys(m)),
  ).size;
  const changed =
    w.membershipVersion !== 1 || before !== JSON.stringify(w.targetMembers);
  w.membershipVersion = 1;
  return {
    changed,
    assigned,
    unassigned: Object.keys(w.jobs).length - assigned,
  };
}
export function selectVersionJobFact(w, { targetRevisionId, jobId }) {
  jobId = resolveJobId(w, jobId);
  let observations;
  if (targetRevisionId) {
    const member = w.targetMembers?.[targetRevisionId]?.[jobId];
    if (!member)
      return {
        status: "not_member",
        record: null,
        factContentHash: null,
        observationIds: [],
        originalJobId: null,
      };
    observations = member.factRefs
      .map((r) => w.observations[r.observationId])
      .filter((o) => fields(o));
  } else
    observations = Object.values(w.observations).filter(
      (o) => jobIdMatches(w, o.jobId, jobId) && fields(o),
    );
  const current = latest(observations);
  if (!current)
    return {
      status: "missing",
      record: null,
      factContentHash: null,
      observationIds: [],
      originalJobId: null,
    };
  const record = structuredClone(fields(current)),
    factContentHash = jobFactHash(record);
  return {
    status: "verified",
    record,
    factContentHash,
    observationIds: observations
      .filter((o) => jobFactHash(fields(o)) === factContentHash)
      .map((o) => o.observationId),
    originalJobId: current.jobId,
  };
}
export function selectRunJobFact(w, { runId, jobId }) {
  jobId = resolveJobId(w, jobId);
  const observation = latest(
    Object.values(w.observations).filter(
      (o) => o.runId === runId && jobIdMatches(w, o.jobId, jobId) && fields(o),
    ),
  );
  if (!observation)
    return {
      status: "missing",
      record: null,
      factContentHash: null,
      observationIds: [],
      originalJobId: null,
    };
  const record = structuredClone(fields(observation));
  return {
    status: "verified",
    record,
    factContentHash: jobFactHash(record),
    observationIds: [observation.observationId],
    originalJobId: observation.jobId,
  };
}
export function selectMatchingEvaluation(
  w,
  { jobId, targetRevisionId, profileRevisionId, factContentHash },
) {
  if (!factContentHash) return null;
  return (
    Object.values(w.evaluations)
      .filter(
        (e) =>
          jobIdMatches(w, e.jobId, jobId) &&
          (!targetRevisionId || e.targetRevisionId === targetRevisionId) &&
          (!profileRevisionId || e.profileRevisionId === profileRevisionId) &&
          resolveEvaluationFactBasis(w, e).factContentHash === factContentHash,
      )
      .sort(
        (a, b) =>
          String(b.createdAt || "").localeCompare(String(a.createdAt || "")) ||
          b.evaluationId.localeCompare(a.evaluationId),
      )[0] || null
  );
}
