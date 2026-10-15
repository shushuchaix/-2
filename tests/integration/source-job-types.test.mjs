import test from "node:test";
import assert from "node:assert/strict";
import job91 from "../../src/sources/adapters/university-91job.mjs";
import official from "../../src/sources/adapters/official-announcements.mjs";
import { prepareRecruitmentRecord } from "../../src/domain/recruitment-evidence.mjs";

const school = {
  siteId: "synthetic-school",
  tenantId: "10286",
  origin: "https://school.example.org",
};
function schoolContext(row, detail = row) {
  return {
    sites: [school],
    request: async (url) => ({
      status: 200,
      url,
      text: JSON.stringify({
        success: true,
        code: 200,
        result: url.includes("getZpgwxq")
          ? detail
          : { pages: 1, records: [row] },
      }),
    }),
  };
}
for (const [title, body, expected] of [
  ["消防工程实习生", "协助消防设施检测，整理安全检查资料。", "internship"],
  [
    "机场安全 Laboratory Assistant Intern",
    "协助机场安全设施检查。",
    "internship",
  ],
  ["消防校园招聘", "面向应届本科毕业生。", "campus"],
  ["消防社会招聘", "按具体岗位条件招聘。", "social"],
  ["消防工程师", "工作性质：实习\n协助消防设施检查。", "internship"],
  ["消防工程师", "岗位性质：社会招聘\n负责消防设施检查。", "social"],
  ["消防工程师（不接受实习生）", "有实习经历者优先。", "unknown"],
  ["消防工程师（非实习岗位）", "应聘人员无需实习经历。", "unknown"],
  ["消防工程师（不接受在校实习生）", "负责消防设施检查。", "unknown"],
  ["消防工程师（实习生勿投）", "负责消防设施检查。", "unknown"],
  ["消防实习指导教师", "指导学生完成消防设施检查实习。", "unknown"],
  ["消防岗位，实习生优先", "按具体岗位条件招聘。", "unknown"],
  ["消防工程师", "工作性质：不接受实习生。", "unknown"],
  ["消防工程师", "工作性质：2\n有实习经历者优先。", "unknown"],
  ["消防工程师", "岗位性质：有实习经验者优先。", "unknown"],
  ["消防工程师", "岗位性质：全职，具有实习生指导经验者优先。", "unknown"],
  ["消防工程师", "全职工作，应届毕业生可申请。", "unknown"],
  ["消防校园招聘实习生", "协助消防设施检查。", "internship"],
  ["消防工程师（实习）", "协助消防设施检查。", "internship"],
  ["Fire Safety Internship", "协助消防设施检查。", "internship"],
  ["Intern - Fire Safety Engineer", "协助消防设施检查。", "internship"],
  ["Intern Fire Safety Engineer", "协助消防设施检查。", "internship"],
  ["消防工程师（校园招聘）", "负责消防设施检查。", "campus"],
  ["消防工程师", "招聘类型：应届毕业生\n负责消防设施检查。", "campus"],
  ["消防工程师", "工作性质：Internship\n负责消防设施检查。", "internship"],
  ["消防工程师", "招聘性质：校园招聘\n负责消防设施检查。", "campus"],
  ["社会招聘消防工程师", "负责消防设施检查。", "social"],
  ["Fire Safety Intern", "协助消防设施检查。", "internship"],
  ["消防工程师，实习", "协助消防设施检查。", "internship"],
  ["Fire Safety Engineer | Internship", "协助消防设施检查。", "internship"],
]) {
  test(`91job maps explicit type without guessing: ${title} / ${expected}`, async () => {
    const row = { zpgwid: "synthetic-role", zwmc: title, zwms: body };
    const context = schoolContext(row);
    const page = await job91.collectPage({ site: school, query: {}, context });
    assert.equal(page.records[0].jobType, expected);
    const detail = await job91.fetchDetail(page.records[0], context);
    assert.equal(detail.jobType, expected);
    assert.equal(detail.parserVersion, "university-91job-2");
    if (expected !== "unknown")
      assert.ok(
        detail.evidence.some(
          (e) => e.field === "jobType" && e.value === expected,
        ),
      );
    assert.equal(detail.fullTime, undefined);
  });
}

