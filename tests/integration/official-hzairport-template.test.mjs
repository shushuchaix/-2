import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import announcements from "../../src/sources/adapters/official-announcements.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";
import { validateInlineOfficialJobTemplate } from "../../src/sources/adapters/inline-official-jobs.mjs";
import * as inlineOfficial from "../../src/sources/adapters/inline-official-jobs.mjs";
import { prepareRecruitmentRecord } from "../../src/domain/recruitment-evidence.mjs";

const siteId = "official-2ea9828ffe1d2682";
const listUrl = "https://www.hzairport.com/talent/index.html";
const applyUrl = "https://www.hzairport.com/talent/detail/id/37.html";
const now = Date.parse("2026-10-12T00:00:00Z");
const fixture = (name) =>
  fs.readFileSync(
    new URL("../fixtures/official-template-repair/" + name, import.meta.url),
    "utf8",
  );
const html = fixture("hzairport-inline.html"),
  form = fixture("hzairport-application-37.html");
function replay({
  text = html,
  freshText = text,
  applicationText = form,
  responseUrl = applyUrl,
  templatePatch = {},
  runId = "synthetic-hz-run",
} = {}) {
  const site = structuredClone(
    loadSiteCatalog().find((row) => row.siteId === siteId),
  );
  site.template = { ...site.template, ...templatePatch };
  const requests = [];
  let listReads = 0;
  const context = {
    sites: [site],
    clock: { now: () => now },
    runId,
    request: async (url, options = {}) => {
      assert.ok(
        !options.method || options.method === "GET",
        "public reader must never submit or upload",
      );
      assert.ok(
        [listUrl, applyUrl].includes(url),
        "only observed public list and row-native form may be read",
      );
      requests.push(url);
      if (url === listUrl)
        return {
          status: 200,
          url,
          text: ++listReads === 1 ? text : freshText,
          headers: {},
        };
      return {
        status: 200,
        url: responseUrl,
        text: applicationText,
        headers: {},
      };
    },
  };
  return { site, context, requests };
}
const page = (r) =>
  announcements.collectPage({
    site: r.site,
    query: { keyword: "机场" },
    context: r.context,
  });

for (const [name, mutate] of [
  [
    "hidden date",
    (s) =>
      s.replace(
        '<span class="time">2026-10-15</span>',
        '<span class="time" hidden>2026-10-15</span>',
      ),
  ],
  [
    "hidden date label",
    (s) =>
      s.replace(
        '<span class="time">招聘截止日期</span>',
        '<span class="time" hidden>招聘截止日期</span>',
      ),
  ],
  [
    "aria-hidden date",
    (s) =>
      s.replace(
        '<span class="time">2026-10-15</span>',
        '<span class="time" aria-hidden="true">2026-10-15</span>',
      ),
  ],
])
  test(`HZ ${name} cannot provide a verified closing-date year`, async () => {
    const r = replay({ text: mutate(html) }),
      record = (await page(r)).records[0];
    assert.ok(
      !record.sourceEvidence.some(
        (e) => e.sourceKind === "visible_native_deadline_date",
      ),
    );
    assert.equal(
      prepareRecruitmentRecord(record, now).recruitmentEvidence.openingStatus,
      "unknown",
    );
  });
for (const [name, attribute] of [
  ["hidden", "hidden"],
  ["aria-hidden", 'aria-hidden="true"'],
  ["inline display none", 'style="display:none"'],
])
  test(`HZ ${name} body cannot fill visible duties or requirements`, async () => {
    const changed = html.replace(
        '<div class="txt"><p>合成要求甲',
        `<div class="txt" ${attribute}><p>合成要求甲`,
      ),
      record = (await page(replay({ text: changed }))).records[0];
    assert.equal(record.bodyIncomplete, true);
    assert.equal(
      prepareRecruitmentRecord(record, now).recruitmentEvidence.bodyVerified,
      false,
    );
    assert.ok(!record.description.includes("合成要求甲"));
  });

