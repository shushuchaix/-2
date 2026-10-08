import { createPagedProvider, jsonResponse, baseRecord } from "./shared.mjs";
import { elementText } from "../../util/html-elements.mjs";
const id = "ncss";
export default createPagedProvider({
  id,
  name: "国家大学生就业服务平台",
  capabilities: {
    category: "national",
    jobTypes: ["campus", "internship", "social", "unknown"],
    detail: true,
  },
  async listPage(site, query, page, ctx) {
    const url = new URL("https://www.ncss.cn/student/jobs/jobslist/ajax/");
    for (const k of [
      "jobType",
      "areaCode",
      "jobName",
      "monthPay",
      "industrySectors",
      "property",
      "categoryCode",
      "memberLevel",
      "recruitType",
      "keyUnits",
      "degreeCode",
      "sourcesName",
      "sourcesType",
    ])
      url.searchParams.set(k, k === "jobName" ? query.keyword || "" : "");
    url.searchParams.set("offset", String(page));
    url.searchParams.set("limit", "20");
    const response = await ctx.request(url.href, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://www.ncss.cn/student/jobs/index.html",
      },
      signal: ctx.signal,
    });
    const d = jsonResponse(response);
    if (d?.flag !== true || !Array.isArray(d.data?.list)) {
      const e = Error("parse_error: NCSS list contract");
      e.code = "parse_error";
      e.phase = "parse";
      e.requestId = response.requestId;
      e.parser = {
        format: "json",
        version: "ncss-1",
        resultType: d === null ? "null" : Array.isArray(d) ? "array" : typeof d,
        missingFields: !d?.data ? ["data"] : ["list"],
      };
      throw e;
    }
    const records = [],
      issues = [];
    for (const r of d.data.list) {
      if (
        !r.jobId ||
        !r.jobName ||
        !["0", "1"].includes(String(r.recruitType))
      ) {
        issues.push({
          code: "invalid_record",
          sourceId: id,
          siteId: site.siteId,
          message: "Missing NCSS identity/kind",
          retryable: false,
        });
        continue;
      }
      records.push(
        baseRecord({
          id: r.jobId,
          sourceRecordIdKind: "authority",
          urlKind:
            String(r.recruitType) === "1" ? "notice_detail" : "job_detail",
          sourceId: id,
          siteId: site.siteId,
          scope: "national",
          title: r.jobName,
          url:
            "https://www.ncss.cn/student/jobs/" +
            encodeURIComponent(r.jobId) +
            "/detail.html",
          kind: String(r.recruitType) === "1" ? "recruitment_notice" : "job",
          company: r.recName || null,
          cities: r.areaCodeName ? [r.areaCodeName] : [],
          degree: r.degreeName || null,
          jobType: /校园|校招|应届/.test(r.jobName) ? "campus" : "unknown",
          publishedAt: Number.isFinite(r.publishDate)
            ? new Date(r.publishDate).toISOString()
            : null,
          evidence: [
            { field: "kind", value: r.recruitType, sourceField: "recruitType" },
          ],
        }),
      );
    }
    return {
      records,
      issues,
      raw: d.data.list.length,
      hasMore:
        d.data.list.length >= 20 &&
        Number(d.data.pagenation?.count || 0) > page * 20,
    };
  },
  async detail(r, ctx) {
    const response = await ctx.request(r.url, { signal: ctx.signal });
    if (response.status !== 200)
      throw Error("NCSS detail HTTP " + response.status);
    const candidates = [".mainContent", ".jobdetail-box"].map((selector) => ({
      selector,
      text: elementText(response.text, selector),
    }));
    const title = String(r.title || "").replace(/\s+/g, "");
    const body = candidates.find(
      (candidate) =>
        candidate.text?.length >= 30 &&
        candidate.text.replace(/\s+/g, "") !== title,
    );
    if (!body) {
      const insufficient = candidates.some(
        (candidate) => candidate.text !== null,
      );
      const error = Error(
        insufficient
          ? "NCSS source body provides insufficient requirements"
          : "parse_error: missing NCSS requirements",
      );
      error.code = insufficient ? "detail_insufficient" : "parse_error";
      error.phase = "parse";
      error.requestId = response.requestId;
      error.parser = {
        format: "html",
        version: "ncss-1",
        documentLength: response.text.length,
        selectorPresent: insufficient,
        titleOnly: candidates.some(
          (candidate) =>
            candidate.text && candidate.text.replace(/\s+/g, "") === title,
        ),
        textLength: Math.max(
          0,
          ...candidates.map((candidate) => candidate.text?.length || 0),
        ),
        missingFields: ["description"],
      };
      if (insufficient) error.retryable = false;
      throw error;
    }
    return {
      ...r,
      description: body.text,
      detailStatus: "complete",
      evidence: [
        ...r.evidence,
        { field: "description", url: r.url, selector: body.selector },
      ],
    };
  },
});
