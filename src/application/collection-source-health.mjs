import { assertScope } from "../domain/packages.mjs";
import { assessRecruitmentEvidence } from "../domain/recruitment-evidence.mjs";
import { assessSourceProbe } from "../sources/source-quality.mjs";
import {
  normalizeSourceStatus,
  safeSourceIssues,
  isVersionPrivateSource,
} from "../sources/source-status.mjs";
import { recordSourceHealth } from "./source-health.mjs";

const restrictedCodes = new Set([
  "restricted",
  "source_restricted",
  "captcha",
  "http_forbidden",
  "login_required",
  "challenge_required",
  "risk_blocked",
  "boss_account_risk",
  "boss_environment_risk",
  "boss_risk_blocked",
  "boss_auth_expired",
  "boss_login_required",
]);

// A successful list commit proves reading capability, independently of job eligibility.
export function deriveCollectionSourceHealth({
  sourceId,
  siteId,
  records = [],
  issues = [],
  now = Date.now(),
}) {
  const valid = records.filter(
    (r) => r?.title && r.url && (r.sourceRecordId || r.url),
  );
  const bodies = valid.filter(
    (record) => assessRecruitmentEvidence({ record, now }).bodyVerified,
  );
  const quality = assessSourceProbe({
    site: { providerId: sourceId, siteId },
    listSample: {
      status: issues.some((i) => restrictedCodes.has(i.code)) ? 403 : 200,
      records: valid,
    },
    detailSample: bodies,
    now,
  });
  const allIssues = safeSourceIssues(
    [...issues, ...quality.issues],
    sourceId,
    siteId,
  );
  const status = normalizeSourceStatus({
    status:
      quality.verification === "ready"
        ? "ready"
        : quality.verification === "restricted"
          ? "restricted"
          : valid.length
            ? "parse_error"
            : "empty",
    issues: allIssues,
  });
  return {
    sourceId,
    siteId,
    status,
    capabilities: {
      ...quality.capabilities,
      apply:
        quality.capabilities.body === "verified" &&
        bodies.some((record) => {
          const evidence = assessRecruitmentEvidence({ record, now });
          return (
            evidence.applicationStatus === "available" &&
            ["open", "unknown"].includes(evidence.openingStatus)
          );
        })
          ? "verified"
          : "unverified",
    },
    sampleCount: valid.length,
    issues: allIssues,
    checkedAt: quality.checkedAt,
  };
}

export function recordCollectionSourceHealth(
  workspace,
  { scope, provider, sourceId = provider?.id, siteId, records, issues, now },
) {
  let destination = workspace;
  if (
    isVersionPrivateSource({
      id: sourceId,
      capabilities: provider?.capabilities,
    })
  ) {
    const owner = assertScope(workspace, scope, now);
    owner.collectionSettings ||= {
      sourceOverrides: {},
      sessionRefs: {},
      refreshEnabled: false,
    };
    owner.collectionSettings.sourceVerification ||= {};
    destination = { sourceHealth: owner.collectionSettings.sourceVerification };
  }
  return recordSourceHealth(
    destination,
    deriveCollectionSourceHealth({ sourceId, siteId, records, issues, now }),
    now,
  );
}
