import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateQualification,
  evaluateEvidenceQualification,
} from "../../src/domain/qualification.mjs";
import {
  assessRecruitmentEvidence,
  isVerifiedRecommendation,
  prepareRecruitmentRecord,
  assessApplicationResponse,
  readJobPostingEvidence,
  extractRecruitmentConditions,
} from "../../src/domain/recruitment-evidence.mjs";
import { job, profile } from "../helpers/fixtures.mjs";
const now = Date.parse("2026-10-09T12:00:00Z");
test("age minimum range and exclusive endpoints preserve literal boundaries", () => {
  const cases = [
    [
      "要求年龄20周岁以上。",
      [
        [19, "fail"],
        [20, "pass"],
        [25, "pass"],
      ],
    ],
    [
      "要求年龄为18至24周岁。",
      [
        [17, "fail"],
        [18, "pass"],
        [24, "pass"],
        [25, "fail"],
      ],
    ],
    [
      "要求年龄小于25周岁。",
      [
        [24, "pass"],
        [25, "fail"],
      ],
    ],
    [
      "要求年龄大于20周岁。",
      [
        [20, "fail"],
        [21, "pass"],
      ],
    ],
    [
      "要求年龄不超过25周岁。",
      [
        [25, "pass"],
        [26, "fail"],
      ],
    ],
  ];
  for (const [description, ages] of cases)
    for (const [age, status] of ages) {
      const extracted = extractRecruitmentConditions(job({ description }));
      assert.equal(
        evaluateEvidenceQualification({
          profileSnapshot: { age },
          ...extracted,
          now,
        }).status,
        status,
        description + " age " + age,
      );
    }
  assert.equal(
    evaluateEvidenceQualification({
      profileSnapshot: {},
      ...extractRecruitmentConditions(job({ description: "年龄至少20周岁。" })),
      now,
    }).status,
    "unknown",
  );
  assert.equal(
    evaluateEvidenceQualification({
      profileSnapshot: { age: "not an age" },
      ...extractRecruitmentConditions(job({ description: "年龄至少20周岁。" })),
      now,
    }).status,
    "unknown",
  );
});
test("certificate OR permits either confirmed option, AND requires all, and each option owns its grade", () => {
  const run = (description, certificates, confirmed = true) =>
    evaluateEvidenceQualification({
      profileSnapshot: {
        certificates,
        explicitFacts: { certificates: confirmed },
      },
      ...extractRecruitmentConditions(job({ description })),
      now,
    });
  const or = "须持有一级注册消防工程师或中级注册安全工程师证书。";
  assert.equal(run(or, ["一级注册消防工程师"]).status, "pass");
  assert.equal(run(or, ["中级注册安全工程师"]).status, "pass");
  assert.equal(run(or, []).status, "fail");
  assert.equal(run(or, [], false).status, "unknown");
  assert.equal(run(or, ["中级注册消防工程师"]).status, "fail");
  assert.equal(
    run("须持有注册消防工程师和注册安全工程师证书。", ["注册消防工程师"])
      .status,
    "fail",
  );
  assert.equal(
    run("须持有注册消防工程师和注册安全工程师证书。", [
      "注册消防工程师",
      "注册安全工程师",
    ]).status,
    "pass",
  );
  assert.equal(
    run("注册消防工程师或注册安全工程师证书优先。", []).status,
    "pass",
  );
  const extracted = extractRecruitmentConditions(job({ description: or }));
  assert.equal(extracted.conditions.length, 1);
  assert.equal(extracted.conditions[0].operator, "any");
  assert.equal(
    new Set(extracted.sourceEvidence.map((e) => e.evidenceId)).size,
    extracted.sourceEvidence.length,
  );
});
test("explicit certificate all operator is enforced even for trusted structured conditions", () => {
  const condition = {
    type: "certificate",
    operator: "all",
    values: ["注册消防工程师", "注册安全工程师"],
    required: true,
    evidenceRefs: ["manual"],
  };
  const sourceEvidence = [
    {
      evidenceId: "manual",
      status: "verified",
      sourceExcerpt: "必须持两证",
      confidence: 100,
    },
  ];
  const result = evaluateEvidenceQualification({
    profileSnapshot: {
      certificates: ["注册消防工程师"],
      explicitFacts: { certificates: true },
    },
    conditions: [condition],
    sourceEvidence,
    now,
  });
  assert.equal(result.status, "fail");
});
test("older derived conditions are reparsed while unsupported legacy constraints remain pending review", () => {
  const original = job({
    description: "本科，要求年龄20周岁以上。",
    graduationYear: null,
    conditionsParserVersion: "conditions-1",
    conditions: [
      {
        origin: "local_parser",
        type: "age",
        operator: "maximum",
        values: [20],
        required: true,
        evidenceRefs: ["old"],
      },
    ],
    sourceEvidence: [
      {
        evidenceId: "old",
        origin: "local_parser",
        field: "age",
        status: "verified",
        sourceExcerpt: "年龄20周岁以上。",
        confidence: 100,
      },
    ],
  });
  const prepared = prepareRecruitmentRecord(original);
  assert.equal(
    evaluateQualification(prepared, profile({ age: 25 }), {}, { now }).status,
    "pass",
  );
  assert.notEqual(prepared.conditionsParserVersion, "conditions-1");
  assert.equal(
    evaluateQualification(original, profile({ age: 25 }), {}, { now }).status,
    "pass",
  );
  const unknown = prepareRecruitmentRecord({
    ...original,
    conditions: [
      {
        type: "physical",
        operator: "exact",
        values: ["qualified"],
        required: true,
        evidenceRefs: ["old-foreign"],
      },
    ],
    sourceEvidence: [
      {
        evidenceId: "old-foreign",
        field: "physical",
        status: "verified",
        sourceExcerpt: "旧来源未能对应当前正文",
        confidence: 100,
      },
    ],
  });
  assert.ok(unknown.conditions.some((c) => c.type === "physical"));
  assert.equal(
    evaluateQualification(
      unknown,
      profile({ age: 25, explicitFacts: { physicalQualified: true } }),
      {},
      { now },
    ).status,
    "unknown",
  );
});
test("visible and JobPosting conflicts stay unknown and a login form is not an application form", () => {
  const record = job({
      title: "消防工程师",
      degree: "本科",
      description: "消防工程师，岗位要求本科。",
    }),
    parsed = readJobPostingEvidence(
      '<script type="application/ld+json">{"@type":"JobPosting","title":"消防工程师","educationRequirements":"博士"}</script>',
      record,
    );
  assert.equal(parsed.evidenceConflicts[0].field, "degree");
  assert.equal(
    assessRecruitmentEvidence({
      record: {
        ...record,
        ...parsed,
        detailStatus: "complete",
        deadlineAt: "2029-01-01",
      },
      now,
    }).openingStatus,
    "unknown",
  );
  assert.equal(
    assessApplicationResponse(
      {
        status: 200,
        text: '<form><input type="password"><button>登录后报名</button></form>',
      },
      new Date(now).toISOString(),
    ).status,
    "login_required",
  );
});
test("fire technical title and company certificate do not create mandatory candidate certificates", () => {
  for (const text of [
    "本科，消防工程师，负责设施维护。",
    "本科，公司现有一级注册消防工程师团队，负责消防设施维护。",
    "本科，持有一级注册消防工程师证书者优先。",
  ])
    assert.equal(
      evaluateQualification(
        job({ description: text, graduationYear: null }),
        profile({ major: "消防工程", explicitFacts: { certificates: true } }),
        {},
      ).status,
      "pass",
    );
});
test("explicit major OR and formal experience are checked independently of title similarity", () => {
  assert.equal(
    evaluateQualification(
      job({
        description: "本科，专业要求消防工程或安全工程，至少2年正式工作经验。",
        graduationYear: null,
      }),
      profile({
        major: "安全工程",
        experienceYears: 0,
        internships: [{ years: 3 }],
      }),
      {},
    ).status,
    "fail",
  );
  assert.equal(
    evaluateQualification(
      job({
        description: "本科，专业要求消防工程或安全工程。",
        graduationYear: null,
      }),
      profile({ major: "安全工程" }),
      {},
    ).status,
    "pass",
  );
  assert.equal(
    evaluateQualification(
      job({ description: "本科，专业要求机械工程。", graduationYear: null }),
      profile({ major: "消防工程" }),
      {},
    ).status,
    "fail",
  );
});
test("certificate grade and required registration validity cannot be inferred from a certificate name", () => {
  const record = job({
    description: "本科，须持有一级注册消防工程师证书，注册须在有效期内。",
    graduationYear: null,
  });
  assert.equal(
    evaluateQualification(
      record,
      profile({
        certificates: [
          { name: "二级注册消防工程师", registrationValidUntil: "2030-01-01" },
        ],
        explicitFacts: { certificates: true },
      }),
      {},
      { now },
    ).status,
    "fail",
  );
  assert.equal(
    evaluateQualification(
      record,
      profile({ certificates: [{ name: "一级注册消防工程师" }] }),
      {},
      { now },
    ).status,
    "unknown",
  );
  assert.equal(
    evaluateQualification(
      record,
      profile({
        certificates: [
          { name: "一级注册消防工程师", registrationValidUntil: "2026-01-01" },
        ],
      }),
      {},
      { now },
    ).status,
    "fail",
  );
});
test("cross-row and low-confidence OCR requirements stay unknown; physical and age checks require explicit text", () => {
  const condition = {
    type: "major",
    operator: "any",
    values: ["消防工程"],
    required: true,
    evidenceRefs: ["e1"],
    jobRowId: "row2",
  };
  const sourceEvidence = [
    {
      evidenceId: "e1",
      status: "verified",
      confidence: 90,
      sourceExcerpt: "消防工程",
      appliesTo: { jobRowId: "row1" },
    },
  ];
  assert.equal(
    evaluateEvidenceQualification({
      profileSnapshot: profile({ major: "消防工程" }),
      conditions: [condition],
      sourceEvidence,
      now,
    }).status,
    "unknown",
  );
  assert.equal(
    evaluateEvidenceQualification({
      profileSnapshot: profile({ major: "消防工程" }),
      conditions: [{ ...condition, jobRowId: "row1" }],
      sourceEvidence: [{ ...sourceEvidence[0], confidence: 70 }],
      now,
    }).status,
    "unknown",
  );
  assert.equal(
    evaluateQualification(
      job({ description: "本科，消防技术岗。", graduationYear: null }),
      profile({ age: 50 }),
      {},
      { now },
    ).status,
    "pass",
  );
  assert.equal(
    evaluateQualification(
      job({
        description: "本科，要求年龄不超过30周岁。",
        graduationYear: null,
      }),
      profile({ age: 31 }),
      {},
      { now },
    ).status,
    "fail",
  );
});
test("deadline, historical notices, application challenges and long-term 72h freshness gate recommendations", () => {
  const base = prepareRecruitmentRecord(
    job({
      detailStatus: "complete",
      description: "本科，长期招聘消防工程师，报名入口持续开放。",
      applyUrl: "https://jobs.example.com/apply",
      applicationVerification: {
        status: 200,
        checkedAt: new Date(now).toISOString(),
        formVerified: true,
      },
      graduationYear: null,
    }),
    now,
  );
  const evidence = assessRecruitmentEvidence({ record: base, now });
  assert.equal(evidence.openingStatus, "open");
  assert.equal(
    isVerifiedRecommendation({ qualification: { status: "pass" }, evidence }),
    true,
  );
  assert.equal(
    isVerifiedRecommendation({
      qualification: { status: "unknown" },
      evidence,
    }),
    false,
  );
  assert.equal(
    assessRecruitmentEvidence({
      record: {
        ...base,
        applicationVerification: {
          ...base.applicationVerification,
          checkedAt: new Date(now - 73 * 3600000).toISOString(),
        },
      },
      now,
    }).openingStatus,
    "unknown",
  );
  assert.equal(
    assessRecruitmentEvidence({
      record: job({ detailStatus: "complete" }),
      now,
    }).openingStatus,
    "unknown",
  );
  assert.equal(
    assessRecruitmentEvidence({
      record: { ...base, title: "拟录用人员公示" },
      now,
    }).openingStatus,
    "historical",
  );
  assert.equal(
    assessRecruitmentEvidence({
      record: {
        ...base,
        applicationVerification: {
          status: 403,
          checkedAt: new Date(now).toISOString(),
        },
      },
      now,
    }).applicationStatus,
    "login_required",
  );
  assert.equal(
    assessRecruitmentEvidence({
      record: {
        ...base,
        applicationVerification: {
          status: 200,
          challenge: true,
          checkedAt: new Date(now).toISOString(),
        },
      },
      now,
    }).applicationStatus,
    "unknown",
  );
  assert.equal(
    assessRecruitmentEvidence({
      record: { ...base, deadlineAt: "2026-01-01" },
      now,
    }).openingStatus,
    "expired",
  );
});
