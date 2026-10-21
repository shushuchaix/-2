import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyProvider } from "../../src/sources/adapters/legacy.mjs";
import { normalizeRecord } from "../../src/domain/record.mjs";
import { queueContentDraft } from "../../src/sources/content-queue.mjs";
import { createSourceBudget } from "../../src/infrastructure/http/budget.mjs";
import job91 from "../../src/sources/adapters/university-91job.mjs";
import { assessRecruitmentEvidence } from "../../src/domain/recruitment-evidence.mjs";
import { evaluateQualification } from "../../src/domain/qualification.mjs";
import { htmlToText } from "../../src/util/html.mjs";

const now = Date.parse("2026-10-10T00:00:00Z");
const description =
  "消防工程师负责消防设施检查、维护、隐患排查及应急保障，要求本科，岗位要求以当前招聘正文为准。";
const record = (overrides = {}) =>
  normalizeRecord({
    sourceId: "university",
    siteId: "synthetic-university",
    identityScope: "synthetic-university",
    sourceRecordId: "https://school.example.org/job/view/id/1",
    kind: "job",
    title: "消防工程师",
    url: "https://school.example.org/job/view/id/1",
    description: null,
    ...overrides,
  });
const html = (body) =>
  "<h1>消防工程师</h1><main><p>职位详情</p><p>" + body + "</p></main>";
const ctx = (body) => ({
  budget: createSourceBudget({ maxDetails: 2 }),
  request: async (url) => ({ status: 200, headers: {}, url, text: body }),
});

test("a successful university detail clears previous failures and finishes its pending body", async () => {
  const previous = record({
    detailStatus: "unavailable",
    bodyStatus: "incomplete",
    retryEligible: true,
    retryAt: "2027-01-01T00:00:00Z",
    nextDueAt: "2027-01-01T00:00:00Z",
  });
  const before = structuredClone(previous);
  const detailed = await createLegacyProvider("university").fetchDetail(
    previous,
    ctx(html(description)),
  );
  assert.equal(detailed.detailStatus, "complete");
  assert.equal(detailed.bodyStatus, "complete");
  assert.equal(detailed.retryEligible, false);
  assert.equal(detailed.retryAt, undefined);
  assert.equal(detailed.nextDueAt, undefined);
  assert.equal(detailed.description, description);
  const progress = {};
  queueContentDraft(progress, "unit", [previous], now);
  queueContentDraft(progress, "unit", [detailed], now);
  assert.equal(Object.keys(progress.pendingBodies).length, 0);
  assert.deepEqual(previous, before);
});

test("an empty university detail fails instead of retaining a previous body as success", async () => {
  await assert.rejects(
    createLegacyProvider("university").fetchDetail(
      record({ description, detailStatus: "complete" }),
      ctx("<h1>消防工程师</h1><main>页面内容已移除</main>"),
    ),
    { code: "detail_insufficient", retryable: false },
  );
});

test("university details preserve an explicit public application anchor with source evidence", async () => {
  const detailed = await createLegacyProvider("university").fetchDetail(
    record(),
    ctx(html(description + '<a href="/apply/one">在线报名</a>')),
  );
  assert.equal(detailed.applyUrl, "https://school.example.org/apply/one");
  assert.ok(
    detailed.sourceEvidence.some(
      (e) =>
        e.field === "applyUrl" &&
        e.value === "https://school.example.org/apply/one" &&
        e.sourceUrl === "https://school.example.org/job/view/id/1" &&
        e.status === "unknown",
    ),
  );
});

const site91 = {
  siteId: "synthetic-91job",
  origin: "https://seu.91job.org.cn",
  tenantId: "10286",
};
const row91 = (overrides = {}) => ({
  zpgwid: "synthetic-1",
  zwmc: "消防工程师",
  dwmc: "合成工程有限公司",
  sqxxdm: "10286",
  xlyq: "本科",
  zwms: JSON.stringify({ rzzg: description }),
  ...overrides,
});
const record91 = () =>
  normalizeRecord({
    ...record(),
    sourceId: "university-91job",
    siteId: site91.siteId,
    identityScope: "10286",
    sourceRecordId: "synthetic-1",
    url: "https://seu.91job.org.cn/sub-station/jobDetails?xxdm=10286&zpgwid=synthetic-1",
  });
const context91 = (row) => ({
  sites: [site91],
  queries: [{ keyword: "消防", pageLimit: 1 }],
  targetSnapshot: { cities: [] },
  clock: { now: () => now },
  budget: createSourceBudget({ maxDetails: 2 }),
  request: async (url) => ({
    status: 200,
    headers: {},
    url,
    text: JSON.stringify({ success: true, code: 200, result: row }),
  }),
});

