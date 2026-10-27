import { parseHTML } from "linkedom";
import { baseRecord, createPagedProvider, jsonResponse } from "./shared.mjs";
import { htmlToText, decodeEntities } from "../../util/html.mjs";
import { isVisibleHtmlElement } from "../../util/html-visibility.mjs";
import { validatePublicUrl } from "../../infrastructure/http/public-url.mjs";
import { safeSourceDiagnosticRefs } from "../source-status.mjs";

const api = "https://boards-api.greenhouse.io/v1/boards/";
const parserVersion = "greenhouse-job-board-2";
export const GREENHOUSE_LIST_RESPONSE_BYTES = 8 * 1024 * 1024;
const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
const nativeId = (value) =>
  (typeof value === "string" && /^[1-9]\d{0,29}$/.test(value)) ||
  (Number.isSafeInteger(value) && value > 0);
const date = (value) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function fail(code, response) {
  throw Object.assign(Error(code), { code, ...safeSourceDiagnosticRefs(response) });
}
function tenantFor(site) {
  if (
    !site ||
    (site.providerId != null && site.providerId !== "greenhouse") ||
    typeof site.siteId !== "string" || !site.siteId ||
    typeof site.tenantId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(site.tenantId)
  ) fail("template_not_configured");
  return site.tenantId;
}
export function greenhouseListUrl(site) {
  return api + encodeURIComponent(tenantFor(site)) + "/jobs?content=true";
}
/** A narrow configured-board exception. Importing performs no I/O. */
export function isGreenhouseContentListRequest(value, site) {
  try {
    const raw = value instanceof URL ? value.href : value;
    return typeof raw === "string" && raw === greenhouseListUrl(site);
  } catch {
    return false;
  }
}
const detailUrl = (site, id) => api + encodeURIComponent(tenantFor(site)) + "/jobs/" + id;
function visibleContent(value) {
  const { document } = parseHTML("<article></article>");
  const root = document.querySelector("article");
  root.innerHTML = decodeEntities(value || "");
  for (const node of [...root.querySelectorAll("*")])
    if (!isVisibleHtmlElement(node)) node.remove();
  return htmlToText(root.innerHTML).trim();
}
function validateRow(row, { detail = false, response } = {}) {
  if (
    !plain(row) || !nativeId(row.id) ||
    (!detail && (typeof row.title !== "string" || !row.title.trim() ||
      typeof row.absolute_url !== "string" || !row.absolute_url.trim())) ||
    ["title", "company_name", "content", "absolute_url", "first_published", "application_deadline"].some(
      (key) => row[key] != null && typeof row[key] !== "string",
    ) ||
    (row.location != null && (!plain(row.location) ||
      (row.location.name != null && typeof row.location.name !== "string")))
  ) fail("parse_error", response);
}
function jobLocation(value, site, id, response) {
  let url;
  try { url = validatePublicUrl(value); } catch { fail("parse_error", response); }
  if (url.port) fail("detail_identity_mismatch", response);
  const hostname = url.hostname.replace(/\.$/, ""),
    hosted = ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(hostname);
  if (hosted) {
    if (url.protocol !== "https:" || url.pathname !== "/" + tenantFor(site) + "/jobs/" + id)
      fail("detail_identity_mismatch", response);
    for (const [key, val] of url.searchParams) {
      if (key === "gh_jid" && val === id && url.searchParams.getAll(key).length === 1) continue;
      if (key === "gh_src" || /^utm_[a-z_]+$/i.test(key)) continue;
      fail("detail_identity_mismatch", response);
    }
    url.search = "";
    url.hash = "";
    url.hostname = hostname;
    return { url: url.href, urlKind: "job_detail", candidate: url.href, locatorKind: "hosted_job" };
  }
  // A custom company's absolute_url is documented, but its job ownership is not
  // proven by a URL. Keep a public candidate and an explicitly constructed API
  // locator; evidence.sourceUrl below always names the endpoint actually read.
  if (
    hostname === "boards-api.greenhouse.io" ||
    [...url.searchParams.keys()].some((key) =>
      /^(?:.*token|api_?key|key|uin|pass_ticket|auth(?:orization)?|cookie|ticket|signature|code|password|secret)$/i.test(key))
  ) fail("detail_identity_mismatch", response);
  if (url.searchParams.has("gh_jid") &&
    (url.searchParams.getAll("gh_jid").length !== 1 || url.searchParams.get("gh_jid") !== id))
    fail("detail_identity_mismatch", response);
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (key === "gh_src" || /^utm_[a-z_]+$/i.test(key)) url.searchParams.delete(key);
  return { url: detailUrl(site, id), urlKind: "unknown", candidate: url.href, locatorKind: "constructed_api" };
}
function recordLocation(record, site) {
  const id = record.sourceRecordId;
  if (record.url === detailUrl(site, id)) {
    if (record.urlKind !== "unknown") fail("detail_identity_mismatch");
    return { url: record.url, urlKind: "unknown", locatorKind: "constructed_api" };
  }
  const location = jobLocation(record.url, site, id);
  if (location.locatorKind !== "hosted_job") fail("detail_identity_mismatch");
  return location;
}
function normalize(row, site, previous, { response, sourceUrl, now }) {
  const id = String(row.id), suppliedUrl = row.absolute_url?.trim(),
    location = suppliedUrl ? jobLocation(suppliedUrl, site, id, response)
      : previous && recordLocation(previous, site),
    title = row.title?.trim() || previous?.title;
  if (!location || !title) fail("parse_error", response);
  const body = visibleContent(row.content), complete = !!body,
    city = row.location?.name?.trim(),
    publishedAt = date(row.first_published) || previous?.publishedAt || null,
    deadlineAt = date(row.application_deadline) || previous?.deadlineAt || null,
    candidates = suppliedUrl ? [location.candidate] : [...(previous?.applicationCandidates || [])];
  const evidence = (field, value, jsonPath, status = "verified") => ({
    field, value, status, sourceId: "greenhouse", sourceUrl,
    sourceKind: "public_api_job_row", confidence: status === "verified" ? 100 : 0,
    sourceExcerpt: String(value).slice(0, 600), location: { jsonPath },
    appliesTo: { jobRowId: id },
  });
  const result = baseRecord({
    ...previous,
    id, sourceRecordIdKind: "authority", urlKind: location.urlKind,
    sourceId: "greenhouse", siteId: site.siteId, scope: site.tenantId,
    title, company: row.company_name?.trim() || previous?.company || site.name || null,
    cities: city ? [city] : previous?.cities || [], url: location.url,
    description: body || previous?.description || null,
    publishedAt, deadlineAt,
    bodyStatus: complete ? "complete" : "incomplete",
    detailStatus: complete ? "complete" : "incomplete",
    bodyIncomplete: !complete,
    parserVersion, retrievedAt: new Date(now).toISOString(),
    applicationCandidates: candidates,
    nativeRecruitmentBinding: {
      portal: parserVersion, siteId: site.siteId, tenantId: site.tenantId, jobId: id,
      locatorKind: location.locatorKind, url: location.url,
    },
    evidence: [
      ...(previous?.evidence || []),
      ...(complete ? [{ field: "description", source: "documented public Job Board API content" }] : []),
      ...(date(row.first_published) ? [{ field: "publishedAt", source: "first_published", value: row.first_published }] : []),
    ],
    sourceEvidence: [
      ...(previous?.sourceEvidence || []).filter((item) =>
        item.sourceKind !== "public_api_job_row" ||
        item.sourceId !== "greenhouse" || item.appliesTo?.jobRowId !== id),
      evidence("sourceRecordId", id, "id"),
      ...(row.title?.trim() ? [evidence("title", title, "title")] : []),
      ...(complete ? [evidence("description", body, "content")] : []),
      ...(date(row.first_published) ? [evidence("publishedAt", publishedAt, "first_published")] : []),
      ...(date(row.application_deadline) ? [evidence("deadlineAt", deadlineAt, "application_deadline")] : []),
      ...(suppliedUrl ? [evidence("applicationCandidate", location.candidate, "absolute_url", "unknown")] : []),
    ],
  });
  // Refreshing body/identity never renews a previous application-form check.
  delete result.applicationVerification;
  return result;
}
function readResponse(response, expectedUrl) {
  const data = jsonResponse(response);
  if (response.url && response.url !== expectedUrl) fail("detail_identity_mismatch", response);
  return data;
}
export default createPagedProvider({
  id: "greenhouse",
  name: "Greenhouse 企业官网",
  parserVersion,
  conditionalPageCache: "single-public-get-v2",
  capabilities: { category: "employer", jobTypes: ["unknown"], kinds: ["job"], detail: true },
  async listPage(site, query, page, ctx) {
    // Official list API is unpaginated; content is needed for body-only matches.
    // https://developers.greenhouse.io/job-board.html#list-jobs
    const url = greenhouseListUrl(site),
      response = await ctx.request(url, { signal: ctx.signal, maxBytes: GREENHOUSE_LIST_RESPONSE_BYTES }),
      data = readResponse(response, url);
    ctx.signal?.throwIfAborted();
    if (!plain(data) || !Array.isArray(data.jobs) ||
      (data.meta != null && (!plain(data.meta) ||
        !Number.isSafeInteger(data.meta.total) || data.meta.total !== data.jobs.length)))
      fail("parse_error", response);
    const seen = new Set();
    const records = data.jobs.map((row) => {
      validateRow(row, { response });
      if (seen.has(String(row.id))) fail("parse_error", response);
      seen.add(String(row.id));
      return normalize(row, site, null, { response, sourceUrl: url, now: ctx.clock?.now?.() ?? Date.now() });
    }).filter((record) => !query.keyword ||
      (record.title + " " + (record.description || "")).toLowerCase().includes(query.keyword.toLowerCase()));
    return {
      records, raw: data.jobs.length, hasMore: false,
      issues: query.city ? [{
        code: "unsupported_filter", sourceId: "greenhouse", siteId: site.siteId,
        message: "City is not supported by this board API; geography must be checked from record evidence.", retryable: false,
      }] : [],
    };
  },
  async detail(record, ctx) {
    const sites = (ctx.sites || []).filter((site) => site.siteId === record.siteId);
    if (sites.length !== 1) fail("detail_identity_mismatch");
    const site = sites[0];
    tenantFor(site);
    if (
      record.sourceId !== "greenhouse" || record.kind !== "job" ||
      record.sourceRecordIdKind !== "authority" ||
      record.identityScope !== site.tenantId || !nativeId(record.sourceRecordId)
    ) fail("detail_identity_mismatch");
    const location = recordLocation(record, site), binding = record.nativeRecruitmentBinding;
    if (binding && (
      binding.portal !== parserVersion || binding.siteId !== site.siteId ||
      binding.tenantId !== site.tenantId || binding.jobId !== record.sourceRecordId ||
      binding.url !== location.url || binding.locatorKind !== location.locatorKind
    )) fail("detail_identity_mismatch");
    const url = detailUrl(site, record.sourceRecordId),
      response = await ctx.request(url, { signal: ctx.signal }),
      row = readResponse(response, url);
    ctx.signal?.throwIfAborted();
    if (!plain(row) || String(row.id) !== record.sourceRecordId) fail("detail_identity_mismatch", response);
    validateRow(row, { detail: true, response });
    return normalize(row, site, record, { response, sourceUrl: url, now: ctx.clock?.now?.() ?? Date.now() });
  },
});
