import { baseRecord, createPagedProvider, jsonResponse } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
const api = "https://api.smartrecruiters.com/v1/companies/";
const date = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
function detailUrl(value, tenant, id) {
  const expected =
    api + encodeURIComponent(tenant) + "/postings/" + encodeURIComponent(id);
  if (value && new URL(value).href !== expected)
    throw Error("SmartRecruiters detail tenant mismatch");
  return expected;
}
function normalize(row, site) {
  if (row.company?.identifier && row.company.identifier !== site.tenantId)
    throw Error("SmartRecruiters company mismatch");
  const sections = row.jobAd?.sections || {};
  return baseRecord({
    id: row.id,
    sourceId: "smartrecruiters",
    siteId: site.siteId,
    scope: site.tenantId,
    title: row.name,
    company: row.company?.name || site.name,
    cities: row.location?.city ? [row.location.city] : [],
    url:
      row.applyUrl ||
      "https://jobs.smartrecruiters.com/" +
        encodeURIComponent(site.tenantId) +
        "/" +
        encodeURIComponent(row.id),
    applyUrl: row.applyUrl || null,
    description:
      Object.values(sections)
        .map((s) => htmlToText(s.text || ""))
        .filter(Boolean)
        .join("\n") || null,
    publishedAt: date(row.releasedDate),
    jobType: /intern/i.test(
      row.typeOfEmployment?.label || row.experienceLevel?.label || "",
    )
      ? "internship"
      : "unknown",
    _detailUrl: detailUrl(row.ref, site.tenantId, row.id),
    evidence: [
      {
        field: "publishedAt",
        source: "releasedDate",
        value: row.releasedDate || null,
      },
    ],
  });
}
export default createPagedProvider({
  id: "smartrecruiters",
  name: "SmartRecruiters 企业官网",
  capabilities: {
    category: "employer",
    jobTypes: ["internship", "social", "unknown"],
    kinds: ["job"],
    detail: true,
  },
  async listPage(site, query, page, ctx) {
    if (!site.tenantId) throw Error("Verified company tenant required");
    const params = new URLSearchParams({
      limit: "20",
      offset: String((page - 1) * 20),
    });
    if (query.keyword) params.set("q", query.keyword);
    if (query.city) params.set("city", query.city);
    if (site.country) params.set("country", site.country);
    const data = jsonResponse(
      await ctx.request(
        api + encodeURIComponent(site.tenantId) + "/postings?" + params,
        { signal: ctx.signal },
      ),
    );
    if (!Array.isArray(data.content)) {
      const e = Error("SmartRecruiters content missing");
      e.code = "parse_error";
      throw e;
    }
    return {
      records: data.content.map((r) => normalize(r, site)),
      hasMore: Number(data.totalFound) > page * 20,
    };
  },
  async detail(record, ctx) {
    const site = ctx.sites.find((s) => s.siteId === record.siteId);
    const row = jsonResponse(
      await ctx.request(
        detailUrl(record._detailUrl, site.tenantId, record.sourceRecordId),
        { signal: ctx.signal },
      ),
    );
    if (String(row.id) !== record.sourceRecordId)
      throw Error("SmartRecruiters detail identity mismatch");
    return { ...record, ...normalize(row, site), detailStatus: "complete" };
  },
});