const contextualNonTypes = [
  ["消防实习生指导教师", "负责学生实践指导与校园消防巡查。"],
  ["机场实习生带教导师", "负责学生实践指导与机场安全培训。"],
  ["大学生实习生管理专员", "负责学生实践管理与工作协调。"],
  ["应届毕业生就业指导教师", "负责毕业生就业辅导与职业指导。"],
  ["应届生职业咨询顾问", "负责毕业生职业咨询与就业指导。"],
  ["校园招聘专员", "负责校园人才招聘与活动组织。"],
  ["校园招聘指导教师", "负责人才招聘教育与指导工作。"],
  ["消防实习生培养培训师", "负责学生实践教学与技能培训。"],
  ["具有实习生带教经验的消防工程师", "负责消防设备检查与安全管理。"],
  ["消防工程师（具备 Internship 经验）", "负责消防设备检查与安全管理。"],
  ["消防工程师 Internship Experience Required", "负责消防设备检查与安全管理。"],
  ["消防工程师（有实习生管理经验者优先）", "负责消防设备检查与安全管理。"],
  ["消防工程师", "岗位性质：不限制应届毕业生\n负责消防巡查。"],
  ["消防工程师", "岗位性质：实习生指导\n负责消防巡查。"],
  ["消防工程师", "岗位性质：不限制实习生\n负责消防巡查。"],
  ["消防工程师", "岗位性质：接受应届毕业生\n负责消防巡查。"],
  ["消防工程师", "岗位性质：有 Internship 经验\n负责消防巡查。"],
  ["消防工程师", "岗位性质：实习生带教工作\n负责消防巡查。"],
  ["消防工程师", "岗位性质：校园招聘指导\n负责消防巡查。"],
  ["消防工程师", "岗位性质：不限定校招\n负责消防巡查。"],
  ["消防工程师", "岗位性质：社会招聘服务\n负责消防巡查。"],
  ["消防（Internship）经验工程师", "负责消防设备检查与安全管理。"],
  ["消防工程师（实习）优先", "负责消防设备检查与安全管理。"],
  ["应届毕业生", "负责毕业生职业咨询与就业指导。"],
  ["消防工程师", "岗位性质：实习/全职\n负责消防巡查。"],
  ["消防工程师", "岗位性质：曾经参加Internship\n负责消防巡查。"],
  ["消防工程师，指导实习生", "负责消防设备检查与安全管理。"],
  ["消防工程师—不限制实习生", "负责消防设备检查与安全管理。"],
  ["消防工程师，欢迎实习生", "负责消防设备检查与安全管理。"],
  [
    "Internship Experience Required: Fire Safety Engineer",
    "负责消防设备检查与安全管理。",
  ],
  ["消防工程师欢迎实习生", "负责消防设备检查与安全管理。"],
  ["指导消防工程实习生", "负责消防设备检查与安全管理。"],
  ["消防工程师，接受 Internship", "负责消防设备检查与安全管理。"],
  ["Internship mentoring Fire Safety Engineer", "负责消防设备检查与安全管理。"],
  [
    "Internship Prior Experience Preferred Fire Safety Engineer",
    "负责消防设备检查与安全管理。",
  ],
  [
    "Fire Safety Engineer | Internship experience preferred",
    "负责消防设备检查与安全管理。",
  ],
  ["消防工程师，不限制（实习生）", "负责消防设备检查与安全管理。"],
  ["消防工程师—接收实习生", "负责消防设备检查与安全管理。"],
];
for (const [title, body] of contextualNonTypes) {
  test(`91job role, experience and eligibility context is not a job type: ${title} / ${body}`, async () => {
    const row = { zpgwid: "synthetic-context-role", zwmc: title, zwms: body };
    const context = schoolContext(row);
    const page = await job91.collectPage({ site: school, query: {}, context });
    const detail = await job91.fetchDetail(page.records[0], context);
    assert.equal(page.records[0].jobType, "unknown");
    assert.equal(detail.jobType, "unknown");
    assert.equal(prepareRecruitmentRecord(detail).jobType, "unknown");
    assert.ok(!detail.evidence.some((e) => e.field === "jobType"));
  });
}

