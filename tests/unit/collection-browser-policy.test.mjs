import test from "node:test";
import assert from "node:assert/strict";
import {
  createPagePolicy,
  platformPolicy,
  classifyBrowserBody,
} from "../../electron/collection/network-policy.mjs";

test("manual Boss successful-login default landing is allowed only as a clean top-level GET or HEAD", async () => {
  for (const manual of [true, false]) {
    const policy = createPagePolicy({
      routePolicy: platformPolicy("boss"),
      manual,
    });
    for (const method of ["GET", "HEAD", "POST"]) {
      assert.equal(
        (
          await policy.authorize({
            url: "https://www.zhipin.com/",
            method,
            resourceType: "mainFrame",
          })
        ).cancel,
        !(manual && method !== "POST"),
      );
    }
    for (const url of [
      "https://www.zhipin.com/?token=synthetic-private",
      "https://www.zhipin.com/#synthetic-private",
      "https://zhipin.com/",
      "https://www.zhipin.com/web/common/403.html?code=31",
    ]) {
      assert.equal(
        (
          await policy.authorize({
            url,
            method: "GET",
            resourceType: "mainFrame",
          })
        ).cancel,
        true,
      );
    }
    for (const resourceType of ["xhr", "image", "script", "subFrame"]) {
      assert.equal(
        (
          await policy.authorize({
            url: "https://www.zhipin.com/",
            method: "GET",
            resourceType,
          })
        ).cancel,
        true,
      );
    }
  }
});

test("Boss login bootstrap permits observed CDN assets only as static GET resources", async () => {
  for (const manual of [false, true]) {
    const policy = createPagePolicy({
      routePolicy: platformPolicy("boss"),
      manual,
    });
    for (const [url, resourceType] of [
      [
        "https://static.zhipin.com/library/js/lib/jquery-1.12.2.min.js",
        "script",
      ],
      [
        "https://static.zhipin.com/zhipin-geek-spa/web/v6763/static/js/boss-login-332c3023.bf146895.js",
        "script",
      ],
      [
        "https://static.zhipin.com/zhipin-geek-spa/web/v6763/static/css/boss-login-1.1fee6651.css",
        "stylesheet",
      ],
      [
        "https://static.zhipin.com/zhipin-geek-spa/web/v6763/static/js/app~0.0bbb1e58.js",
        "script",
      ],
      [
        "https://static.zhipin.com/zhipin-geek-spa/web/v6763/static/css/app~c0d85c3d.9a1b81f1.css",
        "stylesheet",
      ],
      [
        "https://static.zhipin.com/assets/zhipin/geek/boss-ui/bossui.css",
        "stylesheet",
      ],
      [
        "https://img.bosszhipin.com/static/zhipin/geek/sdk/browser-check-v2.js",
        "script",
      ],
    ]) {
      assert.equal(
        (await policy.authorize({ url, resourceType, method: "GET" })).cancel,
        false,
      );
      assert.equal(
        (await policy.authorize({ url, resourceType, method: "POST" })).cancel,
        true,
      );
      assert.equal(
        (
          await policy.authorize({
            url,
            resourceType: "mainFrame",
            method: "GET",
          })
        ).cancel,
        true,
      );
    }
    for (const url of [
      "https://static.zhipin.com/private/user.js",
      "https://static.zhipin.com/wapi/zpgeek/friend/add.json",
      "https://static.zhipin.com/library/js/lib/jquery-1.12.2.min.js?token=secret",
      "https://static.zhipin.com/library/js/lib/jquery-1.12.2.min.js?securityId=synthetic-secret",
      "https://static.zhipin.com/library/js/lib/jquery-1.12.2.min.js?lid=synthetic-secret",
      "https://static.zhipin.com/library/js/lib/jquery-1.12.2.min.js?session=synthetic-secret",
      "https://static.zhipin.com/library/js/lib/jquery-1.12.2.min.js?csrf=synthetic-secret",
      "https://static.zhipin.com/library/js/lib/jquery-1.12.2.min.js?v=unobserved",
      "https://static.zhipin.com/zhipin-geek-spa/web/v6763/static/js/%2e%2e%2fprivate.js",
      "https://static.zhipin.com/zhipin-geek-spa/web/v6763/static/js/private%2f..%2fsecret.js",
      "https://static.zhipin.com/zhipin-geek-spa/web/v6763/static/js//secret.js",
      "https://different.example.org/library/js/lib/jquery-1.12.2.min.js",
    ])
      assert.equal(
        (await policy.authorize({ url, resourceType: "script", method: "GET" }))
          .cancel,
        true,
      );
  }
});
test("Boss manual login permits its observed sign-page resources without enabling them for collection", async () => {
  for (const manual of [false, true]) {
    const policy = createPagePolicy({
      routePolicy: platformPolicy("boss"),
      manual,
    });
    for (const [url, resourceType] of [
      [
        "https://static.zhipin.com/zhipin-sign/v5330/static/js/iframe-core.a35c6000.js",
        "script",
      ],
      [
        "https://static.zhipin.com/zhipin-sign/v5330/static/js/vendors.c30ef7fa.js",
        "script",
      ],
      [
        "https://static.zhipin.com/zhipin-sign/v5330/static/js/app.8b190f81.js",
        "script",
      ],
      [
        "https://static.zhipin.com/zhipin-sign/v5330/static/css/app.a427210e.css",
        "stylesheet",
      ],
      ["https://static.zhipin.com/assets/sdk/apm/patas.2.3.0.min.js", "script"],
    ]) {
      assert.equal(
        (await policy.authorize({ url, resourceType, method: "GET" })).cancel,
        !manual,
      );
      assert.equal(
        (await policy.authorize({ url, resourceType, method: "POST" })).cancel,
        true,
      );
      assert.equal(
        (
          await policy.authorize({
            url: url + "?session=secret",
            resourceType,
            method: "GET",
          })
        ).cancel,
        true,
      );
      assert.equal(
        (
          await policy.authorize({
            url,
            resourceType: "mainFrame",
            method: "GET",
          })
        ).cancel,
        true,
      );
    }
    assert.equal(
      (
        await policy.authorize({
          url: "https://static.zhipin.com/zhipin-sign/v5330/static/js/%2e%2e%2fprivate.js",
          resourceType: "script",
          method: "GET",
        })
      ).cancel,
      true,
    );
  }
});