test("91job detail keeps HTML application evidence before converting structured body to text", async () => {
  const detailed = await job91.fetchDetail(
    record91(),
    context91(
      row91({
        zwms: JSON.stringify({
          rzzg: description,
          apply: '<a href="/apply/one">在线报名</a>',
        }),
      }),
    ),
  );
  assert.equal(detailed.applyUrl, "https://seu.91job.org.cn/apply/one");
  assert.ok(
    detailed.sourceEvidence.some(
      (e) => e.field === "applyUrl" && e.sourceKind === "public_anchor",
    ),
  );
});

test("a long university notice retains its tail deadline for evidence and article chunking", async () => {
  const tail = "报名截止时间：2027年1月1日。";
  const text = "消防设施检查与维护。".repeat(700) + tail;
  const detailed = await createLegacyProvider("university").fetchDetail(
    record({
      kind: "recruitment_notice",
      title: "合成工程有限公司招聘公告",
      url: "https://school.example.org/campus/view/id/1",
    }),
    ctx("<h1>合成工程有限公司招聘公告</h1><p>" + text + "</p>"),
  );
  assert.ok(detailed.description.length > 4001);
  assert.ok(detailed.description.endsWith(tail));
  assert.equal(detailed.deadlineAt, "2027-01-01T15:59:59.999Z");
  assert.ok(detailed.summary.length <= 241);
  assert.equal(
    assessRecruitmentEvidence({ record: detailed, now }).bodyVerified,
    true,
  );
});

test("a long university job retains hard requirements beyond the old 3000 character cutoff", async () => {
  const tail = "专业要求：消防工程。报名截止时间：2027年1月1日。";
  const text = "消防设施检查与维护。".repeat(500) + tail;
  const detailed = await createLegacyProvider("university").fetchDetail(
    record(),
    ctx(html(text)),
  );
  assert.equal(detailed.description === text, true);
  assert.equal(detailed.deadlineAt, "2027-01-01T15:59:59.999Z");
  assert.ok(
    detailed.conditions.some(
      (c) => c.type === "major" && c.values.includes("消防工程"),
    ),
  );
  assert.ok(detailed.summary.length <= 241);
});

test("a fresh complete university detail is not mistaken for an old truncated parser result", async () => {
  const text = "消".repeat(3000) + "…";
  const detailed = await createLegacyProvider("university").fetchDetail(
    record({ parserVersion: "legacy-adapter-2" }),
    ctx(html(text)),
  );
  assert.equal(detailed.description === text, true);
  assert.equal(
    assessRecruitmentEvidence({ record: detailed, now }).bodyVerified,
    true,
  );
});

test("91job empty detail cannot reuse a long old list description as verified body", async () => {
  for (const zwms of ["", null, "null", "{}"])
    await assert.rejects(
      job91.fetchDetail(
        { ...record91(), description, detailStatus: "incomplete" },
        context91(row91({ zwms })),
      ),
      { code: "detail_insufficient", retryable: false },
    );
});

test("91job literal demand majors remain evidence conditions through repeated normalization", async () => {
  const collected = await job91.collect({
    ...context91(row91()),
    request: async () => ({
      status: 200,
      headers: {},
      text: JSON.stringify({
        success: true,
        code: 200,
        result: { records: [row91({ xqzy: "消防工程、安全工程" })], pages: 1 },
      }),
    }),
  });
  const normalized = normalizeRecord(normalizeRecord(collected.records[0]));
  const fire = { education: "本科", major: "消防工程" };
  const chemical = { education: "本科", major: "化学工程" };
  assert.equal(evaluateQualification(normalized, fire).status, "pass");
  assert.equal(evaluateQualification(normalized, chemical).status, "fail");
  const major = normalized.conditions.find((c) => c.type === "major");
  assert.deepEqual(major.values, ["消防工程", "安全工程"]);
  assert.ok(
    normalized.sourceEvidence.some(
      (e) =>
        major.evidenceRefs.includes(e.evidenceId) &&
        e.sourceField === "xqzy" &&
        e.sourceExcerpt === "消防工程、安全工程" &&
        e.status === "verified",
    ),
  );
});

test("91job coded or broad majors remain unknown while explicit unrestricted or preferred majors do not disqualify", async () => {
  const cases = [
    ["081022", "unknown"],
    ["消防工程及相关专业", "unknown"],
    ["工学类", "unknown"],
    ["不限专业", "pass"],
    ["消防工程优先", "pass"],
  ];
  for (const [xqzy, expected] of cases) {
    const detailed = await job91.fetchDetail(
      record91(),
      context91(row91({ xqzy })),
    );
    assert.equal(
      evaluateQualification(normalizeRecord(detailed), {
        education: "本科",
        major: "化学工程",
      }).status,
      expected,
      xqzy,
    );
    if (expected === "unknown")
      assert.ok(
        detailed.sourceEvidence.some(
          (e) => e.field === "major" && e.status === "unknown",
        ),
      );
  }
});

