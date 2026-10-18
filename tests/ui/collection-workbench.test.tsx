import test from "node:test";
import assert from "node:assert/strict";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
import { act, render, cleanup, waitFor, within } from "@testing-library/react";
import { RecruitmentEvidence } from "../../ui/src/features/jobs/RecruitmentEvidence";
const root = {
  runId: "activity-A",
  collectionRole: "collection_root",
  status: "completed",
  collectionProgress: {
    status: "paused",
    revision: 4,
    units: {
      one: { status: "completed", siteId: "s1", committedPages: 3 },
      two: { status: "pending", siteId: "s2", committedPages: 0 },
    },
    metrics: { committedPages: 3, newUnique: 8 },
    limits: {
      maxRequests: 400,
      maxCostCny: 10,
      maxSites: 24,
      maxPagesPerQuery: 4,
    },
  },
  collectionUsage: {
    usedRequests: 12,
    costUpperBoundCny: 3.2,
    reservedCostCny: 0.2,
    usedBytes: 1024,
  },
};
test('activity unit summary is authoritative when the returned unit controls are a partial page',async t=>{
  const activity={...root,collectionProgress:{...root.collectionProgress,unitPage:{hasMore:true,nextCursor:'next'},unitSummary:{plannedSites:2,actualSites:2,pendingUnits:249,totalUnits:250}}};
  const f=await renderApp(t,{route:'#/workbench?packageId=A&targetRevisionId=t1%401',apiHandler:(path,options)=>path==='/collections'?{collections:[activity]}:syntheticApi(path,options)});
  await f.screen.findByText('持续采集活动');const region=f.screen.getByRole('region',{name:'当前采集活动'});assert.match(region.textContent!,/计划 2 站 · 实际 2 站 ·\s*未覆盖或未完成 249 个单元/);
});
test("current collection region uses the root status and does not imply a completed child finished the activity", async (t) => {
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections" ? { collections: [root] } : syntheticApi(p, o),
  });
  await f.screen.findByText("持续采集活动");
  assert.equal(
    f.screen.getAllByRole("region", { name: "当前采集活动" }).length,
    1,
  );
  assert.match(
    f.screen.getByRole("region", { name: "当前采集活动" }).textContent!,
    /已暂停，可继续/,
  );
  assert.equal(f.screen.queryByText("计划范围已完成"), null);
});

