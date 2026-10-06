import { createPagedProvider, jsonResponse, baseRecord } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { explicitDate } from "../../util/html-elements.mjs";
const id = "university-91job";
const description = (value) => {
  if (!value) return null;
  let data = value;
  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      return htmlToText(value);
    }
  }
  return htmlToText(
    typeof data === "object"
      ? Object.values(data)
          .filter((v) => typeof v === "string")
          .join("\n")
      : String(data),
  );
};
function parseNotice(r, site, previous = {}) {
  const noticeId = String(r.zpggid);
  const cities = String(r.gzcs || "")
    .split(",")
    .map((city) => city.trim())
    .filter(Boolean);
  return baseRecord({
    ...previous,
    id: "notice:" + noticeId,
    sourceId: id,
    siteId: site.siteId,
    scope: String(site.tenantId),
    kind: "recruitment_notice",
    title: String(r.zpggbt || "").trim() || previous.title,
    url:
      previous.url ||
      site.origin +
        "/web/wsjysc/lbxq/getZpggxq?zpggid=" +
        encodeURIComponent(noticeId) +
        "&xxdm=" +
        encodeURIComponent(site.tenantId),
    cities: cities.length ? cities : previous.cities || [],
    description: description(r.zpggxq) || previous.description || null,
    publishedAt: explicitDate(r.fbsj) || previous.publishedAt || null,
    evidence: [
      ...(previous.evidence || []),
      { field: "kind", sourceField: "getZpggPageList" },
    ],
  });
}
function parse(r, site, previous = {}) {
  const city = String(r.gzdd || "").trim();
  return baseRecord({
    ...previous,
    id: r.zpgwid,
    sourceId: id,
    siteId: site.siteId,
    scope: String(site.tenantId),
    title: String(r.zwmc || "").trim() || previous.title,
    url:
      previous.url ||
      site.origin +
        "/sub-station/jobDetails?xxdm=" +
        encodeURIComponent(site.tenantId) +
        "&zpgwid=" +
        encodeURIComponent(r.zpgwid),
    company: String(r.dwmc || "").trim() || previous.company || null,
    cities: city ? [city] : previous.cities || [],
    description: description(r.zwms) || previous.description || null,
    degree: String(r.xlyq || "").trim() || previous.degree || null,
    publishedAt: explicitDate(r.fbsj) || previous.publishedAt || null,
    salary:
      typeof r.gzxz === "string" && r.gzxz.trim()
        ? {
            raw: r.gzxz,
            min: null,
            max: null,
            currency: "CNY",
            unit: "unknown",
          }
        : previous.salary || null,
    extra: {
      ...previous.extra,
      sourceExpiry: r.zwsxrq || previous.extra?.sourceExpiry || null,
      major: r.xqzy || previous.extra?.major || null,
    },
    evidence: [
      ...(previous.evidence || []),
      { field: "description", sourceField: "zwms" },
    ],
  });
}
const provider = createPagedProvider({
  id,
  name: "91job 高校招聘",
  capabilities: {
    category: "university",
    jobTypes: ["campus", "internship", "unknown"],
    detail: true,
  },
  async listPage(site, query, page, ctx) {
    if (!/^\d{5}$/.test(String(site.tenantId)))
      throw Error("91job school code required");
    const body = {};
    for (const k of [
      "dwgm",
      "dwxz",
      "fbsj",
      "hylb",
      "jssj",
      "keyword",
      "kssj",
      "ssqy",
      "xlyq",
      "nxsx",
      "nxxx",
      "xqzy",
      "zwlb",
      "lmid",
      "sjly",
    ])
      body[k] = "";
    Object.assign(body, {
      current: page,
      size: 20,
      xxdm: String(site.tenantId),
      keyword: query.keyword || "",
    });
    const notice = query.kind === "recruitment_notice";
    const d = jsonResponse(
      await ctx.request(
        site.origin +
          "/web/wsjysc/lbxq/" +
          (notice ? "getZpggPageList" : "getZpgwPageList"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json;charset=utf-8" },
          body: JSON.stringify(body),
          signal: ctx.signal,
          maxRetries: 0,
          timeoutMs: 12000,
        },
      ),
    );
    if (d.success !== true || Number(d.code) !== 200) {
      const e = Error("91job business code " + d.code);
      e.code = Number(d.code) === 403 ? "restricted" : "parse_error";
      throw e;
    }
    if (!Array.isArray(d.result?.records)) {
      const e = Error("Missing 91job records");
      e.code = "parse_error";
      throw e;
    }
    const records = [],
      issues = [];
    for (const r of d.result.records) {
      if (
        !(notice ? r.zpggid : r.zpgwid) ||
        !(notice ? r.zpggbt : r.zwmc) ||
        (r.sqxxdm && String(r.sqxxdm) !== String(site.tenantId))
      ) {
        issues.push({
          code: "invalid_record",
          sourceId: id,
          siteId: site.siteId,
          message: "Missing identity or wrong school",
          retryable: false,
        });
        continue;
      }
      records.push(notice ? parseNotice(r, site) : parse(r, site));
    }
    return {
      records,
      issues,
      raw: d.result.records.length,
      hasMore: Number(d.result.pages || 0) > page,
    };
  },
  async detail(r, ctx) {
    const site = ctx.sites.find((s) => s.siteId === r.siteId);
    if (!site) throw Error("91job site not found");
    const notice = r.kind === "recruitment_notice";
    const url = new URL(
      site.origin + "/web/wsjysc/lbxq/" + (notice ? "getZpggxq" : "getZpgwxq"),
    );
    url.searchParams.set(
      notice ? "zpggid" : "zpgwid",
      notice ? r.sourceRecordId.slice(7) : r.sourceRecordId,
    );
    url.searchParams.set("xxdm", site.tenantId);
    const d = jsonResponse(
      await ctx.request(url.href, {
        signal: ctx.signal,
        maxRetries: 0,
        timeoutMs: 12000,
      }),
    );
    if (
      d.success !== true ||
      Number(d.code) !== 200 ||
      String(notice ? "notice:" + d.result?.zpggid : d.result?.zpgwid) !==
        r.sourceRecordId
    )
      throw Error("parse_error: 91job detail identity");
    return {
      ...r,
      ...(notice ? parseNotice(d.result, site, r) : parse(d.result, site, r)),
      detailStatus: "complete",
    };
  },
});

export default provider;
