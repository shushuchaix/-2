import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { baseRecord } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { isVisibleHtmlElement } from "../../util/html-visibility.mjs";
import { assessApplicationResponse } from "../../domain/recruitment-evidence.mjs";

const siteId = "official-5cf1fdcffbefdbb8";
const company = "深圳市机场（集团）有限公司";
const tenant = "60b79f9bbef57c1189691f8b";
const origin = "https://wecruit.hotjob.cn";
const portal = "shenzhen-airport-wecruit-1";
const queryParams = "?iSaJAx=isAjax&request_locale=zh_CN";
const api = (path) =>
  origin + "/wecruit/" + path + "/SU" + tenant + queryParams;
const listUrl = api("positionInfo/listPosition");
const configUrl = api("suite/config");
const detailUrl = api("positionInfo/listPositionDetail");
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
const nativeId = (v) =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const digest = (v) => createHash("sha256").update(v).digest("hex");
const fail = (code) => {
  throw Object.assign(Error(code), { code, retryable: false });
};
const viewUrl = (id, type) =>
  origin +
  "/SU" +
  tenant +
  "/pb/posDetail.html?postId=" +
  encodeURIComponent(id) +
  "&postType=" +
  { 1: "campus", 2: "society" }[type];
const post = (data, signal) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
  signal,
});

