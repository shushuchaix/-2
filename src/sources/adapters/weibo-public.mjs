import { createPagedProvider, baseRecord } from "./shared.mjs";
import {
  canonicalSocialUrl,
  parseWeiboContent,
  parseWeiboList,
} from "../social-content.mjs";
const configFor = (ctx) => ctx.config?.weibo || ctx.config || {};
const retained = (record) =>
  record.intent === "employer_recruitment" ||
  (record.intent === "unknown" &&
    /招[聘录]|岗位|投递|应聘|报名/.test(record.description || ""));
function recordFor(post, site) {
  const parsed = parseWeiboContent({
    post,
    url: "https://m.weibo.cn/detail/" + String(post.idstr || post.id),
  });
  return baseRecord({
    id: parsed.sourceRecordId,
    sourceId: "weibo",
    siteId: site.siteId,
    title: parsed.title,
    url: parsed.url,
    kind: "recruitment_notice",
    ...parsed,
    sourceRecordIdKind: "authority",
    urlKind: "notice_detail",
    evidenceLevel: parsed.bodyStatus === "complete" ? "body" : "discovery",
    evidence:
      parsed.bodyStatus === "complete"
        ? [
            {
              field: "description",
              kind: "body",
              excerpt: parsed.description,
              url: parsed.url,
            },
          ]
        : [],
    attachments: parsed.images.map((i) => ({
      ...i,
      kind: "poster",
      textStatus: "not_extracted",
    })),
  });
}
const provider = createPagedProvider({
  id: "weibo",
  name: "微博招聘正文",
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
        canonicalSocialUrl(u, "weibo"),
      ),
      accounts = cfg.accountIds || [];
    if (page === 1 && links.length)
      return {
        records: links.map((url) =>
          baseRecord({
            id: new URL(url).pathname.split("/").at(-1),
            sourceId: "weibo",
            siteId: site.siteId,
            title: "待读取的微博招聘正文",
            url,
            kind: "recruitment_notice",
            bodyStatus: "incomplete",
            retryEligible: true,
            urlKind: "notice_detail",
            sourceRecordIdKind: "authority",
          }),
        ),
        hasMore: accounts.length > 0,
        nextCursor: { page: page + 1, accountIndex: 0 },
        coverageScope: accounts.length ? "selected_seeds" : "limited",
      };
    const accountIndex = ctx.cursor?.accountIndex || 0,
      account = accounts[accountIndex];
    if (!account)
      return {
        records: [],
        hasMore: false,
        coverageScope: "limited",
        issues: [{ code: "public_seeds_required" }],
      };
    if (!/^\d{1,30}$/.test(account))
      throw Object.assign(Error("微博账号标识无效。"), {
        code: "collection_account_invalid",
      });
    const params = new URLSearchParams({ containerid: "107603" + account });
    if (ctx.cursor?.sinceId) params.set("since_id", String(ctx.cursor.sinceId));
    const response = await ctx.request(
      "https://m.weibo.cn/api/container/getIndex?" + params,
      { signal: ctx.signal, maxRetries: 0, maxBytes: 6291456 },
    );
    if ([401, 403, 429].includes(response.status))
      throw Object.assign(Error("微博列表受限。"), {
        code: response.status === 429 ? "rate_limited" : "login_required",
        nextDueAt: response.nextDueAt,
      });
    let payload;
    try {
      payload = JSON.parse(response.text);
    } catch {
      throw Object.assign(Error("微博列表未返回公开数据。"), {
        code: "challenge_required",
      });
    }
    const list = parseWeiboList(payload),
      nextAccount = list.nextSinceId ? accountIndex : accountIndex + 1,
      hasMore = !!list.nextSinceId || nextAccount < accounts.length;
    return {
      records: list.posts.map((p) => recordFor(p, site)).filter(retained),
      raw: list.posts.length,
      hasMore,
      nextCursor: {
        page: page + 1,
        accountIndex: nextAccount,
        ...(list.nextSinceId ? { sinceId: String(list.nextSinceId) } : {}),
      },
      coverageScope: "reachable_account",
      issues: [],
    };
  },
  async detail(record, ctx) {
    let post = record.post,
      longText,
      parsed;
    if (!post) {
      const response = await ctx.request(
        "https://m.weibo.cn/api/statuses/show?" +
          new URLSearchParams({ id: record.sourceRecordId }),
        { signal: ctx.signal, maxRetries: 0, maxBytes: 6291456 },
      );
      if (response.status === 200)
        try {
          const payload = JSON.parse(response.text);
          post = payload.data || payload;
        } catch {}
      if (response.status === 429)
        return {
          ...record,
          bodyStatus: "restricted",
          retryEligible: true,
          retryAt: response.nextDueAt,
          detailStatus: "unavailable",
        };
    }
    if (post?.isLongText) {
      const response = await ctx.request(
        "https://m.weibo.cn/api/statuses/extend?" +
          new URLSearchParams({ id: record.sourceRecordId }),
        { signal: ctx.signal, maxRetries: 0, maxBytes: 6291456 },
      );
      if (response.status === 429)
        return {
          ...record,
          bodyStatus: "restricted",
          retryEligible: true,
          retryAt: response.nextDueAt,
          detailStatus: "unavailable",
        };
      if (response.status === 200)
        try {
          const payload = JSON.parse(response.text);
          longText = payload.data || payload;
        } catch {}
    }
    if (post?.text || post?.text_raw)
      parsed = parseWeiboContent({ post, longText, url: record.url });
    if (parsed?.bodyStatus !== "complete" && ctx.readService)
      parsed = await ctx.readService.read({
        ...ctx,
        url: record.url,
        providerId: "weibo",
        sessionRef: ctx.sessionRefs?.weibo,
      });
    parsed ||= { bodyStatus: "incomplete", retryEligible: true };
    return {
      ...record,
      ...parsed,
      post: undefined,
      attachments: (parsed.images || []).map((i) => ({
        ...i,
        kind: "poster",
        textStatus: "not_extracted",
      })),
      detailStatus:
        parsed.bodyStatus === "complete" ? "available" : "unavailable",
      evidenceLevel: parsed.bodyStatus === "complete" ? "body" : "discovery",
      evidence: parsed.description
        ? [
            {
              field: "description",
              kind: "body",
              excerpt: parsed.description,
              url: record.url,
              checkedAt:
                parsed.checkedAt ||
                new Date(ctx.clock?.now?.() || Date.now()).toISOString(),
            },
          ]
        : [],
    };
  },
});
provider.configSchema = {
  enabled: "boolean",
  articleUrls: "array",
  accountIds: "array",
};
export default provider;
