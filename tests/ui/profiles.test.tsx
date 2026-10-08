import assert from "node:assert/strict";
import test from "node:test";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../helpers/react-fixture";

const text =
  "合成简历正文用于离线界面验证。学历本科，安全工程专业，具有合成项目经历与可核实的技能。";
const preview = {
  text,
  profile: {
    name: "合成人员",
    degree: "本科",
    major: "安全工程",
    graduationYear: 2027,
    skills: ["合成技能"],
    certificates: [],
    cities: [],
    projects: [],
    explicitFacts: {},
  },
  parserVersion: "preview-2",
  warnings: ["请核对提取结果。"],
};
function apiFixture(
  save: (body: any) => unknown = (body) => ({
    ...body,
    profileId: "p-one",
    revisionId: "p-one@1",
    packageId: "profile-one",
    versionName: body.versionName,
    enabled: true,
  }),
) {
  return async (path: string, options: any = {}) => {
    if (path === "/profiles")
      return options.method === "POST" ? save(options.body) : { profiles: [] };
    if (path === "/targets") return { targets: [] };
    if (path === "/profiles/import-preview") return preview;
    throw new Error("Unexpected synthetic API route: " + path);
  };
}
async function openCorrection(f: any) {
  await f.user.click(await f.screen.findByRole("button", { name: "导入简历" }));
  await f.user.type(f.screen.getByLabelText("粘贴简历正文"), text);
  await f.user.click(f.screen.getByRole("button", { name: "提取并预览" }));
  await f.screen.findByLabelText("专业");
}

test("corrected profile facts and original parser metadata are saved as a named independent version", async (t) => {
  const f = await renderApp(t, {
    route: "#/profiles",
    apiHandler: apiFixture(),
  });
  await openCorrection(f);
  await f.user.clear(f.screen.getByLabelText("专业"));
  await f.user.type(f.screen.getByLabelText("专业"), "消防工程");
  await f.user.click(f.screen.getByRole("button", { name: "下一步" }));
  await f.user.type(f.screen.getByLabelText("版本名称"), "合成简历版本");
  await f.user.click(f.screen.getByRole("button", { name: "保存简历" }));
  await f.screen.findByText(/简历已保存：/);
  const saved = f.apiCalls.find(
    (c: any) => c.path === "/profiles" && c.options.method === "POST",
  ).options.body;
  assert.equal(saved.profile.major, "消防工程");
  assert.equal(saved.overrides.major, "消防工程");
  assert.equal(saved.parserVersion, "preview-2");
  assert.equal(saved.text, text);
  assert.equal(saved.versionName, "合成简历版本");
  assert.ok(saved.submissionId);
});

test("duplicate profile name preserves draft and unchanged retry uses the same submission identity", async (t) => {
  let attempts = 0;
  const f = await renderApp(t, {
    route: "#/profiles",
    apiHandler: apiFixture((body) => {
      if (++attempts === 1)
        throw Object.assign(new Error("版本名称已存在。"), {
          fieldErrors: { versionName: "名称已存在，请使用其他名称。" },
          code: "version_name_conflict",
        });
      return {
        ...body,
        profileId: "p-one",
        revisionId: "p-one@1",
        packageId: "profile-one",
        enabled: true,
      };
    }),
  });
  await openCorrection(f);
  await f.user.click(f.screen.getByRole("button", { name: "下一步" }));
  await f.user.type(f.screen.getByLabelText("版本名称"), " 同名合成简历 ");
  await f.user.click(f.screen.getByRole("button", { name: "保存简历" }));
  await f.screen.findByRole("alert");
  assert.equal(
    (f.screen.getByLabelText("版本名称") as HTMLInputElement).value,
    " 同名合成简历 ",
  );
  assert.equal(f.screen.queryByText(/简历已保存/), null);
  await f.user.click(f.screen.getByRole("button", { name: "保存简历" }));
  await f.screen.findByText(/简历已保存：/);
  const calls = f.apiCalls.filter(
    (c: any) => c.path === "/profiles" && c.options.method === "POST",
  );
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].options.body.submissionId,
    calls[1].options.body.submissionId,
  );
});

