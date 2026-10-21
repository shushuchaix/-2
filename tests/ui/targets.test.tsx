import assert from "node:assert/strict";
import test from "node:test";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "../helpers/react-fixture";

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
}

const profile = {
  profileId: "p-one",
  revisionId: "p-one@1",
  packageId: "profile-one",
  versionName: "合成原简历",
  enabled: true,
  text: "合成独立简历正文用于验证目标创建后不会再读取来源版本。",
  profile: {
    degree: "本科",
    major: "安全工程",
    graduationYear: 2027,
    skills: [],
    certificates: [],
    cities: [],
    projects: [],
  },
};
const existing = {
  targetId: "t-existing",
  revisionId: "t-existing@1",
  packageId: "target-existing",
  versionName: "已保存合成目标",
  enabled: true,
  profileRevisionId: "p-deleted@1",
  roles: ["合成方向"],
  cityMode: "any",
  jobTypes: ["campus"],
  sourceIds: [],
  coverageMode: "standard",
  profileSnapshot: {
    text: "目标自己的合成简历正文，来源简历删除后继续可查看。",
    profile: { degree: "硕士", major: "机场工程" },
  },
};
function apiFixture(
  save: (body: any) => unknown = (body) => ({
    ...body,
    targetId: "t-new",
    revisionId: "t-new@1",
    packageId: "target-new",
    enabled: true,
    profileSnapshot: { text: profile.text, profile: profile.profile },
  }),
  targets: any[] = [],
) {
  return async (path: string, options: any = {}) => {
    if (path === "/profiles") return { profiles: [profile] };
    if (path === "/collections") return { collections: [] };
    if (path === "/targets") {
      if (options.method !== "POST") return { targets };
      const saved = await save(options.body);
      targets.push(saved);
      return saved;
    }
    if (path === "/sources")
      return {
        sources: [
          { sourceId: "source-one", name: "合成招聘来源", enabled: true },
        ],
        sites: [],
      };
    if (path === "/settings")
      return {
        model: { model: "deepseek-flash", baseUrl: "https://api.deepseek.com" },
        budgets: { maxCostCny: 10 },
      };
    throw new Error("Unexpected synthetic API route: " + path);
  };
}
async function openSummary(f: any) {
  await f.user.click(await f.screen.findByRole("button", { name: "新建目标" }));
  await f.user.click(f.screen.getByRole("button", { name: "下一步" }));
  await f.user.type(f.screen.getByLabelText("求职方向"), "消防、机场");
  await f.user.click(f.screen.getByRole("button", { name: "下一步" }));
  await f.screen.findByText("合成招聘来源");
  await f.user.click(f.screen.getByRole("button", { name: "下一步" }));
}

test("target wizard saves preferences and budget and selects the returned exact package", async (t) => {
  const f = await renderApp(t, {
    route: "#/targets",
    apiHandler: apiFixture(),
  });
  await openSummary(f);
  await f.user.type(f.screen.getByLabelText("版本名称"), "消防机场合成目标");
  await f.user.click(f.screen.getByRole("button", { name: "保存目标" }));
  await f.screen.findByText(/目标已保存：/);
  const call = f.apiCalls.find(
    (c: any) => c.path === "/targets" && c.options.method === "POST",
  );
  assert.ok(call);
  assertRecord(call.options.body);
  assertRecord(call.options.body.budgets);
  assert.equal(call.options.body.profileRevisionId, "p-one@1");
  assert.deepEqual(call.options.body.roles, ["消防", "机场"]);
  assert.equal(call.options.body.budgets.maxCostCny, 10);
  assert.equal(call.options.body.versionName, "消防机场合成目标");
  assert.ok(call.options.body.submissionId);
  assert.match(f.screen.getByRole("banner").textContent!, /消防机场合成目标/);
});

test("target cards use direction and city summaries and reserve identifiers for technical details", async (t) => {
  const f = await renderApp(t, {
    route: "#/targets",
    apiHandler: apiFixture(undefined, [{ ...existing, cityMode: "selected", cities: ["合成城市"] }]),
  });
  await f.screen.findByText(existing.versionName);
  assert.equal(f.screen.queryAllByText("目标版本 · t-existing@1").length, 0);
  assert.ok(f.screen.getByText("合成城市"));
  await f.user.click(f.screen.getByRole("button", { name: "查看 " + existing.versionName }));
  assert.equal(f.screen.queryAllByText(existing.revisionId).length, 0);
  await f.user.click(f.screen.getByRole("button", { name: "技术信息" }));
  assert.ok(f.screen.getByText(existing.revisionId));
  assert.ok(f.screen.getByText(existing.profileSnapshot.text));
});

