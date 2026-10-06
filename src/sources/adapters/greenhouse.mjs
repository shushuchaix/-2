import { baseRecord, createPagedProvider, jsonResponse } from "./shared.mjs";
import { htmlToText, decodeEntities } from "../../util/html.mjs";
const api = "https://boards-api.greenhouse.io/v1/boards/";
const date = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
function normalize(row, site, previous = {}) {
  const city = String(row.location?.name || "").trim();
  return baseRecord({
    ...previous,
    id: row.id,
    sourceId: "greenhouse",
    siteId: site.siteId,
    scope: site.tenantId,
    title: String(row.title || "").trim() || previous.title,
    company:
      String(row.company_name || "").trim() || previous.company || site.name,
    cities: city ? [city] : previous.cities || [],
    url: String(row.absolute_url || "").trim() || previous.url,
    description:
      htmlToText(decodeEntities(row.content || "")) ||
      previous.description ||
      null,
    publishedAt: date(row.first_published) || previous.publishedAt || null,
    deadlineAt: date(row.application_deadline) || previous.deadlineAt || null,
    evidence: [
      ...(previous.evidence || []),
      {
        field: "description",
        source: "documented public Job Board API content",
      },
      {
        field: "publishedAt",
        source: "first_published",
        value: row.first_published || null,
      },
    ],
  });
}
export default createPagedProvider({
  id: "greenhouse",
  name: "Greenhouse 企业官网",
  capabilities: {
    category: "employer",
    jobTypes: ["unknown"],
    kinds: ["job"],
    detail: true,
  },
  async listPage(site, query, page, ctx) {
    if (!site.tenantId) throw Error("Verified board tenant required");
    const data = jsonResponse(
      await ctx.request(
        api + encodeURIComponent(site.tenantId) + "/jobs?content=true",
        { signal: ctx.signal },
      ),
    );
    if (!Array.isArray(data.jobs)) {
      const e = Error("Greenhouse jobs missing");
      e.code = "parse_error";
      throw e;
    }
    const records = data.jobs
      .filter(
        (row) =>
          !query.keyword ||
          (row.title + " " + htmlToText(decodeEntities(row.content || "")))
            .toLowerCase()
            .includes(query.keyword.toLowerCase()),
      )
      .map((row) => normalize(row, site));
    return {
      records,
      raw: data.jobs.length,
      hasMore: false,
      issues: query.city
        ? [
            {
              code: "unsupported_filter",
              sourceId: "greenhouse",
              siteId: site.siteId,
              message:
                "City is not supported by this board API; geography must be checked from record evidence.",
              retryable: false,
            },
          ]
        : [],
    };
  },
  async detail(record, ctx) {
    const site = ctx.sites.find((s) => s.siteId === record.siteId);
    const row = jsonResponse(
      await ctx.request(
        api +
          encodeURIComponent(site.tenantId) +
          "/jobs/" +
          encodeURIComponent(record.sourceRecordId) +
          "?content=true",
        { signal: ctx.signal },
      ),
    );
    if (String(row.id) !== record.sourceRecordId)
      throw Error("Greenhouse detail identity mismatch");
    return {
      ...record,
      ...normalize(row, site, record),
      detailStatus: "complete",
    };
  },
});