test("91job detail refresh replaces previous structured major evidence without carrying the old condition", async () => {
  const old = await job91.fetchDetail(
    record91(),
    context91(row91({ xqzy: "化学工程" })),
  );
  const fresh = normalizeRecord(
    await job91.fetchDetail(old, context91(row91({ xqzy: "消防工程" }))),
  );
  assert.equal(
    evaluateQualification(fresh, { education: "本科", major: "消防工程" })
      .status,
    "pass",
  );
  assert.deepEqual(
    fresh.conditions.filter((c) => c.type === "major").map((c) => c.values),
    [["消防工程"]],
  );
});

test("91job literal major suffixes are normalized while degree qualifiers remain unsupported", async () => {
  const literal = await job91.fetchDetail(
    record91(),
    context91(row91({ xqzy: "消防工程专业" })),
  );
  assert.equal(
    evaluateQualification(literal, { education: "本科", major: "消防工程" })
      .status,
    "pass",
  );
  for (const xqzy of ["消防工程（本科）", "不限制专业", "无要求"]) {
    const detailed = await job91.fetchDetail(
      record91(),
      context91(row91({ xqzy })),
    );
    assert.equal(
      evaluateQualification(detailed, { education: "本科", major: "消防工程" })
        .status,
      "unknown",
      xqzy,
    );
  }
});

test("university and 91job retain ambiguous entries as evidence without selecting an application URL", async () => {
  const variants = [
    '<a href="/apply/one">报名</a><a href="/apply/two">报名</a>',
    '<a href="#">投递简历</a>',
    '<a href="/login">登录后投递</a>',
    '<a href="/apply?token=synthetic">报名</a>',
  ];
  for (const anchors of variants) {
    const university = await createLegacyProvider("university").fetchDetail(
      record(),
      ctx(html(description + anchors)),
    );
    const scoped91 = await job91.fetchDetail(
      record91(),
      context91(
        row91({ zwms: JSON.stringify({ rzzg: description, apply: anchors }) }),
      ),
    );
    assert.equal(university.applyUrl, null);
    assert.equal(scoped91.applyUrl, null);
  }
});

test("an existing application URL survives absent valid candidates without overriding new entry evidence", async () => {
  const previousUrl = "https://jobs.example.com/apply/1";
  const cases = [
    ["", previousUrl],
    ['<a href="#">投递简历</a>', previousUrl],
    ['<a href="/login">登录后投递</a>', previousUrl],
    ['<a href="/apply?token=synthetic">报名</a>', previousUrl],
    ['<a href="/apply/one">报名</a>', "https://seu.91job.org.cn/apply/one"],
    ['<a href="/apply/one">报名</a><a href="/apply/two">报名</a>', null],
  ];
  for (const [anchors, expected] of cases) {
    const detailed = await job91.fetchDetail(
      { ...record91(), applyUrl: previousUrl },
      context91(
        row91({ zwms: JSON.stringify({ rzzg: description, apply: anchors }) }),
      ),
    );
    assert.equal(detailed.applyUrl, expected, anchors);
  }
});

test("university details retain a known list entry only when no new public candidate exists", async () => {
  const previous = record({ applyUrl: "https://jobs.example.com/apply/1" });
  const preserved = await createLegacyProvider("university").fetchDetail(
    previous,
    ctx(html(description)),
  );
  assert.equal(preserved.applyUrl, "https://jobs.example.com/apply/1");
  const ambiguous = await createLegacyProvider("university").fetchDetail(
    previous,
    ctx(
      html(
        description + '<a href="/apply/a">报名</a><a href="/apply/b">报名</a>',
      ),
    ),
  );
  assert.equal(ambiguous.applyUrl, null);
});

