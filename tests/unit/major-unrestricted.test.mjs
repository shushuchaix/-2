import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEvidenceQualification } from "../../src/domain/qualification.mjs";
import { evaluateRules, RULE_VERSION } from "../../src/domain/ranking.mjs";
import {
  CONDITIONS_PARSER_VERSION,
  prepareRecruitmentRecord,
} from "../../src/domain/recruitment-evidence.mjs";
import {
  jobFactHash,
  selectMatchingEvaluation,
} from "../../src/domain/job-facts.mjs";
import { evaluationCacheKey } from "../../src/llm/validation.mjs";
import { PROMPT_VERSION, SCHEMA_VERSION } from "../../src/llm/prompts.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { createJobService } from "../../src/application/job-service.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { tempRepository } from "../helpers/repository.mjs";
import {
  job,
  profile,
  target,
  namedTargetInput,
} from "../helpers/fixtures.mjs";

const now = Date.parse("2026-10-12T00:00:00Z");
const oldRuleVersion = "rules-2.1.0-conditions";
const unrestrictedValues = ["不限", "不限专业", "专业不限", "无专业限制"];
const description = [
  "消防中控员，负责值班巡查、记录设施运行情况并及时报告异常。",
  "学历要求：大专及以上学历。",
  "需求专业：不限专业，计算机、机电类等优先。",
].join("\n");
const syntheticJob = (overrides = {}) =>
  job({
    title: "消防中控员",
    description,
    degree: "大专",
    graduationYear: null,
    jobType: "social",
    bodyStatus: "complete",
    detailStatus: "complete",
    ...overrides,
  });

function majorCheck(values, ownMajor, { condition = {}, evidence = {} } = {}) {
  return evaluateEvidenceQualification({
    profileSnapshot: ownMajor === undefined ? {} : { major: ownMajor },
    conditions: [
      {
        type: "major",
        operator: "any",
        values,
        required: true,
        evidenceRefs: ["major-evidence"],
        ...condition,
      },
    ],
    sourceEvidence: [
      {
        evidenceId: "major-evidence",
        status: "verified",
        confidence: 100,
        sourceExcerpt: "专业要求：" + values.join("、"),
        ...evidence,
      },
    ],
    now,
  });
}

for (const facts of [
  { education: "大专", major: "计算机" },
  { education: "本科", major: "美术" },
]) {
  test(`prepared unrestricted major does not reject synthetic ${facts.education}/${facts.major}`, () => {
    const prepared = prepareRecruitmentRecord(syntheticJob(), now);
    const major = prepared.conditions.find((c) => c.type === "major");
    assert.deepEqual(major.values, ["不限"]);
    assert.equal(major.required, true);
    assert.ok(
      major.evidenceRefs.every((id) =>
        prepared.sourceEvidence.some(
          (e) => e.evidenceId === id && e.status === "verified",
        ),
      ),
    );
    const evaluation = evaluateRules(prepared, profile(facts), {}, { now });
    assert.equal(
      evaluation.qualification.checks.find((c) => c.type === "major").status,
      "pass",
    );
    assert.equal(evaluation.qualification.status, "pass");
    assert.equal(evaluation.recommendation, "insufficient");
    assert.equal(evaluation.recruitmentEvidence.openingStatus, "unknown");
    assert.equal(evaluation.recruitmentEvidence.applicationStatus, "unknown");
    assert.equal(evaluation.recommended, false);
  });
}

for (const value of unrestrictedValues) {
  test(`supported single major value ${value} permits unrelated or missing profile major`, () => {
    for (const ownMajor of ["美术", undefined]) {
      const result = majorCheck([value], ownMajor);
      assert.equal(result.status, "pass");
      assert.equal(result.checks[0].status, "pass");
      assert.equal(result.checks[0].required, true);
    }
  });
}

for (const values of [
  ["计算机"],
  ["不限", "计算机"],
  ["不限专业", "计算机"],
  ["不限", "专业不限"],
  ["不限于计算机"],
  ["专业不限于计算机"],
  ["无专业限制（部分岗位除外）"],
  [" 不限 "],
]) {
  test(`major values ${JSON.stringify(values)} do not bypass strict comparison`, () => {
    assert.equal(majorCheck(values, "美术").status, "fail");
    assert.equal(majorCheck(values, undefined).status, "unknown");
  });
}

test("named major values retain exact matching, including mixed unrestricted labels", () => {
  assert.equal(majorCheck(["计算机"], "计算机").status, "pass");
  assert.equal(majorCheck(["计算机"], "计算机科学与技术").status, "fail");
  assert.equal(majorCheck(["不限", "计算机"], "计算机").status, "pass");
});

test("unrestricted labels with unknown, ambiguous, missing or out-of-scope evidence stay unknown", () => {
  for (const overrides of [
    { evidence: { status: "unknown" } },
    { evidence: { ambiguous: true } },
    { evidence: { confidence: 84 } },
    { evidence: { sourceExcerpt: "" } },
    { condition: { evidenceRefs: [] } },
    { condition: { migrationStatus: "needs_review" } },
    {
      condition: { jobRowId: "first" },
      evidence: { appliesTo: { jobRowId: "other" } },
    },
  ]) {
    for (const ownMajor of ["美术", undefined])
      assert.equal(majorCheck(["不限"], ownMajor, overrides).status, "unknown");
  }
});

