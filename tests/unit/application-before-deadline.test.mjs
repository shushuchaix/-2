import test from "node:test";
import assert from "node:assert/strict";
import {
  CONDITIONS_PARSER_VERSION,
  prepareApplicationCheck,
  prepareRecruitmentRecord,
} from "../../src/domain/recruitment-evidence.mjs";
import {
  jobFactHash,
  selectMatchingEvaluation,
} from "../../src/domain/job-facts.mjs";
import { evaluationCacheKey } from "../../src/llm/validation.mjs";
import { RULE_VERSION } from "../../src/domain/ranking-policy.mjs";
import { job } from "../helpers/fixtures.mjs";

const now = Date.parse("2026-10-12T00:00:00Z");
const notice = (description, extra = {}) =>
  job({
    title: "合成消防岗位招聘",
    description,
    detailStatus: "complete",
    bodyStatus: "complete",
    applyUrl: "https://jobs.example.org/apply",
    ...extra,
  });

// Reduced public wording; no applicant information or real resume is used.
test("an explicit applicant action before midnight expires before checking application HTTP", () => {
  const record = notice("应聘人员于北京时间2026年8月9日24时前填写并投递简历。");
  const before = structuredClone(record);
  const prepared = prepareRecruitmentRecord(record, now);
  assert.equal(prepared.deadlineAt, "2026-08-09T16:00:00.000Z");
  assert.equal(prepared.recruitmentEvidence.openingStatus, "expired");
  assert.equal(prepareApplicationCheck(record, now).shouldRequest, false);
  assert.deepEqual(record, before);
});

for (const [label, description, expected] of [
  [
    "a future midnight action",
    "应聘人员于北京时间2026年12月9日24时前填写并投递简历。",
    "2026-12-09T16:00:00.000Z",
  ],
  [
    "a colon midnight clock",
    "应聘人员于2026年12月9日24:00前投递简历。",
    "2026-12-09T16:00:00.000Z",
  ],
  [
    "a specific clock",
    "报名人员须在2026年12月9日17:30前提交报名材料。",
    "2026-12-09T09:30:00.000Z",
  ],
  [
    "an hour-only clock",
    "应聘者请于2026年12月9日17时前提交应聘材料。",
    "2026-12-09T09:00:00.000Z",
  ],
  [
    "a day without clock",
    "应聘人员于2026年12月9日前投递简历。",
    "2026-12-09T15:59:59.999Z",
  ],
  [
    "a midnight month boundary",
    "应聘人员于2026年12月31日24时前填写并投递简历。",
    "2026-12-31T16:00:00.000Z",
  ],
  [
    "a valid leap-day midnight",
    "应聘人员于2028年2月29日24时前投递简历。",
    "2028-02-29T16:00:00.000Z",
  ],
  [
    "an existing explicit cutoff at midnight",
    "报名截止时间：2026年12月9日24:00。",
    "2026-12-09T16:00:00.000Z",
  ],
]) {
  test(`an explicit before-date application retains ${label}`, () => {
    const record = notice(description);
    const prepared = prepareRecruitmentRecord(record, now);
    assert.equal(prepared.deadlineAt, expected);
    assert.equal(prepared.recruitmentEvidence.openingStatus, "open");
    assert.equal(prepareApplicationCheck(record, now).shouldRequest, true);
    assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
  });
}

