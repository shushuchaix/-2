import { parseHTML } from "linkedom";
import {
  createPagedProvider,
  baseRecord,
  extractApplicationLinks,
} from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { explicitDate } from "../../util/html-elements.mjs";
import { canonicalizeSourceUrl } from "../../domain/identity.mjs";
import { validatePublicUrl } from "../../infrastructure/http/public-url.mjs";
import { readJobPostingEvidence } from "../../domain/recruitment-evidence.mjs";
import {
  collectInlineOfficialJobs,
  fetchInlineOfficialJob,
} from "./inline-official-jobs.mjs";
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
function jobIdPattern(template) {
  if (
    !["urlIdPattern", "detailIdRule"].some((key) =>
      Object.hasOwn(template, key),
    )
  )
    return null;
  if (
    typeof template.urlIdPattern !== "string" ||
    template.urlIdPattern.length > 200 ||
    !template.urlIdPattern.startsWith("^") ||
    !template.urlIdPattern.endsWith("$") ||
    typeof template.detailIdRule !== "string" ||
    !template.detailIdRule.trim()
  )
    throw Object.assign(
      Error("Paired job URL and visible identity rules required"),
      { code: "template_not_configured" },
    );
  try {
    return new RegExp(template.urlIdPattern);
  } catch {
    throw Object.assign(Error("Job URL identity pattern invalid"), {
      code: "template_not_configured",
    });
  }
}
function jobUrlId(url, pattern) {
  try {
    const id = new URL(url).pathname.match(pattern)?.[1];
    return /^\d+$/.test(id || "") ? id : null;
  } catch {
    return null;
  }
}
export default createPagedProvider({
  id: "official-announcements",
  name: "官方招聘公告",
  capabilities: {
    category: "public",
    jobTypes: ["campus", "social", "unknown"],
    kinds: ["recruitment_notice", "job"],
    detail: true,
    attachments: true,
  },
  async listPage(site, query, page, ctx) {
    const template = site.template;
    if (template?.inlineJob === true)
      return collectInlineOfficialJobs(site, page, ctx, noticeDocument);
    const jobMode = template?.recordKind === "job";
    const paginated =
      template?.paginationVerified === true && !!template.nextPageRule;
    if (page > 1 && !paginated)
      return {
        records: [],
        hasMore: false,
        coverageScope: "limited",
        truncationReason: "listing_only",
      };
    if (
      !template?.listUrl ||
      !template.linkRule ||
      !template.bodyRule ||
      (jobMode &&
        (!template.rowRule ||
          !template.titleRule ||
          !Object.hasOwn(template, "listDateRule") ||
          (template.listDateRule !== null &&
            (typeof template.listDateRule !== "string" ||
              !template.listDateRule.trim())) ||
          !template.detailTitleRule ||
          !Array.isArray(template.requiredBodyRules) ||
          !template.requiredBodyRules.length ||
          template.requiredBodyRules.some(
            (rule) => typeof rule !== "string" || !rule.trim(),
          ) ||
          !["href", "data-url"].includes(template.linkAttribute || "href")))
    ) {
      const e = Error("Verified notice template required");
      e.code = "template_not_configured";
      throw e;
    }
    const idPattern = jobMode ? jobIdPattern(template) : null;
    const listUrl = listLocation(site, ctx.cursor?.url || template.listUrl);
    const document = noticeDocument(
      await ctx.request(listUrl, { signal: ctx.signal }),
    );
    const records = [],
      seen = new Set();
    for (const anchor of document.querySelectorAll(template.linkRule)) {
      const row = jobMode
        ? anchor.closest(template.rowRule)
        : anchor.closest("li") ||
          anchor.closest(".row") ||
          anchor.parentElement;
      const titleNode = jobMode
        ? row?.querySelector(template.titleRule)
        : anchor;
      if (jobMode && !titleNode?.textContent.trim())
        throw Object.assign(Error("Job row title selector missing"), {
          code: "parse_error",
        });
      let title = (
        jobMode
          ? titleNode.textContent
          : anchor.getAttribute("title") || anchor.textContent
      )
        .replace(/\s+/g, " ")
        .trim();
      if (
        !jobMode &&
        (!recruiting.test(title) ||
          /平台宣传|工作动态|会议纪要|招聘工作总结/.test(title))
      )
        continue;
      const raw = anchor.getAttribute(
        jobMode ? template.linkAttribute || "href" : "href",
      );
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
      const nativeId = idPattern ? jobUrlId(url, idPattern) : null;
      if (idPattern && !nativeId) continue;
      seen.add(url);
      const publishedAt = explicitDate(
        jobMode
          ? template.listDateRule === null
            ? null
            : row.querySelector(template.listDateRule)?.textContent
          : row?.textContent,
      );
      title = title
        .replace(/(?:20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}日?)/g, "")
        .trim();
      records.push(
        baseRecord({
          id: nativeId || url,
          ...(nativeId ? { sourceRecordIdKind: "authority" } : {}),
          sourceId: "official-announcements",
          siteId: site.siteId,
          scope: site.siteId,
          kind: jobMode ? "job" : "recruitment_notice",
          title,
          url,
          company: site.name,
          jobType: !jobMode && /校园|应届/.test(title) ? "campus" : "unknown",
          publishedAt,
          ...(jobMode
            ? {
                urlKind: "job_detail",
                detailStatus: "incomplete",
                bodyStatus: "incomplete",
                bodyIncomplete: true,
              }
            : {}),
          evidence: [
            ...(nativeId
              ? [
                  {
                    field: "sourceRecordId",
                    url,
                    source: "job_url_id",
                    value: nativeId,
                  },
                ]
              : []),
            {
              field: "title",
              url: listUrl,
              selector: jobMode
                ? `${template.rowRule} ${template.titleRule}`
                : template.linkRule,
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
    if (site.template.inlineJob === true)
      return fetchInlineOfficialJob(site, record, ctx, noticeDocument);
    const template = site.template,
      jobMode = template.recordKind === "job";
    const idPattern = jobMode ? jobIdPattern(template) : null;
    if (idPattern) {
      const nativeId = jobUrlId(record.url, idPattern);
      if (
        !nativeId ||
        nativeId !== String(record.sourceRecordId || "") ||
        record.sourceRecordIdKind !== "authority" ||
        record.kind !== "job" ||
        record.sourceId !== "official-announcements" ||
        record.identityScope !== site.siteId ||
        new URL(record.url).origin !== new URL(site.origin).origin
      )
        throw Object.assign(
          Error("Job detail URL does not match the requested authority"),
          { code: "detail_identity_mismatch", retryable: false },
        );
    }
    const response = await ctx.request(record.url, { signal: ctx.signal }),
      document = noticeDocument(response);
    if (jobMode) {
      if (idPattern) {
        const identityNodes = [
          ...document.querySelectorAll(template.detailIdRule),
        ];
        if (
          identityNodes.length !== 1 ||
          identityNodes[0].textContent.trim() !== String(record.sourceRecordId)
        )
          throw Object.assign(
            Error(
              "Visible job identity does not match the requested authority",
            ),
            { code: "detail_identity_mismatch", retryable: false },
          );
      }
      const observedTitle = (
        template.detailTitleRule
          ? document.querySelector(template.detailTitleRule)?.textContent
          : ""
      )
        ?.replace(/\s+/g, " ")
        .trim();
      if (
        !observedTitle ||
        observedTitle !==
          String(record.title || "")
            .replace(/\s+/g, " ")
            .trim()
      )
        throw Object.assign(
          Error("Job detail title does not match requested record"),
          {
            code: "detail_title_mismatch",
            retryable: false,
          },
        );
      if (
        !Array.isArray(template.requiredBodyRules) ||
        !template.requiredBodyRules.length
      )
        throw Object.assign(
          Error("Required job body sections are not configured"),
          { code: "template_not_configured" },
        );
    }
    const nodes = jobMode
      ? [...document.querySelectorAll(template.bodyRule)]
      : [document.querySelector(template.bodyRule)].filter(Boolean);
    if (!nodes.length) {
      const e = Error("Notice body selector missing");
      e.code = "parse_error";
      throw e;
    }
    const bodyHtml = nodes.map((node) => node.innerHTML).join("\n"),
      description = nodes
        .map((node) => htmlToText(node.innerHTML).trim())
        .filter(Boolean)
        .join("\n");
    const missingRequiredBody =
      jobMode &&
      template.requiredBodyRules.some(
        (rule) =>
          !htmlToText(document.querySelector(rule)?.innerHTML || "").trim(),
      );
    const attachmentNodes = template.attachmentRule
      ? [...document.querySelectorAll(template.attachmentRule)]
      : nodes.flatMap((node) => [...node.querySelectorAll("a[href]")]);
    const attachments = attachmentNodes.flatMap((a) => {
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
    const dateNode = template.dateRule
      ? document.querySelector(template.dateRule)
      : null;
    const shortBody = description.length < 30,
      incomplete = shortBody || missingRequiredBody;
    if (shortBody && !attachments.length && !missingRequiredBody)
      throw Object.assign(Error("Notice body insufficient"), {
        code: "detail_insufficient",
        retryable: false,
      });
    const links = extractApplicationLinks(bodyHtml, {
      baseUrl: record.url,
      record,
    });
    const structuredEvidence = readJobPostingEvidence(response.text, {
      ...record,
      description,
    });
    return {
      ...record,
      description,
      publishedAt: explicitDate(dateNode?.textContent) || record.publishedAt,
      attachments,
      detailStatus: incomplete ? "incomplete" : "complete",
      ...(jobMode
        ? {
            bodyStatus: incomplete ? "incomplete" : "complete",
            bodyIncomplete: incomplete,
            attachmentBodyPending: shortBody && attachments.length > 0,
            retryEligible: shortBody && attachments.length > 0,
          }
        : {}),
      ...(shortBody && attachments.length
        ? {
            bodyStatus: "incomplete",
            attachmentBodyPending: true,
            retryEligible: true,
          }
        : {}),
      ...(links.applyUrl ? { applyUrl: links.applyUrl } : {}),
      ...structuredEvidence,
      sourceEvidence: [
        ...(record.sourceEvidence || []),
        ...links.sourceEvidence,
        ...(structuredEvidence.sourceEvidence || []),
      ],
      evidence: [
        ...record.evidence,
        ...(idPattern
          ? [
              {
                field: "sourceRecordId",
                url: record.url,
                source: "visible_job_id",
                selector: template.detailIdRule,
                value: String(record.sourceRecordId),
              },
            ]
          : []),
        {
          field: "description",
          url: record.url,
          selector: site.template.bodyRule,
        },
      ],
    };
  },
});
