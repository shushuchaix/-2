import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ncss from "../../src/sources/adapters/ncss.mjs";
import { job } from "../helpers/fixtures.mjs";

const requirements =
  "负责设备维护与工程实施，要求具备相关专业知识、工程实践能力及现场项目经验。";
const longTitle =
  "合成单位公开招聘机场行为识别工作人员及相关技术支持岗位的招聘信息";

test("NCSS actual public structure preserves body without treating a placeholder as applying", async () => {
  const html = await fs.readFile(
    new URL(
      "../fixtures/recruitment-details/ncss-fire-control.html",
      import.meta.url,
    ),
    "utf8",
  );
  const { record, ctx } = fixture(html);
  const result = await ncss.fetchDetail(record, ctx);
  assert.ok(result.description.length > 30);
  assert.ok(!result.applyUrl);
  assert.ok(!result.deadlineAt);
  assert.equal(result.detailStatus, "complete");
});
function fixture(html, overrides = {}) {
  const record = job({
    sourceId: "ncss",
    siteId: "ncss",
    identityScope: "national",
    title: "合成机场识别岗",
    description: null,
    ...overrides,
  });
  const ctx = {
    sites: [{ siteId: "ncss" }],
    request: async () => ({ status: 200, text: html }),
  };
  return { record, ctx };
}

for (const [name, html, title] of [
  [
    "empty body",
    '<div class="jobdetail-box"><div class="mainContent"></div></div>',
    "合成机场识别岗",
  ],
  [
    "title-only body matching the observed public page structure",
    '<div class="jobdetail-box"><div class="mainContent mainContent-geshi">合成机场识别岗</div></div>',
    "合成机场识别岗",
  ],
  [
    "short body",
    '<div class="mainContent">具体招聘要求请联系招聘单位。</div>',
    "合成机场识别岗",
  ],
  [
    "long title-only body",
    '<div class="mainContent">' + longTitle + "</div>",
    longTitle,
  ],
]) {
  test("NCSS reports " + name + " as insufficient source content", async () => {
    const { record, ctx } = fixture(html, { title });
    const before = structuredClone(record);
    await assert.rejects(ncss.fetchDetail(record, ctx), {
      code: "detail_insufficient",
      retryable: false,
    });
    assert.deepEqual(record, before);
  });
}

test("NCSS still treats missing public body structure as a parse error", async () => {
  const { record, ctx } = fixture(
    "<nav>公开岗位目录导航</nav><p>" + requirements + "</p>",
  );
  await assert.rejects(ncss.fetchDetail(record, ctx), { code: "parse_error" });
});

test("NCSS uses factual fallback requirements instead of a title-only main body", async () => {
  const { record, ctx } = fixture(
    '<div class="mainContent">' +
      longTitle +
      "</div>" +
      '<div class="jobdetail-box"><p>' +
      requirements +
      "</p></div>",
    { title: longTitle },
  );
  const detail = await ncss.fetchDetail(record, ctx);
  assert.equal(detail.description, requirements);
  assert.equal(detail.detailStatus, "complete");
  assert.equal(detail.evidence.at(-1).selector, ".jobdetail-box");
});

for (const kind of ["job", "recruitment_notice"]) {
  test(
    "NCSS preserves " +
      kind +
      " identity when public requirements are available",
    async () => {
      const { record, ctx } = fixture(
        '<div class="mainContent"><p>' + requirements + "</p></div>",
        { kind },
      );
      const before = structuredClone(record);
      const detail = await ncss.fetchDetail(record, ctx);
      assert.equal(detail.description, requirements);
      assert.equal(detail.kind, kind);
      assert.equal(detail.sourceRecordId, "1");
      assert.equal(detail.identityScope, "national");
      assert.equal(detail.url, "https://jobs.example.com/1");
      assert.equal(detail.evidence.at(-1).selector, ".mainContent");
      assert.deepEqual(record, before);
    },
  );
}
