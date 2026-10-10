import { assertSourceRecord } from "../../domain/contracts.mjs";
import { recordDiagnostic } from "../../infrastructure/diagnostics/log.mjs";
import { parseHTML } from "linkedom";
import { validatePublicUrl } from "../../infrastructure/http/public-url.mjs";

export function extractApplicationLinks(html, { baseUrl, record }) {
  const { document } = parseHTML(String(html || ""));
  for (const node of document.querySelectorAll(
    'script,style,nav,header,footer,[hidden],[aria-hidden="true"]',
  ))
    node.remove();
  const entries = new Map();
  const add = (href, label, sourceKind) => {
    try {
      const url = validatePublicUrl(new URL(href, baseUrl).href);
      if (
        /login|signin|captcha/i.test(url.pathname) ||
        [...url.searchParams.keys()].some((k) =>
          /token|secret|signature|sign$|password|session|cookie|auth|ticket/i.test(
            k,
          ),
        )
      )
        return;
      entries.set(url.href, {
        field: "applyUrl",
        value: url.href,
        sourceId: record.sourceId,
        sourceUrl: baseUrl,
        sourceKind,
        sourceExcerpt: label.slice(0, 300),
        status: "unknown",
        location: {
          selector: sourceKind === "public_anchor" ? "a[href]" : "p,li",
        },
      });
    } catch {}
  };
  for (const anchor of document.querySelectorAll("a[href]")) {
    const label = anchor.textContent.trim(),
      href = anchor.getAttribute("href");
    if (
      !/报名|投递|应聘|申请职位|提交申请/.test(label) ||
      /登录|验证码|导航|指南|说明/.test(label) ||
      !href ||
      href.startsWith("#")
    )
      continue;
    add(href, label, "public_anchor");
  }
  for (const paragraph of document.querySelectorAll("p,li")) {
    const text = paragraph.textContent;
    if (
      !/(?:报名|投递|应聘)[^。\n]{0,100}(?:网站|网址|地址)|(?:网站|网址|地址)[^。\n]{0,100}(?:报名|投递|应聘)/.test(
        text,
      )
    )
      continue;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'（）。，；]+/g))
      add(match[0], text, "public_text_entry");
  }
  return {
    applyUrl: entries.size === 1 ? [...entries.keys()][0] : null,
    sourceEvidence: [...entries.values()],
  };
}
const coverageReasons = {
  listing_only: "仅采集当前列表页，尚未支持历史分页。",
  page_limit: "已达到本次查询分页上限。",
  request_budget: "本次来源请求预算已用完。",
};
export function jsonResponse(response) {
  if (response.status === 401 || response.status === 403) {
    const e = Error("restricted: HTTP " + response.status);
    e.code = "restricted";
    e.status = response.status;
    throw e;
  }
  if (response.status !== 200)
    throw Object.assign(Error("HTTP " + response.status), {
      status: response.status,
    });
  if (
    /captcha|人机验证|访问过于频繁|<title>[^<]*验证码/i.test(
      response.text?.slice(0, 1500) || "",
    )
  ) {
    const e = Error("captcha");
    e.code = "captcha";
    throw e;
  }
  try {
    return JSON.parse(response.text);
  } catch {
    const e = Error("parse_error: invalid JSON");
    e.code = "parse_error";
    e.phase = "parse";
    e.requestId = response.requestId;
    e.parser = {
      format: "json",
      resultType: "unknown",
      documentLength: String(response.text || "").length,
    };
    throw e;
  }
}
export function baseRecord({
  id,
  sourceId,
  siteId,
  scope,
  title,
  url,
  kind = "job",
  company = null,
  description = null,
  jobType = "unknown",
  ...fields
}) {
  return {
    sourceRecordId: id == null ? null : String(id),
    sourceRecordIdKind: "hint",
    urlKind: "unknown",
    sourceId,
    siteId,
    identityScope: scope || siteId,
    kind,
    title: String(title || "").trim(),
    company,
    cities: [],
    jobType,
    graduationYear: null,
    level: null,
    url,
    applyUrl: null,
    description,
    degree: null,
    experience: null,
    requiredCertificates: [],
    deadlineAt: null,
    publishedAt: null,
    salary: null,
    evidence: [],
    parserVersion: sourceId + "-1",
    ...fields,
  };
}
export function createPagedProvider({
  id,
  name,
  capabilities,
  listPage,
  detail,
}) {
  const provider = {
    id,
    name,
    capabilities: {
      resumablePages: true,
      body: !!detail,
      attachments: false,
      ...capabilities,
    },
    configSchema: { enabled: "boolean" },
    async collectPage(input) {
      const { site, query = {}, cursor = null, context = {} } = input;
      const page = cursor?.page ?? 1;
      if (!Number.isSafeInteger(page) || page < 1 || page > 20)
        throw Object.assign(Error("Invalid collection page"), {
          code: "collection_cursor_invalid",
        });
      const ctx = {
        ...context,
        ...input,
        sites: context.sites || [site],
        page,
        cursor,
      };
      const response = await listPage(site, query, page, ctx);
      const limited = response.coverageScope === "limited";
      const done = limited || !response.hasMore;
      return {
        ...response,
        records: response.records || [],
        issues: response.issues || [],
        done,
        nextCursor: done ? null : response.nextCursor || { page: page + 1 },
        parserVersion: id + "-1",
      };
    },
    async collect(ctx) {
      const records = [],
        issues = [],
        coverage = [];
      let raw = 0;
      for (const site of ctx.sites || []) {
        const queries = (ctx.queries || []).filter(
          (q) => !q.siteId || q.siteId === site.siteId,
        );
        if (!queries.length) queries.push({ keyword: "", pageLimit: 1 });
        for (const [localQueryIndex, query] of queries.entries()) {
          let pages = 0,
            truncated = false,
            coverageScope,
            truncationReason,
            currentPage = 1,
            cursor = null;
          const queryIndex = ctx.queryIndex ?? localQueryIndex;
          const pageDiagnostic = (event, error) =>
            ctx.reportDiagnostic
              ? recordDiagnostic(ctx.reportDiagnostic, event, error)
              : recordDiagnostic(ctx.diagnostics, event, error);
          const startedAt = new Date(
            ctx.clock?.now?.() || Date.now(),
          ).toISOString();
          try {
            for (
              let page = 1;
              page <= Math.min(20, query.pageLimit || 1);
              page++
            ) {
              currentPage = page;
              ctx.signal?.throwIfAborted();
              const location = {
                runId: ctx.runId,
                sourceId: id,
                siteId: site.siteId,
                queryIndex,
                page,
              };
              const pageStarted = ctx.clock?.now?.() ?? Date.now();
              const response = await listPage(site, query, page, {
                ...ctx,
                queryIndex,
                page,
                cursor,
                request:
                  ctx.request &&
                  ((url, options = {}) =>
                    ctx.request(url, {
                      ...options,
                      diagnosticContext: {
                        ...options.diagnosticContext,
                        ...location,
                        endpointKind: "list",
                      },
                    })),
              });
              pages++;
              cursor = response.nextCursor || { page: page + 1 };
              raw += response.raw ?? response.records.length;
              for (const issue of response.issues || []) {
                const entry = await ctx.reportError?.(
                  Object.assign(Error(issue.message || issue.code), {
                    code: issue.code,
                  }),
                  location,
                );
                issues.push({
                  ...issue,
                  ...(entry ? { diagnosticId: entry.diagnosticId } : {}),
                });
              }
              const batch = [];
              for (const record of response.records) {
                try {
                  assertSourceRecord(record);
                  batch.push(record);
                } catch (e) {
                  const entry = await ctx.reportError?.(e, location);
                  issues.push({
                    code: "invalid_record",
                    sourceId: id,
                    siteId: site.siteId,
                    message: e.message,
                    retryable: false,
                    ...(entry ? { diagnosticId: entry.diagnosticId } : {}),
                  });
                }
              }
              records.push(...batch);
              if (batch.length) await ctx.onBatch?.(batch);
              const limited = response.coverageScope === "limited";
              await pageDiagnostic({
                operation: "run.page",
                ...location,
                phase: "parse",
                outcome: batch.length ? "success" : "empty",
                durationMs: Math.max(
                  0,
                  (ctx.clock?.now?.() ?? Date.now()) - pageStarted,
                ),
                pageLimit: Math.min(20, query.pageLimit || 1),
                truncationReason: limited
                  ? "listing_only"
                  : response.hasMore &&
                      page === Math.min(20, query.pageLimit || 1)
                    ? "page_limit"
                    : undefined,
                counts: {
                  raw: response.raw ?? response.records.length,
                  accepted: batch.length,
                  rejected:
                    response.records.length -
                    batch.length +
                    (response.issues || []).filter(
                      (issue) => issue.code === "invalid_record",
                    ).length,
                },
                issueCount:
                  (response.issues || []).length +
                  response.records.length -
                  batch.length,
                parser: {
                  version: id + "-1",
                  resultCount: response.records.length,
                },
              });
              truncated = limited || !!response.hasMore;
              coverageScope = limited ? "limited" : undefined;
              truncationReason = limited
                ? "listing_only"
                : response.hasMore
                  ? "page_limit"
                  : undefined;
              if (limited || !response.hasMore) break;
            }
            coverage.push({
              sourceId: id,
              siteId: site.siteId,
              queries: [query.keyword],
              cities: [query.city].filter(Boolean),
              pages,
              truncated,
              ...(coverageScope ? { coverageScope } : {}),
              ...(truncationReason
                ? {
                    truncationReason,
                    reason: coverageReasons[truncationReason],
                  }
                : {}),
              status: "complete",
              startedAt,
              finishedAt: new Date().toISOString(),
            });
          } catch (e) {
            if (
              ctx.signal?.aborted ||
              e.runFatal ||
              e.code === "workspace_write_failed"
            )
              throw e;
            const requestBudgetExhausted =
              e.code === "source_budget_exhausted" &&
              e.budgetKind === "requests";
            const entry = await ctx.reportError?.(e, {
              sourceId: id,
              siteId: site.siteId,
              queryIndex,
              page: currentPage,
              requestId: e.requestId,
              parser: e.parser,
            });
            await pageDiagnostic({
              operation: "run.page",
              runId: ctx.runId,
              sourceId: id,
              siteId: site.siteId,
              queryIndex,
              page: currentPage,
              phase: e.phase || "parse",
              outcome: "failed",
              code: e.code,
              parser: e.parser,
              truncationReason: requestBudgetExhausted
                ? "request_budget"
                : undefined,
            });
            issues.push({
              code:
                e.code ||
                (/budget_exhausted/.test(e.message)
                  ? "budget_exhausted"
                  : "unavailable"),
              sourceId: id,
              siteId: site.siteId,
              message: e.message,
              retryable: !e.code,
              ...(entry ? { diagnosticId: entry.diagnosticId } : {}),
            });
            coverage.push({
              sourceId: id,
              siteId: site.siteId,
              queries: [query.keyword],
              cities: [],
              pages,
              truncated: true,
              ...(requestBudgetExhausted
                ? { truncationReason: "request_budget" }
                : {}),
              status: "failed",
              reason: requestBudgetExhausted
                ? coverageReasons.request_budget
                : e.code || e.message,
              startedAt,
              finishedAt: new Date().toISOString(),
            });
          }
        }
      }
      return {
        records,
        issues,
        coverage,
        stats: { raw, parsed: records.length, accepted: records.length },
      };
    },
    async fetchDetail(record, ctx) {
      ctx.signal?.throwIfAborted();
      await ctx.budget?.claimDetail(
        record.sourceId + "/" + record.siteId + "/" + record.sourceRecordId,
      );
      if (!detail) return { ...record, detailStatus: "unavailable" };
      // An old failed attempt must not survive a fresh detail response.
      const freshRecord = { ...record };
      for (const field of [
        "bodyStatus",
        "retryEligible",
        "detailStatus",
        "retryAt",
        "nextDueAt",
      ])
        delete freshRecord[field];
      const result = await detail(freshRecord, {
        ...ctx,
        request:
          ctx.request &&
          ((url, options = {}) =>
            ctx.request(url, {
              ...options,
              diagnosticContext: {
                ...options.diagnosticContext,
                runId: ctx.runId,
                sourceId: id,
                siteId: record.siteId,
                endpointKind: "detail",
              },
            })),
      });
      if (
        result.detailStatus === "complete" &&
        (!result.bodyStatus || result.bodyStatus === "complete") &&
        (typeof result.description !== "string" ||
          result.description.trim().length === 0)
      )
        throw Object.assign(
          new Error("Detail response has insufficient body content"),
          {
            code: "detail_insufficient",
            retryable: false,
          },
        );
      if (
        result.detailStatus === "complete" &&
        typeof result.description === "string" &&
        result.description.trim().length > 0 &&
        (!result.bodyStatus || result.bodyStatus === "complete") &&
        !result.bodyIncomplete &&
        !result.rowAmbiguous
      )
        return { ...result, bodyStatus: "complete", retryEligible: false };
      return result;
    },
    async probe(ctx) {
      const result = await provider.collect({
        ...ctx,
        onBatch: undefined,
        queries: (ctx.queries || [{ keyword: "", pageLimit: 1 }])
          .slice(0, 1)
          .map((q) => ({ ...q, pageLimit: 1 })),
      });
      const evidence = [];
      for (const r of result.records.slice(0, 2)) {
        try {
          const record = await provider.fetchDetail(r, ctx);
          evidence.push({
            sourceRecordId: record.sourceRecordId,
            title: record.title,
            url: record.url,
            kind: record.kind,
            jobType: record.jobType,
            hasRequirements:
              (!record.bodyStatus || record.bodyStatus === "complete") &&
              typeof record.description === "string" &&
              record.description.trim().length >= 30,
          });
        } catch (e) {
          const entry = await ctx.reportError?.(e, {
            sourceId: id,
            siteId: r.siteId,
          });
          result.issues.push({
            code: e.code || "detail_unavailable",
            sourceId: id,
            siteId: r.siteId,
            message: e.message,
            retryable: false,
            ...(entry ? { diagnosticId: entry.diagnosticId } : {}),
          });
        }
      }
      const ready = evidence.some(
        (e) => e.sourceRecordId && e.title && e.url && e.hasRequirements,
      );
      return {
        sourceId: id,
        siteId: ctx.sites?.[0]?.siteId || id,
        status: ready
          ? "ready"
          : result.issues.some((e) =>
                ["restricted", "captcha"].includes(e.code),
              )
            ? "restricted"
            : result.issues.length
              ? "unavailable"
              : result.records.length
                ? "parse_error"
                : "empty",
        sampleCount: result.records.length,
        checkedAt: new Date().toISOString(),
        issues: result.issues,
        evidence,
        budget: ctx.budget?.snapshot?.(),
      };
    },
  };
  return provider;
}
