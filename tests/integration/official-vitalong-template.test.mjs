import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import announcements from "../../src/sources/adapters/official-announcements.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";
import { validateInlineOfficialJobTemplate } from "../../src/sources/adapters/inline-official-jobs.mjs";
import { resolveJobIdentity } from "../../src/domain/identity.mjs";
import {
  prepareRecruitmentRecord,
  isVerifiedRecommendation,
} from "../../src/domain/recruitment-evidence.mjs";

const siteId = "official-7ac6546c836dc43a",
  listUrl = "https://vitalong.cn/join.php?cate=1031";
const now = Date.parse("2026-10-12T00:00:00Z");
const html = fs.readFileSync(
  new URL(
    "../fixtures/official-template-repair/vitalong-inline.html",
    import.meta.url,
  ),
  "utf8",
);
function replay({ text = html, detailText = text, templatePatch = {} } = {}) {
  const site = structuredClone(
    loadSiteCatalog().find((row) => row.siteId === siteId),
  );
  site.template = { ...site.template, ...templatePatch };
  const requests = [];
  const context = {
    sites: [site],
    clock: { now: () => now },
    request: async (url, options = {}) => {
      assert.equal(
        url,
        listUrl,
        "only observed same-page public URL may be read",
      );
      assert.ok(
        !options.method || options.method === "GET",
        "upload/form submission is forbidden in this reader",
      );
      requests.push(url);
      return {
        status: 200,
        text: requests.length === 1 ? text : detailText,
        headers: {},
      };
    },
  };
  return { site, context, requests };
}
const page = (fixture) =>
  announcements.collectPage({
    site: fixture.site,
    query: { keyword: "消防" },
    context: fixture.context,
  });
test("Vitalong rel native IDs keep two row-bound jobs distinct even with equal titles and no DOM target IDs", async () => {
  const fixture = replay(),
    result = await page(fixture);
  assert.deepEqual(
    result.records.map((row) => row.sourceRecordId),
    ["37", "38"],
  );
  assert.equal(
    new Set(result.records.map((row) => resolveJobIdentity(row).key)).size,
    2,
  );
  assert.deepEqual(
    result.records.map((row) => row.url),
    [listUrl + "#37", listUrl + "#38"],
  );
  assert.equal(result.records[0].sourceRecordIdKind, "authority");
  assert.equal(
    result.records[0].urlKind,
    "listing",
    "derived row fragment is not an observed detail-page href",
  );
  assert.equal(result.records[0].kind, "job");
  assert.equal(result.records[0].publishedAt, "2018-11-19T00:00:00.000Z");
  assert.ok(result.records[0].description.includes("合成职责甲"));
  assert.ok(result.records[0].description.includes("合成要求甲"));
  assert.ok(!result.records[0].description.includes("合成要求乙"));
  assert.ok(!result.records[0].description.includes("合成人才战略"));
  assert.equal(result.coverageScope, "limited");
  assert.equal(result.nextCursor, null);
});
test("Vitalong missing deadline and no-href hidden upload form remain unknown instead of proving recruitment or applying", async () => {
  const fixture = replay(),
    result = await page(fixture);
  const detail = await announcements.fetchDetail(
    result.records[0],
    fixture.context,
  );
  assert.equal(detail.detailStatus, "complete");
  assert.equal(detail.applyUrl, null);
  const prepared = prepareRecruitmentRecord(detail, now);
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
  assert.deepEqual(fixture.requests, [listUrl, listUrl]);
  assert.equal(fixture.site.status, "candidate");
  assert.equal(fixture.site.verifiedAt, null);
});
for (const [name, mutate] of [
  [
    "missing duty heading",
    (text) => text.replace("<p>岗位职责：</p>", "<p>其他内容：</p>"),
  ],
  [
    "empty duties before requirements",
    (text) =>
      text.replace(
        "合成职责甲：记录设备检查流程与消防验收记录，确保记录准确且完整。",
        "",
      ),
  ],
  [
    "missing requirement heading",
    (text) => text.replace("<p>任职要求：</p>", "<p>其他条件：</p>"),
  ],
  [
    "empty requirements",
    (text) =>
      text.replace(
        "合成要求甲：能够阅读技术文档并核对信息，此段不表示真实岗位条件。",
        "",
      ),
  ],
  [
    "duplicate requirement heading",
    (text) =>
      text.replace("<p>任职要求：</p>", "<p>任职要求：</p><p>任职要求：</p>"),
  ],
  [
    "contact heading after empty requirements",
    (text) =>
      text
        .replace(
          "合成要求甲：能够阅读技术文档并核对信息，此段不表示真实岗位条件。",
          "",
        )
        .replace(
          "<p><br></p>",
          "<p>联系方式：</p><p>这一段合成联系方式很长，仍不能代替缺失的任职要求。</p>",
        ),
  ],
  [
    "benefits heading after empty duties",
    (text) =>
      text.replace(
        "合成职责甲：记录设备检查流程与消防验收记录，确保记录准确且完整。",
        "<p>福利待遇：</p><p>这一段合成福利内容很长，仍不能代替缺失的岗位职责。</p>",
      ),
  ],
])
  test(`Vitalong ${name} cannot borrow neighboring body or headers to verify a complete role`, async () => {
    const fixture = replay({ text: mutate(html) }),
      result = await page(fixture);
    assert.equal(result.records[0].detailStatus, "incomplete");
    assert.equal(
      prepareRecruitmentRecord(result.records[0], now).recruitmentEvidence
        .bodyVerified,
      false,
    );
    assert.equal(result.records[1].detailStatus, "complete");
  });
