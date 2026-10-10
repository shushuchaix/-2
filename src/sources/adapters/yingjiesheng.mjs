import { createPagedProvider, baseRecord } from "./shared.mjs";
import { noticeDocument } from "./official-announcements.mjs";
import { htmlToText } from "../../util/html.mjs";
import { explicitDate } from "../../util/html-elements.mjs";
import { canonicalizeSourceUrl } from "../../domain/identity.mjs";
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
    const document = noticeDocument(
      await ctx.request(url, { signal: ctx.signal }),
    );
    const records = [],
      seen = new Set();
    for (const a of document.querySelectorAll("table tr a[href]")) {
      const title = a.textContent.trim();
      if (!title || /首页|上一页|下一页|登录|注册/.test(title)) continue;
      let href;
      try {
        href = canonicalizeSourceUrl(new URL(a.getAttribute("href"), url).href);
      } catch {
        continue;
      }
      if (
        !/(?:^|\.)yingjiesheng\.com$/.test(new URL(href).hostname) ||
        seen.has(href)
      )
        continue;
      seen.add(href);
      const deadlineAt = explicitDate(a.closest("tr")?.textContent);
      records.push(
        baseRecord({
          id: href,
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
    const document = noticeDocument(
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