for (const [name, mutate, at] of [
  ["expired closing date", (s) => s, Date.parse("2026-10-16T00:00:00Z")],
  [
    "incomplete role body",
    (s) =>
      s.replace(
        "合成要求甲：能够阅读文件并认真核对信息，这些条件不代表实际岗位要求。",
        "",
      ),
    now,
  ],
  [
    "conflicting native closing date and body",
    (s) => s.replace("10月15日12:00", "10月16日12:00"),
    now,
  ],
])
  test(`Hangzhou ${name} preserves list evidence without an unnecessary application GET`, async () => {
    const r = replay({ text: mutate(html) });
    r.context.clock = { now: () => at };
    const result = await page(r),
      detail = await announcements.fetchDetail(result.records[0], r.context);
    assert.equal(detail.description, result.records[0].description);
    assert.equal(
      detail.applicationVerification,
      undefined,
      "no application check means no fresh run marker",
    );
    assert.deepEqual(r.requests, [listUrl, listUrl]);
  });

test("Hangzhou native row hrefs preserve job bodies, role identity and separate publication/closing dates", async () => {
  const r = replay(),
    result = await page(r);
  assert.deepEqual(
    result.records.map((row) => row.sourceRecordId),
    ["37", "58"],
  );
  assert.deepEqual(
    result.records.map((row) => row.url),
    [applyUrl, "https://www.hzairport.com/talent/detail/id/58.html"],
  );
  const job = result.records[0];
  assert.equal(job.sourceRecordIdKind, "authority");
  assert.equal(job.urlKind, "job_apply");
  assert.equal(job.applyUrl, applyUrl);
  assert.equal(job.publishedAt, "2026-10-09T00:00:00.000Z");
  assert.equal(result.records[1].publishedAt, "2026-10-08T00:00:00.000Z");
  assert.equal(
    job.deadlineAt,
    null,
    "adapter keeps date/time interpretation in the evidence domain",
  );
  assert.equal(job.detailStatus, "complete");
  assert.ok(job.description.includes("合成职责甲"));
  assert.ok(!job.description.includes("合成职责乙"));
  assert.ok(!job.description.includes("公共页脚"));
  for (const evidence of job.evidence.filter((e) =>
    ["description", "publishedAt"].includes(e.field),
  ))
    assert.equal(evidence.url, listUrl);
  const closing = job.sourceEvidence.find((e) => e.field === "deadlineDate");
  assert.equal(closing.value, "2026-10-15");
  assert.equal(closing.status, "verified");
  assert.equal(closing.sourceKind, "visible_native_deadline_date");
  assert.equal(closing.sourceExcerpt, "招聘截止日期：2026-10-15");
  assert.equal(closing.sourceUrl, listUrl);
  assert.equal(closing.sourceId, "official-announcements");
  assert.deepEqual(closing.appliesTo, { jobRowId: "37" });
  assert.deepEqual(closing.location, {
    selector: ".talent_list .inside_item .title .time",
    labelSelector: ".talent_nav .time",
    nativeIdSelector: ".talent_list .inside_item .talent_bot a.download[href]",
  });
  assert.equal(
    job.sourceEvidence.find((e) => e.field === "applyUrl").status,
    "unknown",
  );
  assert.equal(r.site.status, "candidate");
  assert.equal(r.site.verifiedAt, null);
});
test("Hangzhou fetch rechecks list row and native form identity but keeps captcha application unknown", async () => {
  const r = replay(),
    result = await page(r),
    detail = await announcements.fetchDetail(result.records[0], r.context);
  assert.equal(detail.description, result.records[0].description);
  assert.equal(detail.applicationVerification.status, 200);
  assert.equal(detail.applicationVerification.challenge, true);
  assert.equal(detail.applicationVerification.formVerified, false);
  assert.equal(
    detail.applicationVerification.checkedAt,
    new Date(now).toISOString(),
  );
  assert.equal(detail.applicationVerification.checkedInRunId, r.context.runId);
  assert.equal(detail.applicationVerification.checkedUrl, applyUrl);
  assert.equal(
    prepareRecruitmentRecord(detail, now).recruitmentEvidence.applicationStatus,
    "unknown",
  );
  assert.deepEqual(r.requests, [listUrl, listUrl, applyUrl]);
});
test("Hangzhou verified row closing date supplies the year only for matching body month/day and preserves noon time", async () => {
  const r = replay(),
    result = await page(r);
  for (const job of result.records) {
    assert.equal(job.deadlineAt, null);
    const prepared = prepareRecruitmentRecord(job, now);
    assert.equal(prepared.deadlineAt, "2026-10-15T04:00:00.000Z");
    assert.equal(prepared.recruitmentEvidence.openingStatus, "open");
    assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
  }
});
test("Hangzhou bare challenge without a form preserves the role body and standard challenge result", async () => {
  const r = replay({
      applicationText:
        "<html><title>安全验证</title><p>验证码核验后访问。</p></html>",
    }),
    result = await page(r);
  const detail = await announcements.fetchDetail(result.records[0], r.context);
  assert.equal(detail.detailStatus, "complete");
  assert.equal(detail.applicationVerification.challenge, true);
  assert.equal(detail.applicationVerification.formVerified, false);
});
test("Hangzhou no run ID does not stamp a reusable run marker", async () => {
  const r = replay({ runId: undefined }),
    result = await page(r);
  delete r.context.runId;
  const detail = await announcements.fetchDetail(result.records[0], r.context);
  assert.equal(detail.applicationVerification.checkedInRunId, undefined);
});
for (const [name, mutate] of [
  ["wrong native ID", (s) => s.replace('value="37"', 'value="58"')],
  ["wrong native name", (s) => s.replace("合成勤务观察员", "合成其他岗位")],
  ["missing readonly identity", (s) => s.replace(" readonly", "")],
  ["non-hidden native ID", (s) => s.replace('type="hidden"', 'type="text"')],
  [
    "duplicate ID control",
    (s) =>
      s.replace(
        '<input type="hidden" name="job_id" value="37">',
        '<input type="hidden" name="job_id" value="37"><input type="hidden" name="job_id" value="37">',
      ),
  ],
  [
    "duplicate native form",
    (s) => s.replace("</body>", s.match(/<form[\s\S]*<\/form>/)[0] + "</body>"),
  ],
])
  test(`Hangzhou ${name} application page rejects role mixing even with a captcha`, async () => {
    const r = replay({ applicationText: mutate(form) }),
      result = await page(r);
    await assert.rejects(
      announcements.fetchDetail(result.records[0], r.context),
      { code: "detail_identity_mismatch" },
    );
  });
