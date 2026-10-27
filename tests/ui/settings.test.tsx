import test from "node:test";
import assert from "node:assert/strict";
import { act, waitFor, within } from "@testing-library/react";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
import type { DesktopBridge } from "../../ui/src/lib/types";

const settings = {
  model: {
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    configured: false,
  },
  budgets: { maxCostCny: 10, maxModelRequests: 1000 },
};

const credentialMessage =
  "本地模型凭据与当前配置尚未核对，请重新填写密钥并保存；规则分析仍可使用。";
function desktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    isAvailable: async () => true,
    getKeyStatus: async () => ({ configured: true, saved: true }),
    saveKey: async () => ({ configured: true }),
    deleteKey: async () => ({ configured: false }),
    getDataLocations: async () => ({ data: "C:/synthetic/workspace" }),
    openDataLocation: async () => undefined,
    copyDataLocation: async () => undefined,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("public credential status overrides an encrypted file that still exists", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    desktopBridge: desktopBridge(),
    apiHandler: (path) =>
      path === "/settings"
        ? {
            ...settings,
            model: {
              ...settings.model,
              credentialStatus: "needs_configuration",
              credentialMessage,
            },
          }
        : undefined,
  });
  await f.screen.findByLabelText("模型名称");
  assert.ok(f.screen.getAllByText(new RegExp(credentialMessage)).length >= 2);
  assert.equal(f.screen.queryByText("已保存加密密钥，不显示原文。"), null);
  assert.equal(f.screen.queryByText(/已配置模型访问/), null);
});

test("desktop save refreshes public settings and clears only the submitted password", async (t) => {
  let configured = false;
  const f = await renderApp(t, {
    route: "#/settings",
    desktopBridge: desktopBridge({
      saveKey: async (_provider, key) => {
        assert.equal(key, "sk-synthetic-settings");
        configured = true;
        return { configured: true };
      },
    }),
    apiHandler: (path) =>
      path === "/settings"
        ? {
            ...settings,
            model: {
              ...settings.model,
              configured,
              credentialStatus: configured ? "configured" : "not_configured",
            },
          }
        : undefined,
  });
  const password = await f.screen.findByLabelText("桌面密钥");
  await f.user.type(password, "sk-synthetic-settings");
  await f.user.click(
    f.screen.getByRole("button", { name: "加密保存桌面 Key" }),
  );
  await f.screen.findByText(/已配置模型访问/);
  assert.equal((password as HTMLInputElement).value, "");
  assert.ok(f.apiCalls.filter((c) => c.path === "/settings").length >= 2);
  assert.equal(
    JSON.stringify(f.apiCalls).includes("sk-synthetic-settings"),
    false,
  );
  assert.equal(
    f.apiCalls.some((c) => c.options.method === "PUT"),
    false,
  );
});

test("a false desktop save receipt never advertises configured or a success toast", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    desktopBridge: desktopBridge({
      saveKey: async () => ({ configured: false }),
    }),
    apiHandler: (path) => (path === "/settings" ? settings : undefined),
  });
  const password = await f.screen.findByLabelText("桌面密钥");
  await f.user.type(password, "sk-synthetic-false");
  await f.user.click(
    f.screen.getByRole("button", { name: "加密保存桌面 Key" }),
  );
  await f.screen.findByText(/桌面密钥尚未配置成功/);
  assert.equal((password as HTMLInputElement).value, "sk-synthetic-false");
  assert.equal(f.screen.queryByText("桌面密钥已加密保存"), null);
  assert.equal(f.screen.queryByText(/已配置模型访问/), null);
  assert.ok(f.apiCalls.filter((c) => c.path === "/settings").length >= 2);
});

test("desktop delete refreshes the model status even when local status reported saved", async (t) => {
  let configured = true;
  const f = await renderApp(t, {
    route: "#/settings",
    desktopBridge: desktopBridge({
      deleteKey: async () => {
        configured = false;
        return { configured: false };
      },
    }),
    apiHandler: (path) =>
      path === "/settings"
        ? {
            ...settings,
            model: {
              ...settings.model,
              configured,
              credentialStatus: configured ? "configured" : "not_configured",
            },
          }
        : undefined,
  });
  await f.screen.findByText(/已配置模型访问/);
  await f.user.click(f.screen.getByRole("button", { name: "清除桌面 Key" }));
  await f.screen.findAllByText(/尚未配置密钥，规则模式可正常使用/);
  assert.equal(f.screen.queryByText(/已配置模型访问/), null);
  assert.ok(f.apiCalls.filter((c) => c.path === "/settings").length >= 2);
});

