import {
  selectVersionJobFact,
  selectMatchingEvaluation,
} from "./job-facts.mjs";
import {
  assessRecruitmentEvidence,
  isVerifiedRecommendation,
} from "./recruitment-evidence.mjs";
import { classifyJobDuplicate } from "./job-duplicates.mjs";
import { resolveJobIds } from "./job-resolution.mjs";

/** Counts overlap; unverified request upper bounds never enter the measured denominator. */
export function projectCollectionQuality(
  workspace,
  { root, now = Date.now() },
) {
  const targetRevisionId = root.targetSnapshot.revisionId;
  const facts = resolveJobIds(
    workspace,
    root.collectionProgress.newJobIds || [],
    { allowMissing: true },
  ).flatMap((jobId) => {
    if (
      !workspace.jobs[jobId] ||
      (workspace.schemaVersion === 3 &&
        workspace.jobs[jobId].ownerPackageId !== root.ownerPackageId)
    )
      return [];
    const fact = selectVersionJobFact(workspace, { jobId, targetRevisionId });
    return fact.status === "verified" ? [{ jobId, ...fact }] : [];
  });
  const q = {
    uniqueRecords: facts.length,
    bodyVerified: 0,
    open: 0,
    applicationAvailable: 0,
    qualificationPass: 0,
    qualificationUnknown: 0,
    qualificationFail: 0,
    historicalOrExpired: 0,
    suspectedDuplicates: 0,
    validNewUnique: 0,
    knownRequests: root.collectionUsage?.knownPhysicalRequests || 0,
    unknownRequestUpperBound:
      root.collectionUsage?.unknownRequestUpperBound || 0,
    validPer100KnownRequests: null,
  };
  const suspects = new Set();
  for (const [i, fact] of facts.entries()) {
    const evidence = assessRecruitmentEvidence({ record: fact.record, now });
    const evaluation = root.profileSnapshot?.revisionId
      ? selectMatchingEvaluation(workspace, {
          jobId: fact.jobId,
          targetRevisionId,
          profileRevisionId: root.profileSnapshot.revisionId,
          factContentHash: fact.factContentHash,
        })
      : null;
    if (evidence.bodyVerified) q.bodyVerified++;
    if (evidence.openingStatus === "open") q.open++;
    if (evidence.applicationStatus === "available") q.applicationAvailable++;
    if (["historical", "closed", "expired"].includes(evidence.openingStatus))
      q.historicalOrExpired++;
    const status = evaluation?.qualification?.status;
    q[
      status === "pass"
        ? "qualificationPass"
        : status === "fail"
          ? "qualificationFail"
          : "qualificationUnknown"
    ]++;
    if (
      isVerifiedRecommendation({
        qualification: evaluation?.qualification,
        evidence,
      })
    )
      q.validNewUnique++;
    for (const other of facts.slice(i + 1)) {
      if (
        classifyJobDuplicate(fact.record, other.record).relation === "possible"
      ) {
        suspects.add(fact.jobId);
        suspects.add(other.jobId);
      }
    }
  }
  q.suspectedDuplicates = suspects.size;
  q.validPer100KnownRequests =
    q.knownRequests > 0 ? (q.validNewUnique * 100) / q.knownRequests : null;
  return q;
}
