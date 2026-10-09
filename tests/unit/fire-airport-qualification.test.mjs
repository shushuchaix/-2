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
} from "../../src/domain/recruitment-evidence.mjs";
import { job, profile } from "../helpers/fixtures.mjs";
const now = Date.parse("2026-10-09T12:00:00Z");
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