for (const [name, mutate] of [
  ["duplicate ID", (text) => text.replace('rel="38"', 'rel="37"')],
  ["non-numeric ID", (text) => text.replace('rel="37"', 'rel="job-37"')],
  ["zero ID", (text) => text.replace('rel="37"', 'rel="0"')],
  [
    "duplicate body",
    (text) =>
      text.replace(
        '<div class="jc_txt">',
        '<div class="jc_txt"><div class="jx_mar"><p>岗位职责：</p><p>伪造职责很长也不能跨正文定位。</p><p>任职要求：</p><p>伪造要求也不能替代原生唯一正文。</p></div>',
      ),
  ],
  [
    "nested row identity",
    (text) =>
      text
        .replace(
          '<div class="jc_txt">',
          '<div class="jc_txt"><div class="jn_div">',
        )
        .replace("</div></div>\n    </div>", "</div></div></div>\n    </div>"),
  ],
])
  test(`Vitalong ${name} is rejected instead of silently mixing role ownership`, async () => {
    const fixture = replay({ text: mutate(html) });
    await assert.rejects(page(fixture), { code: "parse_error" });
  });
test("Vitalong mismatched record authority and fragment fail before a read", async () => {
  const fixture = replay(),
    result = await page(fixture);
  const before = fixture.requests.length;
  await assert.rejects(
    announcements.fetchDetail(
      { ...result.records[0], sourceRecordId: "38" },
      fixture.context,
    ),
    { code: "detail_identity_mismatch" },
  );
  assert.equal(fixture.requests.length, before);
});
test("Vitalong fresh title drift is rejected after same-page identity recheck", async () => {
  const fixture = replay({
    detailText: html.replace("合成电气工程师", "合成变更岗位"),
  });
  const result = await page(fixture);
  await assert.rejects(
    announcements.fetchDetail(result.records[0], fixture.context),
    { code: "detail_title_mismatch" },
  );
});
for (const [name, patch] of [
  ["unknown body mode", { inlineBodyMode: "global" }],
  ["empty body mode", { inlineBodyMode: "" }],
  ["wrong native attribute", { nativeIdAttribute: "href" }],
  [
    "one required section",
    { requiredBodySections: [{ headingRule: "p", headingText: "岗位职责：" }] },
  ],
  [
    "duplicate required sections",
    {
      requiredBodySections: [
        { headingRule: "p", headingText: "岗位职责：" },
        { headingRule: "p", headingText: "岗位职责：" },
      ],
    },
  ],
  [
    "missing required heading selector",
    {
      requiredBodySections: [
        { headingRule: "p", headingText: "岗位职责：" },
        { headingText: "任职要求：" },
      ],
    },
  ],
])
  test(`Vitalong ${name} is blocked by shared configuration validation before transport`, async () => {
    const fixture = replay({ templatePatch: patch });
    assert.throws(() => validateInlineOfficialJobTemplate(fixture.site), {
      code: "template_not_configured",
    });
    await assert.rejects(page(fixture), { code: "template_not_configured" });
    assert.equal(fixture.requests.length, 0);
  });
