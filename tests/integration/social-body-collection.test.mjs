import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseWechatContent,
  parseWeiboContent,
  canonicalSocialUrl,
  parseWechatList,
  parseWeiboList,
} from "../../src/sources/social-content.mjs";
import { createContentReadService } from "../../src/application/content-read-service.mjs";
import wechatProvider from "../../src/sources/adapters/wechat-public.mjs";
import weiboProvider from "../../src/sources/adapters/weibo-public.mjs";
test("known article needs no search credential and private provider config selects actual seeds", async () => {
  const site = { siteId: "wechat" },
    url = "https://mp.weixin.qq.com/s/seed";
  const page = await wechatProvider.collectPage({
    site,
    context: { config: { wechat: { articleUrls: [url] } } },
  });
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].url, url);
  assert.equal(page.done, true);
});
test("account provider follows real cursor past page two and filters unrelated personal text", async () => {
  const seen = [],
    site = { siteId: "weibo" },
    ctx = {
      config: { weibo: { accountIds: ["12345"] } },
      request: async (url) => {
        seen.push(url);
        return {
          status: 200,
          text: JSON.stringify({
            data: {
              cards: [
                {
                  mblog: {
                    id: "recruit" + seen.length,
                    text: "公司现招聘消防工程师。本科要求。",
                  },
                },
                { mblog: { id: "unrelated", text: "今天去旅游了" } },
              ],
              cardlistInfo:
                seen.length < 3 ? { since_id: "next" + seen.length } : {},
            },
          }),
        };
      },
    };
  let cursor = null;
  for (let i = 0; i < 3; i++) {
    const page = await weiboProvider.collectPage({
      site,
      cursor,
      context: ctx,
    });
    assert.equal(page.records.length, 1);
    cursor = page.nextCursor;
  }
  assert.equal(cursor, null);
  assert.equal(new URL(seen[2]).searchParams.get("since_id"), "next2");
});
test("reader never returns transport headers, scripts or credentials as business fields", async () => {
  const reader = createContentReadService({
    request: async () => ({
      status: 200,
      headers: { "set-cookie": "private-secret" },
      text: article,
    }),
  });
  const result = await reader.read({
    providerId: "wechat",
    url: "https://mp.weixin.qq.com/s/seed",
  });
  assert.equal(result.bodyStatus, "complete");
  assert.equal(result.headers, undefined);
  assert.equal(result.html, undefined);
  assert.equal(result.text, undefined);
  assert.equal(JSON.stringify(result).includes("private-secret"), false);
});
const article = readFileSync(
  new URL(
    "../fixtures/social-recruitment/wechat-article.html",
    import.meta.url,
  ),
  "utf8",
);
test("wechat article preserves canonical identity, actual body and poster sequence without inventing company or deadline", () => {
  const url =
      "https://mp.weixin.qq.com/s?__biz=public-account&mid=123&idx=1&sn=public-signature&scene=27#wechat_redirect",
    result = parseWechatContent({ html: article, url });
  assert.equal(result.sourceRecordId, "public-account:123:1");
  assert.equal(result.bodyStatus, "complete");
  assert.match(result.description, /应届本科/);
  assert.equal(result.description.includes("hidden-test-text"), false);
  assert.equal(result.company, null);
  assert.equal(result.deadlineAt, null);
  assert.equal(result.images[0].sequence, 0);
  assert.equal(result.images[0].url, "https://mmbiz.qpic.cn/poster.png");
  assert.equal(
    result.externalLinks[0].url,
    "https://jobs.example.org/original",
  );
  assert.ok(result.publishedAt);
  assert.deepEqual(result.cities, []);
  assert.equal(canonicalSocialUrl(url, "wechat").includes("scene="), false);
  assert.equal(canonicalSocialUrl(url, "wechat").includes("#"), false);
  const challenge = parseWechatContent({
    html: '<title>安全验证</title><div id="captcha"></div>',
    url,
  });
  assert.equal(challenge.bodyStatus, "challenge_required");
  assert.equal(challenge.retryEligible, true);
});
test("weibo truncation is pending until full text is independently present and repost retains original ID", () => {
  const post = {
    id: "123",
    isLongText: true,
    text: "机场消防公司招聘……",
    created_at: "Fri Oct 09 08:00:00 +0800 2026",
    user: { id: "u1", screen_name: "机场官方", location: "北京" },
    pics: [{ large: { url: "https://wx1.sinaimg.cn/large/poster.jpg" } }],
    retweeted_status: { id: "original-one", text: "原帖" },
  };
  const before = parseWeiboContent({
    post,
    url: "https://m.weibo.cn/detail/123",
  });
  assert.equal(before.bodyStatus, "incomplete");
  assert.equal(before.retryEligible, true);
  assert.deepEqual(before.cities, []);
  assert.equal(before.deadlineAt, null);
  assert.equal(before.originalPostId, "original-one");
  const after = parseWeiboContent({
    post,
    longText: {
      longTextContent:
        "机场消防公司现招聘消防工程师。报名条件：本科，应届。投递入口：https://jobs.example.org/",
    },
    url: "https://m.weibo.cn/detail/123",
  });
  assert.equal(after.bodyStatus, "complete");
  assert.match(after.description, /报名条件/);
  assert.equal(after.images.length, 1);
  assert.equal(after.sourceRecordId, "123");
});
test("account continuation uses actual returned cursor and cannot claim unreachable account history", () => {
  const list = parseWeiboList({
    data: {
      cards: [{ mblog: { id: "123", text: "公司招聘" } }],
      cardlistInfo: { since_id: "actual-next" },
    },
  });
  assert.equal(list.posts.length, 1);
  assert.equal(list.nextSinceId, "actual-next");
  const wechat = parseWechatList(
    '<a href="/s?__biz=one&mid=2&idx=1">招聘公告</a><a href="/mp/profile_ext?action=home">历史</a>',
    "https://mp.weixin.qq.com/mp/profile_ext?__biz=one",
  );
  assert.equal(wechat.articleUrls.length, 1);
  assert.equal(wechat.hasMore, false);
  assert.equal(wechat.coverageScope, "limited");
});
test("reader holds challenge as retryable and never treats search metadata as body; 429 does not immediately enhance", async () => {
  let calls = 0,
    enhancements = 0;
  const reader = createContentReadService({
    request: async () => {
      calls++;
      return { status: 429, text: "limited" };
    },
    anonymousWorker: {
      read: async () => {
        enhancements++;
        return { bodyStatus: "complete" };
      },
    },
    clock: { now: () => 0 },
  });
  const result = await reader.read({
    url: "https://mp.weixin.qq.com/s/known",
    providerId: "wechat",
    ref: {
      scope: { packageId: "a", targetRevisionId: "a@1" },
      activityId: "root",
    },
    token: {},
    operationLease: {},
  });
  assert.equal(result.bodyStatus, "restricted");
  assert.equal(result.retryEligible, true);
  assert.equal(calls, 1);
  assert.equal(enhancements, 0);
  const restricted = createContentReadService({
    request: async () => ({
      status: 200,
      text: '<title>安全验证</title><div id="captcha"></div>',
    }),
    browser: {
      read: async () => ({
        status: 200,
        html: '<title>安全验证</title><div id="captcha"></div>',
        bodyStatus: "challenge_required",
      }),
    },
  });
  const body = await restricted.read({
    url: "https://mp.weixin.qq.com/s/known",
    providerId: "wechat",
    ref: {
      scope: { packageId: "a", targetRevisionId: "a@1" },
      activityId: "root",
    },
    token: {},
    operationLease: {},
  });
  assert.notEqual(body.bodyStatus, "complete");
  assert.equal(body.retryEligible, true);
});