test("91job detail resolves an unknown list type from literal nature and preserves a genuine conflict", async () => {
  const row = { zpgwid: "synthetic-role", zwmc: "消防工程师" };
  const context = schoolContext(row, {
    ...row,
    zwms: "岗位性质：实习\n协助消防设施检查并整理记录。",
  });
  const page = await job91.collectPage({ site: school, query: {}, context });
  assert.equal(page.records[0].jobType, "unknown");
  assert.equal(
    (await job91.fetchDetail(page.records[0], context)).jobType,
    "internship",
  );

  const conflicting = {
    ...row,
    zwmc: "社会招聘消防工程师",
    zwms: "岗位性质：实习\n协助消防设施检查并整理记录。",
  };
  const conflictContext = schoolContext(conflicting);
  const conflict = (
    await job91.collectPage({
      site: school,
      query: {},
      context: conflictContext,
    })
  ).records[0];
  assert.equal(conflict.jobType, "unknown");
  assert.ok(conflict.evidenceConflicts.some((e) => e.field === "jobType"));
  assert.ok(
    prepareRecruitmentRecord(conflict).recruitmentEvidence.conflicts.some(
      (e) => e.field === "jobType",
    ),
  );
});

test("91job notice titles expose internship but retain their notice kind", async () => {
  const context = {
    sites: [school],
    request: async (url) => ({
      status: 200,
      url,
      text: JSON.stringify({
        success: true,
        code: 200,
        result: {
          pages: 1,
          records: [{ zpggid: "notice", zpggbt: "消防工程实习生招聘公告" }],
        },
      }),
    }),
  };
  const page = await job91.collectPage({
    site: school,
    query: { kind: "recruitment_notice" },
    context,
  });
  assert.equal(page.records[0].kind, "recruitment_notice");
  assert.equal(page.records[0].jobType, "internship");
});

function officialContext(title, body, jobMode) {
  const site = {
    siteId: "synthetic-official",
    name: "合成企业",
    origin: "https://official.example.org",
    template: {
      listUrl: "https://official.example.org/jobs/",
      linkRule: ".row a",
      bodyRule: ".body",
      ...(jobMode
        ? {
            recordKind: "job",
            rowRule: ".row",
            titleRule: "a",
            listDateRule: null,
            detailTitleRule: "h1",
            requiredBodyRules: [".body"],
          }
        : {}),
    },
  };
  const context = {
    sites: [site],
    request: async (url) => ({
      status: 200,
      url,
      text:
        url === site.template.listUrl
          ? `<div class="row"><a href="/jobs/one">${title}</a></div>`
          : `<h1>${title}</h1><div class="body">${body}</div>`,
    }),
  };
  return { site, context };
}
for (const [title, body] of contextualNonTypes) {
  test(`official role, experience and eligibility context is not a job type: ${title} / ${body}`, async () => {
    const f = officialContext(
      title,
      `<p>${body.replaceAll("\n", "</p><p>")}</p><p>负责消防设备日常安全巡查，整理检查记录并组织安全管理工作，具体职责和任职条件以正文为准。</p>`,
      true,
    );
    const page = await official.collectPage({
      site: f.site,
      query: {},
      context: f.context,
    });
    const detail = await official.fetchDetail(page.records[0], f.context);
    assert.equal(page.records[0].jobType, "unknown");
    assert.equal(detail.jobType, "unknown");
    assert.equal(prepareRecruitmentRecord(detail).jobType, "unknown");
    assert.ok(!detail.evidence.some((e) => e.field === "jobType"));
  });
}
for (const jobMode of [false, true]) {
  test(`official ${jobMode ? "job" : "notice"} template maps explicit title and nature without asserting employment form`, async () => {
    const f = officialContext(
      "消防工程实习生招聘",
      "<p>岗位性质：实习</p><p>协助消防设备巡查并整理检测记录，要求本科相关专业，具备沟通与安全意识。</p>",
      jobMode,
    );
    const page = await official.collectPage({
      site: f.site,
      query: {},
      context: f.context,
    });
    assert.equal(page.records[0].jobType, "internship");
    const detail = await official.fetchDetail(page.records[0], f.context);
    assert.equal(detail.jobType, "internship");
    assert.equal(detail.parserVersion, "official-announcements-2");
    assert.equal(detail.kind, jobMode ? "job" : "recruitment_notice");
    assert.equal(detail.fullTime, undefined);
    assert.equal(
      (
        await official.fetchDetail(
          { ...page.records[0], parserVersion: "official-announcements-1" },
          f.context,
        )
      ).parserVersion,
      "official-announcements-2",
    );
  });
}