function config(site) {
  let entry;
  try {
    entry = new URL(site?.origin);
  } catch {
    /* Exact configured portal required. */
  }
  if (
    site?.siteId !== siteId ||
    site.providerId !== "official-announcements" ||
    entry?.href !== "https://szairport.hotjob.cn/" ||
    site.name !== company ||
    site.template?.nativePortal !== portal ||
    site.template.tenantKey !== tenant ||
    site.template.listUrl !== listUrl ||
    !site.allowedDomains?.includes("wecruit.hotjob.cn")
  )
    fail("template_not_configured");
}
function json(response, url) {
  if ([401, 403, 412].includes(response.status)) fail("restricted");
  if (response.status === 429) fail("rate_limited");
  if (response.status !== 200)
    throw Object.assign(Error("Public portal HTTP failure"), {
      code: "http_error",
      status: response.status,
      retryable: false,
    });
  if (response.url && response.url !== url) fail("detail_identity_mismatch");
  let value;
  try {
    value = JSON.parse(response.text);
  } catch {
    if (assessApplicationResponse(response, null).challenge) fail("captcha");
    fail("parse_error");
  }
  if (!plain(value)) fail("parse_error");
  if (String(value.state) === "808") fail("login_required");
  if (String(value.state) !== "200" || !plain(value.data)) fail("parse_error");
  return value.data;
}
function validateTenant(data) {
  if (
    data.companyName !== company ||
    data.suiteKey !== tenant ||
    data.templateNum !== "pb" ||
    ["campus", "society"].some(
      (type) =>
        data.config?.[type]?.jobList?.jobListData?.searchType !== "postName" ||
        data.config[type].jobList.jobListData.listType !== "row",
    )
  )
    fail("detail_identity_mismatch");
}
function validateRow(row, code = "parse_error") {
  if (
    !plain(row) ||
    !nativeId(row.postId) ||
    typeof row.postName !== "string" ||
    !row.postName.trim() ||
    row.postName.length > 500 ||
    row.currentSuiteKey !== tenant ||
    ["orgName", "workPlaceStr", "workContent", "serviceCondition"].some(
      (key) => row[key] != null && typeof row[key] !== "string",
    )
  )
    fail(code);
}
function pageRows(data, page) {
  const p = data.pageForm;
  if (
    !plain(p) ||
    !Array.isArray(p.pageData) ||
    !Number.isSafeInteger(data.positonNum) ||
    data.positonNum < 0 ||
    !Number.isSafeInteger(p.dataCount) ||
    p.dataCount !== data.positonNum ||
    !Number.isSafeInteger(p.totalPage) ||
    p.totalPage < 0 ||
    !Number.isSafeInteger(p.pageSize) ||
    !Number.isSafeInteger(p.currentPage)
  )
    fail("parse_error");
  // The live tenant returns all-zero pagination for an actually empty query.
  if (!data.positonNum) {
    if (p.totalPage || p.pageSize || p.currentPage || p.pageData.length)
      fail("parse_error");
    return { rows: [], more: false };
  }
  if (
    p.pageSize !== 15 ||
    p.currentPage !== page ||
    p.totalPage !== Math.ceil(p.dataCount / 15) ||
    p.pageData.length !==
      Math.min(15, Math.max(0, p.dataCount - (page - 1) * 15))
  )
    fail("parse_error");
  for (const row of p.pageData) validateRow(row);
  return { rows: p.pageData, more: page < p.totalPage };
}
function visible(value) {
  const { document } = parseHTML("<article>" + (value || "") + "</article>");
  const root = document.querySelector("article");
  for (const node of [...root.querySelectorAll("*")])
    if (!isVisibleHtmlElement(node)) node.remove();
  return htmlToText(root.innerHTML).trim();
}
function recordFor(row, type, endpoint, now, detail = false) {
  const duties = detail ? visible(row.workContent) : "";
  const requirements = detail ? visible(row.serviceCondition) : "";
  const complete = duties.length >= 15 && requirements.length >= 15;
  const title = row.postName.trim(),
    url = viewUrl(row.postId, type);
  const description = detail
    ? "岗位职责：\n" + duties + "\n任职要求：\n" + requirements
    : null;
  const evidence = (field, value, jsonPath, status = "verified") => ({
    field,
    value,
    status,
    sourceId: "official-announcements",
    sourceUrl: endpoint,
    sourceKind: "public_api_job_row",
    confidence: status === "verified" ? 100 : 0,
    sourceExcerpt: String(value).slice(0, 600),
    location: { jsonPath },
    appliesTo: { jobRowId: row.postId },
  });
  return baseRecord({
    id: row.postId,
    sourceRecordIdKind: "authority",
    sourceId: "official-announcements",
    siteId,
    scope: siteId,
    kind: "job",
    title,
    url,
    urlKind: "job_detail",
    company: row.orgName?.trim() || company,
    cities: row.workPlaceStr?.trim() ? [row.workPlaceStr.trim()] : [],
    jobType: type === 1 ? "campus" : "social",
    description,
    publishedAt: null,
    deadlineAt: null,
    applyUrl: null,
    applicationCandidates: [url],
    attachments: [],
    attachmentBodyPending: false,
    bodyStatus: complete ? "complete" : "incomplete",
    detailStatus: complete ? "complete" : "incomplete",
    bodyIncomplete: !complete,
    parserVersion: portal,
    sourceEvidence: [
      evidence("sourceRecordId", row.postId, "postId"),
      evidence("title", title, "postName"),
      ...(detail
        ? [
            evidence("duties", duties, "workContent"),
            evidence("requirements", requirements, "serviceCondition"),
            ...(complete
              ? [
                  evidence(
                    "description",
                    description,
                    "workContent,serviceCondition",
                  ),
                ]
              : []),
          ]
        : []),
      evidence("applicationCandidate", url, "postId", "unknown"),
    ],
    nativeRecruitmentBinding: {
      portal,
      siteId,
      origin,
      tenantKey: tenant,
      postId: row.postId,
      recruitType: type,
      title,
      checkedAt: new Date(now).toISOString(),
    },
  });
}