test("saving endpoint refreshes the binding status without replacing form drafts", async (t) => {
  let saved = false;
  const f = await renderApp(t, {
    route: "#/settings",
    desktopBridge: desktopBridge(),
    apiHandler: (path, options) => {
      if (path !== "/settings") return undefined;
      if (options.method === "PUT") {
        saved = true;
        return { saved: true };
      }
      return {
        ...settings,
        model: {
          ...settings.model,
          configured: !saved,
          credentialStatus: saved ? "needs_configuration" : "configured",
          ...(saved ? { credentialMessage } : {}),
        },
      };
    },
  });
  const endpoint = await f.screen.findByLabelText("兼容 API endpoint");
  const password = f.screen.getByLabelText("桌面密钥");
  await f.user.clear(endpoint);
  await f.user.type(endpoint, "https://model.example.invalid/v1");
  await f.user.clear(f.screen.getByLabelText("每任务模型费用上限（元）"));
  await f.user.type(password, "sk-unsaved-password");
  await f.user.click(
    f.screen.getByRole("button", { name: "保存模型与预算设置" }),
  );
  await waitFor(() =>
    assert.ok(f.screen.getAllByText(new RegExp(credentialMessage)).length >= 2),
  );
  assert.equal(f.screen.getByLabelText("兼容 API endpoint"), endpoint);
  assert.equal(
    (endpoint as HTMLInputElement).value,
    "https://model.example.invalid/v1",
  );
  assert.equal((password as HTMLInputElement).value, "sk-unsaved-password");
});

test("credential refresh and tab navigation preserve unsaved model and budget drafts", async (t) => {
  let configured = false;
  const f = await renderApp(t, {
    route: "#/settings",
    desktopBridge: desktopBridge({
      saveKey: async () => {
        configured = true;
        return { configured: true };
      },
    }),
    apiHandler: (path) =>
      path === "/settings"
        ? {
            ...settings,
            model: { ...settings.model, configured },
          }
        : undefined,
  });
  const model = await f.screen.findByLabelText("模型名称");
  const budget = f.screen.getByLabelText("每任务模型费用上限（元）");
  await f.user.clear(model);
  await f.user.type(model, "unsaved-model");
  await f.user.clear(budget);
  await f.user.type(budget, "3");
  await f.user.type(f.screen.getByLabelText("桌面密钥"), "sk-synthetic-draft");
  await f.user.click(
    f.screen.getByRole("button", { name: "加密保存桌面 Key" }),
  );
  await f.screen.findByText(/已配置模型访问/);
  assert.equal(f.screen.getByLabelText("模型名称"), model);
  await f.user.click(f.screen.getByRole("tab", { name: "数据与备份" }));
  assert.equal(f.screen.queryByText(/workspace\.v2\.json.*schema3/), null);
  await f.user.click(f.screen.getByRole("tab", { name: "模型与预算" }));
  assert.equal(
    (f.screen.getByLabelText("模型名称") as HTMLInputElement).value,
    "unsaved-model",
  );
  assert.equal(
    (f.screen.getByLabelText("每任务模型费用上限（元）") as HTMLInputElement)
      .value,
    "3",
  );
  assert.ok(f.screen.getByRole("region", { name: "预算设置（待保存）" }));
});

test("committed model settings with failed refresh remain saved and can retry status", async (t) => {
  let committed = false,
    failRefresh = true;
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path, options) => {
      if (path !== "/settings") return undefined;
      if (options.method === "PUT") {
        committed = true;
        return { saved: true };
      }
      if (committed && failRefresh) throw Error("合成状态读取失败");
      return {
        ...settings,
        model: { ...settings.model, configured: committed },
      };
    },
  });
  const budget = await f.screen.findByLabelText("每任务模型费用上限（元）");
  await f.user.clear(budget);
  await f.user.type(budget, "2");
  await f.user.click(
    f.screen.getByRole("button", { name: "保存模型与预算设置" }),
  );
  await f.screen.findByText(/设置已保存，但配置状态刷新失败/);
  assert.ok(f.screen.getByRole("region", { name: "已保存预算设置" }));
  assert.equal(f.screen.queryByText("设置已保存"), null);
  assert.equal((budget as HTMLInputElement).value, "2");
  failRefresh = false;
  await f.user.click(f.screen.getByRole("button", { name: "刷新配置状态" }));
  await f.screen.findByText(/已配置模型访问/);
  assert.equal((budget as HTMLInputElement).value, "2");
  await waitFor(() =>
    assert.equal(f.screen.queryByText(/设置已保存，但配置状态刷新失败/), null),
  );
});