test("Hangzhou unexpected response redirect rejects application identity", async () => {
  const r = replay({
      responseUrl: "https://www.hzairport.com/talent/detail/id/58.html",
    }),
    result = await page(r);
  await assert.rejects(
    announcements.fetchDetail(result.records[0], r.context),
    { code: "detail_identity_mismatch" },
  );
});
test("Hangzhou same URL without a form preserves body and records an unverified entry", async () => {
  const r = replay({
      applicationText: "<html><p>合成普通新闻页面。</p></html>",
    }),
    result = await page(r);
  const detail = await announcements.fetchDetail(result.records[0], r.context);
  assert.equal(detail.applicationVerification.formVerified, false);
  assert.equal(detail.applicationVerification.challenge, false);
  assert.equal(
    prepareRecruitmentRecord(detail, now).recruitmentEvidence.applicationStatus,
    "unknown",
  );
});
test("Hangzhou unrelated application form cannot verify a native job entry without its configured identity", async () => {
  const r = replay({
      applicationText: '<html><form id="other_form"><p>报名</p></form></html>',
    }),
    result = await page(r);
  const detail = await announcements.fetchDetail(result.records[0], r.context);
  assert.equal(detail.applicationVerification.formVerified, false);
  assert.equal(
    prepareRecruitmentRecord(detail, now).recruitmentEvidence.applicationStatus,
    "unknown",
  );
});
const cleanForm = form.replace(
  '<label>验证码<input type="text" name="verifyCode"></label>',
  "",
);
const otherForm = '<form id="other_form"><p>提交申请</p></form>';
for (const [name, mutate] of [
  [
    "hidden native form",
    (s) => s.replace('<form id="resume_form"', '<form hidden id="resume_form"'),
  ],
  [
    "native form without apply text",
    (s) => s.replace("报名</button>", "返回</button>"),
  ],
  [
    "hidden native ancestor",
    (s) =>
      s
        .replace(
          '<form id="resume_form"',
          '<section hidden><form id="resume_form"',
        )
        .replace("</form>", "</form></section>"),
  ],
  [
    "native ancestor display none",
    (s) =>
      s
        .replace(
          '<form id="resume_form"',
          '<section style="display: none"><form id="resume_form"',
        )
        .replace("</form>", "</form></section>"),
  ],
  [
    "native ancestor visibility hidden",
    (s) =>
      s
        .replace(
          '<form id="resume_form"',
          '<section style="visibility: hidden"><form id="resume_form"',
        )
        .replace("</form>", "</form></section>"),
  ],
])
  test(`Hangzhou ${name} cannot borrow another visible form's application availability`, async () => {
    const applicationText = mutate(cleanForm).replace(
      "</body>",
      otherForm + "</body>",
    );
    const r = replay({ applicationText }),
      result = await page(r),
      detail = await announcements.fetchDetail(result.records[0], r.context);
    assert.equal(detail.applicationVerification.formVerified, false);
    assert.equal(
      prepareRecruitmentRecord(detail, now).recruitmentEvidence
        .applicationStatus,
      "unknown",
    );
  });
