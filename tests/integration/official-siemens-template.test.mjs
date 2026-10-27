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

const listUrl = "https://jobs.siemens.com/en_US/externaljobs/SearchJobs";
const detailUrl =
  "https://jobs.siemens.com/en_US/externaljobs/JobDetail/990348";
const now = Date.parse("2026-10-12T00:00:00Z");
const read = (kind) =>
  fs.readFileSync(
    new URL(
      `../fixtures/official-template-repair/siemens-${kind}.html`,
      import.meta.url,
    ),
    "utf8",
  );

function replay({
  listText = read("list"),
  detailText = read("detail"),
  status = 200,
} = {}) {
  const site = loadSiteCatalog().find((row) => row.siteId === "siemens");
  const context = {
    sites: [site],
    clock: { now: () => now },
    request: async (url) => {
      if (url === listUrl) return { status: 200, text: listText, headers: {} };
      if (url === detailUrl) return { status, text: detailText, headers: {} };
      throw Error("Unexpected fixture URL");
    },
  };
  return { site, context };
}
const page = (fixture) =>
  announcements.collectPage({
    site: fixture.site,
    query: { keyword: "" },
    context: fixture.context,
  });
async function detail(fixture) {
  const record = (await page(fixture)).records.find((r) => r.url === detailUrl);
  assert.ok(
    record,
    "observed native list structure must produce the requested detail record",
  );
  return announcements.fetchDetail(record, fixture.context);
}

test("Siemens explicit unknown list dates retain six native URL authorities and equal titles separately", async () => {
  const fixture = replay();
  const result = await page(fixture);
  assert.deepEqual(
    result.records.map((r) => r.sourceRecordId),
    ["990362", "990348", "990959", "990658", "990961", "990731"],
  );
  assert.equal(
    result.records.filter((r) => r.title === "Synthetic Site Engineer").length,
    5,
  );
  assert.equal(
    new Set(result.records.map((r) => resolveJobIdentity(r).key)).size,
    6,
  );
  for (const record of result.records) {
    assert.equal(record.sourceRecordIdKind, "authority");
    assert.equal(record.publishedAt, null);
    assert.equal(record.kind, "job");
    assert.equal(record.urlKind, "job_detail");
    assert.equal(record.jobType, "unknown");
    assert.equal(record.detailStatus, "incomplete");
  }
  assert.equal(result.coverageScope, "limited");
  assert.equal(result.nextCursor, null);
  assert.equal(fixture.site.status, "candidate");
  assert.equal(fixture.site.verifiedAt, null);
  assert.equal(fixture.site.adapterVerification, "unverified");
  assert.equal(fixture.site.templateEvidence.requiresLiveProbe, true);
});

test("Siemens complete duties and qualifications retain the body tail while date and Apply stay unknown", async () => {
  const record = await detail(replay());
  assert.ok(record.description.includes("Synthetic duties:"));
  assert.ok(record.description.includes("Synthetic qualification:"));
  assert.ok(record.description.includes("Synthetic closing paragraph"));
  assert.ok(!record.description.includes("Synthetic site footer"));
  assert.ok(!record.description.includes("Apply"));
  assert.equal(record.detailStatus, "complete");
  assert.equal(record.bodyStatus, "complete");
  assert.equal(record.bodyIncomplete, false);
  assert.equal(record.publishedAt, null);
  assert.equal(record.applyUrl, null);
  const prepared = prepareRecruitmentRecord(record, now);
  assert.equal(prepared.recruitmentEvidence.bodyVerified, true);
  assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
  assert.equal(prepared.deadlineAt, null);
  assert.equal(
    isVerifiedRecommendation({
      qualification: { status: "pass" },
      evidence: prepared.recruitmentEvidence,
    }),
    false,
  );
});

for (const unset of ["missing", "undefined"]) {
  test(`a ${unset} listDateRule cannot silently opt into unknown dates`, async () => {
    const fixture = replay();
    if (unset === "missing") delete fixture.site.template.listDateRule;
    else fixture.site.template.listDateRule = undefined;
    await assert.rejects(page(fixture), { code: "template_not_configured" });
  });
}

for (const field of ["urlIdPattern", "detailIdRule"]) {
  test(`URL identity binding requires the paired ${field} setting`, async () => {
    const fixture = replay();
    delete fixture.site.template[field];
    await assert.rejects(page(fixture), { code: "template_not_configured" });
  });
}

for (const nativeId of ["990362", ""]) {
  test(`a ${nativeId ? "different" : "missing"} visible Job ID cannot satisfy the same-title detail`, async () => {
    const fixture = replay({
      detailText: read("detail").replace(
        'field__value">990348</div>',
        `field__value">${nativeId}</div>`,
      ),
    });
    await assert.rejects(detail(fixture), {
      code: "detail_identity_mismatch",
      retryable: false,
    });
  });
}

test("a forged authority cannot use a different numeric detail URL", async () => {
  const fixture = replay();
  const record = (await page(fixture)).records.find((r) => r.url === detailUrl);
  await assert.rejects(
    announcements.fetchDetail(
      { ...record, sourceRecordId: "990362" },
      fixture.context,
    ),
    { code: "detail_identity_mismatch", retryable: false },
  );
});

test("matching visible identity still cannot satisfy a different detail title", async () => {
  await assert.rejects(
    detail(
      replay({
        detailText: read("detail").replace(
          "Synthetic Site Engineer",
          "Synthetic Different Role",
        ),
      }),
    ),
    { code: "detail_title_mismatch", retryable: false },
  );
});

for (const replacement of ["<ul></ul>", ""]) {
  test(`an ${replacement ? "empty" : "absent"} qualifications list cannot use offers to become complete`, async () => {
    const text = read("detail").replace(
      /<ul><li>Synthetic qualification:[\s\S]*?<\/ul>/,
      replacement,
    );
    const record = await detail(replay({ detailText: text }));
    assert.equal(record.detailStatus, "incomplete");
    assert.equal(record.bodyIncomplete, true);
    assert.equal(
      prepareRecruitmentRecord(record, now).recruitmentEvidence.bodyVerified,
      false,
    );
  });
}

test("an explicit expired deadline in a synthetic body stays expired despite complete content", async () => {
  const record = await detail(
    replay({
      detailText: read("detail").replace(
        "Synthetic closing paragraph must remain in the full body.",
        "合成测试：报名截止时间：2026年09月01日。",
      ),
    }),
  );
  const prepared = prepareRecruitmentRecord(record, now);
  assert.equal(prepared.recruitmentEvidence.bodyVerified, true);
  assert.equal(prepared.recruitmentEvidence.openingStatus, "expired");
  assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
  assert.equal(prepared.applyUrl, null);
});

for (const [code, status, text] of [
  ["captcha", 200, "<title>安全验证</title><p>人机验证</p>"],
  ["restricted", 403, "<p>Access denied</p>"],
]) {
  test(`Siemens native identity templates reject ${code} detail HTML`, async () => {
    await assert.rejects(detail(replay({ detailText: text, status })), {
      code,
    });
  });
}
