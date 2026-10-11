import { createPagedProvider, baseRecord } from "./shared.mjs";
import { noticeDocument } from "./official-announcements.mjs";
import { htmlToText } from "../../util/html.mjs";
import { explicitDate } from "../../util/html-elements.mjs";
import { canonicalizeSourceUrl } from "../../domain/identity.mjs";
import { parseHTML } from "linkedom";

function campusDocument(response) {
  if (response.status === 200) {
    const { document } = parseHTML(response.text);
    const cookieReload = [...document.querySelectorAll("script")].some(
      (script) =>
        /\bacw_sc__v2\b/.test(script.textContent) &&
        /\bdocument\.cookie\b/.test(script.textContent) &&
        /\b(?:document\.)?location\.reload\s*\(/.test(script.textContent),
    );
    if (
      document.querySelector("textarea#renderData") &&
      document.querySelector('meta[name="aliyun_waf_aa"]') &&
      document.querySelector('meta[name="aliyun_waf_bb"]') &&
      cookieReload
    )
      throw Object.assign(
        Error("Public campus page requires JavaScript verification"),
        {
          code: "challenge_required",
          phase: "parse",
          requestId: response.requestId,
          retryable: false,
        },
      );
  }
  return noticeDocument(response);
}

export default createPagedProvider({
  id: "yingjiesheng",
  name: "应届生网申窗口",
  capabilities: {
    category: "campus_aggregator",
    jobTypes: ["campus"],
    kinds: ["company_campaign"],
    detail: true,
  },
  async listPage(site, query, page, ctx) {
    if (page > 1)
      return {
        records: [],
        hasMore: false,
        coverageScope: "limited",
        truncationReason: "listing_only",
      };
    const url = "https://www.yingjiesheng.com/deadline/";
    const document = campusDocument(
      await ctx.request(url, { signal: ctx.signal }),
    );
    const records = [],
      seen = new Set();
    for (const a of document.querySelectorAll("table tr a[href]")) {
      const title = a.textContent.trim();
      if (!title || /首页|上一页|下一页|登录|注册/.test(title)) continue;
      let candidate;
      try {
        candidate = new URL(a.getAttribute("href"), url);
      } catch {
        continue;
      }
      const nativeId = candidate.pathname.match(
        /^\/job-(\d{3}-\d{3}-\d{3})\.html$/,
      )?.[1];
      if (
        candidate.origin !== new URL(url).origin ||
        candidate.username ||
        candidate.password ||
        !nativeId ||
        seen.has(nativeId)
      )
        continue;
      const href = canonicalizeSourceUrl(new URL(candidate.pathname, url).href);
      seen.add(nativeId);
      const deadlineAt = explicitDate(a.closest("tr")?.textContent);
      records.push(
        baseRecord({
          id: nativeId,
          sourceRecordIdKind: "authority",
          urlKind: "notice_detail",
          sourceId: "yingjiesheng",
          siteId: site.siteId,
          scope: "deadline",
          kind: "company_campaign",
          title,
          url: href,
          jobType: "campus",
          deadlineAt,
          evidence: [
            {
              field: "deadlineAt",
              source: "visible_table_date",
              value: deadlineAt,
            },
          ],
        }),
      );
    }
    if (!records.length) {
      const e = Error("Campus deadline table missing");
      e.code = "parse_error";
      throw e;
    }
    return {
      records,
      hasMore: false,
      coverageScope: "limited",
      truncationReason: "listing_only",
    };
  },
  async detail(record, ctx) {
    const document = campusDocument(
      await ctx.request(record.url, { signal: ctx.signal }),
    );
    const node = document.querySelector(
      "#job_content, .job-content, .jobDetail, .content",
    );
    if (!node) {
      const e = Error("Public campus detail unavailable");
      e.code = "parse_error";
      throw e;
    }
    const description = htmlToText(node.innerHTML).trim();
    if (description.length < 30) throw Error("Campus detail insufficient");
    return { ...record, description, detailStatus: "complete" };
  },
});