test("pause acceptance shows draining and only confirms completion after the shared state reports paused", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let activity = {
    ...root,
    collectionProgress: {
      ...root.collectionProgress,
      status: "collecting",
      draining: false,
      stopIntent: null as "pause" | null,
    },
  };
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, options) => {
      if (path === "/collections") return { collections: [activity] };
      if (path === "/collections/activity-A/pause") {
        activity = {
          ...activity,
          collectionProgress: {
            ...activity.collectionProgress,
            draining: true,
            stopIntent: "pause",
          },
        };
        return { ...activity, accepted: true, action: "pause", draining: true };
      }
      return syntheticApi(path, options);
    },
  });
  await f.user.click(await f.screen.findByRole("button", { name: "暂停采集" }));
  await waitFor(() =>
    assert.match(
      f.screen.getByRole("region", { name: "当前采集活动" }).textContent!,
      /已受理暂停，正在排空/,
    ),
  );
  assert.equal(f.screen.queryByText("活动已暂停"), null);
  assert.equal(
    (f.screen.getByRole("button", { name: "继续采集" }) as HTMLButtonElement)
      .disabled,
    true,
  );
  activity = {
    ...activity,
    collectionProgress: {
      ...activity.collectionProgress,
      status: "paused",
      draining: false,
      stopIntent: null,
    },
  };
  await act(async () => t.mock.timers.tick(2000));
  await waitFor(() =>
    assert.match(
      f.screen.getByRole("region", { name: "当前采集活动" }).textContent!,
      /活动已暂停/,
    ),
  );
});
async function pausedSliceFixture(
  t: Parameters<typeof renderApp>[0],
  {
    resumeError = false,
    terminalStatus,
  }: { resumeError?: boolean; terminalStatus?: "completed" | "partial" } = {},
) {
  let activity = {
    ...root,
    collectionProgress: {
      ...root.collectionProgress,
      status: "collecting",
      activeSliceRunId: "slice-before-pause" as string | null,
    },
  };
  let finishOld: (events: unknown) => void = () => {};
  const oldEvents = new Promise((resolve) => (finishOld = resolve));
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: async (p, o) => {
      if (p === "/collections") return { collections: [activity] };
      if (p === "/collections/activity-A") return activity;
      if (p === "/runs")
        return {
          runs: [
            {
              runId: "slice-before-pause",
              status: "running",
              stage: "collecting",
            },
          ],
        };
      if (p === "/runs/slice-before-pause/events") return oldEvents;
      if (p === "/collections/activity-A/pause") {
        // The backend closes the old slice before returning the paused root.
        finishOld([{ type: "done", payload: { status: "cancelled" } }]);
        await new Promise((resolve) => setImmediate(resolve));
        activity = {
          ...activity,
          collectionProgress: {
            ...activity.collectionProgress,
            status: "paused",
            activeSliceRunId: null,
          },
        };
        return {};
      }
      if (p === "/collections/activity-A/resume") {
        if (resumeError) throw Error("合成续采失败");
        activity = {
          ...activity,
          collectionProgress: {
            ...activity.collectionProgress,
            status: "collecting",
            activeSliceRunId: "slice-after-resume",
          },
        };
        return { runId: "slice-after-resume", status: "queued" };
      }
      if (p === "/runs/slice-after-resume/events")
        return [
          {
            type: "stage",
            payload: { status: "running", stage: "collecting" },
          },
          ...(terminalStatus
            ? [{ type: "done", payload: { status: terminalStatus } }]
            : []),
        ];
      return syntheticApi(p, o);
    },
  });
  await f.screen.findByText("持续采集活动");
  await waitFor(() =>
    assert.ok(
      f.apiCalls.some((c) => c.path === "/runs/slice-before-pause/events"),
    ),
  );
  await f.user.click(f.screen.getByRole("button", { name: "暂停采集" }));
  await f.screen.findAllByText("活动已暂停");
  await f.screen.findByText("上次批次已取消，当前活动状态以采集活动为准");
  return f;
}
test("resuming a paused activity clears the previous slice cancellation outcome", async (t) => {
  const f = await pausedSliceFixture(t);
  await f.user.click(f.screen.getByRole("button", { name: "继续采集" }));
  await f.screen.findAllByText("已继续采集，沿用活动累计额度");
  assert.match(
    f.screen.getByRole("region", { name: "当前采集活动" }).textContent!,
    /正在采集/,
  );
  await f.screen.findByText(/阶段：采集岗位/);
  assert.equal(
    f.screen.queryByText("任务已取消") === null,
    true,
    "the active slice must not show the previous cancellation outcome",
  );
});
test("a failed resume preserves the previous slice result as history", async (t) => {
  const f = await pausedSliceFixture(t, { resumeError: true });
  await f.user.click(f.screen.getByRole("button", { name: "继续采集" }));
  await f.screen.findAllByText(/合成续采失败/);
  assert.ok(f.screen.getByText("上次批次已取消，当前活动状态以采集活动为准"));
  assert.equal(
    f.apiCalls.some((c) => c.path === "/runs/slice-after-resume/events"),
    false,
  );
});
for (const status of ["completed", "partial"] as const)
  test(`a resumed slice still shows its ${status} terminal outcome`, async (t) => {
    const f = await pausedSliceFixture(t, { terminalStatus: status });
    await f.user.click(f.screen.getByRole("button", { name: "继续采集" }));
    await f.screen.findByText(
      status === "completed"
        ? "岗位更新完成"
        : "岗位更新部分完成，请查看覆盖与回退提示",
    );
    assert.equal(f.screen.queryByText("任务已取消"), null);
  });
