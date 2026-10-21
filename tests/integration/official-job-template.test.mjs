import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import announcements from "../../src/sources/adapters/official-announcements.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";
import { resolveJobIdentity } from "../../src/domain/identity.mjs";
import {
  prepareRecruitmentRecord,
  isVerifiedRecommendation,
} from "../../src/domain/recruitment-evidence.mjs";

const siteId = "official-a64ede1720adf4fa";
const listUrl = "https://www.cimc-tdholding.com/Job/index_lcid_2.html";
const detailUrl = "https://www.cimc-tdholding.com/Job/info_itemid_8.html";
const now = Date.parse("2026-10-12T00:00:00Z");
const read = (kind) =>
  fs.readFileSync(
    new URL(
      `../fixtures/official-template-repair/cimc-${kind}.html`,
      import.meta.url,
    ),
    "utf8",
  );

function replay({
  site,
  listText = read("list"),
  detailText = read("detail"),
  detailStatus = 200,
} = {}) {
  site ||= loadSiteCatalog().find((entry) => entry.siteId === siteId);
  const context = {
    sites: [site],
    clock: { now: () => now },
    request: async (url) => {
      if (url === listUrl) return { status: 200, text: listText, headers: {} };
      if (url === detailUrl)
        return { status: detailStatus, text: detailText, headers: {} };
      throw Error("Unexpected fixture request");
    },
  };
  return { site, context };
}

async function page(fixture) {
  return announcements.collectPage({
    site: fixture.site,
    query: { keyword: "" },
    context: fixture.context,
  });
}

async function detail(fixture) {
  const collected = await page(fixture);
  const record = collected.records.find((row) => row.url === detailUrl);
  assert.ok(record, "the observed native detail URL must be collected");
  return announcements.fetchDetail(record, fixture.context);
}

test("explicit official job templates read data-url and card titles without the notice keyword filter", async () => {
  const fixture = replay();
  const collected = await page(fixture);
  assert.equal(collected.records.length, 6);
  assert.equal(collected.records[0].title, "合成机械工程师1");
  assert.equal(collected.coverageScope, "limited");
  assert.equal(collected.nextCursor, null);
  for (const row of collected.records) {
    assert.equal(row.kind, "job");
    assert.equal(row.urlKind, "job_detail");
    assert.equal(row.sourceRecordId, row.url);
    assert.equal(row.sourceRecordIdKind, "hint");
    assert.equal(row.publishedAt, "2025-07-01T00:00:00.000Z");
    assert.equal(row.jobType, "unknown");
    assert.equal(row.description, null);
    assert.equal(row.detailStatus, "incomplete");
    assert.equal(row.bodyStatus, "incomplete");
    assert.equal(row.bodyIncomplete, true);
  }
  assert.equal(fixture.site.status, "candidate");
  assert.equal(fixture.site.verifiedAt, null);
  assert.equal(fixture.site.adapterVerification, "unverified");
  assert.equal(fixture.site.templateEvidence.requiresLiveProbe, true);
});

test("five equal CIMC titles retain all distinct observed native detail identities", async () => {
  const collected = await page(replay());
  assert.deepEqual(
    collected.records.map((row) => row.url),
    [8, 7, 6, 5, 3, 2].map(
      (id) => `https://www.cimc-tdholding.com/Job/info_itemid_${id}.html`,
    ),
  );
  assert.equal(
    collected.records.filter((row) => row.title === "合成机械工程师").length,
    5,
  );
  assert.equal(
    new Set(collected.records.map((row) => resolveJobIdentity(row).key)).size,
    6,
  );
});

test("official notice mode cannot opt into data-url or unfiltered card titles implicitly", async () => {
  const fixture = replay();
  fixture.site.template.recordKind = "recruitment_notice";
  assert.equal((await page(fixture)).records.length, 0);
});

for (const field of ["requiredBodyRules", "detailTitleRule"]) {
  test(`explicit job templates require ${field} before collecting`, async () => {
    const fixture = replay();
    delete fixture.site.template[field];
    await assert.rejects(page(fixture), { code: "template_not_configured" });
  });
}

test("CIMC's 55-character shared description and empty required duties stay incomplete", async () => {
  const row = await detail(replay());
  assert.equal(row.description.length, 55);
  assert.ok(!row.description.includes("页面导航与版权信息"));
  assert.equal(row.detailStatus, "incomplete");
  assert.equal(row.bodyStatus, "incomplete");
  assert.equal(row.bodyIncomplete, true);
  assert.equal(row.attachments.length, 0);
  assert.ok(!row.attachmentBodyPending);
  const prepared = prepareRecruitmentRecord(row, now);
  assert.equal(prepared.recruitmentEvidence.bodyVerified, false);
  assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
  assert.equal(prepared.deadlineAt, null);
  assert.equal(prepared.applyUrl, null);
  assert.equal(
    isVerifiedRecommendation({
      qualification: { status: "pass" },
      evidence: prepared.recruitmentEvidence,
    }),
    false,
  );
});

test("a missing required duties article stays incomplete as well", async () => {
  const row = await detail(
    replay({
      detailText: read("detail").replace(
        '<article class="edit-info"></article>',
        "",
      ),
    }),
  );
  assert.equal(row.detailStatus, "incomplete");
  assert.equal(row.bodyIncomplete, true);
});

test("all configured body sections are retained when required duties become readable", async () => {
  const duties =
    "合成职责内容：负责整理设备记录、核对维护步骤和登记处理结果；这段独立文字只用于验证多个正文容器，不表示真实岗位条件。";
  const row = await detail(
    replay({
      detailText: read("detail").replace(
        '<article class="edit-info"></article>',
        `<article class="edit-info">${duties}</article>`,
      ),
    }),
  );
  assert.ok(row.description.includes(duties));
  assert.equal(row.detailStatus, "complete");
  assert.equal(row.bodyStatus, "complete");
  assert.equal(row.bodyIncomplete, false);
  assert.equal(row.applyUrl, null);
});

for (const title of ["合成其他工程师", ""]) {
  test(`explicit job detail rejects ${title ? "a different" : "a missing"} observed title`, async () => {
    const fixture = replay({
      detailText: read("detail").replace("合成机械工程师1", title),
    });
    await assert.rejects(detail(fixture), { code: "detail_title_mismatch" });
  });
}

test("data-url must remain within the observed detail path and public origin", async () => {
  const fixture = replay({
    listText: read("list").replace(
      "/Job/info_itemid_8.html",
      "https://unrelated.example.org/Job/info_itemid_8.html",
    ),
  });
  const collected = await page(fixture);
  assert.equal(collected.records.length, 5);
  assert.ok(
    collected.records.every(
      (row) => new URL(row.url).hostname === "www.cimc-tdholding.com",
    ),
  );
});

for (const [code, status, text] of [
  ["captcha", 200, "<title>安全验证</title><p>人机验证</p>"],
  ["restricted", 403, "<p>Access denied</p>"],
]) {
  test(`CIMC job templates reject ${code} detail responses`, async () => {
    await assert.rejects(
      detail(replay({ detailStatus: status, detailText: text })),
      { code },
    );
  });
}
