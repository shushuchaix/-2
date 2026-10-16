import { parseHTML } from "linkedom";
import { baseRecord, extractApplicationLinks } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { explicitDate } from "../../util/html-elements.mjs";
import { isHiddenHtmlElement } from "../../util/html-visibility.mjs";
import { validatePublicUrl } from "../../infrastructure/http/public-url.mjs";
import { assessApplicationResponse } from "../../domain/recruitment-evidence.mjs";

const siteId = "official-c738f71905918585";
const sourceId = "official-announcements";
const portal = "hpu-public-notices-1";
const listUrl = "https://hpu.bysjy.com.cn/";
const linkRule =
  ".row-left.obtain-tags .col-news.tags-list ul.col-content.curr > li.content-item.new > a.content-txt-wrap[href]";
const recruiting = /招聘|招募|岗位|人才引进|聘用|选聘/;
const text = (value) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const fail = (code, message) => {
  throw Object.assign(Error(message), { code, retryable: false });
};
const nativeId = (value) =>
  /^[1-9]\d{0,15}$/.test(value || "") && Number.isSafeInteger(Number(value))
    ? value
    : null;

export function isHpuPublicTemplateConfigured(site) {
  return Boolean(
    site?.siteId === siteId &&
      site.providerId === sourceId &&
      [new URL(listUrl).origin, listUrl].includes(site.origin) &&
      site.template?.nativePortal === portal &&
      site.template.recordKind === "recruitment_notice" &&
      site.template.listUrl === listUrl,
  );
}

function validateSite(site) {
  if (!isHpuPublicTemplateConfigured(site))
    fail(
      "template_not_configured",
      "Exact HPU public notice contract required",
    );
}

function noticeLocation(value) {
  try {
    const url = validatePublicUrl(new URL(value, listUrl).href);
    const id = url.searchParams.get("id");
    if (
      url.origin !== new URL(listUrl).origin ||
      url.pathname !== "/detail/news" ||
      url.hash ||
      url.searchParams.getAll("id").length !== 1 ||
      url.searchParams.getAll("type_id").length > 1 ||
      [...url.searchParams.keys()].some(
        (key) => !["id", "type_id"].includes(key),
      ) ||
      !nativeId(id) ||
      (url.searchParams.has("type_id") &&
        !nativeId(url.searchParams.get("type_id")))
    )
      return null;
    return { url: url.href, id };
  } catch {
    return null;
  }
}

function checkResponse(response, expectedUrl) {
  if ([401, 403].includes(response?.status))
    fail("restricted", "HPU public notice access restricted");
  if (response?.status !== 200)
    fail("unavailable", "HPU public notice HTTP failure");
  if (response.url && response.url !== expectedUrl)
    fail(
      "detail_identity_mismatch",
      "HPU response URL changed its requested authority",
    );
  if (typeof response.text !== "string")
    fail("parse_error", "HPU public response text required");
}

function checkAccess(html) {
  const access = assessApplicationResponse({ status: 200, text: html }, null);
  if (
    access.challenge ||
    /<title\b[^>]*>[^<]*(?:captcha|验证码|安全验证)/i.test(html)
  )
    fail("captcha", "HPU public notice requires a challenge");
  if (access.status === "login_required")
    fail("restricted", "HPU public notice requires login");
}

function visibleDocument(html) {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll(
    "head,script,style,template,noscript,[hidden],[aria-hidden],[style],input,nav,header,footer",
  ))
    if (
      isHiddenHtmlElement(node) ||
      /^(?:NAV|HEADER|FOOTER)$/.test(node.tagName)
    )
      node.remove();
  return document;
}

