import test from "node:test";
import assert from "node:assert/strict";
import { act, waitFor, within } from "@testing-library/react";
import {
  renderApp,
  syntheticApi,
  syntheticTargets,
} from "../helpers/react-fixture";

const scope = { packageId: "A", targetRevisionId: "t1@1" };
const posts = (f: Awaited<ReturnType<typeof renderApp>>) =>
  f.apiCalls.filter((c) => c.path === "/runs" && c.options.method === "POST");
const root = (status: string, extra = {}) => ({
  runId: "startup-root",
  collectionRole: "collection_root",
  ownerPackageId: "A",
  targetSnapshot: { revisionId: "t1@1" },
  collectionProgress: {
    status,
    revision: 1,
    limits: { maxRequests: 120, maxCostCny: 10 },
    units: {},
    ...extra,
  },
});

test("a deliberately paused startup releases its preparation state without waiting for a redundant refresh", async (t) => {
  let reads = 0;
  let release!: (value: unknown) => void;
  const paused = { collections: [root("paused", { manualPaused: true })] };
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    await act(async () => release(paused));
  });
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => {
      if (p === "/collections") return ++reads === 1 ? paused : slow;
      return syntheticApi(p, o);
    },
  });
  await f.screen.findByText("活动已主动暂停，可手动继续采集。");
  await waitFor(() =>
    assert.equal(!!f.screen.queryByText("正在准备岗位更新…"), false),
  );
  assert.equal(posts(f).length, 0);
});

test("startup updates the selected target once with local rules across page navigation", async (t) => {
  let activity: unknown = null;
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => {
      if (p === "/collections")
        return { collections: activity ? [activity] : [] };
      if (p === "/runs" && o.method === "POST") {
        activity = root("collecting", { activeSliceRunId: "startup-slice" });
        return { runId: "startup-slice", status: "queued" };
      }
      return syntheticApi(p, o);
    },
  });
  await waitFor(() => assert.equal(posts(f).length, 1));
  assert.deepEqual(posts(f)[0].scope, scope);
  assert.deepEqual(posts(f)[0].body, {
    mode: "rules",
    coverageMode: "standard",
  });
  assert.ok(await f.screen.findByText("启动自动更新已开始"));
  await f.user.click(f.screen.getByRole("link", { name: "工作台" }));
  await f.screen.findByText("持续采集活动");
  await f.user.click(f.screen.getByRole("link", { name: "招聘来源" }));
  assert.equal(posts(f).length, 1);
});

test("one enabled target is automatically selected on startup", async (t) => {
  const f = await renderApp(t, {
    startupUpdate: true,
    apiHandler: (p, o) => {
      if (p === "/targets")
        return {
          targets: [
            syntheticTargets[0],
            { ...syntheticTargets[1], enabled: false },
          ],
        };
      if (p === "/collections") return { collections: [] };
      if (p === "/runs" && o.method === "POST")
        return { runId: "auto-single", status: "queued" };
      return syntheticApi(p, o);
    },
  });
  await waitFor(() => assert.equal(posts(f).length, 1));
  assert.deepEqual(posts(f)[0].scope, scope);
  assert.match(window.location.hash, /packageId=A/);
});

test("multiple unselected targets wait for a choice and later switches do not create startup tasks", async (t) => {
  const f = await renderApp(t, {
    startupUpdate: true,
    apiHandler: (p, o) => {
      if (p === "/collections") return { collections: [] };
      if (p === "/runs" && o.method === "POST")
        return { runId: "chosen-A", status: "queued" };
      return syntheticApi(p, o);
    },
  });
  await f.screen.findByText("选择一个启用目标后，本次启动将自动更新岗位。");
  assert.equal(posts(f).length, 0);
  await f.selectTarget(scope);
  await waitFor(() => assert.equal(posts(f).length, 1));
  await f.selectTarget({ packageId: "B", targetRevisionId: "t2@1" });
  await act(async () => new Promise((resolve) => setImmediate(resolve)));
  assert.equal(posts(f).length, 1);
});

for (const [status, extra, message] of [
  ["paused", { manualPaused: true }, "活动已主动暂停，可手动继续采集。"],
  ["waiting_for_auth", {}, "需要在独立采集窗口登录，完成后可手动继续。"],
  ["budget_exhausted", {}, "活动累计额度不足，请在工作台查看额度。"],
  [
    "paused",
    { replanRequired: true },
    "来源或查询已变化，请到工作台确认重新规划。",
  ],
] as const)
  test(
    "startup preserves the existing " + status + " boundary " + message,
    async (t) => {
      const f = await renderApp(t, {
        startupUpdate: true,
        route: "#/sources?packageId=A&targetRevisionId=t1%401",
        apiHandler: (p, o) =>
          p === "/collections"
            ? { collections: [root(status, extra)] }
            : syntheticApi(p, o),
      });
      await f.screen.findByText(message);
      assert.equal(posts(f).length, 0);
      assert.equal(
        f.apiCalls.some(
          (c) => c.options.method === "POST" && c.path.endsWith("/resume"),
        ),
        false,
      );
    },
  );