for (const [label, description] of [
  ["publication", "招聘公告于北京时间2026年8月9日24时前发布。"],
  ["a narrative date", "应聘人员于2026年8月9日填写并投递简历。"],
  ["a completed narrative", "应聘人员于2026年8月9日24时前已填写并投递简历。"],
  [
    "a historical instruction",
    "历史记录：曾要求应聘人员于2026年8月9日24时前投递简历。",
  ],
  ["a negated instruction", "不要求应聘人员于2026年8月9日24时前投递简历。"],
  [
    "a withdrawn instruction",
    "本次不再要求应聘人员于2026年12月9日24时前投递简历。",
  ],
  [
    "a cancelled requirement",
    "应聘人员于2026年12月9日24时前投递简历的要求已经取消。",
  ],
  [
    "a directly cancelled requirement",
    "现已取消应聘人员于2026年12月9日24时前投递简历的要求。",
  ],
  [
    "a directly revoked requirement",
    "现已撤销应聘人员于2026年12月9日24时前投递简历的规定。",
  ],
  [
    "a directly abolished requirement",
    "现已废止应聘人员于2026年12月9日24时前投递简历的限制。",
  ],
  [
    "a comma-linked history",
    "历史记录，要求应聘人员于2026年12月9日24时前投递简历。",
  ],
  ["training", "应聘人员于2026年8月9日24时前参加消防培训。"],
  ["training materials", "应聘人员于2026年8月9日24时前提交培训材料。"],
  ["an exempted application", "应聘人员于2026年8月9日24时前无需投递简历。"],
  ["no application action", "应聘人员于2026年8月9日24时前。报名另行通知。"],
  [
    "a different sentence action",
    "应聘人员于2026年8月9日24时前完成培训。请投递简历。",
  ],
  ["an impossible date", "应聘人员于2026年2月30日24时前投递简历。"],
  ["a non-leap day", "应聘人员于2027年2月29日24时前投递简历。"],
  ["an invalid hour", "应聘人员于2026年12月9日25时前投递简历。"],
  ["an invalid minute", "应聘人员于2026年12月9日17:60前投递简历。"],
  ["nonzero minutes at midnight", "应聘人员于2026年12月9日24:01前投递简历。"],
  ["an unsupported half-hour", "应聘人员于2026年12月9日17时半前投递简历。"],
  ["a split year", "应聘人员于202\n6年12月9日24时前投递简历。"],
]) {
  test(`${label} cannot prove an application deadline`, () => {
    const prepared = prepareRecruitmentRecord(notice(description), now);
    assert.equal(prepared.deadlineAt, null);
    assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  });
}

test("an unrelated cancelled training cannot revoke a direct application instruction", () => {
  const prepared = prepareRecruitmentRecord(
    notice("培训已经取消，应聘人员于2026年12月9日24时前投递简历。"),
    now,
  );
  assert.equal(prepared.deadlineAt, "2026-12-09T16:00:00.000Z");
  assert.equal(prepared.recruitmentEvidence.openingStatus, "open");
});

test("a visible before-date action conflicts with a different structured deadline", () => {
  const prepared = prepareRecruitmentRecord(
    notice("应聘人员于2026年12月9日24时前填写并投递简历。", {
      deadlineAt: "2026-12-20T15:59:59.999Z",
    }),
    now,
  );
  assert.equal(prepared.deadlineAt, "2026-12-20T15:59:59.999Z");
  assert.ok(
    (prepared.evidenceConflicts || []).some(
      (c) =>
        c.field === "deadlineAt" && c.code === "visible_structured_conflict",
    ),
  );
  assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  assert.equal(prepareApplicationCheck(prepared, now).shouldRequest, false);
});

test("repreparing an action deadline conflict retains its structured value without duplicate evidence", () => {
  const first = prepareRecruitmentRecord(
    notice("应聘人员于2026年12月9日24时前填写并投递简历。", {
      deadlineAt: "2026-12-20T15:59:59.999Z",
    }),
    now,
  );
  const again = prepareRecruitmentRecord(first, now);
  assert.equal(again.deadlineAt, "2026-12-20T15:59:59.999Z");
  assert.deepEqual(again.evidenceConflicts, first.evidenceConflicts);
  assert.equal(again.recruitmentEvidence.openingStatus, "unknown");
});

test("the changed deadline parser makes version-four cache keys stale", () => {
  const record = notice("应聘人员于北京时间2026年8月9日24时前填写并投递简历。");
  const factContentHash = jobFactHash(record);
  const input = {
    jdHash: factContentHash,
    profileRevisionId: "p",
    targetRevisionId: "t",
    promptVersion: "matching",
    ruleVersion: RULE_VERSION,
    modelFingerprint: "rules",
  };
  assert.notEqual(
    evaluationCacheKey(input),
    evaluationCacheKey({ ...input, conditionsParserVersion: "conditions-4" }),
  );
});

test("the changed deadline parser rejects a version-four matching evaluation", () => {
  const record = notice("应聘人员于北京时间2026年8月9日24时前填写并投递简历。");
  const factContentHash = jobFactHash(record);
  const old = {
    evaluationId: "old-unknown-deadline",
    jobId: "j",
    targetRevisionId: "t",
    profileRevisionId: "p",
    observationId: "o",
    factContentHash,
    conditionsParserVersion: "conditions-4",
    ruleVersion: RULE_VERSION,
    recruitmentEvidence: { openingStatus: "unknown" },
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