test("unrestricted majors preserve hard degree and confirmed certificate failures", () => {
  for (const [record, facts, failureType] of [
    [
      syntheticJob({
        degree: "本科",
        description: description.replace("大专", "本科"),
      }),
      { education: "大专", major: "计算机" },
      "degree",
    ],
    [
      syntheticJob({
        description: description + "\n须持有注册消防工程师证书。",
      }),
      {
        education: "本科",
        major: "美术",
        explicitFacts: { certificates: true },
      },
      "certificate",
    ],
  ]) {
    const result = evaluateRules(
      prepareRecruitmentRecord(record, now),
      profile(facts),
      {},
      { now },
    );
    assert.equal(
      result.qualification.checks.find((c) => c.type === "major").status,
      "pass",
    );
    assert.equal(
      result.qualification.checks.find((c) => c.type === failureType).status,
      "fail",
    );
    assert.equal(result.qualification.status, "fail");
    assert.equal(result.recommendation, "not_recommended");
  }
});

test("the prior major rule version cannot match current facts or cache keys", () => {
  const record = prepareRecruitmentRecord(syntheticJob(), now);
  const factContentHash = jobFactHash(record);
  const old = {
    evaluationId: "old-false-fail",
    jobId: "j",
    targetRevisionId: "t",
    profileRevisionId: "p",
    observationId: "o",
    factContentHash,
    conditionsParserVersion: CONDITIONS_PARSER_VERSION,
    ruleVersion: oldRuleVersion,
    qualification: { status: "fail" },
    recommendation: "not_recommended",
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
  const input = {
    jdHash: factContentHash,
    profileRevisionId: "p",
    targetRevisionId: "t",
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    modelFingerprint: "rules",
  };
  assert.notEqual(
    evaluationCacheKey({ ...input, ruleVersion: oldRuleVersion }),
    evaluationCacheKey({ ...input, ruleVersion: RULE_VERSION }),
  );
  assert.equal(RULE_VERSION, "rules-2.1.1-major-unrestricted");
  workspace.evaluations.current = {
    ...old,
    evaluationId: "current",
    ruleVersion: RULE_VERSION,
  };
  assert.equal(
    selectMatchingEvaluation(workspace, selection).evaluationId,
    "current",
  );
});

test("evaluation service recomputes a prior false-fail cache and reuses the new result", async (t) => {
  const repository = await tempRepository(t);
  const workspaceService = createWorkspaceService({ repository });
  const jobs = createJobService({ repository });
  const cache = new Map();
  const service = createEvaluationService({ repository, cache });
  const savedProfile = await workspaceService.saveProfile({
    profile: profile({ education: "本科", major: "美术" }),
  });
  const savedTarget = await workspaceService.saveTarget(
    namedTargetInput({
      ...target(),
      profileRevisionId: savedProfile.revisionId,
      jobTypes: ["social"],
    }),
  );
  const {
    jobIds: [jobId],
  } = await jobs.ingestRecords({
    targetRevisionId: savedTarget.revisionId,
    runId: "synthetic-major-cache",
    records: [prepareRecruitmentRecord(syntheticJob(), now)],
  });
  const input = {
    jobIds: [jobId],
    profileRevisionId: savedProfile.revisionId,
    targetRevisionId: savedTarget.revisionId,
    mode: "rules",
  };
  const first = (await service.evaluate(input)).evaluations[0];
  const oldCacheKey = evaluationCacheKey({
    jdHash: first.factContentHash,
    profileRevisionId: savedProfile.revisionId,
    targetRevisionId: savedTarget.revisionId,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    ruleVersion: oldRuleVersion,
    modelFingerprint: "rules",
  });
  const old = {
    ...first,
    cacheKey: oldCacheKey,
    ruleVersion: oldRuleVersion,
    qualification: {
      ...first.qualification,
      status: "fail",
      checks: first.qualification.checks.map((c) =>
        c.type === "major" ? { ...c, status: "fail" } : c,
      ),
    },
    recommendation: "not_recommended",
    recommended: false,
  };
  await repository.mutateWorkspace((w) => {
    w.evaluations[first.evaluationId] = old;
  });
  cache.clear();
  cache.set(oldCacheKey, old);
  const fresh = (await service.evaluate(input)).evaluations[0];
  assert.notEqual(fresh.evaluationId, first.evaluationId);
  assert.equal(fresh.ruleVersion, RULE_VERSION);
  assert.equal(fresh.qualification.status, "pass");
  assert.equal(fresh.recommendation, "insufficient");
  assert.equal(
    (await service.evaluate(input)).evaluations[0].evaluationId,
    fresh.evaluationId,
  );
  assert.equal(Object.keys((await repository.read()).evaluations).length, 2);
});
