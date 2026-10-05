import test from "node:test";
import assert from "node:assert/strict";
import { validateModelResults } from "../../src/llm/validation.mjs";
import { expandArticles } from "../../src/match/article.mjs";

test("an AI score without source evidence must fall back", () => {
  const result = validateModelResults(
    {
      results: [
        { jobId: "j1", score: 95, reasons: ["合适"], gaps: [], evidence: [] },
      ],
    },
    { records: [{ jobId: "j1", title: "Java开发", description: "熟悉Java" }] },
  );
  assert.equal(result.valid.length, 0);
  assert.deepEqual(result.invalidIds, ["j1"]);
});

test("announcement expansion keeps only literal facts and original provenance", async () => {
  const article = {
    sourceId: "official-announcements",
    siteId: "institute-1",
    sourceRecordId: "notice-1",
    sourceName: "研究所公告",
    identityScope: "institute-1",
    url: "https://example.com/notice/1",
    title: "招聘通知",
    description: "研发工程师：本科，熟悉Java。工作地点北京。实习岗位。".repeat(
      8,
    ),
    extra: {},
  };
  const result = await expandArticles(
    {
      chatJson: async () => ({
        company: "虚构企业",
        batch: "2027届校招",
        deadline: "2099-12-31",
        applyMethod: "虚构投递方式",
        positions: [
          {
            title: "研发工程师",
            company: "虚构企业",
            city: "上海",
            education: "博士",
            experience: "10年以上",
            jobType: "校招",
            salary: "100万元/年",
            major: "虚构专业",
            summary: "虚构摘要",
            requirementsExcerpt: "本科，熟悉Java。",
          },
        ],
      }),
    },
    {},
    [article],
  );
  assert.equal(result.jobs.length, 1);
  const job = result.jobs[0];
  assert.equal(job.company, "");
  assert.equal(job.city, "");
  assert.equal(job.education, "");
  assert.equal(job.salary, "");
  assert.equal(job.experience, "");
  assert.equal(job.jobType, "");
  assert.equal(job.extra.deadline, "");
  assert.equal(job.source, "official-announcements");
  assert.equal(job.description, "本科，熟悉Java。");
  assert.ok(job.skills.includes("Java"));
  assert.ok(job.evidence.every((e) => article.description.includes(e.excerpt)));
});
