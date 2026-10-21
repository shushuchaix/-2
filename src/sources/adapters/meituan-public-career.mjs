import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { baseRecord } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { isVisibleHtmlElement } from "../../util/html-visibility.mjs";
import { assessApplicationResponse } from "../../domain/recruitment-evidence.mjs";

const origin = "https://zhaopin.meituan.com";
const portal = "meituan-public-career-1";
const listUrl = origin + "/api/official/job/getJobList";
const detailUrl = origin + "/api/official/job/getJobDetail";
const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const fail = (code) => {
  throw Object.assign(Error(code), { code, retryable: false });
};
const viewUrl = (value) =>
  origin +
  "/web/position/detail?jobUnionId=" +
  encodeURIComponent(value) +
  "&jobShareType=1";

export function isMeituanPublicTemplateConfigured(site) {
  let base;
  try {
    base = new URL(site?.origin);
  } catch {
    /* Exact public portal required. */
  }
  return Boolean(
    site?.siteId === "meituan" &&
      site.providerId === "official-announcements" &&
      base?.origin === origin &&
      ["/", "/web/campus"].includes(base.pathname) &&
      !base.search &&
      !base.hash &&
      site.template?.nativePortal === portal &&
      site.template.listUrl === listUrl &&
      Array.isArray(site.allowedDomains) &&
      site.allowedDomains.includes("zhaopin.meituan.com"),
  );
}
function config(site) {
  if (!isMeituanPublicTemplateConfigured(site)) fail("template_not_configured");
}
function json(response, url) {
  if ([401, 403].includes(response.status)) fail("restricted");
  if (response.status !== 200)
    throw Object.assign(Error("Public career HTTP failure"), {
      code: "http_error",
      status: response.status,
    });
  if (response.url && response.url !== url) fail("detail_identity_mismatch");
  let value;
  try {
    value = JSON.parse(response.text);
  } catch {
    if (assessApplicationResponse(response, null).challenge) fail("captcha");
    fail("parse_error");
  }
  if (!plain(value) || value.status !== 1 || !plain(value.data))
    fail("parse_error");
  return value.data;
}
function rowValid(row, code = "parse_error") {
  if (
    !plain(row) ||
    !id(row.jobUnionId) ||
    typeof row.name !== "string" ||
    !row.name.trim() ||
    !["1", "2", "3"].includes(row.jobType) ||
    typeof row.jobStatus !== "string" ||
    !Array.isArray(row.cityList) ||
    row.cityList.length > 100 ||
    row.cityList.some(
      (city) => !plain(city) || typeof city.name !== "string",
    ) ||
    ["jobDuty", "jobRequirement"].some(
      (key) => row[key] != null && typeof row[key] !== "string",
    )
  )
    fail(code);
}
function visible(value) {
  const { document } = parseHTML("<article>" + (value || "") + "</article>");
  const root = document.querySelector("article");
  for (const node of [...root.querySelectorAll("*")])
    if (!isVisibleHtmlElement(node)) node.remove();
  return htmlToText(root.innerHTML).trim();
}
function recordFor(site, row, endpoint, now) {
  const duties = visible(row.jobDuty),
    requirements = visible(row.jobRequirement);
  const title = row.name.trim(),
    url = viewUrl(row.jobUnionId);
  const incomplete = duties.length < 15 || requirements.length < 15;
  const evidence = (field, value, jsonPath, status = "verified") => ({
    field,
    value,
    sourceId: site.providerId,
    sourceUrl: endpoint,
    sourceKind: "public_api_job_row",
    status,
    confidence: status === "verified" ? 100 : 0,
    sourceExcerpt: String(value).slice(0, 600),
    location: { jsonPath },
    appliesTo: { jobRowId: row.jobUnionId },
  });
  return baseRecord({
    id: row.jobUnionId,
    sourceRecordIdKind: "authority",
    sourceId: site.providerId,
    siteId: site.siteId,
    scope: site.siteId,
    kind: "job",
    title,
    url,
    urlKind: "job_detail",
    company: site.name,
    cities: [
      ...new Set(row.cityList.map((city) => city.name.trim()).filter(Boolean)),
    ],
    jobType: { 1: "campus", 2: "internship", 3: "social" }[row.jobType],
    description: "岗位职责：\n" + duties + "\n任职要求：\n" + requirements,
    publishedAt: null,
    deadlineAt: null,
    closed: row.jobStatus === "001",
    sourceRecruitmentStatus:
      row.jobStatus === "000"
        ? "in_recruitment"
        : row.jobStatus === "001"
          ? "offline"
          : "unknown",
    // Status and refreshTime do not supply a recruitment window or a usable
    // application. Keep the native view as a public candidate, with no login RPC.
    applyUrl: null,
    applicationCandidates: [url],
    bodyStatus: incomplete ? "incomplete" : "complete",
    detailStatus: incomplete ? "incomplete" : "complete",
    bodyIncomplete: incomplete,
    attachments: [],
    attachmentBodyPending: false,
    parserVersion: portal,
    sourceEvidence: [
      evidence("sourceRecordId", row.jobUnionId, "jobUnionId"),
      evidence("title", title, "name"),
      evidence("duties", duties, "jobDuty"),
      evidence("requirements", requirements, "jobRequirement"),
      evidence("recruitmentStatus", row.jobStatus, "jobStatus"),
      evidence("applicationCandidate", url, "jobUnionId", "unknown"),
    ],
    nativeRecruitmentBinding: {
      portal,
      siteId: site.siteId,
      origin,
      jobUnionId: row.jobUnionId,
      title,
      checkedAt: new Date(now).toISOString(),
    },
  });
}
const post = (body, signal) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  signal,
});
export async function collectMeituanPublicJobs(site, query, page, ctx) {
  config(site);
  ctx.signal?.throwIfAborted();
  const keyword = query?.keyword || "",
    cursor = ctx.cursor;
  if (
    typeof keyword !== "string" ||
    keyword.length > 99 ||
    /[\u0000-\u001f]/.test(keyword)
  )
    fail("collection_query_invalid");
  const queryHash = createHash("sha256").update(keyword).digest("hex");
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 20 ||
    (page > 1 && !cursor) ||
    (cursor &&
      (cursor.page !== page ||
        cursor.meituan?.siteId !== site.siteId ||
        cursor.meituan.origin !== origin ||
        cursor.meituan.queryHash !== queryHash ||
        !Array.isArray(cursor.meituan.seenPages) ||
        cursor.meituan.seenPages.length !== page - 1 ||
        cursor.meituan.seenPages.some(
          (value) => !/^[a-f0-9]{64}$/.test(value),
        )))
  )
    fail("collection_cursor_invalid");
  const body = {
    page: { pageNo: page, pageSize: 10 },
    jobShareType: "1",
    keywords: keyword,
    cityList: [],
    department: [],
    jfJgList: [],
    jobType: [],
    typeCode: [],
    specialCode: [],
    u_query_id: "",
    r_query_id: "",
  };
  const data = json(
      await ctx.request(listUrl, post(body, ctx.signal)),
      listUrl,
    ),
    p = data.page;
  ctx.signal?.throwIfAborted();
  if (
    !plain(p) ||
    p.pageNo !== page ||
    p.pageSize !== 10 ||
    !Number.isSafeInteger(p.totalCount) ||
    p.totalCount < 0 ||
    p.totalPage !== Math.ceil(p.totalCount / 10) ||
    !Array.isArray(data.list) ||
    data.list.length !==
      Math.min(10, Math.max(0, p.totalCount - (page - 1) * 10))
  )
    fail("parse_error");
  const seen = new Set();
  for (const row of data.list) {
    rowValid(row);
    if (seen.has(row.jobUnionId)) fail("parse_error");
    seen.add(row.jobUnionId);
  }
  const signature = createHash("sha256")
    .update(JSON.stringify([...seen]))
    .digest("hex");
  const seenPages = [...(cursor?.meituan.seenPages || [])];
  if (seenPages.includes(signature)) fail("pagination_cycle");
  seenPages.push(signature);
  const more = page < p.totalPage,
    limited = more && page === 20;
  return {
    records: data.list.map((row) =>
      recordFor(site, row, listUrl, ctx.clock?.now?.() || Date.now()),
    ),
    raw: data.list.length,
    hasMore: more && !limited,
    coverageScope: limited ? "limited" : "query",
    ...(limited ? { truncationReason: "page_limit" } : {}),
    nextCursor:
      more && !limited
        ? {
            page: page + 1,
            meituan: { siteId: site.siteId, origin, queryHash, seenPages },
          }
        : null,
    parserVersion: portal,
  };
}
export async function fetchMeituanPublicJob(site, record, ctx) {
  config(site);
  ctx.signal?.throwIfAborted();
  const b = record.nativeRecruitmentBinding;
  if (
    record.sourceId !== site.providerId ||
    record.siteId !== site.siteId ||
    record.identityScope !== site.siteId ||
    record.sourceRecordIdKind !== "authority" ||
    !id(record.sourceRecordId) ||
    record.url !== viewUrl(record.sourceRecordId) ||
    b?.portal !== portal ||
    b.siteId !== site.siteId ||
    b.origin !== origin ||
    b.jobUnionId !== record.sourceRecordId ||
    b.title !== record.title
  )
    fail("detail_identity_mismatch");
  const row = json(
    await ctx.request(
      detailUrl,
      post(
        { jobUnionId: record.sourceRecordId, jobShareType: "1" },
        ctx.signal,
      ),
    ),
    detailUrl,
  );
  ctx.signal?.throwIfAborted();
  rowValid(row, "detail_identity_mismatch");
  if (
    row.jobUnionId !== record.sourceRecordId ||
    row.name.trim() !== record.title
  )
    fail("detail_identity_mismatch");
  const fresh = {
    ...record,
    ...recordFor(site, row, detailUrl, ctx.clock?.now?.() || Date.now()),
  };
  delete fresh.applicationVerification;
  return fresh;
}
