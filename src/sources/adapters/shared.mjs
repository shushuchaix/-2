import { assertSourceRecord } from "../../domain/contracts.mjs";
export function jsonResponse(response) {
  if (response.status === 401 || response.status === 403) {
    const e = Error("restricted: HTTP " + response.status);
    e.code = "restricted";
    throw e;
  }
  if (response.status !== 200) throw Error("HTTP " + response.status);
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
    capabilities,
    configSchema: { enabled: "boolean" },
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
        for (const query of queries) {
          let pages = 0,
            truncated = false;
          const startedAt = new Date(
            ctx.clock?.now?.() || Date.now(),
          ).toISOString();
          try {
            for (
              let page = 1;
              page <= Math.min(2, query.pageLimit || 1);
              page++
            ) {
              ctx.signal?.throwIfAborted();
              const response = await listPage(site, query, page, ctx);
              pages++;
              raw += response.raw ?? response.records.length;
              issues.push(...(response.issues || []));
              const batch = [];
              for (const record of response.records) {
                try {
                  assertSourceRecord(record);
                  batch.push(record);
                } catch (e) {
                  issues.push({
                    code: "invalid_record",
                    sourceId: id,
                    siteId: site.siteId,
                    message: e.message,
                    retryable: false,
                  });
                }
              }
              records.push(...batch);
              if (batch.length) await ctx.onBatch?.(batch);
              truncated = !!response.hasMore;
              if (!response.hasMore) break;
            }
            coverage.push({
              sourceId: id,
              siteId: site.siteId,
              queries: [query.keyword],
              cities: [query.city].filter(Boolean),
              pages,
              truncated,
              status: "complete",
              startedAt,
              finishedAt: new Date().toISOString(),
            });
          } catch (e) {
            if (ctx.signal?.aborted || e.code === "workspace_write_failed")
              throw e;
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
            });
            coverage.push({
              sourceId: id,
              siteId: site.siteId,
              queries: [query.keyword],
              cities: [],
              pages,
              truncated: true,
              status: "failed",
              reason: e.code || e.message,
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
      ctx.budget?.claimDetail(
        record.sourceId + "/" + record.siteId + "/" + record.sourceRecordId,
      );
      return detail
        ? detail(record, ctx)
        : { ...record, detailStatus: "unavailable" };
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
              typeof record.description === "string" &&
              record.description.trim().length >= 30,
          });
        } catch (e) {
          result.issues.push({
            code: e.code || "detail_unavailable",
            sourceId: id,
            siteId: r.siteId,
            message: e.message,
            retryable: false,
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
