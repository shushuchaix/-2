import test from "node:test";
import assert from "node:assert/strict";
import {
  CONDITIONS_PARSER_VERSION,
  extractRecruitmentConditions,
  prepareApplicationCheck,
  prepareRecruitmentRecord,
} from "../../src/domain/recruitment-evidence.mjs";
import { evaluateEvidenceQualification } from "../../src/domain/qualification.mjs";
import { evaluationCacheKey } from "../../src/llm/validation.mjs";
import {
  jobFactHash,
  selectMatchingEvaluation,
} from "../../src/domain/job-facts.mjs";
import { RULE_VERSION } from "../../src/domain/ranking-policy.mjs";
import { job } from "../helpers/fixtures.mjs";
import { htmlToText } from "../../src/util/html.mjs";

const now = Date.parse("2026-10-11T00:00:00Z");
const notice = (description, extra = {}) =>
  job({
    description,
    detailStatus: "complete",
    bodyStatus: "complete",
    ...extra,
  });
const genericMaterials =
  "应聘人员投递的材料包括应聘登记表、个人简历、身份证、已取得的各层次学历学位证书、在校期间获得荣誉和奖励证书、英语水平等级证书、法律职业资格证书、注册会计师资格证书等。";

test("an explicit immediately-until date preserves spaced digits and expires before application HTTP", () => {
  for (const description of [
    "报名方式：即日起至202 6 年 9 月 1 日前提交相关材料，逾期不再受理报名。",
    "报名方式：即日起至2026年9月1日前提交相关材料。",
    "报名截止时间：202 6 年 9 月 1 日。",
  ]) {
    const record = notice(description, {
      applyUrl: "https://jobs.example.org/apply",
    });
    const before = structuredClone(record);
    const prepared = prepareRecruitmentRecord(record, now);
    assert.equal(prepared.deadlineAt, "2026-09-01T15:59:59.999Z");
    assert.equal(prepared.recruitmentEvidence.openingStatus, "expired");
    assert.equal(prepareApplicationCheck(record, now).shouldRequest, false);
    assert.deepEqual(record, before);
  }
});

test("explicit visible ranges still retain their final clock time", () => {
  const prepared = prepareRecruitmentRecord(
    notice("报名时间：2026年8月1日至202 6 年 9 月 1 日17:00。"),
    now,
  );
  assert.equal(prepared.deadlineAt, "2026-09-01T09:00:00.000Z");
});

for (const [label, description, deadlineAt] of [
  [
    "cue and date",
    "报名截止时间：\n2026年9月1日。",
    "2026-09-01T15:59:59.999Z",
  ],
  [
    "range and final date",
    "报名时间：2026年8月1日至\n2026年9月1日。",
    "2026-09-01T15:59:59.999Z",
  ],
  [
    "completed date and clock",
    "报名截止时间：2026年9月1日\n17:00。",
    "2026-09-01T09:00:00.000Z",
  ],
  [
    "HTML blocks after cue",
    htmlToText("<p>报名截止时间：</p><p>2026年9月1日。</p>"),
    "2026-09-01T15:59:59.999Z",
  ],
]) {
  test(`explicit deadline allows layout whitespace between ${label}`, () => {
    const record = notice(description, {
      applyUrl: "https://jobs.example.org/apply",
    });
    assert.equal(prepareRecruitmentRecord(record, now).deadlineAt, deadlineAt);
    assert.equal(prepareApplicationCheck(record, now).shouldRequest, false);
  });
}

test("publication or founding dates and unrelated digit groups cannot become deadlines", () => {
  for (const description of [
    "公司成立于202 6 年 9 月 1 日。现公开招聘合成岗位。",
    "公告发布于2026年9月1日。报名方式另行通知。",
    "报名截止：20 26 9 1。",
    "报名截止：202\n6年9月1日。",
    "报名截止：2026年2月30日。",
  ]) {
    const prepared = prepareRecruitmentRecord(notice(description), now);
    assert.equal(prepared.deadlineAt, null);
    assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  }
});

test("generic application document lists do not assert unrelated required certificates", () => {
  const parsed = extractRecruitmentConditions(notice(genericMaterials));
  assert.deepEqual(
    parsed.conditions.filter((c) => c.type === "certificate"),
    [],
  );
  assert.notEqual(
    evaluateEvidenceQualification({
      profileSnapshot: {
        certificates: [],
        explicitFacts: { certificates: true },
      },
      ...parsed,
      now,
    }).status,
    "fail",
  );
});

