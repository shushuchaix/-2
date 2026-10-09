import test from "node:test";
import assert from "node:assert/strict";
import {
  queueContentDraft,
  articleParts,
} from "../../src/sources/content-queue.mjs";
test("known official link remains a bounded independent evidence task and unchanged body avoids model replay", () => {
  const p = {},
    record = {
      sourceId: "wechat",
      sourceRecordId: "1",
      identityScope: "wechat",
      kind: "recruitment_notice",
      title: "公司招聘",
      url: "https://mp.weixin.qq.com/s/one",
      bodyStatus: "complete",
      description: "公司现招聘消防工程师。",
      officialLinks: [
        {
          url: "https://jobs.example.org/notice/1",
          site: {
            siteId: "official",
            providerId: "official-announcements",
            origin: "https://jobs.example.org",
            template: { bodyRule: "main" },
          },
        },
      ],
    };
  queueContentDraft(p, "unit", [record], 0);
  assert.equal(Object.keys(p.pendingOfficialLinks).length, 1);
  const key = Object.keys(p.pendingArticles)[0];
  p.articleCache[key] = { jobIds: ["job"] };
  delete p.pendingArticles[key];
  queueContentDraft(p, "unit", [record], 0);
  assert.equal(Object.keys(p.pendingArticles).length, 0);
});
test("article chunks cover tail without a fixed article count", () => {
  const text = "招聘条件：".repeat(2200) + "尾部真实岗位要求",
    parts = articleParts(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 6000));
  assert.ok(parts.at(-1).endsWith("尾部真实岗位要求"));
});
