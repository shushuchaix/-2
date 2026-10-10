import test from "node:test";
import assert from "node:assert/strict";
import { renderApp } from "../helpers/react-fixture";

const settings = {
  model: {
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    configured: false,
  },
  budgets: { maxCostCny: 10, maxModelRequests: 1000 },
};

test("settings retains official model and yuan budget and rejects invalid amount", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path) => (path === "/settings" ? settings : undefined),
  });
  const budget = await f.screen.findByLabelText("每任务模型费用上限（元）");
  assert.equal((budget as HTMLInputElement).value, "10");
  assert.equal(
    (f.screen.getByLabelText("模型名称") as HTMLInputElement).value,
    "deepseek-flash",
  );
  await f.user.clear(budget);
  await f.user.type(budget, "-1");
  await f.user.click(
    f.screen.getByRole("button", { name: "保存模型与预算设置" }),
  );
  assert.equal(
    f.apiCalls.filter(
      (c) => c.path === "/settings" && c.options?.method === "PUT",
    ).length,
    0,
  );
  assert.equal(budget.getAttribute("aria-invalid"), "true");
  assert.equal(f.screen.queryByText("设置已保存"), null);
});

test("zero yuan commits zero and explains rules mode without sending a key", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path) => (path === "/settings" ? settings : undefined),
  });
  const budget = await f.screen.findByLabelText("每任务模型费用上限（元）");
  await f.user.clear(budget);
  await f.user.type(budget, "0");
  await f.user.click(
    f.screen.getByRole("button", { name: "保存模型与预算设置" }),
  );
  assert.ok((await f.screen.findAllByText("设置已保存")).length);
  const call = f.apiCalls.find(
    (c) => c.path === "/settings" && c.options?.method === "PUT",
  );
  assert.equal((call?.body as any).budgets.maxCostCny, 0);
  assert.equal((call?.body as any).budgets.maxModelRequests, 1000);
  assert.equal(JSON.stringify(call?.body).includes("apiKey"), false);
  assert.ok(f.screen.getByText(/0.*不发起模型调用/));
});

test("settings field rejection retains draft and does not claim committed success", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path, options) => {
      if (path === "/settings" && options?.method === "PUT")
        throw Object.assign(new Error("检查未通过"), {
          fieldErrors: { "model.model": "模型名称不可用" },
        });
      if (path === "/settings") return settings;
    },
  });
  const model = await f.screen.findByLabelText("模型名称");
  await f.user.clear(model);
  await f.user.type(model, "new-draft-model");
  const budget = f.screen.getByLabelText("每任务模型费用上限（元）");
  await f.user.clear(budget);
  await f.user.click(
    f.screen.getByRole("button", { name: "保存模型与预算设置" }),
  );
  assert.ok((await f.screen.findAllByText(/模型名称不可用/)).length);
  assert.equal((model as HTMLInputElement).value, "new-draft-model");
  assert.equal(f.screen.queryByText("设置已保存"), null);
});

test("empty desktop key is rejected locally and directory errors remain actionable", async (t) => {
  let saves = 0;
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path) => (path === "/settings" ? settings : undefined),
    desktopBridge: {
      isAvailable: async () => true,
      getKeyStatus: async () => ({ configured: false }),
      saveKey: async () => {
        saves++;
      },
      deleteKey: async () => undefined,
      getDataLocations: async () => ({ data: "C:/synthetic/workspace" }),
      openDataLocation: async () => {
        throw new Error("目录暂时无法打开");
      },
      copyDataLocation: async () => undefined,
    },
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "加密保存桌面 Key" }),
  );
  assert.equal(saves, 0);
  assert.equal(
    f.screen.getByLabelText("桌面密钥").getAttribute("aria-invalid"),
    "true",
  );
  await f.user.click(f.screen.getByRole("tab", { name: "数据与备份" }));
  await f.user.click(
    await f.screen.findByRole("button", { name: "打开工作区数据" }),
  );
  assert.ok(await f.screen.findByText(/目录暂时无法打开/));
  assert.equal(
    f.apiCalls.some((c) => /location|director/.test(c.path)),
    false,
  );
});

test("legacy assignment uses one exact target and commits only after preview confirmation", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path) => {
      if (path === "/settings") return settings;
      if (path === "/legacy-records")
        return {
          records: [
            {
              recordId: "old-record",
              kind: "application",
              title: "待归属合成投递",
            },
          ],
        };
      if (path === "/legacy-records/assignment-preview")
        return {
          workspaceRevision: 1,
          planHash: "move-plan",
          recordIds: ["old-record"],
          counts: { applications: 1, events: 2 },
        };
      if (path === "/legacy-records/assign") return { moved: 1 };
    },
  });
  await f.user.click(f.screen.getByRole("tab", { name: "版本维护" }));
  await f.user.click(
    await f.screen.findByRole("button", { name: "分配待归属合成投递" }),
  );
  await f.user.click(f.screen.getByRole("button", { name: "预览归属移动" }));
  assert.equal(
    f.apiCalls.some((c) => c.path === "/legacy-records/assign"),
    false,
  );
  await f.user.click(
    await f.screen.findByRole("button", { name: "确认移动到此目标" }),
  );
  const assigned = f.apiCalls.find((c) => c.path === "/legacy-records/assign");
  assert.deepEqual((assigned?.body as any).destination, {
    packageId: "A",
    targetRevisionId: "t1@1",
  });
  assert.equal((assigned?.body as any).allTargets, undefined);
});

