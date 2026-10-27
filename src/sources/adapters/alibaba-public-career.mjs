import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { baseRecord } from "./shared.mjs";
import { htmlToText } from "../../util/html.mjs";
import { isVisibleHtmlElement } from "../../util/html-visibility.mjs";
import { assessApplicationResponse } from "../../domain/recruitment-evidence.mjs";
import {
  buildAlibabaPublicSearchRequest,
  ALIBABA_PUBLIC_LIST,
} from "./alibaba-public-read.mjs";
import { safeSourceDiagnosticRefs } from "../source-status.mjs";

const origin = "https://talent.alibaba.com",
  portal = "alibaba-public-career-1";
const fail = (code) => {
  throw Object.assign(Error(code), { code, retryable: false });
};
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
const digest = (v) => createHash("sha256").update(v).digest("hex");
const id = (v) => Number.isSafeInteger(v) && v > 0;
const keywordValid = (v) =>
  typeof v === "string" && v.length <= 99 && !/[\u0000-\u001f]/.test(v);
const viewUrl = (id) => origin + "/off-campus/position-detail?positionId=" + id;
function config(site) {
  let url;
  try {
    url = new URL(site?.origin);
  } catch {}
  if (
    site?.siteId !== "alibaba" ||
    site.providerId !== "official-announcements" ||
    site.name !== "阿里巴巴" ||
    url?.href !== origin + "/" ||
    site.template?.nativePortal !== portal ||
    site.template.listUrl !== ALIBABA_PUBLIC_LIST ||
    !site.allowedDomains?.includes("talent.alibaba.com")
  )
    fail("template_not_configured");
}
function gate(response) {
  if ([401, 403, 412].includes(response.status)) fail("restricted");
  if (response.status === 429) fail("rate_limited");
  if (response.status !== 200)
    throw Object.assign(Error("Public recruitment HTTP failure"), {
      code: "http_error",
      status: response.status,
      retryable: false,
    });
  if (assessApplicationResponse(response, null).challenge) fail("captcha");
}
function visible(value) {
  const { document } = parseHTML("<article>" + (value || "") + "</article>"),
    root = document.querySelector("article");
  for (const node of [...root.querySelectorAll("*")])
    if (!isVisibleHtmlElement(node)) node.remove();
  return htmlToText(root.innerHTML).trim();
}
function rowValid(row) {
  if (
    !plain(row) ||
    !id(row.id) ||
    typeof row.name !== "string" ||
    !row.name.trim() ||
    row.name.length > 500 ||
    !Array.isArray(row.workLocations) ||
    row.workLocations.length > 100 ||
    row.workLocations.some((v) => typeof v !== "string" || v.length > 200) ||
    ["description", "requirement"].some(
      (k) => row[k] != null && typeof row[k] !== "string",
    ) ||
    typeof row.positionUrl !== "string"
  )
    fail("parse_error");
  let url;
  try {
    url = new URL(row.positionUrl, origin);
  } catch {
    fail("parse_error");
  }
  if (
    url.origin !== origin ||
    url.pathname !== "/off-campus/position-detail" ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("positionId").length !== 1 ||
    url.searchParams.get("positionId") !== String(row.id) ||
    [...url.searchParams.keys()].some(
      (k) => !["positionId", "track_id"].includes(k),
    )
  )
    fail("parse_error");
}
async function readList(site, keyword, page, ctx) {
  const fresh = await ctx.request(origin + "/", { signal: ctx.signal });
  gate(fresh);
  let built;
  try {
    built = buildAlibabaPublicSearchRequest({ siteId: site.siteId, query: keyword, page, response: fresh });
  } catch (error) {
    // Only bounded public correlation and fixed contract metadata survive.
    const requestId = safeSourceDiagnosticRefs(fresh).requestId;
    if (error?.code === "native_transport_contract_mismatch" && requestId) error.requestId = requestId;
    throw error;
  }
  const { url, ...options } = built;
  const response = await ctx.request(url, { ...options, signal: ctx.signal });
  ctx.signal?.throwIfAborted();
  gate(response);
  if (response.url && response.url !== url) fail("detail_identity_mismatch");
  let value;
  try {
    value = JSON.parse(response.text);
  } catch {
    fail("parse_error");
  }
  if (value?.success === false && value.errorCode === "LOGIN_EXPIRED")
    fail("login_required");
  const p = value?.content;
  if (
    value?.success !== true ||
    !plain(p) ||
    !Array.isArray(p.datas) ||
    !Number.isSafeInteger(p.totalCount) ||
    p.totalCount < 0 ||
    p.currentPage !== page ||
    p.pageSize !== 10 ||
    p.datas.length !== Math.min(10, Math.max(0, p.totalCount - (page - 1) * 10))
  )
    fail("parse_error");
  const seen = new Set();
  for (const row of p.datas) {
    rowValid(row);
    if (seen.has(row.id)) fail("parse_error");
    seen.add(row.id);
  }
  return p;
}
function recordFor(site, row, keyword, page, now) {
  const duties = visible(row.description),
    requirements = visible(row.requirement),
    complete = duties.length >= 15 && requirements.length >= 15;
  const title = row.name.trim(),
    url = viewUrl(row.id),
    description = "岗位职责：\n" + duties + "\n任职要求：\n" + requirements;
  const evidence = (field, value, jsonPath, status = "verified") => ({
    field,
    value,
    status,
    sourceId: site.providerId,
    sourceUrl: ALIBABA_PUBLIC_LIST,
    sourceKind: "public_api_job_row",
    confidence: status === "verified" ? 100 : 0,
    sourceExcerpt: String(value).slice(0, 600),
    location: { jsonPath },
    appliesTo: { jobRowId: String(row.id) },
  });
  const date =
    Number.isSafeInteger(row.publishTime) &&
    row.publishTime >= 946684800000 &&
    row.publishTime <= now
      ? new Date(row.publishTime).toISOString()
      : null;
  return baseRecord({
    id: row.id,
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
      ...new Set(row.workLocations.map((v) => v.trim()).filter(Boolean)),
    ],
    jobType: "social",
    description,
    publishedAt: date,
    deadlineAt: null,
    applyUrl: null,
    applicationCandidates: [url],
    attachments: [],
    attachmentBodyPending: false,
    bodyStatus: complete ? "complete" : "incomplete",
    detailStatus: complete ? "complete" : "incomplete",
    bodyIncomplete: !complete,
    parserVersion: portal,
    retrievedAt: new Date(now).toISOString(),
    sourceEvidence: [
      evidence("sourceRecordId", String(row.id), "id"),
      evidence("title", title, "name"),
      evidence("duties", duties, "description"),
      evidence("requirements", requirements, "requirement"),
      ...(complete
        ? [evidence("description", description, "description,requirement")]
        : []),
      ...(date ? [evidence("publishedAt", date, "publishTime")] : []),
      evidence("applicationCandidate", url, "positionUrl", "unknown"),
    ],
    nativeRecruitmentBinding: {
      portal,
      siteId: site.siteId,
      origin,
      jobId: String(row.id),
      title,
      keyword,
      page,
      checkedAt: new Date(now).toISOString(),
    },
  });
}
export async function collectAlibabaPublicJobs(site, query, page, ctx) {
  config(site);
  ctx.signal?.throwIfAborted();
  const keyword = query?.keyword || "",
    wanted = ctx.targetSnapshot?.jobTypes || [];
  if (!keywordValid(keyword) || !Array.isArray(wanted))
    fail("collection_query_invalid");
  if (wanted.length && !wanted.includes("social"))
    return {
      records: [],
      raw: 0,
      hasMore: false,
      nextCursor: null,
      coverageScope: "limited",
      truncationReason: "listing_only",
      parserVersion: portal,
    };
  const queryHash = digest(keyword),
    cursor = ctx.cursor,
    b = cursor?.alibaba;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 20 ||
    (page > 1 && !cursor) ||
    (cursor &&
      (cursor.page !== page ||
        b?.siteId !== site.siteId ||
        b.origin !== origin ||
        b.queryHash !== queryHash ||
        !Array.isArray(b.seenPages) ||
        b.seenPages.length !== page - 1 ||
        b.seenPages.some((v) => !/^[a-f0-9]{64}$/.test(v))))
  )
    fail("collection_cursor_invalid");
  const p = await readList(site, keyword, page, ctx),
    signature = digest(JSON.stringify(p.datas.map((row) => row.id))),
    seenPages = [...(b?.seenPages || [])];
  if (seenPages.includes(signature)) fail("pagination_cycle");
  seenPages.push(signature);
  const more = page * 10 < p.totalCount,
    limited = more && page === 20;
  return {
    records: p.datas.map((row) =>
      recordFor(site, row, keyword, page, ctx.clock?.now?.() || Date.now()),
    ),
    raw: p.datas.length,
    hasMore: more && !limited,
    coverageScope: limited ? "limited" : "query",
    ...(limited ? { truncationReason: "page_limit" } : {}),
    nextCursor:
      more && !limited
        ? {
            page: page + 1,
            alibaba: { siteId: site.siteId, origin, queryHash, seenPages },
          }
        : null,
    parserVersion: portal,
  };
}
export async function fetchAlibabaPublicJob(site, record, ctx) {
  config(site);
  ctx.signal?.throwIfAborted();
  const b = record.nativeRecruitmentBinding;
  if (
    record.sourceId !== site.providerId ||
    record.siteId !== site.siteId ||
    record.identityScope !== site.siteId ||
    record.kind !== "job" ||
    record.sourceRecordIdKind !== "authority" ||
    !/^\d+$/.test(record.sourceRecordId || "") ||
    b?.portal !== portal ||
    b.siteId !== site.siteId ||
    b.origin !== origin ||
    b.jobId !== record.sourceRecordId ||
    b.title !== record.title ||
    !keywordValid(b.keyword) ||
    !Number.isSafeInteger(b.page) ||
    b.page < 1 ||
    b.page > 20 ||
    record.url !== viewUrl(record.sourceRecordId)
  )
    fail("detail_identity_mismatch");
  const page = await readList(site, b.keyword, b.page, ctx),
    row = page.datas.find((row) => String(row.id) === record.sourceRecordId);
  if (!row || row.name.trim() !== record.title)
    fail("detail_identity_mismatch");
  const fresh = {
    ...record,
    ...recordFor(
      site,
      row,
      b.keyword,
      b.page,
      ctx.clock?.now?.() || Date.now(),
    ),
  };
  delete fresh.applicationVerification;
  return fresh;
}
