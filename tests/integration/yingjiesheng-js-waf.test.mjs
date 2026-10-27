import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import yingjiesheng from "../../src/sources/adapters/yingjiesheng.mjs";
import { readProviderPage } from "../../src/sources/collection-page.mjs";
import { job } from "../helpers/fixtures.mjs";

const record = () =>
  job({
    sourceId: "yingjiesheng",
    siteId: "yingjiesheng",
    sourceRecordId: "000-001-001",
    sourceRecordIdKind: "authority",
    urlKind: "notice_detail",
    kind: "company_campaign",
    title: "合成校园招聘公告",
    url: "https://www.yingjiesheng.com/job-000-001-001.html",
    description: null,
  });
const challenge = () =>
  fs.readFile(
    new URL("../fixtures/yingjiesheng/js-waf-challenge.html", import.meta.url),
    "utf8",
  );
const requirements =
  "合成单位校园招聘公告：招聘工程师，要求本科及以上，负责设备维护、技术支持与项目协调工作。";
function detail(html) {
  const input = record();
  return yingjiesheng.fetchDetail(input, {
    sites: [{ siteId: "yingjiesheng" }],
    request: async (url) => {
      if (url !== input.url) throw Error("unexpected fixture request");
      return { status: 200, text: html, requestId: "synthetic-waf-detail" };
    },
  });
}

test("a public detail JavaScript cookie challenge is an explicit restriction", async () => {
  await assert.rejects(detail(await challenge()), {
    code: "challenge_required",
    retryable: false,
    requestId: "synthetic-waf-detail",
  });
});

test("the same JavaScript challenge cannot become a missing deadline table", async () => {
  await assert.rejects(
    readProviderPage(yingjiesheng, {
      unitId: "synthetic-waf-list",
      site: { siteId: "yingjiesheng" },
      query: { pageLimit: 1 },
      request: async () => ({ status: 200, text: await challenge() }),
    }),
    { code: "challenge_required", retryable: false },
  );
});

test("article text mentioning WAF cookies remains public recruitment content", async () => {
  const result = await detail(
    '<div id="job_content">' +
      requirements +
      "技术资料涉及 aliyun_waf_aa、aliyun_waf_bb、renderData、acw_sc__v2、waf、cookie 与 location.reload。" +
      "</div>",
  );
  assert.ok(result.description.includes(requirements));
  assert.equal(result.detailStatus, "complete");
});

test("a cookie script without the challenge document markers is not blocked", async () => {
  const result = await detail(
    '<div id="job_content">' +
      requirements +
      "</div>" +
      '<script>var cookieName = "acw_sc__v2"; document.cookie = cookieName; document.location.reload();</script>',
  );
  assert.equal(result.description, requirements);
});

test("challenge document markers without its cookie reload script are not blocked", async () => {
  const result = await detail(
    '<textarea id="renderData">synthetic</textarea>' +
      '<meta name="aliyun_waf_aa" content="synthetic"><meta name="aliyun_waf_bb" content="synthetic">' +
      '<div id="job_content">' +
      requirements +
      "</div>",
  );
  assert.equal(result.description, requirements);
});
