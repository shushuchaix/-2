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
import {
  parseSearchFragment,
  parseNoticeDetail,
  collect as collectUniversity,
} from "../../src/sources/university.mjs";
import { resolveJobIdentity } from "../../src/domain/identity.mjs";
import { normalizeRecord } from "../../src/domain/record.mjs";
import { createSourceBudget } from "../../src/infrastructure/http/budget.mjs";
import { parseListFragment as chenyunList } from "../../src/sources/chenyun.mjs";
import { parseListFragment as bridgeList } from "../../src/sources/jiuyeqiao.mjs";
import { normalizeWebResult } from "../../src/sources/searchapi.mjs";
import { parseSearchResults } from "../../src/sources/wechat.mjs";

test("legacy university sources keep list clues with zero detail credits", async () => {
  const fixtures = {
    university: '<li><a href="/job/view/id/1">合成岗位甲</a>职位信息</li>',
    chenyun:
      '<li><a class="post-title" href="/index/index/employjobdetail.html?id=1">合成岗位甲</a></li>',
    jiuyeqiao:
      '<ul class="ul-main-list"><li><a href="/zhiwei/1.html"><div class="list-job">合成岗位甲</div></a></li></ul>',
  };
  for (const [id, html] of Object.entries(fixtures)) {
    let detailCalls = 0;
    const result = await createLegacyProvider(id).collect({
      queries: [{ keyword: "合成", pageLimit: 1 }],
      sites: [
        {
          siteId: "school",
          name: "合成高校",
          origin: "https://school.example.org",
        },
      ],
      budget: createSourceBudget({ maxDetails: 0 }),
      request: async (url) => {
        if (
          /\/job\/view|\/campus\/view|employjobdetail|\/zhiwei\/1/.test(url)
        ) {
          detailCalls++;
          throw Error("unexpected_detail_request");
        }
        return { status: 200, text: html, headers: {} };
      },
    });
    assert.equal(result.records.length, 1, id);
    assert.equal(result.records[0].title, "合成岗位甲");
    assert.equal(result.records[0].siteId, "school");
    assert.equal(result.records[0].detailStatus, "incomplete");
    assert.equal(detailCalls, 0);
    assert.equal(typeof createLegacyProvider(id).fetchDetail, "function");
  }
});

test("university notice rows have distinct stable names and identities", async () => {
  const rows = [
    "<tr><td>01</td><td>合成岗位甲</td><td>北京市</td><td>本科</td></tr>",
    "<tr><td>02</td><td>合成岗位乙</td><td>北京市</td><td>硕士</td></tr>",
  ];
  const keys = [];
  for (const order of [rows, rows.toReversed()]) {
    const result = await withSourceContext(
      {
        request: async (url) => ({
          status: 200,
          headers: {},
          text: /\/search\//.test(url)
            ? '<li><a href="/campus/view/id/1">合成公司招聘公告</a>招聘公告</li>'
            : "<title>合成公司招聘公告</title><p>公司招聘。</p><table>" +
              order.join("") +
              "</table>",
        }),
      },
      () =>
        collectUniversity({
          keywords: ["合成"],
          hosts: [{ host: "https://school.example.org", name: "合成高校" }],
          maxDetail: 1,
          delayMs: 0,
        }),
    );
    const sub = result.jobs.filter((j) => j.extra.kind === "招聘公告-职位表");
    assert.deepEqual(
      sub.map((j) => j.title).sort(),
      ["合成岗位乙", "合成岗位甲"].sort(),
    );
    assert.notEqual(sub[0].id, sub[1].id);
    assert.ok(
      sub.every(
        (j) =>
          !j.description.includes(
            j.title === "合成岗位甲" ? "合成岗位乙" : "合成岗位甲",
          ),
      ),
    );
    keys.push(
      sub.map((j) => resolveJobIdentity(normalizeRecord(j)).key).sort(),
    );
    assert.notEqual(keys.at(-1)[0], keys.at(-1)[1]);
  }
  assert.deepEqual(keys[0], keys[1]);
});

test("university application buttons do not discard valid position rows", () => {
  const html =
    '<table><tr><td>01</td><td>合成岗位甲</td><td>北京市</td><td>本科</td><td><a href="/apply/1">投递简历</a></td></tr><tr><td>电话：合成占位</td><td>联系</td><td>地址</td></tr></table>';
  assert.deepEqual(
    parseNoticeDetail(html).positions.map((p) => p.name),
    ["合成岗位甲"],
  );
});

test("legacy details claim idempotent credits before HTTP", async () => {
  for (const id of ["zhaopin", "shixiseng"]) {
    const provider = createLegacyProvider(id);
    const record = {
      ...job(),
      sourceId: id,
      sourceRecordId: "one",
      siteId: "s",
      url: "https://jobs.example.org/one",
    };
    let requests = 0;
    const context = {
      request: async () => {
        requests++;
        return {
          status: 200,
          headers: {},
          text: "<main>岗位职责：合成设备维护。任职要求：本科。</main>",
        };
      },
      budget: createSourceBudget({ maxDetails: 0 }),
    };
    await assert.rejects(provider.fetchDetail(record, context), {
      code: "source_budget_exhausted",
    });
    assert.equal(requests, 0);
    context.budget = createSourceBudget({ maxDetails: 1 });
    await provider.fetchDetail(record, context);
    await provider.fetchDetail(record, context);
    assert.equal(context.budget.snapshot().details, 1);
    await assert.rejects(
      provider.fetchDetail({ ...record, sourceRecordId: "two" }, context),
      { code: "source_budget_exhausted" },
    );
    assert.equal(requests, 2);
  }
});
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
