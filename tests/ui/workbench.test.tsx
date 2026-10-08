import test from "node:test";
import assert from "node:assert/strict";
import { act } from "@testing-library/react";
import { renderApp, syntheticApi } from "../helpers/react-fixture";

test("terminal progress uses real backend counters and explains page limits and monetary fallback", async (t) => {
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, options) =>
      path === "/runs" && options.method === "POST"
        ? { runId: "r-limits", status: "running" }
        : path.endsWith("/events")
          ? [
              {
                type: "done",
                payload: {
                  status: "partial",
                  counts: {
                    raw: 593,
                    deduplicated: 282,
                    shortlisted: 197,
                    aiSuccess: 148,
                    fallback: 134,
                  },
                  degraded: true,
                  coverage: [
                    {
                      siteId: "synthetic-one",
                      status: "complete",
                      truncated: true,
                      truncationReason: "page_limit",
                      pages: 2,
                    },
                  ],
                  usage: {
                    sources: { requests: 72, maxRequests: 120 },
                    model: {
                      costMode: "cny_upper_bound",
                      costUpperBoundCny: 1.25,
                      maxCostCny: 10,
                      reservedCostCny: 0.25,
                      uncertainCostCny: 0.1,
                      requests: 32,
                      maxRequests: 1000,
                    },
                  },
                  issues: [{ code: "model_budget_exhausted" }],
                },
              },
            ]
          : syntheticApi(path, options),
  });
  await f.user.click(await f.screen.findByRole("button", { name: "更新岗位" }));
  await f.screen.findByText("采集 593 条 · 保存 282 条 · 候选 197 条");
  assert.ok(await f.screen.findByText(/部分来源达到分页上限/));
  assert.ok(await f.screen.findByText(/模型费用上界 ¥1.25 \/ ¥10/));
  assert.ok(await f.screen.findByText(/部分模型评价已回退规则/));
  assert.equal(f.screen.queryByText(/结果未覆盖全部来源/), null);
});

test("a committed AI run clears its temporary key and switching version discards a new draft", async (t) => {
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path === "/runs" && opts.method === "POST"
        ? { runId: "r-temp", status: "running" }
        : path.endsWith("/events")
          ? [{ type: "done", payload: { status: "completed" } }]
          : syntheticApi(path, opts),
  });
  await f.user.click(f.screen.getByRole("button", { name: "运行选项" }));
  await f.user.click(f.screen.getByRole("button", { name: "模型辅助" }));
  await f.user.type(
    f.screen.getByLabelText("本次更新临时模型密钥"),
    "sk-synthetic-temporary-key",
  );
  await f.user.click(f.screen.getByRole("button", { name: "更新岗位" }));
  await f.screen.findByText("岗位更新完成");
  assert.equal(
    (f.screen.getByLabelText("本次更新临时模型密钥") as HTMLInputElement).value,
    "",
  );
  await f.user.type(
    f.screen.getByLabelText("本次更新临时模型密钥"),
    "sk-synthetic-unsent-draft",
  );
  await f.selectTarget({ packageId: "B", targetRevisionId: "t2@1" });
  assert.equal(f.screen.queryByLabelText("本次更新临时模型密钥"), null);
  assert.equal(
    f.apiCalls.filter((c) => c.path === "/runs" && c.options.method === "POST")
      .length,
    1,
  );
});
test("a disconnected run can be reconnected in its exact scope", async (t) => {
  let attempts = 0;
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path === "/runs" && opts.method === "POST"
        ? { runId: "r-retry", status: "running" }
        : path === "/runs/r-retry/events"
          ? ++attempts === 1
            ? Promise.reject(Error("连接暂时中断，请重新连接。"))
            : [
                {
                  type: "done",
                  payload: {
                    status: "completed",
                    counts: { collected: 4, saved: 4, candidates: 3 },
                  },
                },
              ]
          : syntheticApi(path, opts),
  });
  await f.user.click(f.screen.getByRole("button", { name: "更新岗位" }));
  await f.screen.findByRole("alert");
  await f.user.click(f.screen.getByRole("button", { name: "重新连接任务" }));
  await f.screen.findByText("岗位更新完成");
  assert.equal(attempts, 2);
  assert.deepEqual(
    f.apiCalls.filter((c) => c.path === "/runs/r-retry/events").at(-1)?.scope,
    { packageId: "A", targetRevisionId: "t1@1" },
  );
});