test("committed desktop key with failed refresh clears the password and reports pending status", async (t) => {
  let committed = false;
  const f = await renderApp(t, {
    route: "#/settings",
    desktopBridge: desktopBridge({
      saveKey: async () => {
        committed = true;
        return { configured: true };
      },
    }),
    apiHandler: (path) => {
      if (path !== "/settings") return undefined;
      if (committed) throw Error("合成状态读取失败");
      return settings;
    },
  });
  const password = await f.screen.findByLabelText("桌面密钥");
  await f.user.type(password, "sk-synthetic-pending");
  await f.user.click(
    f.screen.getByRole("button", { name: "加密保存桌面 Key" }),
  );
  await f.screen.findByText(/桌面密钥已加密保存，但配置状态刷新失败/);
  assert.equal((password as HTMLInputElement).value, "");
  assert.equal(f.screen.queryByText("桌面密钥已加密保存"), null);
  assert.equal(f.screen.queryByText(/已配置模型访问/), null);
  assert.ok(f.screen.getByRole("button", { name: "刷新配置状态" }));
});

test("cancelled desktop receipt and rejected deletion never show success", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    desktopBridge: desktopBridge({
      saveKey: async () => ({ configured: true, cancelled: true }),
      deleteKey: async () => {
        throw Error("合成删除失败");
      },
    }),
    apiHandler: (path) => (path === "/settings" ? settings : undefined),
  });
  const password = await f.screen.findByLabelText("桌面密钥");
  await f.user.type(password, "sk-synthetic-cancelled");
  await f.user.click(
    f.screen.getByRole("button", { name: "加密保存桌面 Key" }),
  );
  await f.screen.findByText(/未收到桌面密钥保存确认/);
  assert.equal((password as HTMLInputElement).value, "sk-synthetic-cancelled");
  await f.user.click(f.screen.getByRole("button", { name: "清除桌面 Key" }));
  await f.screen.findByText("合成删除失败");
  assert.equal(f.screen.queryByText("桌面密钥已加密保存"), null);
  assert.equal(f.screen.queryByText("桌面密钥已清除"), null);
});

test("a late mount read cannot overwrite the refresh after desktop commit", async (t) => {
  const initial = deferred<typeof settings>();
  let reads = 0;
  const f = await renderApp(t, {
    route: "#/settings",
    strictMode: true,
    desktopBridge: desktopBridge(),
    apiHandler: (path, options) => {
      if (path !== "/settings") return undefined;
      if (!reads++) return initial.promise;
      if (!options.signal?.aborted && reads === 2) return initial.promise;
      return {
        ...settings,
        model: {
          ...settings.model,
          configured: true,
          credentialStatus: "configured",
        },
      };
    },
  });
  const password = await f.screen.findByLabelText("桌面密钥");
  await f.user.type(password, "sk-synthetic-late");
  await f.user.click(
    f.screen.getByRole("button", { name: "加密保存桌面 Key" }),
  );
  await f.screen.findByText(/已配置模型访问/);
  await act(async () => initial.resolve(settings));
  assert.ok(f.screen.getByText(/已配置模型访问/));
  assert.equal(f.screen.queryByText(/尚未配置密钥，规则模式可正常使用/), null);
});

