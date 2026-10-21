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

const siteId = "official-9b7b3076410fcacc";
const listUrl = "https://www.gst.com.cn/contactus/";
const now = Date.parse("2026-10-12T00:00:00Z");
const html = fs.readFileSync(
  new URL(
    "../fixtures/official-template-repair/gst-inline.html",
    import.meta.url,
  ),
  "utf8",
);
const firstRequirements =
  "合成要求甲：能够阅读技术文档，清楚记录处理过程并核对信息；此段不表示真实岗位条件。";

function replay({ text = html, detailText = text, status = 200 } = {}) {
  const site = loadSiteCatalog().find((entry) => entry.siteId === siteId);
  let requestCount = 0;
  const context = {
    sites: [site],
    clock: { now: () => now },
    request: async (url) => {
      assert.equal(
        url,
        listUrl,
        "only the configured same-page public URL may be requested",
      );
      requestCount++;
      return {
        status,
        text: requestCount === 1 ? text : detailText,
        headers: {},
      };
    },
  };
  return { site, context };
}
const page = (fixture, cursor = null) =>
  announcements.collectPage({
    site: fixture.site,
    cursor,
    query: { keyword: "" },
    context: fixture.context,
  });

test("GST explicit inline jobs retain three authoritative identities even when two titles are equal", async () => {
  const fixture = replay();
  const result = await page(fixture);
  assert.deepEqual(
    result.records.map((r) => r.sourceRecordId),
    ["career-detail-9901", "career-detail-9902", "career-detail-9903"],
  );
  assert.deepEqual(
    result.records.map((r) => r.url),
    [
      listUrl + "#career-detail-9901",
      listUrl + "#career-detail-9902",
      listUrl + "#career-detail-9903",
    ],
  );
  assert.equal(
    result.records.filter((r) => r.title === "合成方案工程师").length,
    2,
  );
  assert.equal(
    new Set(result.records.map((r) => resolveJobIdentity(r).key)).size,
    3,
  );
  for (const record of result.records) {
    assert.equal(record.sourceRecordIdKind, "authority");
    assert.equal(record.urlKind, "job_detail");
    assert.equal(record.kind, "job");
    assert.equal(record.jobType, "unknown");
    assert.equal(record.publishedAt, "2026-09-04T00:00:00.000Z");
  }
  assert.equal(result.coverageScope, "limited");
  assert.equal(result.nextCursor, null);
  assert.equal(fixture.site.status, "candidate");
  assert.equal(fixture.site.verifiedAt, null);
  assert.equal(fixture.site.adapterVerification, "unverified");
});

test("GST complete list bodies stay scoped to each native job while opening and mailto application remain unknown", async () => {
  const result = await page(replay());
  const first = result.records[0];
  assert.ok(first.description.includes("合成职责甲"));
  assert.ok(first.description.includes(firstRequirements));
  assert.ok(!first.description.includes("合成职责乙"));
  assert.ok(!first.description.includes("合成导航"));
  assert.ok(!first.description.includes("合成版权"));
  assert.ok(!first.description.includes("example.invalid"));
  for (const record of result.records) {
    assert.equal(record.detailStatus, "complete");
    assert.equal(record.bodyStatus, "complete");
    assert.equal(record.bodyIncomplete, false);
    const prepared = prepareRecruitmentRecord(record, now);
    assert.equal(prepared.recruitmentEvidence.bodyVerified, true);
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
  }
});

test("inline fetchDetail locates the requested native ID and title rather than reading the first job", async () => {
  const fixture = replay();
  const record = (await page(fixture)).records[1];
  const result = await announcements.fetchDetail(record, fixture.context);
  assert.equal(result.sourceRecordId, "career-detail-9902");
  assert.ok(result.description.includes("合成职责乙"));
  assert.ok(!result.description.includes("合成职责甲"));
  assert.equal(result.detailStatus, "complete");
});

