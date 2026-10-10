import { searchAll } from "../searchapi.mjs";
import { withSourceContext } from "../request-context.mjs";
import { normalizeRecord } from "../../domain/record.mjs";
export function createSocialDiscoveryProvider(id, name, domains) {
  return {
    id,
    name,
    capabilities: {
      category: "social_discovery",
      jobTypes: ["unknown"],
      kinds: ["recruitment_notice"],
      detail: false,
      discovery: true,
    },
    configSchema: { enabled: "boolean" },
    async collect(ctx) {
      const cfg = ctx.config || {},
        siteId = ctx.sites?.[0]?.siteId || id;
      if (!cfg.__activeSearchProvider)
        return {
          records: [],
          issues: [
            {
              code: "missing_search_key",
              sourceId: id,
              siteId,
              message: "需要配置搜索 API；也可粘贴平台正文导入。",
              retryable: false,
            },
          ],
          coverage: [
            {
              sourceId: id,
              siteId,
              status: "skipped",
              truncated: true,
              queries: [],
              cities: [],
              pages: 0,
              reason: "missing_key",
            },
          ],
          stats: { raw: 0, parsed: 0, accepted: 0 },
        };
      const queries = (ctx.queries || []).flatMap((q) =>
        domains.map((domain) => "site:" + domain + " " + q.keyword + " 招聘"),
      );
      const result = await withSourceContext(ctx, () =>
        searchAll(queries, {
          provider: cfg.__activeSearchProvider,
          apiKey: cfg.__searchKeys[cfg.__activeSearchProvider],
          maxResults: 10,
          signal: ctx.signal,
        }),
      );
      const records = result.jobs.map((j) =>
        normalizeRecord({
          ...j,
          sourceId: id,
          sourceRecordIdKind: "hint",
          urlKind: "unknown",
          siteId,
          identityScope: id,
          kind: "recruitment_notice",
          jobType: "unknown",
          platform: id,
          account: null,
          sourceUrl: j.url,
          publishedAt: null,
          retrievedAt: new Date().toISOString(),
          evidenceLevel: "discovery",
          accessStatus: "search_metadata",
          officialIdentity: "unverified",
          parserVersion: "social-discovery-1",
        }),
      );
      if (records.length) await ctx.onBatch?.(records);
      return {
        records,
        issues: (result.errors || []).map((message) => ({
          code: "discovery_error",
          sourceId: id,
          siteId,
          message,
          retryable: false,
        })),
        coverage: [
          {
            sourceId: id,
            siteId,
            status: result.errors?.length ? "failed" : "complete",
            truncated: true,
            queries,
            cities: [],
            pages: 1,
          },
        ],
        stats: {
          raw: records.length,
          parsed: records.length,
          accepted: records.length,
        },
      };
    },
    async fetchDetail(record) {
      return {
        ...record,
        detailStatus: "restricted",
        accessStatus: "authorization_required",
      };
    },
    async probe() {
      return {
        sourceId: id,
        siteId: id,
        status: "restricted",
        checkedAt: new Date().toISOString(),
        sampleCount: 0,
        evidence: [],
        issues: [
          {
            code: "authorization_required",
            message:
              "支持搜索线索和用户正文导入；平台正文 API 需要账号及权限。",
          },
        ],
      };
    },
  };
}
export const socialProviders = [
  createSocialDiscoveryProvider("weibo", "微博招聘线索", [
    "weibo.com",
    "weibo.cn",
  ]),
  createSocialDiscoveryProvider("douyin", "抖音招聘线索", ["douyin.com"]),
];
