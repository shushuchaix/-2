import test from "node:test";
import assert from "node:assert/strict";
import { evaluateQualification } from "../../src/domain/qualification.mjs";
import { job, profile, target } from "../helpers/fixtures.mjs";
test("eligibility preserves lower accepted degrees unknown facts and preferences", () => {
  assert.equal(
    evaluateQualification(
      job({
        degree: "大专及以上",
        description: "负责软件开发，学历要求大专及以上。",
      }),
      profile(),
      target(),
    ).status,
    "pass",
  );
  const certificate = job({
    title: "消防工程师",
    description: "须持有注册消防工程师证书，负责消防设施维护及验收。",
  });
  assert.equal(
    evaluateQualification(
      certificate,
      profile({ certificates: [], explicitFacts: {} }),
      target(),
    ).status,
    "unknown",
  );
  assert.equal(
    evaluateQualification(
      certificate,
      profile({ certificates: [], explicitFacts: { certificates: true } }),
      target(),
    ).status,
    "fail",
  );
  assert.notEqual(
    evaluateQualification(
      {
        ...certificate,
        description: "注册消防工程师证书者优先，负责消防设施维护及验收。",
      },
      profile({ explicitFacts: { certificates: true } }),
      target(),
    ).status,
    "fail",
  );
});
test("explicit year range experience and selected policy have independent evidence", () => {
  assert.equal(
    evaluateQualification(
      job({
        graduationYear: null,
        description: "招聘2026至2028届毕业生，本科以上。",
      }),
      profile(),
      target(),
    ).status,
    "pass",
  );
  assert.equal(
    evaluateQualification(
      job({
        description: "仅限2026届毕业生，本科以上。",
        graduationYear: 2026,
      }),
      profile(),
      target(),
    ).status,
    "fail",
  );
  assert.equal(
    evaluateQualification(
      job({ description: "要求3年以上工作经验，本科以上。" }),
      profile({ experienceYears: 0 }),
      target(),
    ).status,
    "fail",
  );
  assert.notEqual(
    evaluateQualification(
      job({ description: "有3年工作经验者优先，本科以上。" }),
      profile({ experienceYears: 0 }),
      target(),
    ).status,
    "fail",
  );
  assert.equal(
    evaluateQualification(
      job({ degree: "大专及以上", description: "学历要求大专及以上。" }),
      profile(),
      target({ degreePolicy: "minimum_requirement", minDegree: "本科" }),
    ).status,
    "fail",
  );
});