test("model edits entered while a desktop refresh waits survive its response", async (t) => {
  const refresh = deferred<typeof settings>();
  let saved = false;
  const f = await renderApp(t, {
    route: "#/settings",
    desktopBridge: desktopBridge({
      saveKey: async () => {
        saved = true;
        return { configured: true };
      },
    }),
    apiHandler: (path) =>
      path === "/settings" ? (saved ? refresh.promise : settings) : undefined,
  });
  const model = await f.screen.findByLabelText("模型名称");
  await f.user.type(
    f.screen.getByLabelText("桌面密钥"),
    "sk-synthetic-waiting",
  );
  await f.user.click(
    f.screen.getByRole("button", { name: "加密保存桌面 Key" }),
  );
  await f.user.clear(model);
  await f.user.type(model, "draft-during-refresh");
  await act(async () =>
    refresh.resolve({
      ...settings,
      model: { ...settings.model, configured: true },
    }),
  );
  await f.screen.findByText(/已配置模型访问/);
  assert.equal(f.screen.getByLabelText("模型名称"), model);
  assert.equal((model as HTMLInputElement).value, "draft-during-refresh");
});

test("an old desktop completion after unmount cannot refresh or toast in a new page", async (t) => {
  const receipt = deferred<{ configured: boolean }>();
  const f = await renderApp(t, {
    route: "#/settings",
    desktopBridge: desktopBridge({ saveKey: () => receipt.promise }),
    apiHandler: (path) => (path === "/settings" ? settings : undefined),
  });
  await f.user.type(
    await f.screen.findByLabelText("桌面密钥"),
    "sk-synthetic-old-page",
  );
  await f.user.click(
    f.screen.getByRole("button", { name: "加密保存桌面 Key" }),
  );
  await f.remount();
  const password = await f.screen.findByLabelText("桌面密钥");
  await f.user.type(password, "sk-new-page-draft");
  const reads = f.apiCalls.filter((c) => c.path === "/settings").length;
  await act(async () => receipt.resolve({ configured: true }));
  assert.equal(f.apiCalls.filter((c) => c.path === "/settings").length, reads);
  assert.equal((password as HTMLInputElement).value, "sk-new-page-draft");
  assert.equal(f.screen.queryByText("桌面密钥已加密保存"), null);
  assert.equal(f.screen.queryByText(/已配置模型访问/), null);
});

test("unavailable OS encryption and an inconsistent deletion receipt cannot claim success", async (t) => {
  let saves = 0;
  const f = await renderApp(t, {
    route: "#/settings",
    desktopBridge: desktopBridge({
      isAvailable: async () => false,
      saveKey: async () => {
        saves++;
        return { configured: true };
      },
      deleteKey: async () => ({ configured: true }),
    }),
    apiHandler: (path) => (path === "/settings" ? settings : undefined),
  });
  const password = await f.screen.findByLabelText("桌面密钥");
  await f.user.type(password, "sk-synthetic-no-encryption");
  await f.user.click(
    f.screen.getByRole("button", { name: "加密保存桌面 Key" }),
  );
  await f.screen.findByText("系统加密不可用，不能保存密钥。");
  assert.equal(saves, 0);
  await f.user.click(f.screen.getByRole("button", { name: "清除桌面 Key" }));
  await f.screen.findByText(/桌面密钥尚未清除/);
  assert.equal(
    (password as HTMLInputElement).value,
    "sk-synthetic-no-encryption",
  );
  assert.equal(f.screen.queryByText("桌面密钥已加密保存"), null);
  assert.equal(f.screen.queryByText("桌面密钥已清除"), null);
});