test("startup joins a running activity and never creates another root", async (t) => {
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections"
        ? {
            collections: [
              root("collecting", { activeSliceRunId: "existing-slice" }),
            ],
          }
        : syntheticApi(p, o),
  });
  await f.screen.findByText("已有岗位更新正在进行，继续显示该任务。");
  assert.equal(posts(f).length, 0);
});

test("startup response failure is visible and manual source update remains available", async (t) => {
  let attempts = 0;
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => {
      if (p === "/collections") return { collections: [] };
      if (p === "/runs" && o.method === "POST") {
        if (++attempts === 1)
          throw Object.assign(Error("合成断网，岗位保留"), {
            diagnosticId: "d-startup-network",
          });
        return { runId: "manual-after-error", status: "queued" };
      }
      return syntheticApi(p, o);
    },
  });
  await f.screen.findByText("合成断网，岗位保留");
  assert.equal(posts(f).length, 1);
  await f.user.click(f.screen.getByRole("button", { name: "手动更新岗位" }));
  await waitFor(() => assert.equal(posts(f).length, 2));
  assert.ok(await f.screen.findByText("手动岗位更新已开始"));
  assert.deepEqual(posts(f)[1].scope, scope);
});

test("manual source update shares startup's pending mutation", async (t) => {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => {
      if (p === "/collections") return { collections: [] };
      if (p === "/runs" && o.method === "POST") return pending;
      return syntheticApi(p, o);
    },
  });
  await waitFor(() => assert.equal(posts(f).length, 1));
  const button = f.screen.getByRole("button", {
    name: "手动更新岗位",
  }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  await f.user.click(button);
  assert.equal(posts(f).length, 1);
  await act(async () => {
    release({ runId: "delayed-start", status: "queued" });
  });
});

test("all-target read-only view cannot start an automatic update even with a single target", async (t) => {
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/sources?allTargets=true",
    apiHandler: (p, o) =>
      p === "/targets"
        ? { targets: [syntheticTargets[0]] }
        : syntheticApi(p, o),
  });
  await f.screen.findByRole("heading", { name: "招聘来源" });
  assert.equal(posts(f).length, 0);
  const panel = f.screen.getByRole("region", { name: "岗位更新" });
  assert.equal(
    (
      within(panel).getByRole("button", {
        name: "手动更新岗位",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
});

test("startup resumes only a refresh-ready paused activity using its existing budget and rules", async (t) => {
  const activity = root("paused", { manualPaused: false, refreshReady: true });
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => {
      if (p === "/collections") return { collections: [activity] };
      if (p === "/collections/startup-root/resume")
        return { runId: "resumed-slice", status: "queued" };
      return syntheticApi(p, o);
    },
  });
  await f.screen.findByText("启动自动更新已开始");
  assert.equal(posts(f).length, 0);
  const call = f.apiCalls.find(
    (c) => c.path === "/collections/startup-root/resume",
  )!;
  assert.equal((call.body as Record<string, unknown>).automatic, true);
  assert.equal((call.body as Record<string, unknown>).mode, "rules");
  assert.equal(Object.hasOwn(call.body as object, "limits"), false);
  assert.deepEqual(call.scope, scope);
});

test("disabled and missing-resume targets never start an automatic collection", async (t) => {
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/targets"
        ? {
            targets: [
              { ...syntheticTargets[0], enabled: false },
              { ...syntheticTargets[1], profileSnapshot: undefined },
            ],
          }
        : syntheticApi(p, o),
  });
  await f.screen.findByText("当前目标已停用，启用后可更新岗位。");
  assert.equal(posts(f).length, 0);
  await f.selectTarget({ packageId: "B", targetRevisionId: "t2@1" });
  await f.screen.findByText("当前目标缺少简历副本，请完善后更新岗位。");
  assert.equal(posts(f).length, 0);
});

