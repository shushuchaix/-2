import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRules } from "../../src/domain/ranking.mjs";
import { job, profile, target } from "../helpers/fixtures.mjs";
import { computeRankingMetrics } from "../../evals/metrics.mjs";
test("ranking separates evidence completeness hard failures and match components", () => {
  assert.equal(
    evaluateRules(job({ description: null }), profile(), target())
      .recommendation,
    "insufficient",
  );
  const fail = evaluateRules(
    job({
      degree: "博士",
      description: "必须博士学历，掌握Java，2027届毕业。",
    }),
    profile(),
    target(),
  );
  assert.equal(fail.qualification.status, "fail");
  assert.equal(fail.recommendation, "not_recommended");
  assert.ok(fail.components.skills.evidence.length);
  const security = evaluateRules(
    job({
      title: "网络安全工程师",
      description: "本科以上，负责渗透测试、网络安全、漏洞分析。",
    }),
    profile({ major: "消防工程", skills: ["消防设计"] }),
    target(),
  );
  assert.equal(security.components.major.score, 0);
  const metrics = computeRankingMetrics(
    [{ jobId: "1", relevance: 3, qualification: "pass", incomplete: false }],
    [
      {
        jobId: "1",
        score: 90,
        qualification: { status: "pass" },
        recommendation: "high",
      },
    ],
  );
  assert.equal(metrics.precisionAt10, 1);
  assert.equal(metrics.ndcgAt10, 1);
});