test("dedup completion renders the backend totals and per-package counts", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path) =>
      path === "/jobs/duplicates/preview"
        ? {
            workspaceRevision: 1,
            planHash: "synthetic",
            groups: [
              {
                groupId: "g",
                packageId: "A",
                versionName: "合成目标A",
                keepJobId: "j",
                removeJobIds: ["j-2"],
                reasons: ["authority_id"],
              },
            ],
          }
        : path === "/jobs/duplicates/apply"
          ? {
              totals: {
                removedEntities: 1,
                collapsedVersionEntries: 1,
                affectedVersions: 1,
              },
              packages: [
                {
                  packageId: "A",
                  versionName: "合成目标A",
                  counts: { removedEntities: 1, protected: 0 },
                },
              ],
            }
          : syntheticApi(path),
  });
  await f.user.click(f.screen.getByRole("tab", { name: "版本维护" }));
  await f.user.click(
    f.screen.getByRole("button", { name: "预览所有版本去重" }),
  );
  await f.screen.findByText("逐版本清理重复岗位");
  await f.user.click(
    f.screen.getByRole("button", { name: "确认清理所选重复岗位" }),
  );
  await f.screen.findByText(
    "已清理重复实体 1 条，版本内归并 1 条，涉及 1 个版本。",
  );
  await f.screen.findByText("合成目标A：清理 1，保护 0");
});
test("all-version dedup keeps protected conflicts and requires fresh preview after 409", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path) => {
      if (path === "/settings") return settings;
      if (path === "/legacy-records") return { records: [] };
      if (path === "/jobs/duplicates/preview")
        return {
          workspaceRevision: 1,
          planHash: "dedup-1",
          groups: [
            {
              groupId: "allowed",
              packageId: "package-a",
              versionName: "目标 A",
              keepJobId: "job-a",
              removeJobIds: ["job-a2"],
              reasons: ["specific_job_url"],
            },
            {
              groupId: "protected",
              packageId: "trash-b",
              versionName: "回收目标 B",
              keepJobId: "job-b",
              removeJobIds: ["job-b2"],
              protected: true,
              protectedReason: "multiple_manual_applications",
            },
          ],
          possiblePairs: [],
        };
      if (path === "/jobs/duplicates/apply")
        throw Object.assign(new Error("预览已过期"), {
          code: "duplicate_plan_stale",
          status: 409,
        });
    },
  });
  await f.user.click(f.screen.getByRole("tab", { name: "版本维护" }));
  await f.user.click(
    f.screen.getByRole("button", { name: "预览所有版本去重" }),
  );
  const protectedGroup = await f.screen.findByRole("checkbox", {
    name: /回收目标 B/,
  });
  assert.equal(
    (protectedGroup as HTMLInputElement).disabled ||
      protectedGroup.getAttribute("aria-disabled") === "true",
    true,
  );
  await f.user.click(
    f.screen.getByRole("button", { name: "确认清理所选重复岗位" }),
  );
  assert.ok((await f.screen.findAllByText(/重新预览/)).length);
  const body = f.apiCalls.find((c) => c.path === "/jobs/duplicates/apply")
    ?.body as any;
  assert.deepEqual(body.selectedGroupIds, ["allowed"]);
  assert.equal(body.allVersions, true);
});

