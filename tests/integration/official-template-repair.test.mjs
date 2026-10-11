import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import announcements from "../../src/sources/adapters/official-announcements.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";
import {
  prepareRecruitmentRecord,
  isVerifiedRecommendation,
} from "../../src/domain/recruitment-evidence.mjs";

const now = Date.parse("2026-10-12T00:00:00Z");
const cases = [
  {
    siteId: "official-d80ddfbc91795a1f",
    fixture: "zhejiang",
    listUrl: "https://www.zjairports.com/newRecruitment.html",
    detailUrl: "https://www.zjairports.com/newRecruitmentInfo.html?id=132",
    title: "公开招聘岗位公告",
    publishedAt: null,
    attachments: 2,
  },
  {
    siteId: "official-1144ced905f90a21",
    fixture: "wenzhou",
    listUrl: "https://www.wzair.cn/zygg/rlzygg/",
    detailUrl: "https://www.wzair.cn/zygg/rlzygg/2024/08/15/310851.html",
    title: "公开岗位招聘公告",
    publishedAt: "2024-08-15T00:00:00.000Z",
    attachments: 0,
  },
];

function replay(row, { listResponse, detailResponse } = {}) {
  const site = loadSiteCatalog().find((entry) => entry.siteId === row.siteId);
  const read = (kind) =>
    fs.readFileSync(
      new URL(
        `../fixtures/official-template-repair/${row.fixture}-${kind}.html`,
        import.meta.url,
      ),
      "utf8",
    );
  const context = {
    sites: [site],
    clock: { now: () => now },
    request: async (url) => {
      if (url === row.listUrl)
        return listResponse || { status: 200, text: read("list"), headers: {} };
      if (url === row.detailUrl)
        return (
          detailResponse || { status: 200, text: read("detail"), headers: {} }
        );
      throw Error("Unexpected fixture request");
    },
  };
  return { site, context };
}

async function listRecord(row, fixture) {
  const page = await announcements.collectPage({
    site: fixture.site,
    query: { keyword: "" },
    context: fixture.context,
  });
  assert.equal(page.records.length, 1);
  return { record: page.records[0], page };
}

for (const row of cases) {
  test(`${row.siteId} reads the observed recruitment list without navigation or duplicate excerpts`, async () => {
    const fixture = replay(row);
    const { record, page } = await listRecord(row, fixture);
    assert.equal(record.url, row.detailUrl);
    assert.equal(record.title, row.title);
    assert.equal(record.kind, "recruitment_notice");
    assert.equal(page.coverageScope, "limited");
    assert.equal(page.nextCursor, null);
    assert.equal(fixture.site.status, "candidate");
    assert.equal(fixture.site.verifiedAt, null);
  });

  test(`${row.siteId} confines the body and publication date to observed detail structure`, async () => {
    const fixture = replay(row);
    const { record } = await listRecord(row, fixture);
    const detail = await announcements.fetchDetail(record, fixture.context);
    assert.equal(detail.detailStatus, "complete");
    assert.ok(detail.description.includes("岗位"));
    assert.ok(!detail.description.includes("页面导航与版权信息"));
    assert.equal(detail.publishedAt, row.publishedAt);
    assert.equal(detail.attachments.length, row.attachments);
    assert.equal(detail.applyUrl, null);
    const prepared = prepareRecruitmentRecord(detail, now);
    assert.equal(prepared.recruitmentEvidence.bodyVerified, true);
    assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
    assert.equal(
      isVerifiedRecommendation({
        qualification: { status: "pass" },
        evidence: prepared.recruitmentEvidence,
      }),
      false,
    );
  });

  for (const [code, response] of [
    [
      "captcha",
      { status: 200, text: "<title>安全验证</title><p>人机验证</p>" },
    ],
    ["restricted", { status: 403, text: "<p>Access denied</p>" }],
  ]) {
    test(`${row.siteId} rejects ${code} detail HTML instead of producing verified content`, async () => {
      const fixture = replay(row, { detailResponse: response });
      const { record } = await listRecord(row, fixture);
      await assert.rejects(announcements.fetchDetail(record, fixture.context), {
        code,
      });
      assert.equal(fixture.site.status, "candidate");
      assert.equal(fixture.site.verifiedAt, null);
    });
  }
}

