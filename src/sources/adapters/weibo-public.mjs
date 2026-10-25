import { createPagedProvider, baseRecord, jsonResponse } from "./shared.mjs";
import { parseHTML } from "linkedom";
import {
  canonicalSocialUrl,
  parseWeiboContent,
  parseWeiboList,
  weiboPostIdentity,
} from "../social-content.mjs";
const configFor = (ctx) => ctx.config?.weibo || ctx.config || {};
const numericPostId = value => typeof value === "string" && /^[1-9]\d{0,29}$/.test(value);
function identityFailure(code = "detail_identity_mismatch") {
  throw Object.assign(Error("微博正文身份未通过核验。"), { code, retryable: false });
}
function assertPostBinding(post, expected) {
  if (post != null && weiboPostIdentity(post) !== expected) identityFailure();
}
function seedIdentity(record) {
  if (!numericPostId(record.sourceRecordId)) identityFailure("detail_identity_unsupported");
  const url = canonicalSocialUrl(record.url, "weibo");
  if (new URL(url).pathname.split("/").at(-1) !== record.sourceRecordId) identityFailure();
  return record.sourceRecordId;
}
function detailPayload(response) {
  const payload = weiboJsonResponse(response);
  if (payload?.ok !== undefined && payload.ok !== 1)
    throw Object.assign(Error("parse_error: 微博正文业务状态无效。"), { code: "parse_error", phase: "parse", requestId: response.requestId });
  return payload?.data || payload;
}
function weiboJsonResponse(response) {
  if (response.status !== 200) return jsonResponse(response);
  try {
    return JSON.parse(response.text);
  } catch {
    const text = String(response.text || "");
    const mime = String(response.headers?.["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const expectsJson =
      mime === "application/json" ||
      mime.endsWith("+json") ||
      /^\s*[\[{]/.test(text);
    let code = expectsJson ? "parse_error" : "content_non_json";
    if (!expectsJson && /<[a-z][^>]*>/i.test(text)) {
      const { document } = parseHTML(text);
      const title = document.querySelector("title")?.textContent.trim() || "";
      if (
        /^(?:(?:新浪)?微博[\s·|_-]*)?(?:安全验证|验证码|人机验证|访问验证)(?:[\s·|_-]*(?:新浪)?微博)?$/.test(
          title,
        ) ||
        document.querySelector("#captcha, #geetest_captcha")
      )
        code = "risk_blocked";
      else if (
        /^(?:(?:新浪)?微博[\s·|_-]*)?(?:用户)?登录(?:[\s·|_-]*(?:新浪)?微博)?$/.test(
          title,
        ) ||
        /^(?:weibo[\s|_-]*)?(?:log\s*in|sign\s*in)(?:[\s|_-]*weibo)?$/i.test(
          title,
        )
      )
        code = "login_required";
    }
    const messages = {
      parse_error: "parse_error: invalid JSON",
      content_non_json: "微博接口返回非JSON内容，尚未验证。",
      login_required: "微博接口返回明确登录页。",
      risk_blocked: "微博接口返回已知验证页面。",
    };
    throw Object.assign(Error(messages[code]), {
      code,
      status: response.status,
      phase: "parse",
      requestId: response.requestId,
      parser: {
        format: "json",
        resultType: "unknown",
        documentLength: text.length,
      },
    });
  }
}
const retained = (record) =>
  record.intent === "employer_recruitment" ||
  (record.intent === "unknown" &&
    /招[聘录]|岗位|投递|应聘|报名/.test(record.description || ""));
const attachmentsFor = (parsed) => [
  ...(parsed.images || []).map((image) => ({
    ...image,
    kind: "poster",
    textStatus: "not_extracted",
  })),
  ...(parsed.externalLinks || [])
    .filter((link) => /\.(?:pdf|docx?|xlsx?)(?:\?|$)/i.test(link.url))
    .map((link) => ({ ...link, textStatus: "not_extracted" })),
];
function recordFor(post, site) {
  const postId = weiboPostIdentity(post);
  if (!postId) throw Object.assign(Error("微博列表缺少可靠的帖子标识。"), { code: "parse_error" });
  const parsed = parseWeiboContent({
    post,
    url: "https://m.weibo.cn/detail/" + postId,
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
    attachments: attachmentsFor(parsed),
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
            evidenceLevel: "discovery",
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
        issues: [{ code: "not_configured", configurationReason: "public_seeds_required", retryable: false }],
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
    const payload = weiboJsonResponse(response);
    if (
      payload?.ok !== 1 ||
      !payload.data ||
      ![payload.data.cards, payload.data.list, payload.data.statuses].some(
        Array.isArray,
      )
    )
      throw Object.assign(Error("parse_error: 微博列表业务或结构无效。"), {
        code: "parse_error",
        phase: "parse",
        requestId: response.requestId,
      });
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
    const expectedId = seedIdentity(record);
    let post = record.post,
      longText,
      parsed;
    if (!post) {
      const response = await ctx.request(
        "https://m.weibo.cn/api/statuses/show?" +
          new URLSearchParams({ id: record.sourceRecordId }),
        { signal: ctx.signal, maxRetries: 0, maxBytes: 6291456 },
      );
      if (response.status === 200) {
        post = detailPayload(response);
      }
      if ([401, 403, 429].includes(response.status))
        return {
          ...record,
          bodyStatus: "restricted",
          retryEligible: true,
          retryAt: response.nextDueAt,
          detailStatus: "unavailable",
        };
    }
    assertPostBinding(post, expectedId);
    if (post?.longText?.idstr !== undefined || post?.longText?.id !== undefined)
      assertPostBinding(post.longText, expectedId);
    if (post?.isLongText) {
      const response = await ctx.request(
        "https://m.weibo.cn/api/statuses/extend?" +
          new URLSearchParams({ id: record.sourceRecordId }),
        { signal: ctx.signal, maxRetries: 0, maxBytes: 6291456 },
      );
      if ([401, 403, 429].includes(response.status))
        return {
          ...record,
          bodyStatus: "restricted",
          retryEligible: true,
          retryAt: response.nextDueAt,
          detailStatus: "unavailable",
        };
      if (response.status === 200) {
        const data = detailPayload(response);
        // An independently returned full body needs its own matching identity.
        // Missing identity stays pending; an explicit conflicting/lossy ID fails.
        if (data?.idstr !== undefined || data?.id !== undefined) {
          assertPostBinding(data, expectedId);
          longText = data;
        }
      }
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
    if ((parsed?.sourceRecordId != null || parsed?.bodyStatus === "complete") && parsed.sourceRecordId !== expectedId) identityFailure();
    parsed ||= { bodyStatus: "incomplete", retryEligible: true };
    return {
      ...record,
      ...parsed,
      post: undefined,
      attachments: attachmentsFor(parsed),
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