test("late startup response stays in its original version and does not start another target", async (t) => {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => {
      if (p === "/collections") return { collections: [] };
      if (p === "/runs" && o.method === "POST") return pending;
      return syntheticApi(p, o);
    },
  });
  await waitFor(() => assert.equal(posts(f).length, 1));
  await f.selectTarget({ packageId: "B", targetRevisionId: "t2@1" });
  assert.equal(
    (
      f.screen.getByRole("button", {
        name: "手动更新岗位",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  await act(async () => {
    release({ runId: "old-A", status: "queued" });
  });
  await waitFor(() =>
    assert.equal(
      (
        f.screen.getByRole("button", {
          name: "手动更新岗位",
        }) as HTMLButtonElement
      ).disabled,
      false,
    ),
  );
  assert.equal(f.screen.queryByText("启动自动更新已开始"), null);
  assert.equal(posts(f).length, 1);
  assert.deepEqual(posts(f)[0].scope, scope);
});

test("React effect replay performs one startup update", async (t) => {
  const f = await renderApp(t, {
    startupUpdate: true,
    strictMode: true,
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => {
      if (p === "/collections") return { collections: [] };
      if (p === "/runs" && o.method === "POST")
        return { runId: "strict-single", status: "queued" };
      return syntheticApi(p, o);
    },
  });
  await f.screen.findByText("启动自动更新已开始");
  assert.equal(posts(f).length, 1);
});

test("a new application client updates again after the previous activity completed", async (t) => {
  const options = {
    startupUpdate: true,
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p: string, o: Parameters<typeof syntheticApi>[1]) => {
      if (p === "/collections") return { collections: [root("completed")] };
      if (p === "/runs" && o.method === "POST")
        return { runId: "new-launch", status: "queued" };
      return syntheticApi(p, o);
    },
  };
  const first = await renderApp(t, options);
  await waitFor(() => assert.equal(posts(first).length, 1));
  first.unmount();
  const second = await renderApp(t, options);
  await waitFor(() => assert.equal(posts(second).length, 1));
  assert.deepEqual(posts(second)[0].scope, scope);
});

test("remounting the same launched client observes its pending update without a second POST", async (t) => {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => {
      if (p === "/collections") return { collections: [] };
      if (p === "/runs" && o.method === "POST") return pending;
      return syntheticApi(p, o);
    },
  });
  await waitFor(() => assert.equal(posts(f).length, 1));
  await f.remount();
  release({ runId: "remounted-update", status: "queued" });
  await f.screen.findByText("启动自动更新已开始");
  assert.equal(posts(f).length, 1);
});

test("workbench connects startup updates to completion and shows the actual saved counters", async (t) => {
  let activity: unknown = null;
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => {
      if (p === "/collections")
        return { collections: activity ? [activity] : [] };
      if (p === "/runs" && o.method === "POST") {
        activity = root("collecting", { activeSliceRunId: "auto-finish" });
        return { runId: "auto-finish", status: "queued" };
      }
      if (p === "/runs/auto-finish/events") {
        activity = root("completed");
        return [
          {
            type: "done",
            payload: {
              status: "completed",
              counts: { raw: 5, deduplicated: 4, shortlisted: 1 },
            },
          },
        ];
      }
      return syntheticApi(p, o);
    },
  });
  await f.screen.findByText("岗位更新完成");
  assert.ok(f.screen.getByText("采集 5 条 · 保存 4 条 · 候选 1 条"));
  assert.equal(posts(f).length, 1);
});

test("returning to the workbench reconnects its newer manual run instead of cached startup history", async (t) => {
  let started = 0,
    manualConnections = 0;
  let activity: unknown = null;
  let rejectRecovered!: (error: Error) => void;
  const recoveredStream = new Promise((_, reject) => {
    rejectRecovered = reject;
  });
  const f = await renderApp(t, {
    startupUpdate: true,
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => {
      if (p === "/collections")
        return { collections: activity ? [activity] : [] };
      if (p === "/runs" && o.method !== "POST")
        return {
          runs:
            started > 1 ? [{ runId: "current-manual", status: "running" }] : [],
        };
      if (p === "/runs" && o.method === "POST") {
        started++;
        activity = root("collecting", {
          activeSliceRunId: started === 1 ? "old-auto" : "current-manual",
        });
        return {
          runId: started === 1 ? "old-auto" : "current-manual",
          status: "queued",
        };
      }
      if (p === "/runs/old-auto/events") {
        activity = root("completed");
        return [{ type: "done", payload: { status: "completed" } }];
      }
      if (p === "/runs/current-manual/events") {
        manualConnections++;
        return manualConnections === 2
          ? recoveredStream
          : [{ type: "status", payload: { status: "running" } }];
      }
      return syntheticApi(p, o);
    },
  });
  await f.screen.findByText("岗位更新完成");
  await f.user.click(
    f.screen.getByRole("button", { name: "更新岗位", exact: true }),
  );
  await waitFor(() => assert.equal(manualConnections, 1));
  await f.user.click(
    f.screen.getByRole("link", { name: "招聘来源", exact: true }),
  );
  await f.user.click(
    f.screen.getByRole("link", { name: "工作台", exact: true }),
  );
  await waitFor(() => assert.equal(manualConnections, 2));
  rejectRecovered(Error("synthetic stream failure"));
  await f.user.click(
    await f.screen.findByRole("button", { name: "重新连接任务" }),
  );
  await waitFor(() =>
    assert.equal(
      f.apiCalls.filter((c) => c.path.endsWith("/events")).at(-1)?.path,
      "/runs/current-manual/events",
    ),
  );
});