export async function collectShenzhenAirportJobs(site, query, page, ctx) {
  config(site);
  ctx.signal?.throwIfAborted();
  const keyword = query?.keyword || "";
  if (
    typeof keyword !== "string" ||
    keyword.length > 99 ||
    /[\u0000-\u001f]/.test(keyword)
  )
    fail("collection_query_invalid");
  const wanted = ctx.targetSnapshot?.jobTypes || [];
  if (!Array.isArray(wanted)) fail("collection_query_invalid");
  const types = wanted.length
    ? [1, 2].filter((type) => wanted.includes(type === 1 ? "campus" : "social"))
    : [1, 2];
  if (!types.length) fail("collection_query_invalid");
  const queryHash = digest(JSON.stringify([keyword, types]));
  const cursor = ctx.cursor,
    b = cursor?.shenzhenAirport;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 20 ||
    (page > 1 && !cursor) ||
    (cursor &&
      (cursor.page !== page ||
        b?.siteId !== siteId ||
        b.tenantKey !== tenant ||
        b.queryHash !== queryHash ||
        !Array.isArray(b.seenPages) ||
        b.seenPages.length !== page - 1 ||
        b.seenPages.some((v) => !/^[a-f0-9]{64}$/.test(v)) ||
        !Array.isArray(b.activeTypes) ||
        !b.activeTypes.length ||
        new Set(b.activeTypes).size !== b.activeTypes.length ||
        b.activeTypes.some((type) => !types.includes(type))))
  )
    fail("collection_cursor_invalid");
  validateTenant(
    json(await ctx.request(configUrl, { signal: ctx.signal }), configUrl),
  );
  const records = [],
    seen = new Set(),
    activeTypes = [];
  for (const type of b?.activeTypes || types) {
    const data = json(
      await ctx.request(
        listUrl,
        post(
          {
            isFrompb: "true",
            recruitType: String(type),
            pageSize: "15",
            currentPage: String(page),
            ...(keyword ? { postName: keyword } : {}),
          },
          ctx.signal,
        ),
      ),
      listUrl,
    );
    ctx.signal?.throwIfAborted();
    const native = pageRows(data, page);
    if (native.more) activeTypes.push(type);
    for (const row of native.rows) {
      if (seen.has(row.postId)) fail("parse_error");
      seen.add(row.postId);
      records.push(
        recordFor(row, type, listUrl, ctx.clock?.now?.() || Date.now()),
      );
    }
  }
  const signature = digest(JSON.stringify([...seen]));
  const seenPages = [...(b?.seenPages || [])];
  if (seenPages.includes(signature)) fail("pagination_cycle");
  seenPages.push(signature);
  const more = activeTypes.length > 0,
    limited = more && page === 20;
  return {
    records,
    raw: records.length,
    hasMore: more && !limited,
    coverageScope: limited ? "limited" : "query",
    ...(limited ? { truncationReason: "page_limit" } : {}),
    nextCursor:
      more && !limited
        ? {
            page: page + 1,
            shenzhenAirport: {
              siteId,
              tenantKey: tenant,
              queryHash,
              seenPages,
              activeTypes,
            },
          }
        : null,
    parserVersion: portal,
  };
}
export async function fetchShenzhenAirportJob(site, record, ctx) {
  config(site);
  ctx.signal?.throwIfAborted();
  const b = record.nativeRecruitmentBinding;
  if (
    record.sourceId !== site.providerId ||
    record.siteId !== siteId ||
    record.identityScope !== siteId ||
    record.kind !== "job" ||
    record.sourceRecordIdKind !== "authority" ||
    !nativeId(record.sourceRecordId) ||
    b?.portal !== portal ||
    b.siteId !== siteId ||
    b.origin !== origin ||
    b.tenantKey !== tenant ||
    b.postId !== record.sourceRecordId ||
    b.title !== record.title ||
    ![1, 2].includes(b.recruitType) ||
    record.url !== viewUrl(record.sourceRecordId, b.recruitType)
  )
    fail("detail_identity_mismatch");
  const row = json(
    await ctx.request(
      detailUrl,
      post({ postId: record.sourceRecordId }, ctx.signal),
    ),
    detailUrl,
  );
  ctx.signal?.throwIfAborted();
  validateRow(row, "detail_identity_mismatch");
  if (
    row.postId !== record.sourceRecordId ||
    row.postName.trim() !== record.title
  )
    fail("detail_identity_mismatch");
  const fresh = {
    ...record,
    ...recordFor(
      row,
      b.recruitType,
      detailUrl,
      ctx.clock?.now?.() || Date.now(),
      true,
    ),
  };
  delete fresh.applicationVerification;
  return fresh;
}