test("a materials heading continues only into its adjacent document-list block", () => {
  const description = htmlToText(
    "<p>报名材料包括：</p><p>身份证、学历学位证书、法律职业资格证书等。</p>",
  );
  const parsed = extractRecruitmentConditions(notice(description));
  assert.deepEqual(
    parsed.conditions.filter((c) => c.type === "certificate"),
    [],
  );
  assert.notEqual(
    evaluateEvidenceQualification({
      profileSnapshot: {
        certificates: [],
        explicitFacts: { certificates: true },
      },
      ...parsed,
      now,
    }).status,
    "fail",
  );
});

test("a new qualification section stops preceding materials-heading suppression", () => {
  for (const heading of ["岗位要求", "任职资格"]) {
    const description = htmlToText(
      `<p>报名材料包括：</p><p>${heading}：法律职业资格证书。</p>`,
    );
    const parsed = extractRecruitmentConditions(notice(description));
    assert.ok(
      parsed.conditions.some((c) => c.type === "certificate" && c.required),
    );
  }
});

test("a block-separated materials heading preserves explicit certificate holding or acquisition", () => {
  for (const action of ["须持有", "须取得"]) {
    const description = htmlToText(
      `<p>报名材料包括：</p><p>身份证、${action}法律职业资格证书的证明等。</p>`,
    );
    const parsed = extractRecruitmentConditions(notice(description));
    assert.equal(
      evaluateEvidenceQualification({
        profileSnapshot: {
          certificates: [],
          explicitFacts: { certificates: true },
        },
        ...parsed,
        now,
      }).status,
      "fail",
    );
  }
});

test("a materials heading cannot suppress qualifications across a completed unrelated block", () => {
  const description = htmlToText(
    "<p>报名材料包括：</p><p>身份证和简历。</p><p>法务人员法律职业资格证书。</p>",
  );
  assert.ok(
    extractRecruitmentConditions(notice(description)).conditions.some(
      (c) => c.type === "certificate" && c.required,
    ),
  );
});

test("actual certificate holding and acquisition requirements survive a materials context", () => {
  for (const description of [
    "报名材料包括身份证、须持有法律职业资格证书的证明等。",
    "应聘人员投递的材料包括身份证、须取得法律职业资格证书的证明等。",
    "报名材料包括身份证、须持有注册消防工程师、注册安全工程师证书的证明等。",
  ]) {
    const parsed = extractRecruitmentConditions(notice(description));
    assert.ok(
      parsed.conditions.some((c) => c.type === "certificate" && c.required),
    );
    assert.equal(
      evaluateEvidenceQualification({
        profileSnapshot: {
          certificates: [],
          explicitFacts: { certificates: true },
        },
        ...parsed,
        now,
      }).status,
      "fail",
    );
  }
});

test("materials cannot transfer a requirement from one named certificate to unrelated document items", () => {
  const parsed = extractRecruitmentConditions(
    notice(
      "报名材料包括须持有注册消防工程师证书、身份证、法律职业资格证书等。",
    ),
  );
  assert.deepEqual(
    parsed.conditions
      .filter((c) => c.type === "certificate")
      .map((c) => c.values),
    [["注册消防工程师"]],
  );
});

test("certificate preferences remain preferences outside a generic document list", () => {
  const parsed = extractRecruitmentConditions(
    notice("法律职业资格证书者优先。"),
  );
  assert.equal(parsed.conditions[0].preferred, true);
  assert.equal(parsed.conditions[0].required, false);
});

test("old derived document-list conditions are rebuilt while manual and structured constraints remain", () => {
  const preserved = [
    {
      type: "certificate",
      origin: "manual",
      required: true,
      values: ["注册安全工程师"],
      evidenceRefs: ["manual"],
    },
    {
      type: "certificate",
      origin: "structured_source",
      required: true,
      values: ["注册消防工程师"],
      evidenceRefs: ["structured"],
    },
  ];
  const record = notice(genericMaterials, {
    conditionsParserVersion: "conditions-3",
    conditions: [
      ...preserved,
      {
        type: "certificate",
        origin: "local_parser",
        conditionsParserVersion: "conditions-3",
        required: true,
        values: ["法律职业资格"],
        evidenceRefs: ["old-local"],
      },
    ],
    sourceEvidence: [
      {
        evidenceId: "manual",
        origin: "manual",
        field: "certificate",
        status: "verified",
        sourceExcerpt: "人工核验须持有注册安全工程师证书",
      },
      {
        evidenceId: "structured",
        origin: "structured_source",
        field: "certificate",
        status: "verified",
        sourceExcerpt: "来源结构化资格",
      },
      {
        evidenceId: "old-local",
        origin: "local_parser",
        field: "certificate",
        status: "verified",
        sourceExcerpt: "法律职业资格证书",
      },
    ],
  });
  const prepared = prepareRecruitmentRecord(record, now);
  assert.deepEqual(prepared.conditions, preserved);
  assert.deepEqual(
    prepared.sourceEvidence.map((e) => e.evidenceId),
    ["manual", "structured"],
  );
  assert.equal(prepared.conditionsParserVersion, "conditions-4");
});

