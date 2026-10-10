import test from "node:test";
import assert from "node:assert/strict";
import {
  extractRecruitmentConditions,
  prepareRecruitmentRecord,
  CONDITIONS_PARSER_VERSION,
} from "../../src/domain/recruitment-evidence.mjs";

test("professional requirement labels consume punctuation before extracting literal values", () => {
  for (const label of [
    "专业要求：",
    "专业要求:",
    "要求专业：",
    "专业：",
    "限定专业：",
    "专业要求 ",
  ]) {
    const description = label + "消防工程或安全工程专业。";
    const result = extractRecruitmentConditions({
      sourceId: "synthetic",
      description,
    });
    const condition = result.conditions.find((c) => c.type === "major");
    assert.deepEqual(condition.values, ["消防工程", "安全工程"], label);
    assert.ok(
      result.sourceEvidence.some(
        (e) => e.sourceExcerpt === description.slice(0, -1),
      ),
    );
  }
});

test("old local major conditions are reparsed without keeping a punctuation-prefixed value", () => {
  const result = prepareRecruitmentRecord({
    sourceId: "synthetic",
    title: "消防工程师",
    description: "专业要求：消防工程。",
    conditions: [
      {
        type: "major",
        values: ["：消防工程"],
        origin: "local_parser",
        conditionsParserVersion: "conditions-2",
      },
    ],
  });
  assert.deepEqual(
    result.conditions.filter((c) => c.type === "major").map((c) => c.values),
    [["消防工程"]],
  );
  assert.notEqual(CONDITIONS_PARSER_VERSION, "conditions-2");
});