test("legacy assignment explains the actual record and whitelisted move counts", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path) => {
      if (path === "/settings") return settings;
      if (path === "/legacy-records")
        return {
          records: [{ recordId: "legacy-summary", title: "合成历史投递" }],
        };
      if (path === "/legacy-records/legacy-summary")
        return {
          root: {
            recordId: "legacy-summary",
            applicationId: "old-app",
            jobId: "old-job",
            status: "applied",
            note: "合成历史备注",
            updatedAt: "2026-10-09T01:00:00Z",
          },
          records: [
            {
              collection: "applications",
              record: { recordId: "legacy-summary", applicationId: "old-app" },
            },
            {
              collection: "jobs",
              record: {
                canonical: { title: "合成旧岗位", company: "合成旧单位" },
              },
            },
          ],
          counts: { applications: 1, jobs: 1, events: 0 },
          privatePayload: "PRIVATE_LEGACY_SENTINEL",
        };
      if (path === "/legacy-records/assignment-preview")
        return {
          workspaceRevision: 1,
          planHash: "summary-plan",
          recordIds: ["legacy-summary"],
          counts: {
            applications: 1,
            jobs: 1,
            events: 0,
            unknown: "PRIVATE_LEGACY_SENTINEL",
          },
        };
    },
  });
  await f.user.click(f.screen.getByRole("tab", { name: "版本维护" }));
  await f.user.click(
    await f.screen.findByRole("button", { name: "分配合成历史投递" }),
  );
  const record = await f.screen.findByRole("region", {
    name: "旧记录内容摘要",
  });
  assert.ok(within(record).getByText("合成旧岗位"));
  assert.ok(within(record).getByText("合成旧单位"));
  assert.ok(within(record).getByText("投递记录", { selector: "p" }));
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /PRIVATE_LEGACY_SENTINEL|"root"/,
  );
  await f.user.click(f.screen.getByRole("button", { name: "预览归属移动" }));
  const counts = await f.screen.findByRole("region", {
    name: "归属移动内容计数",
  });
  assert.equal(
    within(counts).getByText("投递记录").nextElementSibling?.textContent,
    "1",
  );
  assert.equal(
    within(counts).getByText("变更事件").nextElementSibling?.textContent,
    "0",
  );
  assert.equal(
    within(counts).getByText("文件").nextElementSibling?.textContent,
    "未统计",
  );
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /PRIVATE_LEGACY_SENTINEL/,
  );
});

test("dedup preview explains keep and remove counts without using technical IDs as titles", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path) =>
      path === "/jobs/duplicates/preview"
        ? {
            workspaceRevision: 1,
            planHash: "readable-plan",
            groups: [
              {
                groupId: "readable",
                packageId: "A",
                versionName: "合成目标A",
                keepJobId: "technical-kept",
                removeJobIds: ["technical-removed"],
                reasons: ["authority_id"],
              },
            ],
          }
        : path === "/settings"
          ? settings
          : undefined,
  });
  await f.user.click(f.screen.getByRole("tab", { name: "版本维护" }));
  await f.user.click(
    f.screen.getByRole("button", { name: "预览所有版本去重" }),
  );
  const group = await f.screen.findByRole("region", {
    name: "合成目标A去重摘要",
  });
  assert.ok(within(group).getByText("岗位标题未提供"));
  assert.ok(within(group).getByText("保留 1 条；归并删除 1 条。"));
  assert.ok(within(group).getByText(/可信来源岗位编号相同/));
  assert.equal(f.screen.queryByText("technical-kept"), null);
  await f.user.click(within(group).getByRole("button", { name: "技术详情" }));
  assert.ok(within(group).getByText("technical-kept"));
  assert.equal(
    f.apiCalls.some(
      (c) =>
        c.path.startsWith("/jobs/") && !c.path.startsWith("/jobs/duplicates"),
    ),
    false,
  );
});

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

test("dedup completion distinguishes explicit zero from unreported totals", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path) =>
      path === "/jobs/duplicates/preview"
        ? {
            workspaceRevision: 1,
            planHash: "zero-counts",
            groups: [
              {
                groupId: "zero-group",
                packageId: "A",
                versionName: "合成目标A",
                keepJobId: "kept-zero",
                removeJobIds: ["duplicate-zero"],
              },
            ],
          }
        : path === "/jobs/duplicates/apply"
          ? {
              totals: { removedEntities: 0, affectedVersions: 0 },
              packages: [
                {
                  packageId: "A",
                  versionName: "合成目标A",
                  counts: { removedEntities: 0 },
                },
              ],
            }
          : path === "/settings"
            ? settings
            : undefined,
  });
  await f.user.click(f.screen.getByRole("tab", { name: "版本维护" }));
  await f.user.click(
    f.screen.getByRole("button", { name: "预览所有版本去重" }),
  );
  await f.user.click(
    await f.screen.findByRole("button", { name: "确认清理所选重复岗位" }),
  );
  assert.ok(
    await f.screen.findByText(
      "已清理重复实体 0 条，版本内归并 未统计 条，涉及 0 个版本。",
    ),
  );
  assert.ok(f.screen.getByText("合成目标A：清理 0，保护 未统计"));
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
  assert.ok(
    within(protectedGroup.closest("section")!).getByText(
      "保留 2 条；自动删除 0 条。",
    ),
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
  await f.user.click(await f.screen.findByRole("button", { name: "技术详情" }));
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
  await f.user.click(await f.screen.findByRole("button", { name: "技术详情" }));
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
