import test from "node:test";
import assert from "node:assert/strict";
import {
  createLegacyProvider,
  legacyProviders,
} from "../../src/sources/adapters/legacy.mjs";
import { job } from "../helpers/fixtures.mjs";
import {
  withSourceContext,
  sourceFetch,
} from "../../src/sources/request-context.mjs";
import { normalizePosition } from "../../src/sources/zhaopin.mjs";
import { normalizeIntern } from "../../src/sources/shixiseng.mjs";
import { normalizeNowcoderJob } from "../../src/sources/nowcoder.mjs";
import { parseSearchFragment } from "../../src/sources/university.mjs";
import { parseListFragment as chenyunList } from "../../src/sources/chenyun.mjs";
import { parseListFragment as bridgeList } from "../../src/sources/jiuyeqiao.mjs";
import { normalizeWebResult } from "../../src/sources/searchapi.mjs";
import { parseSearchResults } from "../../src/sources/wechat.mjs";
test("eight legacy contracts retain partial records and classify failures", async () => {
  assert.equal(legacyProviders.length, 8);
  for (const p of legacyProviders) {
    for (const key of ["collect", "fetchDetail", "probe"])
      assert.equal(typeof p[key], "function");
    const tested = createLegacyProvider(p.id, {
      collector: async () => ({
        jobs: [{ ...job(), source: p.id }],
        errors: ["HTTP 403"],
      }),
    });
    const result = await tested.collect({
      runId: "r",
      queries: [{ keyword: "Java" }],
      sites: [],
      targetSnapshot: { roles: ["Java"] },
      request: async () => {},
      onBatch: async () => {},
      clock: { now: Date.now },
    });
    assert.equal(result.records.length, 1);
    assert.equal(result.coverage[0].status, "failed");
    assert.ok(result.issues.some((x) => x.code === "http_forbidden"));
    if (p.id === "wechat")
      assert.equal(result.records[0].kind, "recruitment_notice");
  }
});
test("legacy fetches share the injected context and combine cancellation", async () => {
  let calls = 0;
  await withSourceContext(
    {
      request: async (url, opts) => {
        calls++;
        assert.equal(opts.headers.test, "1");
        return { status: 200, headers: {}, text: "payload", url };
      },
    },
    async () =>
      assert.equal(
        await (
          await sourceFetch("https://jobs.example.com", {
            headers: { test: "1" },
          })
        ).text(),
        "payload",
      ),
  );
  assert.equal(calls, 1);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    withSourceContext(
      {
        signal: ac.signal,
        request: async () => {
          calls++;
        },
      },
      () => sourceFetch("https://jobs.example.com"),
    ),
    /abort/i,
  );
  assert.equal(calls, 1);
});
test("every retained parser accepts its synthetic shape and rejects missing structure", () => {
  const cases = [
    [
      (x) => normalizePosition(x),
      {
        jobId: "1",
        name: "Java开发",
        positionURL: "https://jobs.example.com/1",
      },
    ],
    [
      (x) => normalizeIntern(x),
      { uuid: "inn_1", name: "Java实习", cname: "合成公司" },
    ],
    [(x) => normalizeNowcoderJob(x), { id: "1", jobName: "工程岗位" }],
    [
      (x) => normalizeWebResult(x, "tavily"),
      { url: "https://jobs.example.com/1", title: "招聘公告" },
    ],
  ];
  for (const [parse, input] of cases) {
    assert.ok(parse(input)?.title);
    assert.equal(parse({}), null);
  }
  const htmlCases = [
    [
      parseSearchFragment,
      '<li><a href="/job/view/id/1">Java开发</a>职位信息</li>',
    ],
    [
      chenyunList,
      '<li><a class="post-title" href="employjobdetail.html?id=1">消防设施维护</a></li>',
    ],
    [
      bridgeList,
      '<ul class="ul-main-list"><li><a href="/zhiwei/1.html"><div class="list-job">设备工程师</div></a></li></ul>',
    ],
    [
      parseSearchResults,
      '<li><h3><a href="/link?url=example">校园招聘公告</a></h3></li>',
    ],
  ];
  for (const [parse, html] of htmlCases) {
    assert.equal(parse(html).length, 1);
    assert.deepEqual(parse("<main>structure changed</main>"), []);
  }
});