for (const replacement of ["", '<img src="/structure-fixture.png" alt="">']) {
  test(`an ${replacement ? "image-only" : "empty"} required inline section remains incomplete`, async () => {
    const fixture = replay({
      text: html.replace(firstRequirements, replacement),
    });
    const record = (await page(fixture)).records[0];
    assert.equal(record.detailStatus, "incomplete");
    assert.equal(record.bodyStatus, "incomplete");
    assert.equal(record.bodyIncomplete, true);
    assert.equal(
      prepareRecruitmentRecord(record, now).recruitmentEvidence.bodyVerified,
      false,
    );
    assert.equal(
      (await announcements.fetchDetail(record, fixture.context)).detailStatus,
      "incomplete",
    );
  });
}

test("a changed inline title cannot satisfy detail for the same native ID", async () => {
  const fixture = replay({
    detailText: html.replace("合成方案工程师", "合成其他岗位"),
  });
  const record = (await page(fixture)).records[0];
  await assert.rejects(announcements.fetchDetail(record, fixture.context), {
    code: "detail_title_mismatch",
    retryable: false,
  });
});

test("an inline native ID missing from the fresh page cannot satisfy detail", async () => {
  const fixture = replay({
    detailText: html.replaceAll("career-detail-9901", "career-detail-9999"),
  });
  const record = (await page(fixture)).records[0];
  await assert.rejects(announcements.fetchDetail(record, fixture.context), {
    code: "detail_identity_mismatch",
    retryable: false,
  });
});

for (const url of [
  listUrl + "#career-detail-9902",
  "https://unrelated.example.org/contactus/#career-detail-9901",
]) {
  test("a URL disagreeing with inline authority is rejected before detail extraction", async () => {
    const fixture = replay();
    const record = (await page(fixture)).records[0];
    await assert.rejects(
      announcements.fetchDetail({ ...record, url }, fixture.context),
      { code: "detail_identity_mismatch", retryable: false },
    );
  });
}

for (const text of [
  html.replace('data-target="career-detail-9901"', 'data-target="../other"'),
  html.replaceAll("career-detail-9902", "career-detail-9901"),
]) {
  test("malformed or duplicated native identity fails closed instead of merging inline jobs", async () => {
    await assert.rejects(page(replay({ text })), { code: "parse_error" });
  });
}

for (const field of ["nativeIdRule", "requiredBodyRules"]) {
  test(`inline jobs require explicit ${field}`, async () => {
    const fixture = replay();
    delete fixture.site.template[field];
    await assert.rejects(page(fixture), { code: "template_not_configured" });
  });
}

test("inline jobs cannot use another identity attribute or notice mode", async () => {
  const attribute = replay();
  attribute.site.template.nativeIdAttribute = "href";
  await assert.rejects(page(attribute), { code: "template_not_configured" });
  const notice = replay();
  notice.site.template.recordKind = "recruitment_notice";
  await assert.rejects(page(notice), { code: "template_not_configured" });
});

test("duplicating the description rule cannot stand in for a separate required qualifications section", async () => {
  const fixture = replay({ text: html.replace(firstRequirements, "") });
  fixture.site.template.requiredBodyRules = [
    fixture.site.template.requiredBodyRules[0],
    fixture.site.template.requiredBodyRules[0],
  ];
  await assert.rejects(page(fixture), { code: "template_not_configured" });
});

test("detail rejects an authority whose identity scope no longer matches the configured site", async () => {
  const fixture = replay();
  const record = (await page(fixture)).records[0];
  await assert.rejects(
    announcements.fetchDetail(
      { ...record, identityScope: "other-site" },
      fixture.context,
    ),
    { code: "detail_identity_mismatch", retryable: false },
  );
});

for (const [code, status, text] of [
  ["captcha", 200, "<title>安全验证</title><p>人机验证</p>"],
  ["restricted", 403, "<p>Access denied</p>"],
]) {
  test(`inline jobs reject ${code} responses before extracting any body`, async () => {
    await assert.rejects(page(replay({ text, status })), { code });
  });
}
