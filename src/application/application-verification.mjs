import {
  prepareApplicationCheck,
  assessApplicationResponse,
} from "../domain/recruitment-evidence.mjs";
import { assessInlineOfficialApplication } from "../sources/adapters/inline-official-jobs.mjs";

const normalized = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();
export function prepareOwnedApplicationCheck(record, sites, now) {
  const site = sites.find(
    (s) =>
      s.providerId === "official-announcements" &&
      s.siteId === record.siteId &&
      record.sourceId === s.providerId &&
      s.template?.inlineJob === true &&
      s.template.nativeIdAttribute === "href",
  );
  const binding = record.applicationVerification?.nativeJobBinding;
  const bound = site
    ? Boolean(
        binding?.contract === "inline-native-job-1" &&
          record.kind === "job" &&
          record.sourceRecordIdKind === "authority" &&
          record.identityScope === site.siteId &&
          record.url === record.applyUrl &&
          binding.siteId === site.siteId &&
          binding.sourceRecordId === record.sourceRecordId &&
          binding.title === normalized(record.title) &&
          binding.applyUrl === record.applyUrl,
      )
    : !binding;
  const preparedRecord = bound
    ? record
    : { ...record, applicationVerification: undefined };
  const check = prepareApplicationCheck(preparedRecord, now);
  return {
    record: preparedRecord,
    site,
    check: binding && !site ? { ...check, shouldRequest: false } : check,
  };
}
export function hasCurrentApplicationCheck(record, runId, now) {
  const verification = record.applicationVerification || {},
    checkedAt = Date.parse(verification.checkedAt);
  return Boolean(
    typeof runId === "string" &&
      runId &&
      verification.checkedInRunId === runId &&
      verification.checkedUrl === record.applyUrl &&
      Number.isFinite(checkedAt) &&
      checkedAt <= now &&
      now - checkedAt <= 72 * 3600000 &&
      [200, 401, 403, 404, 410, "login_required"].includes(verification.status),
  );
}
export function assessOwnedApplicationResponse(
  site,
  record,
  response,
  checkedAt,
  runId,
) {
  return {
    ...(site
      ? assessInlineOfficialApplication(site, record, response, checkedAt)
      : assessApplicationResponse(response, checkedAt)),
    checkedUrl: record.applyUrl,
    ...(typeof runId === "string" && runId ? { checkedInRunId: runId } : {}),
  };
}
