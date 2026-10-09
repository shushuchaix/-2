const checked = (now) => new Date(now).toISOString();
export function hasRecentSourceProof(site, health, now = Date.now()) {
  const success = health?.lastSuccessAt || site.verifiedAt;
  const body =
    site.probeEvidence?.some((e) => e.hasRequirements === true) ||
    health?.capabilities?.body === "verified";
  return Boolean(
    body &&
      Number.isFinite(Date.parse(success)) &&
      Date.parse(success) <= Number(now) + 300000 &&
      Number(now) - Date.parse(success) <= 30 * 86400000 &&
      (site.status === "ready" ||
        health?.status === "ready" ||
        health?.lastSuccessAt),
  );
}
export function assessSourceProbe({
  site,
  listSample,
  detailSample = [],
  now = Date.now(),
}) {
  const records = listSample?.records || [],
    details = Array.isArray(detailSample) ? detailSample : [detailSample];
  const blocked =
    [401, 403].includes(listSample?.status) ||
    ["restricted", "captcha", "login_required", "challenge_required"].includes(
      listSample?.code,
    );
  const valid = records.filter(
    (r) => r.title && r.url && (r.sourceRecordId || r.url),
  );
  const bodies = details.filter(
    (r) =>
      r &&
      typeof r.description === "string" &&
      r.description.trim().length >= 30 &&
      !["discovery_only", "incomplete", "restricted"].includes(r.detailStatus),
  );
  const list = valid.length > 0 && listSample.status === 200,
    body = list && bodies.length > 0;
  const capabilities = {
    list: list ? "verified" : "unverified",
    body: body ? "verified" : "unverified",
    date: bodies.some((r) => r.publishedAt || r.deadlineAt)
      ? "verified"
      : "unverified",
    attachments: bodies.some((r) =>
      r.attachments?.some((a) => a.textStatus === "extracted"),
    )
      ? "verified"
      : "unverified",
    apply: bodies.some(
      (r) => r.applyUrl && r.evidence?.some((e) => e.field === "applyUrl"),
    )
      ? "verified"
      : "unverified",
  };
  const at = checked(now),
    evidence = Object.fromEntries(
      Object.entries(capabilities).map(([key, status]) => [
        key,
        {
          status,
          lastSuccessAt: status === "verified" ? at : null,
          checkedAt: at,
        },
      ]),
    );
  return {
    sourceId: site.providerId,
    siteId: site.siteId,
    capabilities,
    evidence,
    verification: blocked ? "restricted" : body ? "ready" : "candidate",
    issues: blocked
      ? [{ code: "source_restricted" }]
      : body
        ? []
        : [{ code: records.length ? "body_unverified" : "list_unverified" }],
    checkedAt: at,
  };
}
export function sourceRefreshDelay({
  changes = 0,
  total = 0,
  failed = false,
  previousMs = 86400000,
} = {}) {
  if (failed) return Math.min(7 * 86400000, Math.max(3600000, previousMs * 2));
  const rate = total > 0 ? changes / total : 0;
  return Math.max(
    3600000,
    Math.min(
      7 * 86400000,
      rate > 0.25
        ? previousMs * 0.5
        : rate === 0
          ? previousMs * 1.5
          : previousMs,
    ),
  );
}
