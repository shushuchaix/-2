import test from "node:test";
import assert from "node:assert/strict";
import {
  createPagePolicy,
  platformPolicy,
  classifyBrowserBody,
} from "../../electron/collection/network-policy.mjs";
test("Boss only permits the selected fixed API operation for every resource type", async () => {
  const routePolicy = {
    ...platformPolicy("boss"),
    bossOperation: {
      kind: "boss.search",
      method: "POST",
      url: "https://www.zhipin.com/wapi/zpgeek/search/joblist.json",
      parameters: { query: "消防", page: 1, pageSize: 15, scene: 1 },
    },
  };
  let claims = 0;
  const p = createPagePolicy({
    routePolicy,
    reserve: async () => {
      claims++;
    },
  });
  assert.equal(
    (
      await p.authorize({
        url: routePolicy.bossOperation.url,
        method: "POST",
        resourceType: "xhr",
        uploadData: [
          {
            bytes: Buffer.from(
              "query=%E6%B6%88%E9%98%B2&page=1&pageSize=15&scene=1",
            ),
          },
        ],
      })
    ).cancel,
    false,
  );
  for (const resourceType of ["xhr", "fetch", "image", "script"]) {
    for (const url of [
      "https://www.zhipin.com/wapi/zpgeek/friend/add.json",
      "https://www.zhipin.com/wapi/zprelation/friend/label/addMark",
      "https://www.zhipin.com/wapi/zpgeek/job/card.json",
    ])
      assert.equal(
        (await p.authorize({ url, method: "GET", resourceType })).cancel,
        true,
      );
  }
  assert.equal(
    (
      await p.authorize({
        url: routePolicy.bossOperation.url,
        method: "GET",
        resourceType: "xhr",
      })
    ).cancel,
    true,
  );
  assert.equal(claims, 1);
});
test("all_automatic_assets_count_before_send_and_request61_is_blocked", async () => {
  let claims = 0;
  const p = createPagePolicy({
    routePolicy: platformPolicy("weibo"),
    reserve: async () => {
      claims++;
    },
    maxRequests: 60,
  });
  for (let n = 0; n < 60; n++)
    assert.equal(
      (
        await p.authorize({
          url: "https://m.weibo.cn/detail/100" + n,
          method: "GET",
          resourceType: n ? "image" : "mainFrame",
        })
      ).cancel,
      false,
    );
  assert.equal(
    (await p.authorize({ url: "https://m.weibo.cn/detail/999", method: "GET" }))
      .cancel,
    true,
  );
  assert.equal(claims, 60);
});
test("workbench_private_authenticated_and_unrelated_routes_are_rejected", async () => {
  const p = createPagePolicy({
    routePolicy: platformPolicy("wechat"),
    reserve: async () => {
      throw Error("must not claim");
    },
  });
  for (const url of [
    "http://127.0.0.1:3000/",
    "file:///c:/private",
    "https://mp.weixin.qq.com/s?access_token=secret",
    "https://mp.weixin.qq.com/s?pass_ticket=secret",
    "https://evil.example.org/",
    "https://mp.weixin.qq.com/cgi-bin/message",
  ])
    assert.equal((await p.authorize({ url, method: "GET" })).cancel, true);
});

test("weibo automatic navigation uses public route allowlist including decoded paths", async () => {
  const p = createPagePolicy({
    routePolicy: platformPolicy("weibo"),
    reserve: async () => {},
  });
  for (const pathname of [
    "/chat/123",
    "/%6dessages",
    "/ajax/messages",
    "/unknown-private-area",
  ])
    assert.equal(
      (
        await p.authorize({
          url: "https://weibo.com" + pathname,
          resourceType: "mainFrame",
          method: "GET",
        })
      ).cancel,
      true,
    );
  assert.equal(
    (
      await p.authorize({
        url: "https://m.weibo.cn/api/statuses/show?id=123",
        resourceType: "xhr",
        method: "GET",
      })
    ).cancel,
    false,
  );
});
test("a_challenge_200_is_not_a_complete_body_and_login_text_inside_a_job_is_allowed", () => {
  assert.equal(
    classifyBrowserBody({
      html: '<title>验证码</title><div id="captcha"></div><script>window.boot={"text":""}</script>',
    }).bodyStatus,
    "challenge_required",
  );
  assert.equal(
    classifyBrowserBody({ html: '<div id="js_content"></div>' }).bodyStatus,
    "incomplete",
  );
  assert.equal(
    classifyBrowserBody({
      status: 200,
      html: '<title>安全验证</title><div id="captcha">验证码</div>',
    }).bodyStatus,
    "challenge_required",
  );
  assert.equal(
    classifyBrowserBody({
      status: 200,
      html: '<div id="js_content">消防工程招聘，请登录报名平台</div>',
    }).bodyStatus,
    "complete",
  );
});
