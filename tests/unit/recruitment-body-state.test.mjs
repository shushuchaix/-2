import test from "node:test";
import assert from "node:assert/strict";
import {
  assessRecruitmentEvidence,
  isVerifiedRecommendation,
} from "../../src/domain/recruitment-evidence.mjs";

const complete = {
  title: "消防工程师",
  description:
    "消防工程师负责消防设备巡检、定期维护和隐患排查，要求本科及以上学历。",
  detailStatus: "complete",
  bodyStatus: "complete",
  deadlineAt: "2030-01-01",
  applyUrl: "https://jobs.example.org/apply",
  applicationVerification: {
    status: 200,
    formVerified: true,
    checkedAt: "2026-10-10T00:00:00Z",
  },
};
const now = Date.parse("2026-10-10T01:00:00Z");

test("an explicit incomplete body overrides conflicting complete detail evidence", () => {
  for (const bodyStatus of [
    "incomplete",
    "pending",
    "restricted",
    "login_required",
    "challenge_required",
  ]) {
    const record = { ...complete, bodyStatus };
    const evidence = assessRecruitmentEvidence({ record, now });
    assert.equal(evidence.bodyVerified, false, bodyStatus);
    assert.equal(
      isVerifiedRecommendation({ evidence, qualification: { status: "pass" } }),
      false,
      bodyStatus,
    );
  }
});

test("an explicitly failed detail cannot be rescued by a stale complete body marker", () => {
  for (const detailStatus of [
    "incomplete",
    "unavailable",
    "discovery_only",
    "pending",
    "restricted",
  ]) {
    const evidence = assessRecruitmentEvidence({
      record: { ...complete, detailStatus },
      now,
    });
    assert.equal(evidence.bodyVerified, false, detailStatus);
  }
});

test("a complete response or verified API body still satisfies the body gate", () => {
  const evidence = assessRecruitmentEvidence({ record: complete, now });
  assert.equal(evidence.bodyVerified, true);
  assert.equal(
    isVerifiedRecommendation({ evidence, qualification: { status: "pass" } }),
    true,
  );
  const api = {
    ...complete,
    detailStatus: undefined,
    bodyStatus: undefined,
    sourceEvidence: [
      {
        field: "description",
        status: "verified",
        sourceExcerpt: complete.description,
        confidence: 100,
      },
    ],
  };
  assert.equal(
    assessRecruitmentEvidence({ record: api, now }).bodyVerified,
    true,
  );
});

test("known truncated legacy university facts require fresh body evidence", () => {
  for (const limit of [3000, 4000]) {
    const record = {
      ...complete,
      sourceId: "university",
      parserVersion: "legacy-adapter-2",
      description: "招".repeat(limit) + "…",
    };
    assert.equal(
      assessRecruitmentEvidence({ record, now }).bodyVerified,
      false,
    );
  }
  const record = {
    ...complete,
    sourceId: "university",
    parserVersion: "legacy-adapter-3",
    description: "招".repeat(4000) + "…",
  };
  assert.equal(assessRecruitmentEvidence({ record, now }).bodyVerified, true);
});

test("legacy university table jobs cannot hide a truncated common body between title and position", () => {
  const record = {
    ...complete,
    sourceId: "university",
    parserVersion: "legacy-adapter-2",
    extra: { kind: "招聘公告-职位表" },
    description:
      "合成企业招聘公告\n" + "招".repeat(4000) + "…\n消防工程师岗位条件。",
  };
  const evidence = assessRecruitmentEvidence({ record, now });
  assert.equal(evidence.bodyVerified, false);
  assert.equal(
    isVerifiedRecommendation({ evidence, qualification: { status: "pass" } }),
    false,
  );
  assert.equal(
    assessRecruitmentEvidence({
      record: { ...record, parserVersion: "legacy-adapter-3" },
      now,
    }).bodyVerified,
    true,
  );
});

for (const sourceId of ["zhaopin", "shixiseng", "jiuyeqiao"]) {
  test(`persisted ${sourceId} fallback bodies require a current scoped parser`, () => {
    for (const parserVersion of ["legacy-adapter-1", "legacy-adapter-2"]) {
      const evidence = assessRecruitmentEvidence({
        record: { ...complete, sourceId, parserVersion },
        now,
      });
      assert.equal(evidence.bodyVerified, false, parserVersion);
      assert.equal(
        isVerifiedRecommendation({
          evidence,
          qualification: { status: "pass" },
        }),
        false,
      );
    }
    for (const parserVersion of ["legacy-adapter-3", "manual-verification-1"]) {
      assert.equal(
        assessRecruitmentEvidence({
          record: { ...complete, sourceId, parserVersion },
          now,
        }).bodyVerified,
        true,
      );
    }
  });
}

test("persisted PDF extraction without image coverage cannot keep a verified body", () => {
  const attachment = {
    url: "https://jobs.example.org/requirements.pdf",
    textStatus: "extracted",
    extraction: {
      format: "pdf",
      status: "extracted",
      parserVersion: "recruitment-attachments-1",
      blocks: [{ text: complete.description, confidence: 100 }],
    },
  };
  const old = assessRecruitmentEvidence({
    record: { ...complete, attachments: [attachment] },
    now,
  });
  assert.equal(old.bodyVerified, false);
  assert.equal(
    isVerifiedRecommendation({
      evidence: old,
      qualification: { status: "pass" },
    }),
    false,
  );
  for (const extraction of [
    { ...attachment.extraction, parserVersion: "recruitment-attachments-2" },
    { ...attachment.extraction, format: "xlsx" },
  ]) {
    assert.equal(
      assessRecruitmentEvidence({
        record: {
          ...complete,
          attachments: [{ ...attachment, extraction }],
        },
        now,
      }).bodyVerified,
      true,
    );
  }
});
