import test from "node:test";
import assert from "node:assert/strict";
import tencent from "../../src/sources/adapters/tencent.mjs";
import ncss from "../../src/sources/adapters/ncss.mjs";
import job91 from "../../src/sources/adapters/university-91job.mjs";
import { job } from "../helpers/fixtures.mjs";

function context(sourceId, response) {
  return {
    sites: [{ siteId: sourceId }],
    queries: [{ keyword: "合成公开岗位", pageLimit: 1 }],
    request: async () => response,
    clock: { now: Date.now },
  };
}

test("Tencent's official zero-count null Posts response is a successful empty collection", async () => {
  const result = await tencent.collect(
    context("tencent", {
      status: 200,
      text: JSON.stringify({ Code: 200, Data: { Count: 0, Posts: null } }),
    }),
  );
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.issues, []);
  assert.equal(result.stats.raw, 0);
  assert.equal(result.coverage[0].status, "complete");
  assert.equal(result.coverage[0].truncated, false);
});

test("Tencent still rejects nonempty or malformed Posts contracts", async () => {
  for (const data of [
    { Count: 1, Posts: null },
    { Count: 0, Posts: {} },
    { Count: 0 },
  ]) {
    const result = await tencent.collect(
      context("tencent", {
        status: 200,
        text: JSON.stringify({ Code: 200, Data: data }),
      }),
    );
    assert.equal(result.issues[0].code, "parse_error");
    assert.equal(result.coverage[0].status, "failed");
  }
});

test("NCSS follows record count instead of treating the page total as a record count", async () => {
  let requests = 0;
  const ctx = context("ncss", null);
  ctx.queries[0].pageLimit = 2;
  ctx.request = async (url) => {
    const page = Number(new URL(url).searchParams.get("offset"));
    requests++;
    return {
      status: 200,
      text: JSON.stringify({
        flag: true,
        data: {
          list: Array.from({ length: 20 }, (_, i) => ({
            jobId: "page-" + page + "-job-" + i,
            jobName: "合成工程岗位",
            recruitType: "0",
          })),
          pagenation: { count: 200, total: 10, limit: 20, offset: page },
        },
      }),
    };
  };
  const result = await ncss.collect(ctx);
  assert.equal(requests, 2);
  assert.equal(result.records.length, 40);
  assert.equal(result.stats.raw, 40);
  assert.equal(result.coverage[0].pages, 2);
  assert.equal(result.coverage[0].truncated, true);
});

test("NCSS stops at the last page when all records fit on one full page", async () => {
  let requests = 0;
  const ctx = context("ncss", {
    status: 200,
    text: JSON.stringify({
      flag: true,
      data: {
        list: Array.from({ length: 20 }, (_, i) => ({
          jobId: String(i),
          jobName: "合成工程岗位",
          recruitType: "0",
        })),
        pagenation: { count: 20, total: 1, limit: 20, offset: 1 },
      },
    }),
  });
  ctx.queries[0].pageLimit = 2;
  const request = ctx.request;
  ctx.request = (...args) => {
    requests++;
    return request(...args);
  };
  const result = await ncss.collect(ctx);
  assert.equal(requests, 1);
  assert.equal(result.records.length, 20);
  assert.equal(result.coverage[0].truncated, false);
});

const requirements =
  "负责仪表设备维护与工程实施，要求具备相关专业知识和现场项目经验。";
for (const primary of ["", '<div class="mainContent">提示</div>']) {
  test(
    "NCSS selects an adequate fallback body when the primary body is " +
      (primary ? "short" : "absent"),
    async () => {
      const record = job({ sourceId: "ncss", siteId: "ncss" });
      const detail = await ncss.fetchDetail(
        record,
        context("ncss", {
          status: 200,
          text:
            primary +
            '<div class="jobdetail-box"><p>' +
            requirements +
            "</p></div>",
        }),
      );
      assert.equal(detail.description, requirements);
      assert.equal(detail.evidence.at(-1).selector, ".jobdetail-box");
      assert.equal(detail.sourceRecordId, "1");
    },
  );
}

test("NCSS continues to reject absent or insufficient requirements", async () => {
  const record = job({ sourceId: "ncss", siteId: "ncss" });
  for (const [html, code] of [
    ["<p>没有正文结构的公开页面</p>", "parse_error"],
    [
      '<div class="mainContent">提示</div><div class="jobdetail-box">短正文</div>',
      "detail_insufficient",
    ],
  ]) {
    await assert.rejects(
      ncss.fetchDetail(
        record,
        context("ncss", {
          status: 200,
          text: html,
        }),
      ),
      { code },
    );
  }
});

const school = {
  siteId: "school",
  tenantId: "10286",
  origin: "https://school.example.com",
};
test("91job lists bound an unavailable gateway to one request attempt", async () => {
  let options;
  const ctx = context("school", { status: 504, text: "Gateway timeout" });
  ctx.sites = [school];
  const request = ctx.request;
  ctx.request = (url, input) => {
    options = input;
    return request(url, input);
  };
  const result = await job91.collect(ctx);
  assert.equal(result.coverage[0].status, "failed");
  assert.match(result.issues[0].message, /HTTP 504/);
  assert.equal(options.maxRetries, 0);
  assert.equal(options.timeoutMs, 12000);
});

test("91job details use the same single attempt and timeout bound", async () => {
  let options;
  const record = job({
    sourceId: "university-91job",
    siteId: "school",
    identityScope: "10286",
  });
  const ctx = context("school", {
    status: 200,
    text: JSON.stringify({
      success: true,
      code: 200,
      result: {
        zpgwid: "1",
        zwmc: "合成工程岗位",
        zwms: requirements,
      },
    }),
  });
  ctx.sites = [school];
  const request = ctx.request;
  ctx.request = (url, input) => {
    options = input;
    return request(url, input);
  };
  const detail = await job91.fetchDetail(record, ctx);
  assert.equal(detail.description, requirements);
  assert.equal(options.maxRetries, 0);
  assert.equal(options.timeoutMs, 12000);
});
