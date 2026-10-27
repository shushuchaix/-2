import { baseRecord } from "../adapters/shared.mjs";
const publicId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_~.-]{1,200}$/.test(value);
const value = (v, max = 300) =>
  typeof v === "string" ? v.trim().slice(0, max) : null;
export function bossPlatformEvidence({
  jobId,
  opening,
  entry,
  now = Date.now(),
}) {
  const fresh = (e) =>
    e?.jobId === jobId &&
    e.semanticVerified === true &&
    Number.isFinite(Date.parse(e.checkedAt)) &&
    Date.parse(e.checkedAt) <= now &&
    now - Date.parse(e.checkedAt) <= 72 * 3600000;
  const openingVerified = fresh(opening) && opening.value === "recruiting";
  const entryVerified =
    fresh(entry) &&
    entry.loggedIn === true &&
    entry.enabled === true &&
    ["apply", "communication"].includes(entry.kind);
  return {
    opening: {
      status: openingVerified ? "verified" : "unknown",
      ...(openingVerified
        ? { value: opening.value, checkedAt: opening.checkedAt }
        : {}),
    },
    entry: {
      kind: entryVerified ? entry.kind : "unknown",
      status: entryVerified ? "verified" : "unknown",
      ...(entryVerified ? { checkedAt: entry.checkedAt } : {}),
    },
    applicationStatus: "unknown",
    formVerified: false,
  };
}
export function mapBossJob(raw, { site, checkedAt }) {
  if (
    !publicId(raw?.encryptJobId) ||
    !value(raw.jobName) ||
    !value(raw.brandName)
  )
    throw Object.assign(Error("Boss岗位身份或字段无效。"), {
      code: "boss_record_invalid",
      retryable: false,
    });
  const id = raw.encryptJobId;
  const record = baseRecord({
    id,
    sourceId: "boss",
    siteId: site.siteId,
    sourceRecordIdKind: "authority",
    urlKind: "job_detail",
    title: value(raw.jobName),
    company: value(raw.brandName),
    url:
      "https://www.zhipin.com/job_detail/" + encodeURIComponent(id) + ".html",
    cities: value(raw.cityName) ? [value(raw.cityName)] : [],
    degree: value(raw.jobDegree),
    experience: value(raw.jobExperience),
    salary: value(raw.salaryDesc),
    jobType: raw.jobType === 4 ? "internship" : "unknown",
    retrievedAt: checkedAt,
    detailStatus: "pending",
    bodyStatus: "incomplete",
    retryEligible: true,
    parserVersion: "boss-public-1",
    platformEvidence: bossPlatformEvidence({
      jobId: id,
      now: Date.parse(checkedAt),
    }),
    applicationVerification: {
      status: "unknown",
      formVerified: false,
      checkedAt,
    },
  });
  const readRef = value(raw.securityId, 2048)
    ? {
        securityId: value(raw.securityId, 2048),
        lid: value(raw.lid, 256) || "",
      }
    : undefined;
  return { record, ...(readRef ? { readRef } : {}) };
}
