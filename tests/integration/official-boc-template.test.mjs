import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import announcements from "../../src/sources/adapters/official-announcements.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";
import {
  prepareRecruitmentRecord,
  isVerifiedRecommendation,
} from "../../src/domain/recruitment-evidence.mjs";

const listUrl = "https://www.boc.cn/";
const detailUrl =
  "https://www.boc.cn/aboutboc/bi4/202607/t20260721_25680323.html";
const read = (kind) =>
  fs.readFileSync(
    new URL(
      `../fixtures/official-template-repair/boc-${kind}.html`,
      import.meta.url,
    ),
    "utf8",
  );
const now = Date.parse("2026-10-12T00:00:00Z");
function replay({
  list = read("list"),
  detail = read("detail"),
  detailStatus = 200,
} = {}) {
  const site = loadSiteCatalog().find((row) => row.siteId === "boc");
  const requests = [];
  const context = {
    sites: [site],
    clock: { now: () => now },
    request: async (url) => {
      requests.push(url);
      if (url === listUrl) return { status: 200, text: list, headers: {} };
      if (url === detailUrl)
        return { status: detailStatus, text: detail, headers: {} };
      throw Error("Unexpected public fixture request");
    },
  };
  return { site, context, requests };
}
async function collect(fixture) {
  return announcements.collectPage({
    site: fixture.site,
    query: { keyword: "消防" },
    context: fixture.context,
  });
}
test("BOC native recruitment link becomes one scoped notice, excluding navigation, other columns and duplicates", async () => {
  const fixture = replay();
  const result = await collect(fixture);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].url, detailUrl);
  assert.equal(result.records[0].title, "合成消防安全招聘公告");
  assert.equal(result.records[0].kind, "recruitment_notice");
  assert.equal(result.coverageScope, "limited");
  assert.equal(result.nextCursor, null);
  assert.deepEqual(fixture.requests, [listUrl]);
});
test("BOC scoped body and publication date exclude page chrome and non-body attachments", async () => {
  const fixture = replay();
  const result = await collect(fixture);
  const detail = await announcements.fetchDetail(
    result.records[0],
    fixture.context,
  );
  assert.equal(detail.publishedAt, "2026-07-21T00:00:00.000Z");
  assert.equal(detail.detailStatus, "complete");
  assert.ok(detail.description.includes("合成消防安全招聘正文"));
  assert.ok(detail.description.includes("2026年8月9日24时前"));
  assert.ok(!detail.description.includes("页面导航与版权信息"));
  assert.ok(!detail.description.includes("分享打印"));
  assert.deepEqual(detail.attachments, []);
  assert.equal(
    prepareRecruitmentRecord(detail, now).recruitmentEvidence.bodyVerified,
    true,
  );
});
test("BOC official portal URL is only an unverified application clue and is never silently requested", async () => {
  const fixture = replay();
  const result = await collect(fixture);
  const detail = await announcements.fetchDetail(
    result.records[0],
    fixture.context,
  );
  assert.equal(detail.applyUrl, "http://chrcmp.chinahr.com/pages/boc-social");
  const evidence = detail.sourceEvidence.find(
    (item) => item.field === "applyUrl",
  );
  assert.equal(evidence.status, "unknown");
  assert.equal(evidence.sourceUrl, detailUrl);
  const prepared = prepareRecruitmentRecord(detail, now);
  assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
  assert.equal(
    isVerifiedRecommendation({
      qualification: { status: "pass" },
      evidence: prepared.recruitmentEvidence,
    }),
    false,
  );
  assert.deepEqual(fixture.requests, [listUrl, detailUrl]);
});
test("BOC public body replay does not promote the catalog or fabricate live probe completion", async () => {
  const fixture = replay();
  await collect(fixture);
  assert.equal(fixture.site.status, "candidate");
  assert.equal(fixture.site.verifiedAt, null);
  assert.equal(fixture.site.adapterVerification, "unverified");
  assert.equal(fixture.site.templateEvidence.requiresLiveProbe, true);
  assert.equal(fixture.site.template.paginationVerified, false);
});
for (const [code, status, text] of [
  ["restricted", 403, "<p>Access denied</p>"],
  ["captcha", 200, "<title>安全验证</title><p>人机验证</p>"],
]) {
  test(`BOC rejects ${code} responses rather than accepting page chrome as body`, async () => {
    const fixture = replay({ detailStatus: status, detail: text });
    const result = await collect(fixture);
    await assert.rejects(
      announcements.fetchDetail(result.records[0], fixture.context),
      { code },
    );
  });
}
test("BOC missing scoped editor fails even when unrelated chrome has enough text", async () => {
  const fixture = replay({
    detail:
      '<div class="con_area"><h2 class="title">合成招聘岗位标题</h2><p class="con_time">2026-07-21</p><footer>页面导航与版权信息超过最小长度，但不属于岗位正文。</footer></div>',
  });
  const result = await collect(fixture);
  await assert.rejects(
    announcements.fetchDetail(result.records[0], fixture.context),
    { code: "parse_error" },
  );
});