test("invalid pasted resume is rejected before extraction and remains available to correct", async (t) => {
  const f = await renderApp(t, {
    route: "#/profiles",
    apiHandler: apiFixture(),
  });
  await f.user.click(await f.screen.findByRole("button", { name: "导入简历" }));
  await f.user.type(f.screen.getByLabelText("粘贴简历正文"), "太短的合成内容");
  await f.user.click(f.screen.getByRole("button", { name: "提取并预览" }));
  await f.screen.findByRole("alert");
  assert.equal(
    f.apiCalls.filter((c: any) => c.path === "/profiles/import-preview").length,
    0,
  );
  assert.equal(
    (f.screen.getByLabelText("粘贴简历正文") as HTMLTextAreaElement).value,
    "太短的合成内容",
  );
});

test("extraction failure keeps source text and exposes a readable file error", async (t) => {
  const api = apiFixture();
  const f = await renderApp(t, {
    route: "#/profiles",
    apiHandler: async (path: string, options: any) => {
      if (path === "/profiles/import-preview")
        throw Object.assign(new Error("提取失败。"), {
          fieldErrors: { resumeText: "正文无法提取，请校正后重试。" },
          diagnosticId: "synthetic-error",
        });
      return api(path, options);
    },
  });
  await f.user.click(await f.screen.findByRole("button", { name: "导入简历" }));
  await f.user.type(f.screen.getByLabelText("粘贴简历正文"), text);
  await f.user.click(f.screen.getByRole("button", { name: "提取并预览" }));
  assert.match((await f.screen.findByRole("alert")).textContent!, /提取/);
  assert.equal(
    (f.screen.getByLabelText("粘贴简历正文") as HTMLTextAreaElement).value,
    text,
  );
});

test("a selected valid resume file takes priority over pasted text in the React preview request", async (t) => {
  const f = await renderApp(t, {
    route: "#/profiles",
    apiHandler: apiFixture(),
  });
  await f.user.click(await f.screen.findByRole("button", { name: "导入简历" }));
  await f.user.type(f.screen.getByLabelText("粘贴简历正文"), text);
  const content = "SYNTHETIC_FILE_CONTENT_FOR_PREVIEW";
  await f.user.upload(
    f.screen.getByLabelText("简历文件"),
    new File([content], "synthetic-resume.txt", { type: "text/plain" }),
  );
  await f.user.click(f.screen.getByRole("button", { name: "提取并预览" }));
  await f.screen.findByLabelText("专业");
  const body = f.apiCalls.find((c) => c.path === "/profiles/import-preview")
    ?.body as Record<string, unknown>;
  assert.equal(body.filename, "synthetic-resume.txt");
  assert.equal(body.base64, Buffer.from(content).toString("base64"));
  assert.equal(body.resumeText, undefined);
});

test("invalid resume file type and size stay at the file field even with valid pasted content", async (t) => {
  const f = await renderApp(t, {
    route: "#/profiles",
    apiHandler: apiFixture(),
  });
  const uploader = userEvent.setup({ applyAccept: false });
  await f.user.click(await f.screen.findByRole("button", { name: "导入简历" }));
  await f.user.type(f.screen.getByLabelText("粘贴简历正文"), text);
  const input = f.screen.getByLabelText("简历文件");
  await uploader.upload(
    input,
    new File(["synthetic"], "synthetic-resume.exe", {
      type: "application/octet-stream",
    }),
  );
  await f.user.click(f.screen.getByRole("button", { name: "提取并预览" }));
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(
    f.apiCalls.some((c) => c.path === "/profiles/import-preview"),
    false,
  );
  const oversized = new File(["synthetic"], "synthetic-resume.pdf", {
    type: "application/pdf",
  });
  Object.defineProperty(oversized, "size", { value: 20 * 1024 * 1024 + 1 });
  await uploader.upload(input, oversized);
  await f.user.click(f.screen.getByRole("button", { name: "提取并预览" }));
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(
    f.apiCalls.some((c) => c.path === "/profiles/import-preview"),
    false,
  );
  assert.equal(
    (f.screen.getByLabelText("粘贴简历正文") as HTMLTextAreaElement).value,
    text,
  );
});