test("Hangzhou visible identity-bound native form with application text passes the standard form gate", async () => {
  const r = replay({ applicationText: cleanForm }),
    result = await page(r),
    detail = await announcements.fetchDetail(result.records[0], r.context);
  assert.equal(detail.applicationVerification.challenge, false);
  assert.equal(detail.applicationVerification.formVerified, true);
  assert.equal(
    prepareRecruitmentRecord(detail, now).recruitmentEvidence.applicationStatus,
    "available",
  );
});
test("Hangzhou pure application assessor validates the native role without network or run markers", async () => {
  const r = replay(),
    result = await page(r);
  assert.equal(
    typeof inlineOfficial.assessInlineOfficialApplication,
    "function",
  );
  const verification = inlineOfficial.assessInlineOfficialApplication(
    r.site,
    result.records[0],
    { status: 200, url: applyUrl, text: cleanForm },
    new Date(now).toISOString(),
  );
  assert.equal(verification.formVerified, true);
  assert.equal(verification.checkedUrl, applyUrl);
  assert.equal(verification.checkedInRunId, undefined);
  assert.deepEqual(r.requests, [listUrl]);
});
for (const [name, patch] of [
  ["non-authority", { sourceRecordIdKind: "hint" }],
  ["foreign site", { siteId: "other-site" }],
  ["foreign scope", { identityScope: "other-site" }],
  ["foreign source", { sourceId: "other-source" }],
  ["wrong native ID", { sourceRecordId: "58" }],
  [
    "wrong native URL",
    { url: "https://www.hzairport.com/talent/detail/id/58.html" },
  ],
  [
    "wrong apply URL",
    { applyUrl: "https://www.hzairport.com/talent/detail/id/58.html" },
  ],
  ["wrong role name", { title: "合成其他岗位" }],
])
  test(`Hangzhou pure application assessor rejects ${name} ownership`, async () => {
    const r = replay(),
      result = await page(r);
    assert.equal(
      typeof inlineOfficial.assessInlineOfficialApplication,
      "function",
    );
    assert.throws(
      () =>
        inlineOfficial.assessInlineOfficialApplication(
          r.site,
          { ...result.records[0], ...patch },
          { status: 200, url: applyUrl, text: cleanForm },
          new Date(now).toISOString(),
        ),
      { code: "detail_identity_mismatch" },
    );
    assert.deepEqual(r.requests, [listUrl]);
  });
