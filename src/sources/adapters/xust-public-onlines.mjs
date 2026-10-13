import { parseHTML } from "linkedom";
import { parse } from "acorn";
import { baseRecord, extractApplicationLinks } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { explicitDate } from "../../util/html-elements.mjs";
import { isVisibleHtmlElement } from "../../util/html-visibility.mjs";
import { validatePublicUrl } from "../../infrastructure/http/public-url.mjs";
import { assessApplicationResponse } from "../../domain/recruitment-evidence.mjs";

const origin = "https://jy.xust.edu.cn";
const siteId = "official-92038145590ecfba";
const sourceId = "official-announcements";
const portal = "xust-public-onlines-1";
const listUrl = origin + "/module/getonlines";
const pageSize = 15;
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
const text = (v) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
const fail = (code) => {
  throw Object.assign(Error(code), { code, retryable: false });
};
function nativeId(value) {
  if (!["string", "number"].includes(typeof value)) return null;
  const id = String(value);
  return /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id))
    ? id
    : null;
}
const viewUrl = (id) => origin + "/detail/online?id=" + id + "&menu_id=8448";

export function isXustPublicTemplateConfigured(site) {
  let base;
  try {
    base = new URL(site?.origin);
  } catch {
    /* Require the exact observed authority. */
  }
  return Boolean(
    site?.siteId === siteId &&
      site.providerId === sourceId &&
      base?.origin === origin &&
      base.pathname === "/" &&
      !base.search &&
      !base.hash &&
      site.template?.nativePortal === portal &&
      site.template.recordKind === "recruitment_notice" &&
      site.template.listUrl === listUrl &&
      site.template.paginationVerified === true &&
      Array.isArray(site.allowedDomains) &&
      site.allowedDomains.includes("jy.xust.edu.cn"),
  );
}
function config(site) {
  if (!isXustPublicTemplateConfigured(site)) fail("template_not_configured");
}
function checkResponse(response, expectedUrl, publicNotice = false) {
  if ([401, 403, 412].includes(response?.status)) fail("restricted");
  if (response?.status === 429) fail("rate_limited");
  if (response?.status !== 200)
    throw Object.assign(Error("Public online recruitment HTTP failure"), {
      code: "http_error",
      status: response?.status,
    });
  if (response.url && response.url !== expectedUrl)
    fail("detail_identity_mismatch");
  if (typeof response.text !== "string") fail("parse_error");
  // Reading the public announcement and signing in to submit an application are
  // separate operations. Keep access-wall controls outside the verified body.
  let accessResponse = response;
  if (publicNotice) {
    const document = parseHTML(response.text).document;
    for (const body of document.querySelectorAll(".details-content"))
      body.remove();
    accessResponse = { ...response, text: document.toString() };
  }
  const access = assessApplicationResponse(accessResponse, null);
  if (access.challenge) fail("captcha");
  if (access.status === "login_required") fail("restricted");
}
function clean(root) {
  for (const node of [...root.querySelectorAll("*")])
    if (
      !isVisibleHtmlElement(node) ||
      /^(?:SCRIPT|STYLE|TEMPLATE|NOSCRIPT|NAV|HEADER|FOOTER)$/.test(
        node.tagName,
      )
    )
      node.remove();
  return root;
}
function fragment(html) {
  const document = parseHTML("<html><body></body></html>").document;
  const root = document.createElement("article");
  root.innerHTML = html;
  return clean(root);
}
function removeReportingControl(body) {
  const footer = body.lastElementChild,
    anchor = footer?.firstElementChild;
  if (
    footer?.tagName === "DIV" &&
    footer.children.length === 1 &&
    anchor?.tagName === "A" &&
    anchor.id === "btnComplaint" &&
    anchor.getAttribute("href") === "javascript:;" &&
    anchor.children.length === 2 &&
    anchor.children[0].tagName === "IMG" &&
    anchor.children[0].getAttribute("src") ===
      "/public/images/global/safity.png" &&
    anchor.children[1].tagName === "SPAN" &&
    text(footer.textContent) === "校园招聘违规举报"
  )
    footer.remove();
}
function evidence(field, value, url, jsonPath, kind) {
  return {
    field,
    value,
    sourceId,
    sourceUrl: url,
    sourceKind: kind,
    status: "verified",
    confidence: 100,
    sourceExcerpt: String(value).slice(0, 600),
    location: { jsonPath },
  };
}
function listLocation(keyword, page) {
  const url = new URL(listUrl);
  // The parameters and pagination aliases come from the site's onlines module.
  for (const [key, value] of Object.entries({
    start_page: "1",
    k: keyword,
    recruit_type: "",
    panel_id: "",
    professionals: "",
    work_city: "",
    company_property: "",
    company_industry: "",
    start: String(page),
    count: String(pageSize),
  }))
    url.searchParams.set(key, value);
  return url.href;
}
export async function collectXustPublicNotices(site, query, page, ctx) {
  config(site);
  const keyword = query?.keyword ?? "";
  if (
    typeof keyword !== "string" ||
    keyword.length > 100 ||
    /[\u0000-\u001f]/.test(keyword)
  )
    fail("collection_query_invalid");
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
    fail("pagination_scope");
  if (
    ctx.cursor &&
    (!plain(ctx.cursor) ||
      Object.keys(ctx.cursor).some((k) => !["page", "keyword"].includes(k)) ||
      ctx.cursor.page !== page ||
      ctx.cursor.keyword !== keyword)
  )
    fail("pagination_scope");
  const url = listLocation(keyword, page);
  ctx.signal?.throwIfAborted();
  const response = await ctx.request(url, { signal: ctx.signal });
  ctx.signal?.throwIfAborted();
  checkResponse(response, url);
  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch {
    fail("parse_error");
  }
  if (
    !plain(payload) ||
    payload.code !== 1 ||
    typeof payload.msg !== "string" ||
    !Array.isArray(payload.data) ||
    payload.data.length > pageSize
  )
    fail("parse_error");
  const records = new Map(),
    signatures = new Map(),
    conflicts = new Set();
  for (const row of payload.data) {
    if (
      !plain(row) ||
      !nativeId(row.recruitment_id) ||
      !nativeId(row.company_id) ||
      !text(row.title) ||
      !text(row.company_name) ||
      typeof row.content !== "string" ||
      typeof row.create_time !== "string" ||
      typeof row.recruit_type !== "string"
    )
      fail("parse_error");
    const id = nativeId(row.recruitment_id),
      companyId = nativeId(row.company_id),
      title = text(row.title),
      company = text(row.company_name);
    const description = htmlToText(fragment(row.content).innerHTML).trim();
    const signature = JSON.stringify([
      title,
      companyId,
      company,
      row.create_time,
      description,
    ]);
    if (signatures.has(id)) {
      if (signatures.get(id) !== signature) conflicts.add(id);
      continue;
    }
    signatures.set(id, signature);
    const publishedAt = explicitDate(row.create_time);
    records.set(
      id,
      baseRecord({
        id,
        sourceRecordIdKind: "authority",
        sourceId,
        siteId,
        scope: siteId,
        kind: "recruitment_notice",
        title,
        company,
        url: viewUrl(id),
        description,
        jobType:
          row.recruit_type === "实习招聘"
            ? "internship"
            : /校园|届/.test(title)
              ? "campus"
              : "unknown",
        publishedAt,
        detailStatus: "incomplete",
        bodyStatus: "incomplete",
        bodyIncomplete: true,
        attachments: [],
        parserVersion: portal,
        sourceEvidence: [
          evidence(
            "sourceRecordId",
            id,
            url,
            "data[].recruitment_id",
            "xust_public_notice_list",
          ),
          evidence(
            "title",
            title,
            url,
            "data[].title",
            "xust_public_notice_list",
          ),
          evidence(
            "company",
            company,
            url,
            "data[].company_name",
            "xust_public_notice_list",
          ),
          ...(publishedAt
            ? [
                {
                  ...evidence(
                    "publishedAt",
                    publishedAt,
                    url,
                    "data[].create_time",
                    "xust_public_notice_list",
                  ),
                  sourceExcerpt: row.create_time,
                },
              ]
            : []),
        ],
        nativeRecruitmentBinding: {
          portal,
          siteId,
          origin,
          schoolId: 2421,
          recruitmentId: id,
          companyId,
          title,
        },
      }),
    );
  }
  const hasMore = payload.data.length === pageSize;
  return {
    records: [...records.values()].filter(
      (r) => !conflicts.has(r.sourceRecordId),
    ),
    raw: payload.data.length,
    hasMore,
    nextCursor: hasMore ? { page: page + 1, keyword } : null,
  };
}
function noticeLocation(value) {
  try {
    const url = validatePublicUrl(value),
      id = url.searchParams.get("id");
    return url.origin === origin &&
      url.pathname === "/detail/online" &&
      !url.hash &&
      url.searchParams.getAll("id").length === 1 &&
      url.searchParams.getAll("menu_id").length === 1 &&
      url.searchParams.get("menu_id") === "8448" &&
      [...url.searchParams.keys()].every((k) =>
        ["id", "menu_id"].includes(k),
      ) &&
      nativeId(id)
      ? { id, url: url.href }
      : null;
  } catch {
    return null;
  }
}
function embeddedData(document) {
  const values = [];
  for (const script of document.querySelectorAll("script:not([src])")) {
    const type = (script.getAttribute("type") || "").trim().toLowerCase();
    if (
      ![
        "",
        "text/javascript",
        "application/javascript",
        "text/ecmascript",
        "application/ecmascript",
      ].includes(type)
    )
      continue;
    const source = script.textContent;
    if (source.length > 1048576) fail("parse_error");
    let program;
    try {
      program = parse(source, { ecmaVersion: "latest" });
    } catch {
      fail("parse_error");
    }
    const jsonCall = (node, method) =>
      node?.type === "CallExpression" &&
      !node.optional &&
      node.arguments.length === 1 &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      !node.callee.optional &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "JSON" &&
      node.callee.property.name === method;
    // Only the observed top-level var initializer is identity evidence. Acorn
    // parses syntax without running it; inert strings/comments/functions vanish.
    for (const statement of program.body) {
      if (statement.type !== "VariableDeclaration") continue;
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type !== "Identifier" ||
          declaration.id.name !== "data"
        )
          continue;
        const parseCall = declaration.init,
          stringify = parseCall?.arguments?.[0],
          object = stringify?.arguments?.[0];
        if (
          statement.kind !== "var" ||
          !jsonCall(parseCall, "parse") ||
          !jsonCall(stringify, "stringify") ||
          object?.type !== "ObjectExpression"
        )
          fail("parse_error");
        try {
          values.push(JSON.parse(source.slice(object.start, object.end)));
        } catch {
          fail("parse_error");
        }
      }
    }
  }
  if (values.length !== 1 || !plain(values[0]) || !plain(values[0].online))
    fail("parse_error");
  return values[0].online;
}
function attachment(href, label, baseUrl) {
  try {
    const url = validatePublicUrl(new URL(href, baseUrl).href);
    if (
      !/\.(?:pdf|docx?|xlsx?)$/i.test(decodeURIComponent(url.pathname)) ||
      [...url.searchParams.keys()].some((k) =>
        /token|secret|signature|sign$|password|session|cookie|auth|ticket|key$/i.test(
          k,
        ),
      )
    )
      return null;
    url.hash = "";
    return { url: url.href, title: text(label), textStatus: "not_extracted" };
  } catch {
    return null;
  }
}
export async function fetchXustPublicNotice(site, record, ctx) {
  config(site);
  const location = noticeLocation(record?.url),
    binding = record?.nativeRecruitmentBinding;
  if (
    !location ||
    record.sourceId !== sourceId ||
    record.siteId !== siteId ||
    record.identityScope !== siteId ||
    record.kind !== "recruitment_notice" ||
    record.sourceRecordIdKind !== "authority" ||
    location.id !== record.sourceRecordId ||
    !plain(binding) ||
    binding.portal !== portal ||
    binding.siteId !== siteId ||
    binding.origin !== origin ||
    binding.schoolId !== 2421 ||
    binding.recruitmentId !== location.id ||
    !nativeId(binding.companyId) ||
    binding.title !== text(record.title)
  )
    fail("detail_identity_mismatch");
  ctx.signal?.throwIfAborted();
  const response = await ctx.request(location.url, { signal: ctx.signal });
  ctx.signal?.throwIfAborted();
  checkResponse(response, location.url, true);
  const document = parseHTML(response.text).document,
    online = embeddedData(document);
  if (
    nativeId(online.recruitment_id) !== location.id ||
    online.school_id !== 2421 ||
    nativeId(online.company_id) !== binding.companyId ||
    text(online.title) !== text(record.title)
  )
    fail("detail_identity_mismatch");
  if (
    typeof online.content !== "string" ||
    typeof online.create_time !== "string" ||
    (online.docs != null && !Array.isArray(online.docs))
  )
    fail("parse_error");
  const roots = [...document.querySelectorAll("#data_details")];
  if (roots.length !== 1) fail("detail_identity_mismatch");
  const root = clean(roots[0]),
    titles = [...root.querySelectorAll(".details-head h1.dh-tit")],
    bodies = [...root.querySelectorAll(".details-content")];
  if (
    titles.length !== 1 ||
    bodies.length !== 1 ||
    text(titles[0].textContent) !== text(record.title)
  )
    fail("detail_identity_mismatch");
  removeReportingControl(bodies[0]);
  const content = fragment(bodies[0].innerHTML),
    description = htmlToText(content.innerHTML).trim(),
    embeddedBody = htmlToText(fragment(online.content).innerHTML).trim();
  // Require the entire body. The DOM is authoritative for URLs: matching text
  // alone cannot prove that a PDF or application anchor has the same destination.
  if (description.replace(/\s+/g, "") !== embeddedBody.replace(/\s+/g, ""))
    fail("detail_identity_mismatch");
  const attachments = new Map();
  for (const anchor of content.querySelectorAll("a[href]")) {
    const item = attachment(
      anchor.getAttribute("href"),
      anchor.textContent,
      location.url,
    );
    if (item) attachments.set(item.url, item);
  }
  const files = [...attachments.values()],
    pending = files.length > 0 || (online.docs?.length || 0) > 0;
  const incomplete = description.length < 60 || pending;
  const publishedAt = explicitDate(online.create_time);
  const application = extractApplicationLinks(content.outerHTML, {
    baseUrl: location.url,
    record,
  });
  const tables = [...content.querySelectorAll("table")].map((table, index) => ({
    field: "description",
    source: "xust_native_notice_table",
    url: location.url,
    selector: `#data_details .details-content table[${index}]`,
    rows: [...table.querySelectorAll("tr")]
      .filter((r) => r.closest("table") === table)
      .map((r) =>
        [...r.children]
          .filter((cell) => ["TD", "TH"].includes(cell.tagName))
          .map((cell) => htmlToText(cell.innerHTML)),
      ),
  }));
  return {
    ...record,
    description,
    publishedAt,
    bodyStatus: incomplete ? "incomplete" : "complete",
    detailStatus: incomplete ? "incomplete" : "complete",
    bodyIncomplete: incomplete,
    attachments: files,
    attachmentBodyPending: pending,
    applyUrl: application.applyUrl,
    applicationVerification:
      record.applyUrl === application.applyUrl &&
      text(record.description) === text(description)
        ? record.applicationVerification
        : undefined,
    // "已发布" / is_shelved are publisher flags, not a verified opening window.
    sourceRecruitmentStatus: "unknown",
    parserVersion: portal,
    evidence: [
      ...(record.evidence || []).filter(
        (e) => e.source !== "xust_native_notice_table",
      ),
      ...tables,
    ],
    sourceEvidence: [
      ...(record.sourceEvidence || []).filter(
        (e) =>
          e.sourceKind !== "xust_public_notice_detail" &&
          e.sourceKind !== "public_anchor" &&
          e.sourceKind !== "public_text_entry",
      ),
      {
        ...evidence(
          "description",
          description,
          location.url,
          "online.content",
          "xust_public_notice_detail",
        ),
        location: { selector: "#data_details .details-content" },
      },
      ...(publishedAt
        ? [
            {
              ...evidence(
                "publishedAt",
                publishedAt,
                location.url,
                "online.create_time",
                "xust_public_notice_detail",
              ),
              sourceExcerpt: online.create_time,
            },
          ]
        : []),
      ...application.sourceEvidence,
    ],
  };
}