test("the Zhejiang historical deadline stays expired and registration downloads cannot prove applying", async () => {
  const row = cases[0];
  const fixture = replay(row);
  const { record } = await listRecord(row, fixture);
  const detail = await announcements.fetchDetail(record, fixture.context);
  const prepared = prepareRecruitmentRecord(detail, now);
  assert.equal(prepared.deadlineAt, "2026-09-01T15:59:59.999Z");
  assert.equal(prepared.recruitmentEvidence.openingStatus, "expired");
  assert.equal(prepared.applyUrl, null);
  assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
  assert.ok(
    prepared.attachments.some((attachment) => attachment.url.endsWith(".docx")),
  );
});

const cah = {
  siteId: "official-0201d47ae30267a0",
  fixture: "cah",
  listUrl: "https://www.cah.com.cn/Information/Recruit/",
  detailUrl:
    "https://www.cah.com.cn/content/2026/03-23/7442058771477565440.html",
};

test("CAH reads the observed recruitment list while remaining a candidate", async () => {
  const fixture = replay(cah);
  const { record, page } = await listRecord(cah, fixture);
  assert.equal(record.url, cah.detailUrl);
  assert.equal(record.title, "公开招聘岗位公告");
  assert.equal(record.publishedAt, "2026-03-23T00:00:00.000Z");
  assert.equal(record.kind, "recruitment_notice");
  assert.equal(page.coverageScope, "limited");
  assert.equal(page.nextCursor, null);
  assert.equal(fixture.site.status, "candidate");
  assert.equal(fixture.site.verifiedAt, null);
  assert.equal(fixture.site.adapterVerification, "unverified");
  assert.equal(fixture.site.templateEvidence.requiresLiveProbe, true);
});

test("CAH's 22-character DOC page stays incomplete until attachment text is extracted", async () => {
  const fixture = replay(cah);
  const { record } = await listRecord(cah, fixture);
  const detail = await announcements.fetchDetail(record, fixture.context);
  assert.equal(detail.description.length, 22);
  assert.ok(!detail.description.includes("页面导航与版权信息"));
  assert.equal(detail.publishedAt, "2026-03-23T00:00:00.000Z");
  assert.equal(detail.attachments.length, 1);
  assert.equal(
    detail.attachments[0].url,
    "https://www.cah.com.cn/upload/2026/03-24/structure-fixture.doc",
  );
  assert.equal(detail.attachments[0].textStatus, "not_extracted");
  assert.equal(detail.detailStatus, "incomplete");
  assert.equal(detail.bodyStatus, "incomplete");
  assert.equal(detail.attachmentBodyPending, true);
  assert.equal(detail.retryEligible, true);
  const prepared = prepareRecruitmentRecord(detail, now);
  assert.equal(prepared.recruitmentEvidence.bodyVerified, false);
  assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  assert.equal(prepared.deadlineAt, null);
  assert.equal(prepared.applyUrl, null);
  assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
  assert.equal(
    isVerifiedRecommendation({
      qualification: { status: "pass" },
      evidence: prepared.recruitmentEvidence,
    }),
    false,
  );
});

test("CAH image-only content cannot use title or page navigation to become complete", async () => {
  const fixture = replay(cah, {
    detailResponse: {
      status: 200,
      text: `
      <div class="content-container">
        <div class="content-title-box"><div class="title">公开招聘岗位公告标题及其他页面信息超过正文最小长度</div></div>
        <div id="content" class="content-inner"><p><img src="/structure-banner.png"></p><p><br></p></div>
        <div class="content-pages-box">上一篇页面导航与版权信息不能充当招聘公告岗位正文</div>
      </div>
    `,
    },
  });
  const { record } = await listRecord(cah, fixture);
  await assert.rejects(announcements.fetchDetail(record, fixture.context), {
    code: "detail_insufficient",
  });
});

for (const [code, response] of [
  ["captcha", { status: 200, text: "<title>安全验证</title><p>人机验证</p>" }],
  ["restricted", { status: 403, text: "<p>Access denied</p>" }],
]) {
  test(`CAH rejects ${code} HTML before attaching evidence`, async () => {
    const fixture = replay(cah, { detailResponse: response });
    const { record } = await listRecord(cah, fixture);
    await assert.rejects(announcements.fetchDetail(record, fixture.context), {
      code,
    });
    assert.equal(fixture.site.status, "candidate");
    assert.equal(fixture.site.verifiedAt, null);
  });
}
