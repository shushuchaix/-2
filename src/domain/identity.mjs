import { createHash } from "node:crypto";
import {
  classifyJobDuplicate,
  canonicalizeSourceUrl,
  identityText,
  identityCities,
  jobBusinessFingerprint,
} from "./job-duplicates.mjs";
export { canonicalizeSourceUrl } from "./job-duplicates.mjs";
const sourceOf = (r) => r.sourceId || r.source || "unknown";
const scopeOf = (r) => r.identityScope || r.siteId || sourceOf(r);
export function resolveJobIdentity(record, { provenance = record } = {}) {
  const occurrenceKey = JSON.stringify([
    record.kind,
    identityText(record.company),
    identityText(record.title),
    identityCities(record),
    record.jobType,
    record.graduationYear || record.cohort || null,
    record.batch || record.recruitmentBatch || null,
    record.recruitmentYear ||
      String(record.publishedAt || "").slice(0, 4) ||
      null,
    record.level || null,
    record.degree || null,
    record.experience || null,
    record.requiredCertificates || [],
    record.workMode || record.employmentMode || null,
  ]);
  const occurrenceHash = createHash("sha256")
    .update(occurrenceKey)
    .digest("hex");
  const aliases = [
    "fields:" +
      JSON.stringify([
        identityText(record.company),
        identityText(record.title),
      ]),
    "content:" + jobBusinessFingerprint(record),
  ];
  let key =
      "input:" +
      JSON.stringify([
        sourceOf(record),
        scopeOf(record),
        record.url ? canonicalizeSourceUrl(record.url, record.urlPolicy) : null,
        jobBusinessFingerprint(record),
      ]),
    strength = "weak";
  if (
    provenance.sourceRecordIdKind === "authority" &&
    record.sourceRecordId != null &&
    String(record.sourceRecordId) !== ""
  ) {
    const authority =
      "id:" +
      JSON.stringify([
        sourceOf(record),
        scopeOf(record),
        String(record.sourceRecordId),
      ]);
    aliases.push(authority);
    key = authority + ":occurrence:" + occurrenceHash;
    strength = "strong";
  } else if (
    record.url &&
    ["job_detail", "job_apply", "notice_detail"].includes(provenance.urlKind)
  ) {
    key =
      "url:" +
      canonicalizeSourceUrl(record.url, record.urlPolicy) +
      ":occurrence:" +
      occurrenceHash;
    strength = "url";
  }
  if (record.url)
    aliases.push("url:" + canonicalizeSourceUrl(record.url, record.urlPolicy));
  return {
    key,
    strength,
    occurrenceKey,
    aliases: [...new Set([key, ...aliases])],
  };
}
export function relateJobs(left, right, options = {}) {
  const result = classifyJobDuplicate(left, right, options);
  return {
    relation: result.relation === "confirmed" ? "same" : result.relation,
    reasons: result.reasonCodes,
  };
}
