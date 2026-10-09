import { parseHTML } from "linkedom";
import { createPagedProvider, baseRecord } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { explicitDate } from "../../util/html-elements.mjs";
import { canonicalizeSourceUrl } from "../../domain/identity.mjs";
import { validatePublicUrl } from "../../infrastructure/http/public-url.mjs";
import { readJobPostingEvidence } from "../../domain/recruitment-evidence.mjs";
function listLocation(site, value) {
  const url = validatePublicUrl(value),
    base = new URL(site.template.listUrl);
  const prefix =
    site.template.paginationPathPrefix ||
    base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
  if (
    url.origin !== base.origin ||
    url.origin !== new URL(site.origin).origin ||
    !url.pathname.startsWith(prefix)
  )
    throw Object.assign(Error("公告分页链接不属于允许的招聘栏目。"), {
      code: "pagination_scope",
    });
  return url.href;
}
export function noticeDocument(response) {
  if ([401, 403].includes(response.status)) {
    const e = Error("HTTP forbidden");
    e.code = "restricted";
    throw e;
  }
  if (response.status !== 200) throw Error("HTTP " + response.status);
  if (
    /人机验证|访问过于频繁|<title>[^<]*(?:captcha|验证码|安全验证)/i.test(
      response.text.slice(0, 2000),
    )
  ) {
    const e = Error("captcha");
    e.code = "captcha";
    throw e;
  }
  const { document } = parseHTML(response.text);
  for (const node of document.querySelectorAll("script,style,nav"))
    node.remove();
  return document;
}
const recruiting = /招聘|招募|岗位|人才引进|聘用|选聘/;
export default createPagedProvider({
  id: "official-announcements",
  name: "官方招聘公告",
  capabilities: {
    category: "public",
    jobTypes: ["campus", "social", "unknown"],
    kinds: ["recruitment_notice"],
    detail: true,
    attachments: true,
  },
  async listPage(site, query, page, ctx) {
    const template = site.template;
    const paginated =
      template?.paginationVerified === true && !!template.nextPageRule;
    if (page > 1 && !paginated)
      return {
        records: [],
        hasMore: false,
        coverageScope: "limited",
        truncationReason: "listing_only",
      };
    if (!template?.listUrl || !template.linkRule || !template.bodyRule) {
      const e = Error("Verified notice template required");
      e.code = "parse_error";
      throw e;
    }
    const listUrl = listLocation(site, ctx.cursor?.url || template.listUrl);
    const document = noticeDocument(
      await ctx.request(listUrl, { signal: ctx.signal }),
    );
    const records = [],
      seen = new Set();
    for (const anchor of document.querySelectorAll(template.linkRule)) {
      let title = (anchor.getAttribute("title") || anchor.textContent)
        .replace(/\s+/g, " ")
        .trim();
      if (
        !recruiting.test(title) ||
        /平台宣传|工作动态|会议纪要|招聘工作总结/.test(title)
      )
        continue;
      const raw = anchor.getAttribute("href");
      if (!raw) continue;
      let url;
      try {
        url = canonicalizeSourceUrl(new URL(raw, listUrl).href);
      } catch {
        continue;
      }
      const parsed = new URL(url);
      if (
        parsed.origin !== new URL(site.origin).origin ||
        (template.pathPrefix &&
          !parsed.pathname.startsWith(template.pathPrefix)) ||
        seen.has(url)
      )
        continue;
      seen.add(url);
      const row =
        anchor.closest("li") || anchor.closest(".row") || anchor.parentElement;
      const publishedAt = explicitDate(row?.textContent);
      title = title
        .replace(/(?:20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}日?)/g, "")
        .trim();
      records.push(
        baseRecord({
          id: url,
          sourceId: "official-announcements",
          siteId: site.siteId,
          scope: site.siteId,
          kind: "recruitment_notice",
          title,
          url,
          company: site.name,
          jobType: /校园|应届/.test(title) ? "campus" : "unknown",
          publishedAt,
          evidence: [
            {
              field: "title",
              url: listUrl,
              selector: template.linkRule,
            },
            {
              field: "publishedAt",
              source: "visible_list_date",
              value: publishedAt,
            },
          ],
        }),
      );
    }
    if (
      !document.querySelector(template.linkRule) &&
      !(template.emptyRule && document.querySelector(template.emptyRule))
    ) {
      const e = Error("Notice list selector missing");
      e.code = "parse_error";
      throw e;
    }
    let nextCursor = null;
    if (paginated) {
      const next = document
        .querySelector(template.nextPageRule)
        ?.getAttribute("href");
      if (next) {
        const nextUrl = listLocation(site, new URL(next, listUrl).href);
        if (nextUrl === listUrl)
          throw Object.assign(Error("pagination_cycle"), {
            code: "pagination_cycle",
          });
        nextCursor = { page: page + 1, url: nextUrl };
      }
    }
    return {
      records,
      raw: records.length,
      hasMore: !!nextCursor,
      nextCursor,
      ...(!paginated
        ? { coverageScope: "limited", truncationReason: "listing_only" }
        : {}),
    };
  },
  async detail(record, ctx) {
    const site = ctx.sites.find((s) => s.siteId === record.siteId);
    if (!site?.template) throw Error("Notice site template missing");
    const response = await ctx.request(record.url, { signal: ctx.signal }),
      document = noticeDocument(response);
    const node = document.querySelector(site.template.bodyRule);
    if (!node) {
      const e = Error("Notice body selector missing");
      e.code = "parse_error";
      throw e;
    }
    const description = htmlToText(node.innerHTML).trim();
    if (description.length < 30) {
      const e = Error("Notice body insufficient");
      e.code = "parse_error";
      throw e;
    }
    const attachments = [...node.querySelectorAll("a[href]")].flatMap((a) => {
      try {
        const url = canonicalizeSourceUrl(
          new URL(a.getAttribute("href"), record.url).href,
        );
        return /\.(?:pdf|docx?|xlsx?)(?:[?#]|$)/i.test(url)
          ? [{ url, title: a.textContent.trim(), textStatus: "not_extracted" }]
          : [];
      } catch {
        return [];
      }
    });
    const dateNode = site.template.dateRule
      ? document.querySelector(site.template.dateRule)
      : null;
    return {
      ...record,
      description,
      publishedAt: explicitDate(dateNode?.textContent) || record.publishedAt,
      attachments,
      detailStatus: "complete",
      ...readJobPostingEvidence(response.text, { ...record, description }),
      evidence: [
        ...record.evidence,
        {
          field: "description",
          url: record.url,
          selector: site.template.bodyRule,
        },
      ],
    };
  },
});