test("91job detail refresh clears earlier type inferences while preserving unrelated evidence conflicts", async () => {
  const row = {
    zpgwid: "synthetic-old-role",
    zwmc: "消防实习生指导教师",
    zwms: "负责消防实践教学与学生指导，并整理设施安全检查记录。",
  };
  const context = schoolContext(row);
  const page = await job91.collectPage({ site: school, query: {}, context });
  const detail = await job91.fetchDetail(
    {
      ...page.records[0],
      jobType: "internship",
      evidence: [
        ...page.records[0].evidence,
        {
          field: "jobType",
          sourceField: "zwmc",
          value: "internship",
          sourceExcerpt: row.zwmc,
        },
      ],
      evidenceConflicts: [
        { field: "jobType", code: "explicit_job_type_conflict" },
        { field: "qualification", code: "synthetic_unresolved_requirement" },
      ],
    },
    context,
  );
  assert.equal(detail.jobType, "unknown");
  assert.ok(!detail.evidence.some((e) => e.field === "jobType"));
  assert.deepEqual(detail.evidenceConflicts, [
    { field: "qualification", code: "synthetic_unresolved_requirement" },
  ]);
  assert.ok(
    prepareRecruitmentRecord(detail).recruitmentEvidence.conflicts.some(
      (e) => e.code === "synthetic_unresolved_requirement",
    ),
  );
});

test("91job sparse detail keeps an independent list type and its provenance without inventing new type evidence", async () => {
  const row = {
    zpgwid: "synthetic-upstream-fact",
    zwmc: "消防实习生指导教师",
    zwms: "负责学生实践指导和消防巡查资料整理，具体岗位职责与条件以正文为准。",
  };
  const context = schoolContext(row, { zpgwid: row.zpgwid, zwms: row.zwms });
  const page = await job91.collectPage({ site: school, query: {}, context });
  const typeEvidence = {
    field: "jobType",
    sourceField: "zwmc",
    value: "internship",
    sourceExcerpt: row.zwmc,
    source: "public_list",
  };
  const listed = {
    ...page.records[0],
    jobType: "internship",
    evidence: [...page.records[0].evidence, typeEvidence],
  };
  const detail = await job91.fetchDetail(listed, context);
  assert.equal(detail.jobType, "internship");
  assert.deepEqual(
    detail.evidence.filter((e) => e.field === "jobType"),
    [typeEvidence],
  );
  assert.equal(prepareRecruitmentRecord(detail).jobType, "internship");
});

test("91job independent list type conflicts with a new explicit detail type instead of being silently overwritten", async () => {
  const row = {
    zpgwid: "synthetic-upstream-conflict",
    zwmc: "消防工程师",
    zwms: "负责消防巡查资料整理，具体岗位职责与条件以正文为准。",
  };
  const context = schoolContext(row, { ...row, zwmc: "社会招聘消防工程师" });
  const page = await job91.collectPage({ site: school, query: {}, context });
  const detail = await job91.fetchDetail(
    { ...page.records[0], jobType: "internship" },
    context,
  );
  assert.equal(detail.jobType, "unknown");
  assert.ok(
    detail.evidenceConflicts.some(
      (e) => e.code === "explicit_job_type_conflict",
    ),
  );
  assert.ok(
    prepareRecruitmentRecord(detail).recruitmentEvidence.conflicts.some(
      (e) => e.code === "explicit_job_type_conflict",
    ),
  );
});

test("official detail refresh clears earlier type inferences instead of inheriting a wrong list type", async () => {
  const f = officialContext(
    "应届毕业生就业指导教师",
    "<p>负责毕业生就业指导与培训，整理职业咨询资料并提供实践教学支持。</p>",
    true,
  );
  const page = await official.collectPage({
    site: f.site,
    query: {},
    context: f.context,
  });
  const detail = await official.fetchDetail(
    {
      ...page.records[0],
      jobType: "campus",
      evidence: [
        ...page.records[0].evidence,
        {
          field: "jobType",
          sourceField: "title",
          value: "campus",
          sourceExcerpt: page.records[0].title,
        },
      ],
    },
    f.context,
  );
  assert.equal(detail.jobType, "unknown");
  assert.ok(!detail.evidence.some((e) => e.field === "jobType"));
  assert.equal(prepareRecruitmentRecord(detail).jobType, "unknown");
});

