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
function parseNotice(r, site) {
  const noticeId = String(r.zpggid);
  return baseRecord({
    id: "notice:" + noticeId,
    sourceId: id,
    siteId: site.siteId,
    scope: String(site.tenantId),
    kind: "recruitment_notice",
    title: r.zpggbt,
    url:
      site.origin +
      "/web/wsjysc/lbxq/getZpggxq?zpggid=" +
      encodeURIComponent(noticeId) +
      "&xxdm=" +
      encodeURIComponent(site.tenantId),
    cities: String(r.gzcs || "")
      .split(",")
      .filter(Boolean),
    description: description(r.zpggxq),
    publishedAt: explicitDate(r.fbsj),
    evidence: [{ field: "kind", sourceField: "getZpggPageList" }],
  });
}
function parse(r, site) {
  return baseRecord({
    id: r.zpgwid,
    sourceId: id,
    siteId: site.siteId,
    scope: String(site.tenantId),
    title: r.zwmc,
    url:
      site.origin +
      "/sub-station/jobDetails?xxdm=" +
      encodeURIComponent(site.tenantId) +
      "&zpgwid=" +
      encodeURIComponent(r.zpgwid),
    company: r.dwmc || null,
    cities: r.gzdd ? [r.gzdd] : [],
    description: description(r.zwms),
    degree: r.xlyq || null,
    publishedAt: explicitDate(r.fbsj),
    salary:
      typeof r.gzxz === "string"
        ? {
            raw: r.gzxz,
            min: null,
            max: null,
            currency: "CNY",
            unit: "unknown",
          }
        : null,
    extra: { sourceExpiry: r.zwsxrq || null, major: r.xqzy || null },
    evidence: [{ field: "description", sourceField: "zwms" }],
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
    const d = jsonResponse(await ctx.request(url.href, { signal: ctx.signal }));
    if (
      d.success !== true ||
      Number(d.code) !== 200 ||
      String(notice ? "notice:" + d.result?.zpggid : d.result?.zpgwid) !==
        r.sourceRecordId
    )
      throw Error("parse_error: 91job detail identity");
    return {
      ...r,
      ...(notice ? parseNotice(d.result, site) : parse(d.result, site)),
      detailStatus: "complete",
    };
  },
});

export default provider;
