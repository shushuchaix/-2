import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { submit } from "../helpers/dom.mjs";
import { mountProfilesPage } from "../../public/js/pages/profiles.js";
test("preview waits for confirmation and explicit target city and degree policy survive save", async () => {
  const profiles = [],
    targets = [];
  const f = uiFixture((p, o) => {
    if (p === "/profiles/import-preview")
      return {
        text: "合成简历软件工程本科 Java开发，2027届毕业，深圳求职。",
        profile: { education: "本科", major: "软件工程", skills: ["Java"] },
        warnings: ["提取结果需校正"],
      };
    if (p === "/profiles" && o.method) {
      const item = {
        ...o.body,
        profileId: "p1",
        revisionId: "p1@1",
        revision: 1,
      };
      profiles.push(item);
      return item;
    }
    if (p === "/targets" && o.method) {
      targets.push({
        ...o.body,
        targetId: "t1",
        revisionId: "t1@1",
        revision: 1,
      });
      return targets.at(-1);
    }
    if (p === "/profiles") return { profiles };
    if (p === "/targets") return { targets };
    return { items: [] };
  });
  const page = mountProfilesPage(f);
  await page.ready;
  f.root.querySelector("#resumeText").value =
    "合成简历软件工程本科 Java开发，2027届毕业，深圳求职。";
  submit(f.document, f.root.querySelector("#previewForm"));
  await f.settle();
  assert.equal(profiles.length, 0);
  assert.ok(f.root.textContent.includes("提取结果需校正"));
  f.root.querySelector("#confirmedText").value =
    "已校正文本：合成简历软件工程本科，熟悉Java并有项目实践。";
  f.root.querySelector("#education").value = "本科";
  submit(f.document, f.root.querySelector("#profileForm"));
  await f.settle();
  assert.ok(profiles[0].text.startsWith("已校正"));
  assert.equal(profiles[0].overrides.education, "本科");
  f.root.querySelector("#targetVersionName").value = "合成目标";
  f.root.querySelector("#targetRoles").value = "Java开发";
  f.root.querySelector("#cityMode").value = "any";
  f.root.querySelector("#targetCities").value = "深圳";
  submit(f.document, f.root.querySelector("#targetForm"));
  await f.settle();
  assert.deepEqual(targets[0].cities, []);
  assert.equal(targets[0].degreePolicy, "eligibility");
  page.destroy();
});
test("profile write failure and missing profile never display successful saves", async () => {
  const f = uiFixture((p, o) => {
    if (p === "/profiles") return { profiles: [] };
    if (p === "/targets") return { targets: [] };
    if (p.endsWith("import-preview")) throw Error("无文本 PDF，请粘贴正文");
  });
  const page = mountProfilesPage(f);
  await page.ready;
  assert.equal(f.root.querySelector("#saveTarget").disabled, true);
  f.root.querySelector("#resumeText").value =
    "测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试";
  submit(f.document, f.root.querySelector("#previewForm"));
  await f.settle();
  assert.ok(f.root.textContent.includes("无文本 PDF"));
  assert.ok(!f.root.textContent.includes("画像已保存"));
  page.destroy();
});