const typeClaimCases = [
  ["社会招聘消防工程实习生", "", "unknown", ["social", "internship"], true],
  ["校园招聘消防工程实习生", "", "internship", ["campus", "internship"], false],
  [
    "社会招聘消防工程师",
    "岗位性质：实习",
    "unknown",
    ["social", "internship"],
    true,
  ],
  [
    "消防工程实习生",
    "招聘类型：社会招聘",
    "unknown",
    ["social", "internship"],
    true,
  ],
  ["（社会招聘）消防工程实习生", "", "unknown", ["social", "internship"], true],
  ["消防工程实习生（社会招聘）", "", "unknown", ["social", "internship"], true],
  [
    "（校园招聘）消防工程实习生",
    "",
    "internship",
    ["campus", "internship"],
    false,
  ],
  [
    "消防工程实习生（校园招聘）",
    "",
    "internship",
    ["campus", "internship"],
    false,
  ],
  [
    "消防工程师（社会招聘）（实习）",
    "",
    "unknown",
    ["social", "internship"],
    true,
  ],
  [
    "消防工程师（实习）（社会招聘）",
    "",
    "unknown",
    ["social", "internship"],
    true,
  ],
  [
    "消防工程师（校园招聘）（实习）",
    "",
    "internship",
    ["campus", "internship"],
    false,
  ],
  [
    "社会招聘消防工程实习生",
    "岗位性质：校园招聘",
    "unknown",
    ["social", "campus", "internship"],
    true,
  ],
  ["社会招聘消防工程师（非实习岗位）", "", "social", ["social"], false],
  ["社会招聘消防实习生指导教师", "", "unknown", [], false],
];
function assertTypeClaims(record, expected, claims, conflicting) {
  assert.equal(record.jobType, expected);
  assert.deepEqual(
    [
      ...new Set(
        record.evidence
          .filter((e) => e.field === "jobType")
          .map((e) => e.value),
      ),
    ].sort(),
    [...claims].sort(),
  );
  const conflicts = (record.evidenceConflicts || []).filter(
    (e) => e.field === "jobType" && e.code === "explicit_job_type_conflict",
  );
  assert.equal(conflicts.length, conflicting ? 1 : 0);
  if (conflicting)
    assert.deepEqual([...conflicts[0].values].sort(), [...claims].sort());
  const prepared = prepareRecruitmentRecord(record);
  assert.equal(prepared.jobType, expected);
  assert.equal(
    prepared.recruitmentEvidence.conflicts.filter(
      (e) => e.field === "jobType" && e.code === "explicit_job_type_conflict",
    ).length,
    conflicting ? 1 : 0,
  );
}
for (const [title, nature, expected, claims, conflicting] of typeClaimCases) {
  test(`91job preserves independent explicit type claims: ${title} / ${nature}`, async () => {
    const row = {
      zpgwid: "synthetic-type-claims",
      zwmc: title,
      zwms: `${nature}\n负责消防设备安全巡查和资料整理，要求本科相关工程专业，具体资格条件以正文为准。`,
    };
    const context = schoolContext(row);
    const page = await job91.collectPage({ site: school, query: {}, context });
    assertTypeClaims(page.records[0], expected, claims, conflicting);
    assertTypeClaims(
      await job91.fetchDetail(page.records[0], context),
      expected,
      claims,
      conflicting,
    );
  });
  test(`official preserves independent explicit type claims: ${title} / ${nature}`, async () => {
    const f = officialContext(
      title,
      `<p>${nature}</p><p>负责消防设备安全巡查和资料整理，要求本科相关工程专业，具体资格条件以正文为准。</p>`,
      true,
    );
    const page = await official.collectPage({
      site: f.site,
      query: {},
      context: f.context,
    });
    if (!nature)
      assertTypeClaims(page.records[0], expected, claims, conflicting);
    assertTypeClaims(
      await official.fetchDetail(page.records[0], f.context),
      expected,
      claims,
      conflicting,
    );
  });
}