export async function collectHpuPublicNotices(site, page, ctx) {
  validateSite(site);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    (ctx.cursor?.url && ctx.cursor.url !== listUrl)
  )
    fail(
      "pagination_scope",
      "HPU collection is limited to its public homepage",
    );
  const result = {
    records: [],
    raw: 0,
    hasMore: false,
    nextCursor: null,
    coverageScope: "limited",
    truncationReason: "listing_only",
  };
  if (page > 1) return result;
  ctx.signal?.throwIfAborted();
  const response = await ctx.request(listUrl, { signal: ctx.signal });
  ctx.signal?.throwIfAborted();
  checkResponse(response, listUrl);
  checkAccess(response.text);
  const document = visibleDocument(response.text);
  if (
    !document.querySelector(
      ".row-left.obtain-tags .col-news.tags-list ul.col-content.curr",
    )
  )
    fail("parse_error", "HPU native notice list missing");
  const records = new Map(),
    conflicts = new Set();
  for (const anchor of document.querySelectorAll(linkRule)) {
    const titles = [...anchor.querySelectorAll("span.content-txt")];
    const title = text(titles[0]?.textContent);
    const attrTitle = text(anchor.getAttribute("title"));
    const location = noticeLocation(anchor.getAttribute("href"));
    if (
      titles.length !== 1 ||
      !title ||
      (attrTitle && attrTitle !== title) ||
      !recruiting.test(title) ||
      /双选会|宣讲会|招聘会|工作动态|招聘工作总结/.test(title) ||
      !location
    )
      continue;
    if (records.has(location.id)) {
      if (records.get(location.id).title !== title) conflicts.add(location.id);
      continue;
    }
    records.set(
      location.id,
      baseRecord({
        id: location.id,
        sourceRecordIdKind: "authority",
        sourceId,
        siteId,
        scope: siteId,
        kind: "recruitment_notice",
        title,
        company: null,
        url: location.url,
        jobType: /校园|应届|高校毕业生/.test(title) ? "campus" : "unknown",
        publishedAt: null,
        detailStatus: "incomplete",
        bodyStatus: "incomplete",
        bodyIncomplete: true,
        parserVersion: portal,
        evidence: [
          {
            field: "sourceRecordId",
            url: location.url,
            source: "native_notice_url_id",
            value: location.id,
          },
          {
            field: "title",
            url: listUrl,
            selector: linkRule + " span.content-txt",
            value: title,
          },
        ],
      }),
    );
  }
  result.records = [...records.values()].filter(
    (record) => !conflicts.has(record.sourceRecordId),
  );
  result.raw = result.records.length;
  return result;
}

function publicAttachment(value, title, baseUrl) {
  try {
    if (typeof value !== "string" || !value.trim()) return null;
    const url = validatePublicUrl(new URL(value, baseUrl).href);
    if (
      !/\.(?:pdf|docx?|xlsx?)$/i.test(decodeURIComponent(url.pathname)) ||
      [...url.searchParams.keys()].some((key) =>
        /token|secret|signature|sign$|password|session|cookie|auth|ticket/i.test(
          key,
        ),
      )
    )
      return null;
    url.hash = "";
    return {
      url: url.href,
      title: htmlToText(title || ""),
      textStatus: "not_extracted",
    };
  } catch {
    return null;
  }
}

function noticeAttachments(data, document, record) {
  const attachments = new Map();
  const add = (entry) => {
    if (entry) attachments.set(entry.url, entry);
  };
  // These three names are evidenced by the native template. Actual observed docs was empty.
  for (const doc of Array.isArray(data.docs) ? data.docs : []) {
    if (
      doc &&
      nativeId(String(doc.doc_id || "")) &&
      typeof doc.doc_name === "string" &&
      typeof doc.doc_url === "string"
    )
      add(publicAttachment(doc.doc_url, doc.doc_name, record.url));
  }
  for (const anchor of document.querySelectorAll("body a[href]"))
    add(
      publicAttachment(
        anchor.getAttribute("href"),
        anchor.textContent,
        record.url,
      ),
    );
  return [...attachments.values()];
}

function tableEvidence(document, url) {
  return [...document.querySelectorAll("body table")].map((table, index) => ({
    field: "description",
    source: "native_notice_table",
    url,
    selector: `data.content table[${index}]`,
    rows: [...table.querySelectorAll("tr")]
      .filter((row) => row.closest("table") === table)
      .map((row) =>
        [...row.children]
          .filter((cell) => ["TD", "TH"].includes(cell.tagName))
          .map((cell) => htmlToText(cell.innerHTML)),
      ),
  }));
}

