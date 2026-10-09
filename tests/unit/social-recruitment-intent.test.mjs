import test from "node:test";
import assert from "node:assert/strict";
import { classifyRecruitmentIntent } from "../../src/sources/social-intent.mjs";
test("recruiting intent separates employers, candidates, paid training and news using literal evidence", () => {
  const cases = [
    [
      "上海机场消防公司现招聘消防工程师。招聘条件：本科，应届毕业生。岗位：消防工程师。投递简历至官网。",
      "employer_recruitment",
    ],
    [
      "本人消防工程本科，应届生，求职意向为机场消防，期待找到工作。",
      "candidate_seeking",
    ],
    ["消防工程师培训班招生，考证辅导，包就业，请缴纳报名费。", "training"],
    ["行业新闻：消防工程市场情况，记者采访了机场工作人员。", "news"],
    ["消防机场交流。", "unknown"],
    [
      "公司现招聘消防工程师，岗位：消防工程师，入职后统一岗前培训。",
      "employer_recruitment",
    ],
  ];
  for (const [text, intent] of cases) {
    const result = classifyRecruitmentIntent({ text });
    assert.equal(result.intent, intent);
    for (const e of result.evidence)
      assert.equal(text.slice(e.start, e.end), e.quote);
  }
});
