import test from "node:test";
import assert from "node:assert/strict";
import { validateModelResults } from "../../src/llm/validation.mjs";
import { expandArticles } from "../../src/match/article.mjs";
import { assessRecruitmentEvidence } from "../../src/domain/recruitment-evidence.mjs";

const extract = (description, positions, other = {}) =>
  expandArticles(
    { chatJson: async () => ({ isRecruiting: true, positions, ...other }) },
    {},
    [
      {
        sourceId: "wechat",
        siteId: "wechat",
        sourceRecordId: "review",
        title: "招聘",
        url: "https://mp.weixin.qq.com/s/review",
        description,
        bodyStatus: "complete",
      },
    ],
  );
test("review: another position row cannot become verified requirements", async () => {
  const text =
    "发布日期：2026-10-09。账号所在地：北京。\n消防设计师：本科，必须持有注册消防工程师证书。\n安全助理：大专，经验不限。";
  const r = await extract(
    text,
    [
      {
        title: "消防设计师",
        city: "北京",
        education: "大专",
        requirementsExcerpt: "安全助理：大专，经验不限。",
      },
    ],
    { deadline: "2026-10-09" },
  );
  assert.equal(r.jobs.length, 0);
});
test("review: metadata city and publish date are not work city or deadline", async () => {
  const text =
    "发布日期：2026-10-09。账号所在地：北京。\n消防设计师：本科，必须持有注册消防工程师证书。";
  const r = await extract(
    text,
    [
      {
        title: "消防设计师",
        city: "北京",
        education: "本科",
        requirementsExcerpt: "本科，必须持有注册消防工程师证书。",
      },
    ],
    { deadline: "2026-10-09" },
  );
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].city, "");
  assert.equal(r.jobs[0].deadlineAt, null);
  const good = await extract(
    "报名截止：2026-10-20\n消防设计师：本科。工作地点：广州。",
    [
      {
        title: "消防设计师",
        city: "广州",
        education: "本科",
        requirementsExcerpt: "本科。工作地点：广州。",
      },
    ],
    { deadline: "2026-10-20" },
  );
  assert.equal(good.jobs[0].city, "广州");
  assert.equal(good.jobs[0].deadlineAt, "2026-10-20");
});
test("review: legacy announcement extraction requires fresh scoped evidence", () => {
  const e = assessRecruitmentEvidence({
    record: {
      parserVersion: "article-literal-2",
      derivedFrom: "article",
      bodyStatus: "complete",
      description: "unsafe legacy excerpt",
      openingStatus: "open",
      applicationStatus: "available",
    },
    now: Date.now(),
  });
  assert.equal(e.bodyVerified, false);
});
test("review: same title with different verified rows is preserved for conservative dedup", async () => {
  const r = await extract(
    "消防工程师：本科，消防工程专业。\n消防工程师：硕士，安全工程专业。",
    [
      {
        title: "消防工程师",
        education: "本科",
        requirementsExcerpt: "消防工程师：本科，消防工程专业。",
      },
      {
        title: "消防工程师",
        education: "硕士",
        requirementsExcerpt: "消防工程师：硕士，安全工程专业。",
      },
    ],
  );
  assert.equal(r.jobs.length, 2);
  assert.notEqual(r.jobs[0].sourceRecordId, r.jobs[1].sourceRecordId);
});
test("review: another row deadline cannot become a common deadline", async () => {
  const r = await extract(
    "消防设计师：本科，消防工程专业。\n安全助理：大专。报名截止：2026-10-20。",
    [
      {
        title: "消防设计师",
        requirementsExcerpt: "消防设计师：本科，消防工程专业。",
      },
    ],
    { deadline: "2026-10-20" },
  );
  assert.equal(r.jobs[0].deadlineAt, null);
});
test("announcement extraction no longer drops positions after eight", async () => {
  const titles = Array.from({ length: 12 }, (_, i) => "消防岗位" + i),
    description = titles.map((t) => t + "：本科要求。").join("\n");
  const result = await expandArticles(
    {
      chatJson: async () => ({
        isRecruiting: true,
        positions: titles.map((title) => ({
          title,
          requirementsExcerpt: title + "：本科要求。",
        })),
      }),
    },
    {},
    [
      {
        sourceId: "wechat",
        siteId: "wechat",
        sourceRecordId: "many",
        title: "单位招聘公告",
        url: "https://mp.weixin.qq.com/s/many",
        description,
      },
    ],
  );
  assert.equal(result.jobs.length, 12);
});

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