test("switching target aborts the old stream and rejects its late progress and completion", async (t) => {
  let finishOld: (events: unknown) => void = () => {};
  const oldEvents = new Promise((resolve) => (finishOld = resolve));
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path === "/runs" && opts.method === "POST"
        ? {
            runId: "old-stream-A",
            status: "running",
            counts: { collected: 7, saved: 6, candidates: 5 },
          }
        : path === "/runs/old-stream-A/events"
          ? oldEvents
          : syntheticApi(path, opts),
  });
  await f.user.click(f.screen.getByRole("button", { name: "更新岗位" }));
  await f.screen.findByText("采集 7 条 · 保存 6 条 · 候选 5 条");
  const oldStream = f.apiCalls.find(
    (c) => c.path === "/runs/old-stream-A/events",
  );
  assert.deepEqual(oldStream?.scope, {
    packageId: "A",
    targetRevisionId: "t1@1",
  });
  await f.selectTarget({ packageId: "B", targetRevisionId: "t2@1" });
  assert.equal(oldStream?.options.signal?.aborted, true);
  assert.equal(f.screen.queryByText("采集 7 条 · 保存 6 条 · 候选 5 条"), null);
  await act(async () => {
    finishOld([
      {
        type: "progress",
        payload: {
          status: "collecting",
          counts: { collected: 999, saved: 998, candidates: 997 },
          warnings: ["OLD_STREAM_PROGRESS_SENTINEL"],
        },
      },
      {
        type: "done",
        payload: {
          status: "completed",
          counts: { collected: 999, saved: 998, candidates: 997 },
          issues: [{ message: "OLD_STREAM_COMPLETION_SENTINEL" }],
        },
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(f.screen.queryByText("岗位更新完成"), null);
  assert.equal(f.screen.queryByText(/OLD_STREAM_/), null);
  assert.equal(
    f.screen.queryByText("采集 999 条 · 保存 998 条 · 候选 997 条"),
    null,
  );
  assert.match(window.location.hash, /packageId=B/);
  assert.match(f.screen.getByRole("banner").textContent ?? "", /合成目标B/);
});
test("rule-mode run sends exact scope without a model key", async (t) => {
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path === "/runs" && opts.method === "POST"
        ? { runId: "run-one", status: "collecting" }
        : path.endsWith("/events")
          ? [
              {
                type: "done",
                payload: { run: { status: "completed" }, collected: 2 },
              },
            ]
          : syntheticApi(path, opts),
  });
  await f.user.click(await f.screen.findByRole("button", { name: "更新岗位" }));
  await f.screen.findByText("岗位更新完成");
  const call = f.apiCalls.find(
    (c) => c.path === "/runs" && c.options.method === "POST",
  )!;
  assert.deepEqual(call.scope, { packageId: "A", targetRevisionId: "t1@1" });
  assert.equal((call.body as Record<string, unknown>).userApiKey, undefined);
});
test("first use explains import then target then update", async (t) => {
  const f = await renderApp(t, {
    route: "#/workbench",
    apiHandler: (path, opts) =>
      path === "/profiles"
        ? { profiles: [] }
        : path === "/targets"
          ? { targets: [] }
          : syntheticApi(path, opts),
  });
  assert.ok(await f.screen.findByText("导入简历 → 创建目标 → 更新岗位"));
  assert.equal(
    f.screen.getByRole("button", { name: "更新岗位" }).getAttribute("disabled"),
    "",
  );
});
test("model key validation preserves a failed draft and blocks a run before submission", async (t) => {
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: syntheticApi,
  });
  await f.user.click(f.screen.getByRole("button", { name: "运行选项" }));
  await f.user.click(f.screen.getByRole("button", { name: "模型辅助" }));
  await f.user.type(
    f.screen.getByLabelText("本次更新临时模型密钥"),
    "invalid key",
  );
  await f.user.click(f.screen.getByRole("button", { name: "更新岗位" }));
  await f.screen.findByRole("alert");
  assert.equal(
    f.apiCalls.filter((c) => c.path === "/runs" && c.options.method === "POST")
      .length,
    0,
  );
  assert.equal(
    (f.screen.getByLabelText("本次更新临时模型密钥") as HTMLInputElement).value,
    "invalid key",
  );
});
test("cancellation stays pending until final stream state and displays nested run counts", async (t) => {
  let done: (v: unknown) => void = () => {};
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path === "/runs" && opts.method === "POST"
        ? {
            runId: "r-A",
            status: "running",
            counts: { collected: 3, saved: 2, candidates: 1 },
          }
        : path === "/runs/r-A/events"
          ? new Promise((resolve) => (done = resolve))
          : path === "/runs/r-A/cancel"
            ? { status: "cancelling" }
            : syntheticApi(path, opts),
  });
  await f.user.click(f.screen.getByRole("button", { name: "更新岗位" }));
  await f.screen.findByText("采集 3 条 · 保存 2 条 · 候选 1 条");
  await f.user.click(f.screen.getByRole("button", { name: "取消任务" }));
  await f.screen.findAllByText("已请求取消，正在等待任务完成");
  assert.equal(f.screen.queryByText("任务已取消"), null);
  done([
    {
      type: "done",
      payload: {
        status: "cancelled",
        counts: { collected: 3, saved: 2, candidates: 1 },
      },
    },
  ]);
  await f.screen.findByText("任务已取消");
});
