import test from "node:test";
import assert from "node:assert/strict";
import weibo from "../../src/sources/adapters/weibo-public.mjs";
import { createSourceService } from "../../src/application/source-service.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";

const site = {
  siteId: "weibo",
  providerId: "weibo",
  name: "公开合成来源",
  origin: "https://m.weibo.cn",
};
const responseContext = (text, headers = {}) => ({
  config: { weibo: { accountIds: ["123"] } },
  request: async () => ({
    status: 200,
    text,
    headers,
    requestId: "synthetic-response",
  }),
});
const responses = [
  [
    "public HTML shell",
    "<html><head><title>微博</title></head><body><div id='app'></div></body></html>",
    "content_non_json",
  ],
  ["unavailable HTML", "<main>服务暂不可用</main>", "content_non_json"],
  [
    "ordinary login and captcha mentions",
    "<main>公开说明：登录后可使用 captcha 工具。</main>",
    "content_non_json",
  ],
  [
    "login help title",
    "<html><title>微博登录帮助</title><main>公开帮助文档</main></html>",
    "content_non_json",
  ],
  ["invalid JSON", '{"data":', "parse_error"],
  ["empty response", "", "content_non_json"],
  [
    "explicit login HTML",
    "<html><title>微博登录</title><form><input type='password'></form></html>",
    "login_required",
  ],
  [
    "known challenge HTML",
    "<html><title>安全验证</title><div id='captcha'></div></html>",
    "risk_blocked",
  ],
];

for (const [name, text, code] of responses) {
  test("weibo response classification: " + name, async () => {
    await assert.rejects(
      weibo.collectPage({ site, context: responseContext(text) }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.status, 200);
        assert.equal(error.requestId, "synthetic-response");
        assert.equal(error.text, undefined);
        assert.equal(error.html, undefined);
        return true;
      },
    );
  });
}

const malformedJsonResponses = [
  ["object prefix", '  {"text":"captcha"', {}],
  ["array prefix", "\n [1,", {}],
  [
    "JSON content type",
    "unavailable",
    { "content-type": "application/json; charset=utf-8" },
  ],
  [
    "structured JSON content type",
    "unavailable",
    { "content-type": "application/problem+json" },
  ],
  [
    "JSON content type with HTML",
    "<html><title>微博登录</title></html>",
    { "content-type": "application/json" },
  ],
];

for (const [name, text, headers] of malformedJsonResponses) {
  test(
    "weibo malformed JSON list response remains parse_error: " + name,
    async () => {
      await assert.rejects(
        weibo.collectPage({ site, context: responseContext(text, headers) }),
        {
          code: "parse_error",
          status: 200,
          phase: "parse",
          requestId: "synthetic-response",
        },
      );
    },
  );
  test(
    "weibo malformed JSON detail response remains parse_error: " + name,
    async () => {
      const record = {
        sourceId: "weibo",
        siteId: "weibo",
        sourceRecordId: "123",
        url: "https://m.weibo.cn/detail/123",
      };
      for (const input of [
        record,
        {
          ...record,
          post: { id: "123", isLongText: true, text: "公司招聘……" },
        },
      ])
        await assert.rejects(
          weibo.fetchDetail(input, responseContext(text, headers)),
          {
            code: "parse_error",
            status: 200,
            phase: "parse",
            requestId: "synthetic-response",
          },
        );
    },
  );
}

test("weibo response classification: valid JSON containing challenge words retains the list contract", async () => {
  const page = await weibo.collectPage({
    site,
    context: responseContext(
      JSON.stringify({
        ok: 1,
        data: {
          cards: [
            {
              mblog: {
                id: "123",
                text: "公司招聘工程师，负责 captcha 系统，登录功能维护。",
              },
            },
          ],
          cardlistInfo: {},
        },
      }),
    ),
  });
  assert.equal(page.records.length, 1);
  assert.equal(page.raw, 1);
  assert.equal(page.done, true);
  assert.deepEqual(page.issues, []);
});

test("weibo response classification: malformed list contracts remain parse errors", async () => {
  for (const text of ['{"ok":0,"msg":"服务异常"}', '{"ok":1,"data":{}}'])
    await assert.rejects(
      weibo.collectPage({ site, context: responseContext(text) }),
      { code: "parse_error" },
    );
  const page = await weibo.collectPage({
    site,
    context: responseContext('{"ok":1,"data":{"cards":[],"cardlistInfo":{}}}'),
  });
  assert.equal(page.raw, 0);
  assert.equal(page.done, true);
  assert.deepEqual(page.issues, []);
});

test("weibo response classification: detail and long-text non-JSON responses expose the same failure", async () => {
  const record = {
    sourceId: "weibo",
    siteId: "weibo",
    sourceRecordId: "123",
    url: "https://m.weibo.cn/detail/123",
  };
  await assert.rejects(
    weibo.fetchDetail(record, responseContext("<main>服务暂不可用</main>")),
    { code: "content_non_json" },
  );
  await assert.rejects(
    weibo.fetchDetail(
      { ...record, post: { id: "123", isLongText: true, text: "公司招聘……" } },
      responseContext("<main>服务暂不可用</main>"),
    ),
    { code: "content_non_json" },
  );
});

test("weibo response classification: legal null JSON preserves incomplete detail fallback", async () => {
  const record = {
    sourceId: "weibo",
    siteId: "weibo",
    sourceRecordId: "123",
    url: "https://m.weibo.cn/detail/123",
  };
  for (const input of [
    record,
    { ...record, post: { id: "123", isLongText: true, text: "公司招聘……" } },
  ]) {
    const result = await weibo.fetchDetail(input, responseContext("null"));
    assert.equal(result.bodyStatus, "incomplete");
    assert.equal(result.detailStatus, "unavailable");
    assert.equal(result.retryEligible, true);
  }
});

for (const [name, text, code] of responses.filter(
  ([name, , code]) =>
    ["login_required", "risk_blocked"].includes(code) ||
    name === "public HTML shell",
)) {
  test("weibo scoped probe classification: " + name, async (t) => {
    const f = await packageBusinessFixture(t);
    const { a } = await f.twoTargets();
    const scope = { packageId: a.packageId, targetRevisionId: a.revisionId };
    await f.repository.mutateWorkspace((w) => {
      w.packages[a.packageId].collectionSettings ||= {
        sourceOverrides: {},
        sessionRefs: {},
        refreshEnabled: false,
      };
      w.packages[a.packageId].collectionSettings.sourceOverrides.weibo = {
        accountIds: ["123"],
      };
    });
    const service = createSourceService({
      repository: f.repository,
      operationGate: f.operationGate,
      registry: createSourceRegistry([weibo]),
      catalog: [site],
      clock: f.clock,
      requestFactory: () => responseContext(text).request,
    });
    const result = await service.probeScopedSource({
      scope,
      sourceId: "weibo",
      siteId: "weibo",
    });
    assert.equal(
      result.status,
      code === "content_non_json" ? "unavailable" : "restricted",
    );
    assert.equal(result.issues[0].code, code);
    assert.equal(result.sampleCount, 0);
    assert.equal(result.capabilities.list, "unverified");
    assert.equal(result.capabilities.body, "unverified");
    const health = (await f.repository.read()).sourceHealth["weibo/weibo"];
    assert.equal(health.lastSuccessAt, null);
    assert.equal(JSON.stringify(result).includes(text), false);
  });
}
