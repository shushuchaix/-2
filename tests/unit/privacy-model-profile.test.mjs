import test from "node:test";
import assert from "node:assert/strict";
import { evaluationPrompt } from "../../src/llm/prompts.mjs";
import { expandArticles } from "../../src/match/article.mjs";

const sentProfile = (profile) =>
  JSON.parse(evaluationPrompt(profile, []).user).profile;

test("model matching excludes identity and arbitrary resume fields", () => {
  const payload = sentProfile({
    name: "合成候选甲丁",
    school: "合成航空学院",
    phone: "13812345678",
    email: "person@example.com",
    address: "合成私人住址",
    text: "合成完整简历正文",
    internships: [{ company: "合成航空有限公司", role: "消防实习" }],
    projects: [{ name: "合成私人项目名称", highlights: "私人经历" }],
    summary: "包含个人经历的自由摘要",
    customPrivateValue: "不认识的私人字段",
    apiKey: "synthetic-secret",
    education: "本科",
    major: "消防工程",
    graduationYear: 2027,
    targetRoles: ["机场消防"],
    skills: ["火灾风险评估"],
    certificates: ["大学英语四级"],
  });
  assert.deepEqual(payload, {
    education: "本科",
    major: "消防工程",
    graduationYear: 2027,
    targetRoles: ["机场消防"],
    skills: ["火灾风险评估"],
    certificates: ["大学英语四级"],
  });
});

test("professional skill and certificate objects cannot forward private fields", () => {
  const payload = sentProfile({
    degree: "本科",
    experienceYears: 2,
    skills: [
      { name: "消防设施检查", level: "熟悉", email: "private@example.com" },
      { name: "Python", proficiency: "基础", privateNote: "私人备注" },
    ],
    certificates: [
      { name: "消防设施操作员", issuer: "合成私人单位", number: "私证123" },
    ],
  });
  assert.deepEqual(payload, {
    degree: "本科",
    experienceYears: 2,
    skills: [
      { name: "消防设施检查", level: "熟悉" },
      { name: "Python", proficiency: "基础" },
    ],
    certificates: [{ name: "消防设施操作员" }],
  });
});

test("known identity values inside allowed fields are withheld without changing clean facts", () => {
  const payload = sentProfile({
    name: "合成候选甲丁",
    school: "合成航空学院",
    contact: { wechat: "synthetic-private-chat" },
    internships: [{ company: "合成航空有限公司" }],
    major: "消防工程 合成候选甲丁",
    targetRoles: ["机场消防", "合成航空学院消防实习"],
    skills: [
      "合成航空有限公司安全检查",
      "防排烟设计",
      "synthetic-private-chat",
    ],
    certificates: ["合成候选甲丁的资格证", "大学英语四级"],
  });
  assert.deepEqual(payload, {
    targetRoles: ["机场消防"],
    skills: ["防排烟设计"],
    certificates: ["大学英语四级"],
  });
});

test("generic contact and identity patterns inside professional values are withheld", () => {
  const payload = sentProfile({
    skills: [
      "火灾风险评估",
      "电话：+86 138-1234-5678",
      "邮箱：someone@example.org",
      "身份证 110101199001011234",
      "微信：synthetic-contact",
      "学号：synthetic-student",
      "地址：合成住址",
    ],
    certificates: ["大学英语四级", "证书联系 foo\u200b@example.com"],
  });
  assert.deepEqual(payload, {
    skills: ["火灾风险评估"],
    certificates: ["大学英语四级"],
  });
});

test("identity comparison catches changed case and inserted whitespace", () => {
  const payload = sentProfile({
    name: "Synthetic Person",
    school: "合成航空学院",
    skills: ["消防检查", "SYNTHETIC PERSON 的经历", "合 成 航 空 学 院 的经历"],
  });
  assert.deepEqual(payload, { skills: ["消防检查"] });
});

test("missing facts remain missing and input profile is not mutated", () => {
  const profile = {
    name: "合成候选甲丁",
    education: null,
    major: "",
    graduationYear: "未知",
    experienceYears: "5",
    skills: [{ name: "消防设计", level: "合成候选甲丁的评价" }],
  };
  const before = structuredClone(profile);
  const payload = sentProfile(profile);
  assert.deepEqual(profile, before);
  assert.deepEqual(payload, { skills: [{ name: "消防设计" }] });
  assert.deepEqual(sentProfile(null), {});
});

test("public announcement extraction does not transmit the candidate profile", async () => {
  let userPayload;
  const article = {
    url: "https://example.com/notice/fire",
    sourceId: "official-announcements",
    siteId: "synthetic-airport",
    sourceRecordId: "notice-1",
    identityScope: "synthetic-airport",
    title: "机场消防招聘",
    description: "机场消防员要求本科，专业为消防工程。".repeat(10),
    extra: { account: "公开招聘账号" },
  };
  const result = await expandArticles(
    {
      chatJson: async (_system, user) => {
        userPayload = user;
        return {
          isRecruiting: true,
          positions: [
            {
              title: "机场消防员",
              requirementsExcerpt: "要求本科，专业为消防工程。",
            },
          ],
        };
      },
    },
    {
      name: "合成候选甲丁",
      major: "合成私人专业备注",
      targetRoles: ["机场岗位 合成候选甲丁"],
      keywords: ["synthetic-private-contact"],
    },
    [article],
  );
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].description, "要求本科，专业为消防工程。");
  assert.ok(userPayload.includes(article.description));
  for (const privateValue of [
    "合成候选甲丁",
    "合成私人专业备注",
    "synthetic-private-contact",
  ])
    assert.equal(userPayload.includes(privateValue), false);
});