test("a late target name error cannot overwrite the edited draft or produce a duplicate submission", async (t) => {
  let rejectSave!: (error: Error) => void;
  const f = await renderApp(t, {
    route: "#/targets",
    apiHandler: apiFixture(() => new Promise((_resolve, reject) => { rejectSave = reject; })),
  });
  await openSummary(f);
  const name = f.screen.getByLabelText("版本名称");
  await f.user.type(name, "旧合成目标");
  await f.user.click(f.screen.getByRole("button", { name: "保存目标" }));
  await f.user.clear(name);
  await f.user.type(name, "新合成目标");
  await act(async () => rejectSave(Object.assign(new Error("旧目标名称占用。"), {
    fieldErrors: { versionName: "旧名称已经占用。" },
  })));
  await waitFor(() => assert.equal(name.getAttribute("aria-invalid"), "false"));
  assert.equal(f.screen.queryAllByText("旧名称已经占用。").length, 0);
  assert.equal(f.screen.queryAllByRole("alert").length, 0);
  assert.equal(f.apiCalls.filter((c) => c.path === "/targets" && c.options.method === "POST").length, 1);
});

test("a server target preference error summary returns to the preference step and focuses its field", async (t) => {
  const f = await renderApp(t, {
    route: "#/targets",
    apiHandler: apiFixture(() => {
      throw Object.assign(new Error("求职方向需要校正。"), {
        fieldErrors: { roles: "请核对求职方向后保存。" },
      });
    }),
  });
  await openSummary(f);
  await f.user.type(f.screen.getByLabelText("版本名称"), "合成方向校正目标");
  await f.user.click(f.screen.getByRole("button", { name: "保存目标" }));
  await f.user.click(await f.screen.findByRole("button", { name: "请核对求职方向后保存。" }));
  const roles = await f.screen.findByLabelText("求职方向");
  await waitFor(() => assert.ok(document.activeElement === roles));
  await f.user.clear(roles);
  await f.user.type(roles, "校正方向");
  assert.equal(roles.getAttribute("aria-invalid"), "false");
  assert.equal(f.screen.queryAllByRole("alert").length, 0);
});

test("duplicate target name keeps creation draft and a retry cannot create a second submission", async (t) => {
  let attempts = 0;
  const f = await renderApp(t, {
    route: "#/targets",
    apiHandler: apiFixture((body) => {
      if (++attempts === 1)
        throw Object.assign(new Error("名称已存在。"), {
          fieldErrors: { versionName: "此目标版本名称已存在。" },
          code: "version_name_conflict",
        });
      return {
        ...body,
        targetId: "t-new",
        revisionId: "t-new@1",
        packageId: "target-new",
        enabled: true,
      };
    }),
  });
  await openSummary(f);
  await f.user.type(f.screen.getByLabelText("版本名称"), " 同名合成目标 ");
  await f.user.click(f.screen.getByRole("button", { name: "保存目标" }));
  assert.match((await f.screen.findByRole("alert")).textContent!, /名称/);
  assert.equal(
    (f.screen.getByLabelText("版本名称") as HTMLInputElement).value,
    " 同名合成目标 ",
  );
  assert.equal(f.screen.queryByText(/目标已保存/), null);
  await f.user.click(f.screen.getByRole("button", { name: "保存目标" }));
  await f.screen.findByText(/目标已保存：/);
  const calls = f.apiCalls.filter(
    (c: any) => c.path === "/targets" && c.options.method === "POST",
  );
  assert.equal(calls.length, 2);
  assertRecord(calls[0].options.body);
  assertRecord(calls[1].options.body);
  assert.equal(
    calls[0].options.body.submissionId,
    calls[1].options.body.submissionId,
  );
});

test("saved target detail renders its independent snapshot without fetching deleted source profile", async (t) => {
  const f = await renderApp(t, {
    route: "#/targets",
    apiHandler: apiFixture(undefined, [existing]),
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "查看 已保存合成目标" }),
  );
  await f.screen.findByText(existing.profileSnapshot.text);
  assert.equal(
    f.apiCalls.some((c: any) => c.path.includes("p-deleted")),
    false,
  );
  assert.match(f.screen.getByRole("dialog").textContent!, /机场工程/);
});

test("invalid target preferences stay in the current step and never save a version", async (t) => {
  const f = await renderApp(t, {
    route: "#/targets",
    apiHandler: apiFixture(),
  });
  await f.user.click(await f.screen.findByRole("button", { name: "新建目标" }));
  await f.user.click(f.screen.getByRole("button", { name: "下一步" }));
  await f.user.click(f.screen.getByRole("button", { name: "下一步" }));
  await f.screen.findByRole("alert");
  assert.ok(f.screen.getByLabelText("求职方向"));
  assert.equal(
    f.apiCalls.filter(
      (c: any) => c.path === "/targets" && c.options.method === "POST",
    ).length,
    0,
  );
});
