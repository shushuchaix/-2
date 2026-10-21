import test from "node:test";
import assert from "node:assert/strict";
import { createContentReadService } from "../../src/application/content-read-service.mjs";

const url = "https://mp.weixin.qq.com/s/synthetic-article";
const captcha = "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha";
const html =
  '<html><body>环境异常，请完成验证后继续访问。<a href="https://example.org/not-evidence">入口</a><img src="https://example.org/not-evidence.png"></body></html>';
const input = {
  providerId: "wechat",
  url,
  ref: {
    scope: { packageId: "synthetic", targetRevisionId: "r1" },
    activityId: "root",
  },
  token: {},
  sessionRef: "synthetic-session",
};
function fixture(response) {
  const calls = { request: 0, browser: 0, enhancement: 0 };
  const service = createContentReadService({
    request: async (address) => {
      calls.request++;
      assert.equal(address, url);
      return response;
    },
    browser: {
      read: async () => {
        calls.browser++;
        throw Error("must not read past captcha");
      },
    },
    anonymousWorker: {
      read: async () => {
        calls.enhancement++;
        throw Error("must not enhance past captcha");
      },
    },
    clock: { now: () => 0 },
  });
  return { service, calls };
}

test("known WeChat captcha redirect stays a challenge without accepting body or reusing its query", async () => {
  const { service, calls } = fixture({
    status: 200,
    url: captcha + "?token=synthetic-sensitive-value",
    text: html,
    usage: { requests: 1 },
    nextDueAt: "2026-10-12T00:00:00Z",
  });
  const result = await service.read(input);
  assert.equal(result.bodyStatus, "challenge_required");
  assert.equal(result.retryEligible, true);
  assert.equal(result.status, 200);
  assert.equal(result.channel, "public_http");
  assert.equal(result.url, url);
  assert.equal(result.description, null);
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.externalLinks, []);
  assert.deepEqual(result.usage, { requests: 1 });
  assert.equal(result.nextDueAt, "2026-10-12T00:00:00Z");
  assert.equal(
    JSON.stringify(result).includes("synthetic-sensitive-value"),
    false,
  );
  assert.deepEqual(calls, { request: 1, browser: 0, enhancement: 0 });
});

test("a challenge at the original article stops browser and anonymous enhancement", async () => {
  for (const sessionRef of [undefined, "synthetic-session"]) {
    const { service, calls } = fixture({ status: 200, url, text: html });
    const result = await service.read({ ...input, sessionRef });
    assert.equal(result.bodyStatus, "challenge_required");
    assert.deepEqual(calls, { request: 1, browser: 0, enhancement: 0 });
  }
});

test("a browser challenge stops anonymous enhancement", async () => {
  let enhanced = 0;
  const service = createContentReadService({
    request: async () => ({
      status: 200,
      url,
      text: "<html><body>加载中</body></html>",
    }),
    browser: { read: async () => ({ status: 200, url, html }) },
    anonymousWorker: {
      read: async () => {
        enhanced++;
        throw Error("must not enhance captcha");
      },
    },
  });
  const result = await service.read({ ...input, sessionRef: undefined });
  assert.equal(result.bodyStatus, "challenge_required");
  assert.equal(enhanced, 0);
});

test("real article body is still accepted", async () => {
  const { service, calls } = fixture({
    status: 200,
    url,
    text: '<html><body><h1 id="activity-name">合成招聘</h1><div id="js_content">合成公司招聘消防工程师，本科，公开招聘。</div></body></html>',
  });
  const result = await service.read(input);
  assert.equal(result.bodyStatus, "complete");
  assert.match(result.description, /消防工程师/);
  assert.deepEqual(calls, { request: 1, browser: 0, enhancement: 0 });
});

for (const style of ["display:none", "visibility:hidden", "opacity:0"]) {
  test(`hidden challenge text is not visible evidence: ${style}`, async () => {
    const { service, calls } = fixture({
      status: 200,
      url: captcha,
      text: `<html><body><p>未知页面</p><div style="${style}">环境异常，请完成验证</div></body></html>`,
    });
    await assert.rejects(service.read(input), {
      code: "collection_route_forbidden",
    });
    assert.deepEqual(calls, { request: 1, browser: 0, enhancement: 0 });
  });
}

test("captcha recognition does not widen route admission or infer challenges from unknown pages", async () => {
  for (const response of [
    { url: captcha + "-fake", text: html },
    {
      url: captcha.replace("mp.weixin.qq.com", "mp.weixin.qq.com.example.org"),
      text: html,
    },
    { url: captcha.replace("https:", "http:"), text: html },
    { url: captcha.replace("https://", "https://synthetic@"), text: html },
    { url: captcha, text: "<html><body>未知页面</body></html>" },
    {
      url: captcha,
      text: '<html><body><script>var text="环境异常"</script></body></html>',
    },
    {
      url: captcha,
      text: html.replace("</body>", '<div id="js_content">正文</div></body>'),
    },
  ]) {
    const { service, calls } = fixture({ status: 200, ...response });
    await assert.rejects(service.read(input), {
      code: "collection_route_forbidden",
    });
    assert.deepEqual(calls, { request: 1, browser: 0, enhancement: 0 });
  }
  for (const address of [captcha, url + "?token=synthetic-sensitive-value"]) {
    const { service, calls } = fixture({
      status: 200,
      url: captcha,
      text: html,
    });
    await assert.rejects(service.read({ ...input, url: address }), {
      code: "collection_route_forbidden",
    });
    assert.deepEqual(calls, { request: 0, browser: 0, enhancement: 0 });
  }
});