test("Boss scan image is allowed only for manual login as a bounded numeric PNG", async () => {
  const url = "https://static.zhipin.com/assets/sdk/bzl-qrcode/123456789.png";
  for (const manual of [false, true]) {
    let claims = 0;
    const policy = createPagePolicy({
      routePolicy: platformPolicy("boss"),
      manual,
      reserve: async () => {
        claims++;
      },
    });
    for (const method of ["GET", "HEAD"])
      assert.equal(
        (await policy.authorize({ url, resourceType: "image", method })).cancel,
        !manual,
      );
    for (const resourceType of ["script", "mainFrame", "stylesheet", "xhr"])
      assert.equal(
        (await policy.authorize({ url, resourceType, method: "GET" })).cancel,
        true,
      );
    assert.equal(
      (await policy.authorize({ url, resourceType: "image", method: "POST" }))
        .cancel,
      true,
    );
    for (const denied of [
      url + "?token=synthetic",
      url + "?v=1",
      url + "#synthetic",
      "https://static.zhipin.com/assets/sdk/bzl-qrcode/abc.png",
      "https://static.zhipin.com/assets/sdk/bzl-qrcode/123.svg",
      "https://static.zhipin.com/assets/sdk/bzl-qrcode/sub/123.png",
      "https://static.zhipin.com/assets/sdk/bzl-qrcode/%2f123.png",
      "https://img.bosszhipin.com/assets/sdk/bzl-qrcode/123.png",
      "https://different.example.org/assets/sdk/bzl-qrcode/123.png",
    ])
      assert.equal(
        (
          await policy.authorize({
            url: denied,
            resourceType: "image",
            method: "GET",
          })
        ).cancel,
        true,
      );
    assert.equal(claims, manual ? 2 : 0);
  }
});

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
