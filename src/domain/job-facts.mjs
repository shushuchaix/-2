import { createHash } from "node:crypto";
import { jobBusinessContent } from "./job-duplicates.mjs";
import { resolveJobId, jobIdMatches } from "./job-resolution.mjs";
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
export const jobFactHash = (record) => {
  const business = jobBusinessContent(record);
  delete business.account;
  delete business.platform;
  return "job-fact-v1:" + hash(stable(business));
};
const fields = (o) => o?.fields || o?.record || null;
const latest = (observations) =>
  observations.sort(
    (a, b) =>
      String(b.observedAt || "").localeCompare(String(a.observedAt || "")) ||
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
      return jobFactHash(r) === evaluation.factContentHash;
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