for (const [name, mutate] of [
  ["missing column label", (s) => s.replace("招聘截止日期", "合成历史日期")],
  [
    "duplicate column label",
    (s) =>
      s.replace(
        '<div class="talent_nav">',
        '<div class="talent_nav"><span class="time">招聘截止日期</span>',
      ),
  ],
  ["incomplete calendar date", (s) => s.replace(">2026-10-15<", ">10月15日<")],
  ["invalid calendar date", (s) => s.replace(">2026-10-15<", ">2026-02-30<")],
  [
    "duplicate row deadline",
    (s) =>
      s.replace(
        '<span class="time">2026-10-15</span>',
        '<span class="time">2026-10-15</span><span class="time">2026-10-16</span>',
      ),
  ],
])
  test(`Hangzhou ${name} never emits verified closing date or uses publication year`, async () => {
    const r = replay({ text: mutate(html) }),
      result = await page(r);
    assert.equal(
      result.records[0].sourceEvidence.some((e) => e.field === "deadlineDate"),
      false,
    );
    assert.equal(result.records[0].publishedAt, "2026-10-09T00:00:00.000Z");
    assert.equal(result.records[0].deadlineAt, null);
  });
for (const [name, mutate] of [
  [
    "other origin",
    (s) =>
      s.replace(
        "/talent/detail/id/37.html",
        "https://other.example.org/talent/detail/id/37.html",
      ),
  ],
  [
    "other path",
    (s) => s.replace("/talent/detail/id/37.html", "/news/detail/id/37.html"),
  ],
  [
    "extra query",
    (s) =>
      s.replace(
        "/talent/detail/id/37.html",
        "/talent/detail/id/37.html?job=58",
      ),
  ],
  [
    "extra fragment",
    (s) =>
      s.replace("/talent/detail/id/37.html", "/talent/detail/id/37.html#58"),
  ],
  [
    "duplicate native IDs",
    (s) => s.replace("/talent/detail/id/58.html", "/talent/detail/id/37.html"),
  ],
])
  test(`Hangzhou ${name} native href is rejected instead of inventing a row URL`, async () => {
    const r = replay({ text: mutate(html) });
    await assert.rejects(page(r), { code: "parse_error" });
  });
test("Hangzhou empty requirements cannot borrow duties or contacts", async () => {
  const r = replay({
      text: html.replace(
        "合成要求甲：能够阅读文件并认真核对信息，这些条件不代表实际岗位要求。",
        "",
      ),
    }),
    result = await page(r);
  assert.equal(result.records[0].detailStatus, "incomplete");
  assert.equal(result.records[1].detailStatus, "complete");
});
test("Hangzhou authority mismatch and fresh name drift reject before the native form GET", async () => {
  const r = replay({
      freshText: html.replace("合成勤务观察员", "合成变更岗位"),
    }),
    result = await page(r);
  await assert.rejects(
    announcements.fetchDetail(
      { ...result.records[0], sourceRecordId: "58" },
      r.context,
    ),
    { code: "detail_identity_mismatch" },
  );
  assert.equal(r.requests.length, 1);
  await assert.rejects(
    announcements.fetchDetail(result.records[0], r.context),
    { code: "detail_title_mismatch" },
  );
  assert.deepEqual(r.requests, [listUrl, listUrl]);
});
for (const [name, patch] of [
  ["missing application form rule", { applicationFormRule: undefined }],
  ["missing application native ID rule", { applicationJobIdRule: "" }],
  ["missing application title rule", { applicationJobTitleRule: null }],
  ["incomplete closing label contract", { deadlineLabelText: undefined }],
  ["empty closing selector", { deadlineRule: "" }],
])
  test(`Hangzhou ${name} configuration is blocked before any public read`, async () => {
    const r = replay({ templatePatch: patch });
    assert.throws(() => validateInlineOfficialJobTemplate(r.site), {
      code: "template_not_configured",
    });
    await assert.rejects(page(r), { code: "template_not_configured" });
    assert.equal(r.requests.length, 0);
  });