export async function fetchHpuPublicNotice(site, record, ctx) {
  validateSite(site);
  const location = noticeLocation(record?.url);
  const title = text(record?.title);
  if (
    record?.sourceId !== sourceId ||
    record.siteId !== siteId ||
    record.identityScope !== siteId ||
    record.kind !== "recruitment_notice" ||
    record.sourceRecordIdKind !== "authority" ||
    !location ||
    location.id !== record.sourceRecordId ||
    !title
  )
    fail(
      "detail_identity_mismatch",
      "HPU notice does not match the requested authority",
    );
  const apiUrl = listUrl + "detail/getnoticedetail?notice_id=" + location.id;
  ctx.signal?.throwIfAborted();
  const response = await ctx.request(apiUrl, { signal: ctx.signal });
  ctx.signal?.throwIfAborted();
  checkResponse(response, apiUrl);
  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch {
    checkAccess(response.text);
    fail("parse_error", "HPU native notice response must be JSON");
  }
  const data = payload?.data;
  if (
    payload?.code !== 1 ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  )
    fail("parse_error", "HPU native notice success data missing");
  if (
    !Number.isSafeInteger(data.notice_id) ||
    data.notice_id < 1 ||
    String(data.notice_id) !== location.id
  )
    fail(
      "detail_identity_mismatch",
      "HPU returned a different notice authority",
    );
  if (text(data.notice_name) !== title)
    fail("detail_title_mismatch", "HPU returned a different notice title");
  if (typeof data.content !== "string")
    fail("detail_insufficient", "HPU native notice body missing");
  checkAccess(data.content);
  if (/<(?:html|head|body)\b/i.test(data.content))
    fail("parse_error", "HPU notice content contains a page shell");
  const document = visibleDocument(
    "<html><body>" + data.content + "</body></html>",
  );
  const bodyHtml = document.body.innerHTML;
  const description = htmlToText(bodyHtml);
  if (
    description.length < 80 ||
    !recruiting.test(description) ||
    /\{\{[^}]*\}\}|<%[\s\S]*?%>/.test(bodyHtml)
  )
    fail("detail_insufficient", "HPU native notice body insufficient");
  const links = extractApplicationLinks(bodyHtml, {
    baseUrl: location.url,
    record,
  });
  const publishedAt = explicitDate(data.create_time);
  const fresh = {
    ...record,
    description,
    deadlineAt: null,
    publishedAt,
    attachments: noticeAttachments(data, document, record),
    detailStatus: "complete",
    bodyStatus: "complete",
    bodyIncomplete: false,
    parserVersion: portal,
    applyUrl: links.applyUrl,
    sourceEvidence: [
      ...(record.sourceEvidence || []).filter(
        (row) =>
          !["description", "deadlineAt", "applyUrl", "publishedAt"].includes(
            row.field,
          ),
      ),
      ...links.sourceEvidence,
      {
        field: "description",
        value: description,
        sourceId,
        sourceUrl: apiUrl,
        sourceKind: "native_notice_content",
        sourceExcerpt: description,
        status: "verified",
        confidence: 100,
        location: { field: "data.content" },
      },
      ...(publishedAt
        ? [
            {
              field: "publishedAt",
              value: publishedAt,
              sourceId,
              sourceUrl: apiUrl,
              sourceKind: "native_notice_publication",
              sourceExcerpt: data.create_time,
              status: "verified",
              confidence: 100,
              location: { field: "data.create_time" },
            },
          ]
        : []),
    ],
    evidence: [
      ...(record.evidence || []).filter(
        (row) =>
          ![
            "native_notice_response_id",
            "native_notice_field",
            "native_notice_table",
          ].includes(row.source),
      ),
      {
        field: "sourceRecordId",
        url: apiUrl,
        source: "native_notice_response_id",
        value: location.id,
      },
      {
        field: "title",
        url: apiUrl,
        source: "native_notice_field",
        selector: "data.notice_name",
        value: title,
      },
      {
        field: "description",
        url: apiUrl,
        source: "native_notice_field",
        selector: "data.content",
      },
      ...tableEvidence(document, apiUrl),
    ],
  };
  // This GET verifies announcement facts, never an external submission form.
  delete fresh.applicationVerification;
  return fresh;
}