test("university demand majors outside the JD remain exact source conditions after repeated normalization", async () => {
  const header = "消防工程、安全工程";
  const fullHtml =
    "<h1>消防工程师</h1><p>需求专业：" +
    header +
    "</p><p>8000 | 南京 | 全职 | 本科</p><p>职位详情</p><p>" +
    description +
    "</p>";
  const detailed = normalizeRecord(
    await createLegacyProvider("university").fetchDetail(
      record(),
      ctx(fullHtml),
    ),
  );
  assert.equal(detailed.description.includes("需求专业"), false);
  assert.equal(
    evaluateQualification(detailed, { education: "本科", major: "化学工程" })
      .status,
    "fail",
  );
  assert.equal(
    evaluateQualification(normalizeRecord(detailed), {
      education: "本科",
      major: "消防工程",
    }).status,
    "pass",
  );
  const major = detailed.conditions.find((c) => c.type === "major");
  assert.deepEqual(major.values, ["消防工程", "安全工程"]);
  const evidence = detailed.sourceEvidence.find((e) =>
    major.evidenceRefs.includes(e.evidenceId),
  );
  assert.equal(evidence.sourceField, "需求专业");
  assert.equal(evidence.sourceExcerpt, header);
  assert.equal(evidence.sourceUrl, "https://school.example.org/job/view/id/1");
  assert.equal(evidence.location.textScope, "page_text");
  assert.equal(evidence.location.end - evidence.location.start, header.length);
  assert.equal(
    htmlToText(fullHtml).slice(evidence.location.start, evidence.location.end),
    header,
  );
});

test("university major metadata keeps its complete value instead of verifying a forty character prefix", async () => {
  const longHeader = [
    "消防工程",
    "安全工程",
    "机械工程",
    "电气工程",
    "软件工程",
    "土木工程",
    "建筑工程",
    "环境工程",
    "化学工程",
  ].join("、");
  assert.ok(longHeader.length > 40);
  const detailed = await createLegacyProvider("university").fetchDetail(
    record(),
    ctx(
      "<h1>消防工程师</h1><p>需求专业：" +
        longHeader +
        "</p>" +
        html(description),
    ),
  );
  assert.equal(detailed.extra.major, longHeader);
  assert.equal(
    evaluateQualification(detailed, { education: "本科", major: "化学工程" })
      .status,
    "pass",
  );
  assert.equal(
    detailed.sourceEvidence.find((e) => e.field === "major").sourceExcerpt,
    longHeader,
  );
});

test("university and 91job share major semantics while unsupported public field values remain unknown", async () => {
  const cases = [
    ["消防工程或安全工程", "pass", "安全工程"],
    ["不限专业", "pass", "化学工程"],
    ["消防工程优先", "pass", "化学工程"],
    ["081022", "unknown", "消防工程"],
    ["消防工程及相关专业", "unknown", "消防工程"],
    ["消防工程（本科）", "unknown", "消防工程"],
  ];
  for (const [majorField, expected, own] of cases) {
    const detailed = await createLegacyProvider("university").fetchDetail(
      record(),
      ctx(
        "<h1>消防工程师</h1><p>需求专业：" +
          majorField +
          "</p>" +
          html(description),
      ),
    );
    assert.equal(
      evaluateQualification(detailed, { education: "本科", major: own }).status,
      expected,
      majorField,
    );
  }
});

test("university demand major values on the next line keep exact public evidence and cannot accept a different major", async () => {
  const fullHtml =
    "<h1>消防工程师</h1><p>需求专业：</p><p>  消防工程  </p><p>8000 | 南京 | 全职 | 本科</p>" +
    html(description);
  const detailed = await createLegacyProvider("university").fetchDetail(
    record(),
    ctx(fullHtml),
  );
  assert.equal(detailed.extra.major, "消防工程");
  assert.equal(
    evaluateQualification(detailed, { education: "本科", major: "化学工程" })
      .status,
    "fail",
  );
  assert.equal(
    evaluateQualification(detailed, { education: "本科", major: "消防工程" })
      .status,
    "pass",
  );
  const evidence = detailed.sourceEvidence.find(
    (e) => e.sourceField === "需求专业",
  );
  assert.equal(evidence.location.textScope, "page_text");
  assert.equal(
    htmlToText(fullHtml).slice(evidence.location.start, evidence.location.end),
    "消防工程",
  );
});

test("empty university demand major fields do not absorb the next metadata label or JD", async () => {
  const nextFields = [
    "招聘人数：10",
    "工作经验：不限",
    "职能类别：消防工程",
    "学历要求：本科",
    "薪资待遇：8000",
    "工作地点：南京",
    "需求专业：",
    "",
  ];
  for (const next of nextFields) {
    const detailed = await createLegacyProvider("university").fetchDetail(
      record(),
      ctx(
        "<h1>消防工程师</h1><p>需求专业：</p><p>" +
          next +
          "</p>" +
          "<main><p>职位详情</p><p>" +
          description +
          "</p></main>",
      ),
    );
    assert.equal(detailed.extra.major, "", next);
    assert.equal(
      detailed.sourceEvidence.some((e) => e.sourceField === "需求专业"),
      false,
      next,
    );
  }
});
