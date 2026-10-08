import { baseRecord, createPagedProvider, jsonResponse } from "./shared.mjs";
const api = "https://careers.tencent.com/tencentcareer/api/post/";
function payload(response) {
  const body = jsonResponse(response);
  if (body.Code !== 200 || !body.Data) {
    const error = Error("Tencent business response " + body.Code);
    error.code = body.Code === 403 ? "restricted" : "parse_error";
    throw error;
  }
  return body.Data;
}
function normalize(row, site) {
  return baseRecord({
    id: row.PostId,
    sourceRecordIdKind: "authority",
    urlKind: "job_detail",
    sourceId: "tencent",
    siteId: site.siteId,
    scope: "tencent-social",
    title: row.RecruitPostName,
    company: "腾讯",
    jobType: "social",
    cities: row.LocationName ? [row.LocationName] : [],
    url:
      "https://careers.tencent.com/jobdesc.html?postId=" +
      encodeURIComponent(row.PostId),
    description:
      [row.Responsibility, row.Requirement].filter(Boolean).join("\n") || null,
    publishedAt: null,
    evidence: [
      { field: "jobType", source: "Tencent public social recruitment API" },
      {
        field: "publishedAt",
        source: "LastUpdateTime is not publication time",
        value: null,
      },
    ],
  });
}
export default createPagedProvider({
  id: "tencent",
  name: "腾讯官方社招",
  capabilities: {
    category: "employer",
    jobTypes: ["social"],
    kinds: ["job"],
    detail: true,
  },
  async listPage(site, query, page, ctx) {
    const params = new URLSearchParams({
      keyword: query.keyword || "",
      pageIndex: String(page),
      pageSize: "20",
      language: "zh-cn",
    });
    const data = payload(
      await ctx.request(api + "Query?" + params, { signal: ctx.signal }),
    );
    const posts = data.Count === 0 && data.Posts === null ? [] : data.Posts;
    if (!Array.isArray(posts)) {
      const e = Error("Tencent Posts missing");
      e.code = "parse_error";
      throw e;
    }
    return {
      records: posts.map((row) => normalize(row, site)),
      hasMore: Number(data.Count) > page * 20,
    };
  },
  async detail(record, ctx) {
    const row = payload(
      await ctx.request(
        api +
          "ByPostId?" +
          new URLSearchParams({
            postId: record.sourceRecordId,
            language: "zh-cn",
          }),
        { signal: ctx.signal },
      ),
    );
    if (String(row.PostId) !== record.sourceRecordId)
      throw Error("Tencent detail identity mismatch");
    return {
      ...record,
      description: [row.Responsibility, row.Requirement]
        .filter(Boolean)
        .join("\n"),
      detailStatus: "complete",
      evidence: [
        ...record.evidence,
        {
          field: "description",
          url: api + "ByPostId?postId=" + record.sourceRecordId,
        },
      ],
    };
  },
});
