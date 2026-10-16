import { parseHTML } from "linkedom";
import { baseRecord } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { isVisibleHtmlElement } from "../../util/html-visibility.mjs";
import { assessApplicationResponse } from "../../domain/recruitment-evidence.mjs";
const origin = "https://hr.xiaomi.com",
  portal = "xiaomi-public-notices-1";
const listUrl = origin + "/website/cli/api/hrportal/domestic/campusNews/list";
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
const id = (v) => Number.isSafeInteger(v) && v > 0;
const fail = (code) => {
  throw Object.assign(Error(code), { code, retryable: false });
};
const viewUrl = (id) => origin + "/website/campus-notice.html#id=" + id;
function config(site) {
  if (
    site?.siteId !== "xiaomi" ||
    site.providerId !== "official-announcements" ||
    site.name !== "小米" ||
    site.origin !== origin + "/website/campus.html" ||
    site.template?.nativePortal !== portal ||
    site.template.recordKind !== "recruitment_notice" ||
    site.template.listUrl !== listUrl ||
    !site.allowedDomains?.includes("hr.xiaomi.com")
  )
    fail("template_not_configured");
}
function visible(value) {
  const { document } = parseHTML("<article>" + value + "</article>"),
    root = document.querySelector("article");
  for (const node of [...root.querySelectorAll("*")])
    if (
      !isVisibleHtmlElement(node) ||
      /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|NAV|HEADER|FOOTER)$/.test(node.tagName)
    )
      node.remove();
  return htmlToText(root.innerHTML).trim();
}
async function readRows(ctx) {
  const response = await ctx.request(listUrl, { signal: ctx.signal });
  ctx.signal?.throwIfAborted();
  if ([401, 403, 412].includes(response.status)) fail("restricted");
  if (response.status === 429) fail("rate_limited");
  if (response.status !== 200)
    throw Object.assign(Error("Public recruitment config HTTP failure"), {
      code: "http_error",
      status: response.status,
      retryable: false,
    });
  if (response.url && response.url !== listUrl)
    fail("detail_identity_mismatch");
  if (assessApplicationResponse(response, null).challenge) fail("captcha");
  let value;
  try {
    value = JSON.parse(response.text);
  } catch {
    fail("parse_error");
  }
  if (
    !plain(value) ||
    value.code !== 200 ||
    value.success !== true ||
    !Array.isArray(value.data) ||
    value.data.length > 100 ||
    value.paging !== ""
  )
    fail("parse_error");
  const rows = [],
    seen = new Set();
  for (const row of value.data) {
    if (
      !plain(row) ||
      !id(row.id) ||
      typeof row.title !== "string" ||
      !row.title.trim() ||
      row.title.length > 500 ||
      typeof row.tag !== "string" ||
      typeof row.isDel !== "boolean" ||
      !Number.isSafeInteger(row.status) ||
      typeof row.body !== "string" ||
      seen.has(row.id)
    )
      fail("parse_error");
    seen.add(row.id);
    if (
      row.isDel ||
      row.status !== 1 ||
      row.tag !== "投递须知" ||
      !/招聘|应届生|实习生|博士后工作站/.test(row.title)
    )
      continue;
    rows.push(row);
  }
  return rows;
}
function recordFor(site, row, now) {
  const title = row.title.trim(),
    description = visible(row.body),
    complete = description.length >= 100;
  const evidence = (field, value, jsonPath) => ({
    field,
    value,
    status: "verified",
    sourceId: site.providerId,
    sourceUrl: listUrl,
    sourceKind: "public_api_recruitment_notice_row",
    confidence: 100,
    sourceExcerpt: String(value).slice(0, 600),
    location: { jsonPath },
    appliesTo: { noticeId: String(row.id) },
  });
  return baseRecord({
    id: row.id,
    sourceRecordIdKind: "authority",
    sourceId: site.providerId,
    siteId: site.siteId,
    scope: site.siteId,
    kind: "recruitment_notice",
    title,
    url: viewUrl(row.id),
    urlKind: "notice_detail",
    company: site.name,
    description,
    jobType: /实习生/.test(title)
      ? "internship"
      : /博士后/.test(title)
        ? "social"
        : "campus",
    publishedAt: null,
    deadlineAt: null,
    applyUrl: null,
    applicationCandidates: [],
    attachments: [],
    attachmentBodyPending: false,
    bodyStatus: complete ? "complete" : "incomplete",
    detailStatus: complete ? "complete" : "incomplete",
    bodyIncomplete: !complete,
    parserVersion: portal,
    retrievedAt: new Date(now).toISOString(),
    sourceEvidence: [
      evidence("sourceRecordId", String(row.id), "id"),
      evidence("title", title, "title"),
      ...(complete ? [evidence("description", description, "body")] : []),
    ],
    nativeRecruitmentBinding: {
      portal,
      siteId: site.siteId,
      origin,
      noticeId: String(row.id),
      title,
      checkedAt: new Date(now).toISOString(),
    },
  });
}
const limited = (records) => ({
  records,
  raw: records.length,
  hasMore: false,
  nextCursor: null,
  coverageScope: "limited",
  truncationReason: "listing_only",
  parserVersion: portal,
});
export async function collectXiaomiPublicNotices(site, _query, page, ctx) {
  config(site);
  ctx.signal?.throwIfAborted();
  if (!Number.isSafeInteger(page) || page < 1 || page > 20)
    fail("collection_cursor_invalid");
  // This is the whole observed public notice configuration, not a paged vacancy feed.
  if (page > 1) return limited([]);
  return limited(
    (await readRows(ctx)).map((row) =>
      recordFor(site, row, ctx.clock?.now?.() || Date.now()),
    ),
  );
}
export async function fetchXiaomiPublicNotice(site, record, ctx) {
  config(site);
  ctx.signal?.throwIfAborted();
  const b = record.nativeRecruitmentBinding;
  if (
    record.sourceId !== site.providerId ||
    record.siteId !== site.siteId ||
    record.identityScope !== site.siteId ||
    record.kind !== "recruitment_notice" ||
    record.sourceRecordIdKind !== "authority" ||
    !/^\d+$/.test(record.sourceRecordId || "") ||
    b?.portal !== portal ||
    b.siteId !== site.siteId ||
    b.origin !== origin ||
    b.noticeId !== record.sourceRecordId ||
    b.title !== record.title ||
    record.url !== viewUrl(record.sourceRecordId)
  )
    fail("detail_identity_mismatch");
  const row = (await readRows(ctx)).find(
    (row) => String(row.id) === record.sourceRecordId,
  );
  if (!row || row.title.trim() !== record.title)
    fail("detail_identity_mismatch");
  const fresh = {
    ...record,
    ...recordFor(site, row, ctx.clock?.now?.() || Date.now()),
  };
  delete fresh.applicationVerification;
  return fresh;
}