test("failed workspace restore preserves selected scope while successful restore refreshes it", async (t) => {
  let fail = true,
    restored = false;
  const f = await renderApp(t, {
    route: "#/jobs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, options) => {
      if (path === "/settings") return settings;
      if (path === "/workspace/restore" && fail)
        throw new Error("备份完整性检查失败");
      if (path === "/workspace/restore") {
        restored = true;
        return { restored: true };
      }
      if (restored && path === "/profiles") return { profiles: [] };
      if (restored && path === "/targets") return { targets: [] };
      if (path.startsWith("/jobs?"))
        return {
          items: [
            {
              jobId: "old-job-A",
              job: { title: "OLD_JOB_STATE_SENTINEL", company: "合成单位" },
            },
          ],
          total: 1,
        };
      if (path === "/runs" && options.method !== "POST")
        return {
          runs: [{ runId: "OLD_RUN_STATE_SENTINEL", status: "completed" }],
        };
    },
  });
  await f.screen.findByText("OLD_JOB_STATE_SENTINEL");
  await f.user.click(f.screen.getByRole("link", { name: "运行日志" }));
  await f.screen.findByText("OLD_RUN_STATE_SENTINEL");
  await f.user.click(f.screen.getByRole("link", { name: "设置" }));
  await f.user.click(f.screen.getByRole("tab", { name: "数据与备份" }));
  await f.user.upload(
    f.screen.getByLabelText("恢复备份文件"),
    new File(["{}"], "synthetic-backup.json", { type: "application/json" }),
  );
  await f.user.click(f.screen.getByRole("button", { name: "校验并恢复" }));
  assert.ok(await f.screen.findByText(/备份完整性检查失败/));
  assert.equal(f.screen.queryByText("工作区已恢复"), null);
  assert.match(window.location.hash, /packageId=A/);
  assert.match(window.location.hash, /targetRevisionId=t1%401/);
  assert.match(
    f.screen.getByRole("combobox", { name: "当前目标" }).textContent ?? "",
    /合成目标A/,
  );
  await f.user.click(f.screen.getByRole("link", { name: "岗位库" }));
  await f.screen.findByText("OLD_JOB_STATE_SENTINEL");
  assert.deepEqual(
    f.apiCalls.filter((c) => c.path.startsWith("/jobs?")).at(-1)?.scope,
    {
      packageId: "A",
      targetRevisionId: "t1@1",
    },
  );
  await f.user.click(f.screen.getByRole("link", { name: "运行日志" }));
  await f.screen.findByText("OLD_RUN_STATE_SENTINEL");
  assert.deepEqual(f.apiCalls.filter((c) => c.path === "/runs").at(-1)?.scope, {
    packageId: "A",
    targetRevisionId: "t1@1",
  });
  await f.user.click(f.screen.getByRole("link", { name: "设置" }));
  await f.user.click(f.screen.getByRole("tab", { name: "数据与备份" }));
  await f.user.upload(
    f.screen.getByLabelText("恢复备份文件"),
    new File(["{}"], "synthetic-backup.json", { type: "application/json" }),
  );
  fail = false;
  const versionReads = f.apiCalls.filter((c) => c.path === "/targets").length;
  await f.user.click(f.screen.getByRole("button", { name: "校验并恢复" }));
  assert.ok((await f.screen.findAllByText("工作区已恢复")).length);
  assert.equal(window.location.hash.includes("packageId="), false);
  assert.equal(window.location.hash.includes("targetRevisionId="), false);
  assert.match(
    f.screen.getByRole("combobox", { name: "当前目标" }).textContent ?? "",
    /选择目标版本/,
  );
  assert.ok(
    f.apiCalls.filter((c) => c.path === "/targets").length > versionReads,
  );
  const businessReads = () =>
    f.apiCalls.filter((c) => c.path.startsWith("/jobs?") || c.path === "/runs")
      .length;
  const before = businessReads();
  await f.user.click(f.screen.getByRole("link", { name: "岗位库" }));
  assert.equal(f.screen.queryByText("OLD_JOB_STATE_SENTINEL"), null);
  await f.user.click(f.screen.getByRole("link", { name: "运行日志" }));
  await f.screen.findByText("先选择目标版本");
  assert.equal(f.screen.queryByText("OLD_RUN_STATE_SENTINEL"), null);
  await f.user.click(f.screen.getByRole("link", { name: "工作台" }));
  await f.screen.findByText("导入简历 → 创建目标 → 更新岗位");
  assert.equal(
    f.screen.getByRole("button", { name: "更新岗位" }).hasAttribute("disabled"),
    true,
  );
  assert.equal(f.screen.queryByText("OLD_RUN_STATE_SENTINEL"), null);
  assert.equal(businessReads(), before);
});

test("legacy detail failure keeps the record and blocks ownership preview", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path) => {
      if (path === "/settings") return settings;
      if (path === "/legacy-records")
        return {
          records: [
            {
              recordId: "unreadable",
              kind: "application",
              title: "不可读取旧记录",
            },
          ],
        };
      if (path === "/legacy-records/unreadable")
        throw new Error("旧记录完整内容读取失败");
    },
  });
  await f.user.click(f.screen.getByRole("tab", { name: "版本维护" }));
  await f.user.click(
    await f.screen.findByRole("button", { name: "分配不可读取旧记录" }),
  );
  assert.ok((await f.screen.findAllByText(/旧记录完整内容读取失败/)).length);
  await f.user.click(f.screen.getByRole("button", { name: "预览归属移动" }));
  assert.equal(
    f.apiCalls.some((c) => c.path === "/legacy-records/assignment-preview"),
    false,
  );
  assert.equal(
    f.apiCalls.some((c) => c.path === "/legacy-records/assign"),
    false,
  );
});
