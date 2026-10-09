import { createPagedProvider, baseRecord } from "./shared.mjs";
import { canonicalSocialUrl, parseWechatList } from "../social-content.mjs";
const configFor = (ctx) => ctx.config?.wechat || ctx.config || {};
const identity = (url) => {
  const u = new URL(url);
  return u.searchParams.get("__biz") && u.searchParams.get("mid")
    ? [
        u.searchParams.get("__biz"),
        u.searchParams.get("mid"),
        u.searchParams.get("idx") || "1",
      ].join(":")
    : u.pathname.split("/").at(-1);
};
function seedRecord(url, site) {
  return baseRecord({
    id: identity(url),
    sourceId: "wechat",
    siteId: site.siteId,
    title: "待读取的公众号招聘文章",
    url,
    kind: "recruitment_notice",
    bodyStatus: "incomplete",
    retryEligible: true,
    sourceRecordIdKind: "authority",
    urlKind: "notice_detail",
    evidenceLevel: "discovery",
  });
}
const provider = createPagedProvider({
  id: "wechat",
  name: "微信公众号招聘正文",
  capabilities: {
    body: true,
    attachments: true,
    accountIncremental: true,
    authorizedBrowser: true,
    search: false,
  },
  async listPage(site, _query, page, ctx) {
    const cfg = configFor(ctx),
      links = (cfg.articleUrls || []).map((u) =>
        canonicalSocialUrl(u, "wechat"),
      ),
      accounts = cfg.accountIds || [],
      index = ctx.cursor?.accountIndex ?? (page === 1 ? -1 : 0);
    if (page === 1 && links.length)
      return {
        records: links.map((u) => seedRecord(u, site)),
        hasMore: accounts.length > 0,
        nextCursor: { page: page + 1, accountIndex: 0 },
        coverageScope: accounts.length ? "selected_seeds" : "limited",
      };
    const accountIndex = Math.max(0, index),
      account = accounts[accountIndex];
    if (!account)
      return {
        records: [],
        hasMore: false,
        coverageScope: "limited",
        issues: [{ code: "public_seeds_required", retryable: false }],
      };
    if (!/^[A-Za-z0-9_=+-]{1,200}$/.test(account))
      throw Object.assign(Error("公众号标识无效。"), {
        code: "collection_account_invalid",
      });
    const url =
      "https://mp.weixin.qq.com/mp/profile_ext?" +
      new URLSearchParams({ action: "home", __biz: account });
    const response = await ctx.request(url, {
        signal: ctx.signal,
        maxRetries: 0,
        maxBytes: 6291456,
      }),
      list = parseWechatList(response.text, url);
    return {
      records: list.articleUrls.map((u) => seedRecord(u, site)),
      hasMore: accountIndex + 1 < accounts.length,
      nextCursor: { page: page + 1, accountIndex: accountIndex + 1 },
      coverageScope:
        accountIndex + 1 < accounts.length ? "selected_accounts" : "limited",
      issues: [
        {
          code: [401, 403, 429].includes(response.status)
            ? "restricted"
            : "account_history_limited",
          retryable: [401, 403, 429].includes(response.status),
        },
      ],
    };
  },
  async detail(record, ctx) {
    if (!ctx.readService)
      return {
        ...record,
        bodyStatus: "incomplete",
        retryEligible: true,
        detailStatus: "unavailable",
      };
    const result = await ctx.readService.read({
      ...ctx,
      url: record.url,
      providerId: "wechat",
      sessionRef: ctx.sessionRefs?.wechat,
    });
    const attachments = [
      ...(result.images || []).map((i) => ({
        ...i,
        kind: "poster",
        textStatus: "not_extracted",
      })),
      ...(result.externalLinks || [])
        .filter((l) => /\.(?:pdf|docx?|xlsx?)(?:\?|$)/i.test(l.url))
        .map((l) => ({ ...l, textStatus: "not_extracted" })),
    ];
    return {
      ...record,
      ...result,
      attachments,
      detailStatus:
        result.bodyStatus === "complete" ? "available" : "unavailable",
      evidenceLevel: result.bodyStatus === "complete" ? "body" : "discovery",
      evidence: result.description
        ? [
            {
              field: "description",
              excerpt: result.description,
              url: result.url,
              kind: "body",
              checkedAt: result.checkedAt,
            },
          ]
        : [],
      extra: {
        ...record.extra,
        account: result.account,
        imageCount: result.images?.length || 0,
        articleTitle: result.title,
      },
    };
  },
});
provider.configSchema = {
  enabled: "boolean",
  articleUrls: "array",
  accountIds: "array",
};
export default provider;
