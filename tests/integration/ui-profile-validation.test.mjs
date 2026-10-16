import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { submit } from "../helpers/dom.mjs";
import { profileForm } from "../../public/js/components/profile-form.js";
import { targetForm } from "../../public/js/components/target-form.js";
import { mountProfilesPage } from "../../public/js/pages/profiles.js";

const resume =
  "合成简历：软件工程本科，2027年毕业，熟悉Java与SQL，有校园项目实践经验。";
const profiles = [
  {
    profileId: "synthetic-profile",
    revisionId: "synthetic-profile@1",
    revision: 1,
    profile: { name: "合成画像", education: "本科" },
    text: resume,
  },
];
function fieldError(node) {
  assert.equal(node.getAttribute("aria-invalid"), "true");
  return (node.getAttribute("aria-describedby") || "")
    .split(/\s+/)
    .map((id) => node.ownerDocument.getElementById(id)?.textContent || "")
    .join(" ");
}
function targetFixture() {
  const f = uiFixture(() => ({})),
    saved = [];
  const form = targetForm({
    ...f,
    profiles,
    sourceIds: ["school"],
    onSave: async (input) => saved.push(input),
  });
  f.root.append(form);
  form.querySelector("#targetRoles").value = "软件开发";
  form.querySelector("#targetVersionName").value = "合成目标";
  return { ...f, form, saved };
}
function pageFixture(failure) {
  return uiFixture((p, o) =>
    p === "/profiles/import-preview"
      ? { text: resume, profile: { education: "本科" }, warnings: [] }
      : p === "/profiles" && !o.method
        ? { profiles: [...profiles] }
        : p === "/targets" && !o.method
          ? { targets: [] }
          : p === "/sources"
            ? { sources: [{ sourceId: "school" }], sites: [] }
            : o.method
              ? (() => {
                  throw failure;
                })()
              : {},
  );
}

test("profile graduation year keeps raw input invalid rather than saving NaN", async () => {
  const f = uiFixture(() => ({})),
    saved = [];
  const form = profileForm({
    ...f,
    preview: { text: resume, profile: {} },
    onSave: async (v) => saved.push(v),
  });
  f.root.append(form);
  const year = form.querySelector("#graduationYear");
  year.value = "二〇二七";
  submit(f.document, form);
  await f.settle();
  assert.equal(saved.length, 0);
  assert.match(fieldError(year), /四位|1900|年份/);
});

test("profile short body is marked before attempting to save a version", async () => {
  const f = uiFixture(() => ({})),
    saved = [];
  const form = profileForm({
    ...f,
    preview: { text: "简历太短", profile: {} },
    onSave: async (v) => saved.push(v),
  });
  f.root.append(form);
  submit(f.document, form);
  await f.settle();
  assert.equal(saved.length, 0);
  assert.match(fieldError(form.querySelector("#confirmedText")), /30/);
});

test("profile long name receives its own field feedback", async () => {
  const f = uiFixture(() => ({})),
    saved = [];
  const form = profileForm({
    ...f,
    preview: { text: resume, profile: {} },
    onSave: async (v) => saved.push(v),
  });
  f.root.append(form);
  form.querySelector("#profileName").value = "a".repeat(201);
  submit(f.document, form);
  await f.settle();
  assert.equal(saved.length, 0);
  assert.match(fieldError(form.querySelector("#profileName")), /200/);
});

test("profile pending save disables reentry without clearing filled content", async () => {
  let release;
  const waiting = new Promise((resolve) => {
      release = resolve;
    }),
    f = uiFixture(() => ({})),
    saved = [];
  const form = profileForm({
    ...f,
    preview: { text: resume, profile: {} },
    onSave: async (v) => {
      saved.push(v);
      await waiting;
    },
  });
  f.root.append(form);
  submit(f.document, form);
  submit(f.document, form);
  await f.settle();
  try {
    assert.equal(saved.length, 1);
    assert.equal(form.querySelector("button[type=submit]").disabled, true);
    assert.equal(form.querySelector("#confirmedText").value, resume);
  } finally {
    release();
    await f.settle();
  }
});

test("target requires at least one role before attempting to save", async () => {
  const f = targetFixture(),
    roles = f.form.querySelector("#targetRoles");
  roles.value = "，、";
  submit(f.document, f.form);
  await f.settle();
  assert.equal(f.saved.length, 0);
  assert.match(fieldError(roles), /至少/);
});

test("target requires a city when selected city mode is chosen", async () => {
  const f = targetFixture();
  f.form.querySelector("#cityMode").value = "selected";
  submit(f.document, f.form);
  await f.settle();
  assert.equal(f.saved.length, 0);
  assert.match(fieldError(f.form.querySelector("#targetCities")), /至少|城市/);
});

test("target requires at least one recruitment type and marks the group", async () => {
  const f = targetFixture();
  for (const checkbox of f.form.querySelectorAll("input[name=jobType]"))
    checkbox.checked = false;
  submit(f.document, f.form);
  await f.settle();
  assert.equal(f.saved.length, 0);
  const group = f.form
    .querySelector("input[name=jobType]")
    .closest("[aria-describedby]");
  assert.ok(group);
  assert.match(fieldError(group), /至少/);
});

test("target rejects an unknown source ID against loaded source references", async () => {
  const f = targetFixture(),
    source = f.form.querySelector("#targetSources");
  source.value = "not-existing";
  submit(f.document, f.form);
  await f.settle();
  assert.equal(f.saved.length, 0);
  assert.match(fieldError(source), /不存在|重新选择/);
});