test("known file application candidates are cleared only on the prepared clone and preserve attachments", () => {
  const applyUrl = "https://jobs.example.org/register.DOCX?download=1#form";
  const record = notice("合成完整公开公告", {
    applyUrl,
    attachments: [
      { url: applyUrl, title: "报名登记表", textStatus: "not_extracted" },
    ],
    applicationVerification: {
      status: 200,
      formVerified: true,
      checkedAt: "2026-10-10T00:00:00Z",
    },
    sourceEvidence: [
      {
        evidenceId: "candidate",
        field: "applyUrl",
        value: applyUrl,
        sourceKind: "public_anchor",
      },
      {
        evidenceId: "manual",
        field: "applyUrl",
        value: applyUrl,
        sourceKind: "public_anchor",
        origin: "manual",
      },
      {
        evidenceId: "structured",
        field: "applyUrl",
        value: applyUrl,
        origin: "structured_source",
      },
    ],
  });
  const before = structuredClone(record),
    prepared = prepareRecruitmentRecord(record, now);
  assert.equal(prepared.applyUrl, null);
  assert.equal(prepared.applicationVerification, undefined);
  assert.deepEqual(prepared.attachments, before.attachments);
  assert.deepEqual(
    prepared.sourceEvidence.map((e) => e.evidenceId),
    ["manual", "structured"],
  );
  assert.equal(prepareApplicationCheck(record, now).shouldRequest, false);
  assert.deepEqual(record, before);
});

test("webpage application parameters that mention files stay valid candidates", () => {
  const applyUrl = "https://jobs.example.org/apply?attachment=register.docx";
  const record = notice("合成完整公开公告", {
    applyUrl,
    attachments: [{ url: "https://jobs.example.org/register.docx" }],
  });
  assert.equal(prepareRecruitmentRecord(record, now).applyUrl, applyUrl);
  assert.equal(prepareApplicationCheck(record, now).shouldRequest, true);
});

test("parser version four makes old version-three caches and matching evaluations stale", () => {
  assert.equal(CONDITIONS_PARSER_VERSION, "conditions-4");
  const input = {
    jdHash: "same-fact",
    profileRevisionId: "p",
    targetRevisionId: "t",
    promptVersion: "matching",
    ruleVersion: RULE_VERSION,
    modelFingerprint: "rules",
  };
  assert.notEqual(
    evaluationCacheKey(input),
    evaluationCacheKey({ ...input, conditionsParserVersion: "conditions-3" }),
  );
  const record = notice(genericMaterials),
    factContentHash = jobFactHash(record);
  const old = {
    evaluationId: "old",
    jobId: "j",
    targetRevisionId: "t",
    profileRevisionId: "p",
    observationId: "o",
    factContentHash,
    conditionsParserVersion: "conditions-3",
    ruleVersion: RULE_VERSION,
  };
  const workspace = {
    jobs: { j: { jobId: "j", canonical: record } },
    observations: {
      o: {
        observationId: "o",
        jobId: "j",
        targetRevisionId: "t",
        fields: record,
      },
    },
    evaluations: { old },
    runs: {},
  };
  const selection = {
    jobId: "j",
    targetRevisionId: "t",
    profileRevisionId: "p",
    factContentHash,
  };
  assert.equal(selectMatchingEvaluation(workspace, selection), null);
  workspace.evaluations.current = {
    ...old,
    evaluationId: "current",
    conditionsParserVersion: CONDITIONS_PARSER_VERSION,
  };
  assert.equal(
    selectMatchingEvaluation(workspace, selection).evaluationId,
    "current",
  );
});