test("advanced activity counts expose byte and attachment occupancy independently of spare requests", async (t) => {
  const byteLimited = {
    ...root,
    collectionProgress: {
      ...root.collectionProgress,
      limits: {
        ...root.collectionProgress.limits,
        maxDetails: 87,
        maxAttachments: 10,
        maxTotalAttachmentBytes: 104857600,
      },
    },
    collectionUsage: {
      ...root.collectionUsage,
      usedDetails: 27,
      usedAttachments: 2,
      usedBytes: 104574484,
    },
  };
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections"
        ? { collections: [byteLimited] }
        : syntheticApi(p, o),
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "高级计数与额度" }),
  );
  assert.ok(f.screen.getByText(/详情占额 27 \/ 87.*附件占额 2 \/ 10/));
  assert.ok(f.screen.getByText(/累计字节占额 104574484 \/ 104857600 字节/));
  assert.ok(f.screen.getByText(/失败或未确认完成的请求保留用量上界/));
});
test("quality reports measured numerator/denominator and keeps unknown requests separate", async (t) => {
  const measured = {
    ...root,
    quality: {
      uniqueRecords: 8,
      bodyVerified: 6,
      open: 3,
      applicationAvailable: 2,
      qualificationPass: 4,
      qualificationUnknown: 3,
      qualificationFail: 1,
      historicalOrExpired: 2,
      suspectedDuplicates: 1,
      validNewUnique: 1,
      knownRequests: 10,
      unknownRequestUpperBound: 2,
      validPer100KnownRequests: 10,
    },
  };
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections" ? { collections: [measured] } : syntheticApi(p, o),
  });
  await f.screen.findByText(/正文已核验 6 \/ 8/);
  assert.ok(f.screen.getByText(/有效新增 1 \/ 已核实请求 10/));
  assert.ok(f.screen.getByText(/未知请求上界 2/));
  assert.ok(f.screen.getByText(/召回率与误合并率：未测量/));
});
test("job evidence labels expired and invalid and separates stale platform observations", (t) => {
  t.after(cleanup);
  const view = render(
    <RecruitmentEvidence
      row={{
        jobId: "synthetic",
        recruitmentEvidence: {
          bodyVerified: true,
          openingStatus: "expired",
          applicationStatus: "invalid",
        },
        platformEvidence: {
          opening: {
            status: "verified",
            value: "recruiting",
            checkedAt: "2026-10-01T00:00:00Z",
          },
          entry: { kind: "communication", status: "verified" },
        },
      }}
    />,
  );
  assert.ok(view.getByText("已过期"));
  assert.ok(view.getByText("入口失效"));
  assert.ok(within(view.getByRole("note")).getByText("平台观察"));
  assert.ok(within(view.getByRole("note")).getByText(/^待复核/));
  assert.ok(view.getByText(/沟通入口.*不构成投递证据/));
});
test("communication-only job keeps application unverified even with a current platform status", (t) => {
  t.after(cleanup);
  const view = render(
    <RecruitmentEvidence
      row={{
        jobId: "synthetic",
        recruitmentEvidence: {
          bodyVerified: true,
          openingStatus: "unknown",
          applicationStatus: "unknown",
        },
        platformEvidence: {
          opening: {
            status: "verified",
            value: "recruiting",
            checkedAt: new Date().toISOString(),
          },
          entry: { kind: "communication", status: "verified" },
        },
      }}
    />,
  );
  assert.ok(view.getByText("投递入口待核验"));
  assert.ok(within(view.getByRole("note")).getByText("平台观察"));
  assert.ok(within(view.getByRole("note")).getByText(/^在招/));
  assert.ok(view.getByText(/沟通入口.*不构成投递证据/));
});
test("review: source changes can replan the same activity with preserved cost", async (t) => {
  const changed = {
    ...root,
    collectionProgress: { ...root.collectionProgress, replanRequired: true },
  };
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections"
        ? { collections: [changed] }
        : p === "/collections/activity-A"
          ? changed
          : p.endsWith("/resume")
            ? new Promise(() => {})
            : syntheticApi(p, o),
  });
  await f.screen.findByText(/活动累计费用上界 ¥3.20/);
  await f.user.click(
    f.screen.getByRole("button", { name: "确认重新规划并继续" }),
  );
  const call = f.apiCalls.find((c) => c.path.endsWith("/resume"));
  assert.ok(call);
  assert.ok(call.options.body && typeof call.options.body === "object" && "replan" in call.options.body);
  assert.equal(call.options.body.replan, true);
  assert.equal(call?.path, "/collections/activity-A/resume");
});
test("root progress retains cumulative costs; repeated resume sends one request", async (t) => {
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections"
        ? { collections: [root] }
        : p === "/collections/activity-A"
          ? root
          : p.endsWith("/resume")
            ? new Promise(() => {})
            : syntheticApi(p, o),
  });
  await f.screen.findByText(/活动累计费用上界 ¥3.20/);
  await f.user.dblClick(f.screen.getByRole("button", { name: "继续采集" }));
  assert.equal(f.apiCalls.filter((c) => c.path.endsWith("/resume")).length, 1);
});
test("failed limits keep draft and business history does not count slices", async (t) => {
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections"
        ? { collections: [root] }
        : p === "/collections/activity-A"
          ? root
          : p.endsWith("/limits")
            ? Promise.reject(Error("保存失败"))
            : syntheticApi(p, o),
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "高级计数与额度" }),
  );
  const input = f.screen.getByLabelText("活动请求上限");
  await f.user.clear(input);
  await f.user.type(input, "600");
  await f.user.click(f.screen.getByRole("button", { name: "保存活动额度" }));
  await f.screen.findByText(/保存失败/);
  assert.equal((input as HTMLInputElement).value, "600");
});
test("history contains one root for two collection slices", async (t) => {
  const f = await renderApp(t, {
    route: "#/logs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections"
        ? { collections: [root] }
        : p === "/runs"
          ? {
              runs: [
                {
                  runId: "slice1",
                  collectionRole: "collection_slice",
                  status: "completed",
                },
                {
                  runId: "slice2",
                  collectionRole: "collection_slice",
                  status: "partial",
                },
              ],
            }
          : syntheticApi(p, o),
  });
  await f.user.click(await f.screen.findByRole("button", { name: "技术详情" }));
  await f.screen.findByText("activity-A");
  assert.equal(f.screen.queryByText("slice1"), null);
  assert.equal(f.screen.queryByText("slice2"), null);
  assert.ok(f.screen.getByText(/¥3.20/));
});
