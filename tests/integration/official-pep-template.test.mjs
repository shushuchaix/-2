import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import announcements from "../../src/sources/adapters/official-announcements.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";
import {
  prepareRecruitmentRecord,
  isVerifiedRecommendation,
} from "../../src/domain/recruitment-evidence.mjs";

const listUrl = "https://www.pep.com.cn/";
const detailUrl =
  "https://www.pep.com.cn/rjdt/jqgg/202609/t20260929_2008304.shtml";
const now = Date.parse("2026-10-12T00:00:00Z");
const read = (kind) =>
  fs.readFileSync(
    new URL(
      `../fixtures/official-template-repair/pep-${kind}.html`,
      import.meta.url,
    ),
    "utf8",
  );
function replay({
  list = read("list"),
  detail = read("detail"),
  status = 200,
} = {}) {
  const site = loadSiteCatalog().find((row) => row.siteId === "pep");
  const requests = [];
  const context = {
    sites: [site],
    clock: { now: () => now },
    request: async (url) => {
      requests.push(url);
      if (url === listUrl) return { status: 200, text: list, headers: {} };
      if (url === detailUrl) return { status, text: detail, headers: {} };
      throw Error("Unexpected public fixture request");
    },
  };
  return { site, requests, context };
}
async function collect(fixture) {
  return announcements.collectPage({
    site: fixture.site,
    query: { keyword: "招聘" },
    context: fixture.context,
  });
}
async function detail(fixture) {
  const page = await collect(fixture);
  return announcements.fetchDetail(page.records[0], fixture.context);
}

test("PEP native notice URL identifies one announcement without navigation, duplicate or external rows", async () => {
  const fixture = replay();
  const page = await collect(fixture);
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].url, detailUrl);
  assert.equal(page.records[0].title, "合成人教应届毕业生招聘简章");
  assert.equal(page.records[0].kind, "recruitment_notice");
  assert.equal(page.records[0].identityScope, "pep");
  assert.equal(page.records[0].publishedAt, null);
  assert.equal(page.coverageScope, "limited");
  assert.equal(page.nextCursor, null);
  assert.deepEqual(fixture.requests, [listUrl]);
});

test("PEP scoped body and independent visible publication date preserve a single aggregate notice", async () => {
  const fixture = replay();
  const record = await detail(fixture);
  assert.equal(record.kind, "recruitment_notice");
  assert.equal(record.publishedAt, "2026-09-29T00:00:00.000Z");
  assert.equal(record.detailStatus, "complete");
  assert.ok(record.description.includes("共招收16人"));
  assert.ok(record.description.includes("本公告未列逐个岗位"));
  assert.ok(!record.description.includes("页面导航与版权信息"));
  assert.ok(!record.description.includes("分享打印"));
  assert.ok(!record.description.includes("相关阅读"));
  assert.deepEqual(record.attachments, []);
  assert.equal(
    prepareRecruitmentRecord(record, now).recruitmentEvidence.bodyVerified,
    true,
  );
});

test("PEP partial closing date does not borrow a year from publication or URL; login text is not an available application", async () => {
  const fixture = replay();
  const record = prepareRecruitmentRecord(await detail(fixture), now);
  assert.equal(record.deadlineAt, null);
  assert.equal(record.recruitmentEvidence.openingStatus, "unknown");
  assert.equal(record.recruitmentEvidence.applicationStatus, "unknown");
  assert.equal(
    isVerifiedRecommendation({
      qualification: { status: "pass" },
      evidence: record.recruitmentEvidence,
    }),
    false,
  );
  assert.ok(record.description.includes("https://jybzp.chsi.com.cn"));
  assert.ok(record.description.includes("学信网账号登录"));
  assert.deepEqual(fixture.requests, [listUrl, detailUrl]);
});

test("PEP missing visible publication date remains unknown despite the date in the native detail URL", async () => {
  const fixture = replay({
    detail: read("detail").replace("时间：2026-09-29", "时间：待提供"),
  });
  assert.equal((await detail(fixture)).publishedAt, null);
});

test("PEP download anchors are scoped to the notice editor and do not become a submission form", async () => {
  const fixture = replay({
    detail: read("detail").replace(
      "<p>五、招聘流程</p>",
      '<a href="./synthetic-positions.xlsx">合成岗位附件</a><p>五、招聘流程</p>',
    ),
  });
  const record = await detail(fixture);
  assert.deepEqual(record.attachments, [
    {
      url: "https://www.pep.com.cn/rjdt/jqgg/202609/synthetic-positions.xlsx",
      title: "合成岗位附件",
      textStatus: "not_extracted",
    },
  ]);
  assert.equal(
    prepareRecruitmentRecord(record, now).recruitmentEvidence.applicationStatus,
    "unknown",
  );
});

test("PEP reduced replay does not promote catalog verification or claim all-page coverage", async () => {
  const fixture = replay();
  await detail(fixture);
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
  test(`PEP rejects ${code} before accepting page text as notice body`, async () => {
    await assert.rejects(detail(replay({ status, detail: text })), { code });
  });
}

test("PEP absent editor fails even when page chrome and date exist", async () => {
  await assert.rejects(
    detail(
      replay({
        detail:
          '<div class="jn_main"><h1>合成人教应届毕业生招聘简章</h1><div class="main1_t_tsnw"><span>时间：2026-09-29</span></div><footer>合成导航与版权信息足够长但不属于招聘正文，不能作为岗位资格或者公告事实。</footer></div>',
      }),
    ),
    { code: "parse_error" },
  );
});