test("target decimal graduation year cannot be saved", async () => {
  const f = targetFixture(),
    year = f.form.querySelector("#targetYear");
  year.value = "2027.5";
  submit(f.document, f.form);
  await f.settle();
  assert.equal(f.saved.length, 0);
  assert.match(fieldError(year), /四位|年份/);
});

test("profile server field errors reach the profile form without losing text", async () => {
  const f = pageFixture(
    Object.assign(Error("画像检查未通过"), {
      fieldErrors: { "profile.major": "专业不能超过 200 字符。" },
    }),
  );
  const page = mountProfilesPage(f);
  await page.ready;
  f.root.querySelector("#resumeText").value = resume;
  submit(f.document, f.root.querySelector("#previewForm"));
  await f.settle();
  f.root.querySelector("#major").value = "软件工程";
  submit(f.document, f.root.querySelector("#profileForm"));
  await f.settle();
  assert.match(fieldError(f.root.querySelector("#major")), /专业/);
  assert.equal(f.root.querySelector("#confirmedText").value, resume);
  assert.doesNotMatch(f.root.textContent, /画像已保存/);
  page.destroy();
});

test("target server field errors reach the target form without losing roles", async () => {
  const f = pageFixture(
    Object.assign(Error("目标检查未通过"), {
      fieldErrors: { sourceIds: "该来源已不存在，请重新选择。" },
    }),
  );
  const page = mountProfilesPage(f);
  await page.ready;
  f.root.querySelector("#targetVersionName").value = "合成目标";
  f.root.querySelector("#targetRoles").value = "软件开发";
  submit(f.document, f.root.querySelector("#targetForm"));
  await f.settle();
  assert.match(fieldError(f.root.querySelector("#targetSources")), /来源/);
  assert.equal(f.root.querySelector("#targetRoles").value, "软件开发");
  assert.doesNotMatch(
    f.root.querySelector(".feedback").textContent,
    /目标已保存/,
  );
  page.destroy();
});

test("optional profile facts remain empty and unknown without blocking valid text", async () => {
  const f = uiFixture(() => ({})),
    saved = [];
  const form = profileForm({
    ...f,
    preview: { text: resume, profile: {} },
    onSave: async (v) => saved.push(v),
  });
  f.root.append(form);
  submit(f.document, form);
  await f.settle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].profile.graduationYear, null);
  assert.equal(saved[0].profile.education, "未知");
  assert.deepEqual(saved[0].profile.certificates, []);
  assert.equal(saved[0].profile.explicitFacts.certificates, false);
});

test("target permits empty optional year and source scope with any city mode", async () => {
  const f = targetFixture();
  f.form.querySelector("#targetCities").value = "深圳";
  submit(f.document, f.form);
  await f.settle();
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].graduationYear, null);
  assert.deepEqual(f.saved[0].cities, []);
  assert.deepEqual(f.saved[0].sourceIds, []);
  assert.equal(f.saved[0].minDegree, null);
});

test("selected valid resume file takes priority over pasted text in preview request", async () => {
  const f = pageFixture(Error("unexpected write")),
    page = mountProfilesPage(f);
  await page.ready;
  const input = f.root.querySelector("#resumeFile");
  Object.defineProperty(input, "files", {
    value: [
      {
        name: "synthetic.txt",
        size: 3,
        arrayBuffer: async () => Uint8Array.from([65, 66, 67]).buffer,
      },
    ],
  });
  f.root.querySelector("#resumeText").value = "此处不会参与本次提取";
  submit(f.document, f.root.querySelector("#previewForm"));
  await f.settle();
  const request = f.calls.find((c) => c.path === "/profiles/import-preview");
  assert.equal(request.body.filename, "synthetic.txt");
  assert.equal(request.body.base64, "QUJD");
  assert.equal(Object.hasOwn(request.body, "resumeText"), false);
  assert.ok(f.root.querySelector("#profileForm"));
  page.destroy();
});

test("resume preview rejects short text locally at its field", async () => {
  const f = pageFixture(Error("unexpected write")),
    page = mountProfilesPage(f);
  await page.ready;
  f.root.querySelector("#resumeText").value = "太短";
  submit(f.document, f.root.querySelector("#previewForm"));
  await f.settle();
  assert.equal(
    f.calls.filter((c) => c.path === "/profiles/import-preview").length,
    0,
  );
  assert.match(fieldError(f.root.querySelector("#resumeText")), /30/);
  page.destroy();
});

test("resume file checks remain attached to the file field even with valid pasted text", async (t) => {
  for (const [name, file, match] of [
    [
      "empty",
      {
        name: "empty.pdf",
        size: 0,
        arrayBuffer: async () => new ArrayBuffer(0),
      },
      /空|内容/,
    ],
    [
      "extension",
      {
        name: "resume.exe",
        size: 2,
        arrayBuffer: async () => new ArrayBuffer(2),
      },
      /TXT|PDF|文件/,
    ],
    [
      "size",
      {
        name: "large.pdf",
        size: 20 * 1024 * 1024 + 1,
        arrayBuffer: async () => new ArrayBuffer(0),
      },
      /20/,
    ],
  ])
    await t.test(name, async () => {
      const f = pageFixture(Error("unexpected write")),
        page = mountProfilesPage(f);
      await page.ready;
      const input = f.root.querySelector("#resumeFile");
      Object.defineProperty(input, "files", { value: [file] });
      f.root.querySelector("#resumeText").value = resume;
      submit(f.document, f.root.querySelector("#previewForm"));
      await f.settle();
      assert.equal(
        f.calls.filter((c) => c.path === "/profiles/import-preview").length,
        0,
      );
      assert.match(fieldError(input), match);
      page.destroy();
    });
});
