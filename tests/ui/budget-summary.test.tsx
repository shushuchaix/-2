import test from "node:test";
import assert from "node:assert/strict";
import { render, cleanup } from "@testing-library/react";
import { CollectionProgress } from "../../ui/src/features/workbench/CollectionProgress";
import { renderApp } from "../helpers/react-fixture";
import { budgetView } from "../../ui/src/lib/budget-view";

test("missing activity usage is unknown rather than a fabricated zero balance", (t) => {
  const view = render(
    <CollectionProgress
      activity={{
        runId: "root",
        collectionProgress: {
          status: "paused",
          revision: 1,
          limits: { maxCostCny: 10, maxRequests: 400 },
          units: {},
        },
      }}
      api={{} as any}
    />,
  );
  t.after(() => {
    view.unmount();
    cleanup();
  });
  assert.match(view.container.textContent!, /费用上界.*未提供/);
  assert.doesNotMatch(view.container.textContent!, /剩余 ¥10\.00/);
});

test("new target coverage budgets expose the shared standard and broad defaults", async (t) => {
  const f = await renderApp(t, { route: "#/targets" });
  await f.user.click(await f.screen.findByRole("button", { name: "新建目标" }));
  await f.user.click(f.screen.getByRole("button", { name: "下一步" }));
  await f.user.type(f.screen.getByLabelText("求职方向"), "合成消防方向");
  await f.user.click(f.screen.getByRole("button", { name: "下一步" }));
  assert.ok(f.screen.getByRole("region", { name: "新活动预算预览" }));
  assert.match(
    f.screen.getByRole("region", { name: "新活动预算预览" }).textContent!,
    /24.*400.*4/,
  );
  await f.user.click(f.screen.getByRole("combobox", { name: "覆盖预算" }));
  await f.user.click(await f.screen.findByRole("option", { name: "广覆盖" }));
  assert.match(
    f.screen.getByRole("region", { name: "新活动预算预览" }).textContent!,
    /50.*1000.*10/,
  );
});

test("budget projections preserve shared defaults, saved overrides and zero/null semantics", () => {
  assert.equal(budgetView().limits.maxRequests, 400);
  assert.equal(
    budgetView({ coverageMode: "broad" }).limits.maxPagesPerQuery,
    10,
  );
  assert.equal(
    budgetView({
      overrides: { maxRequests: 700, maxCostCny: 0 },
      modelBudget: { maxCostCny: 10 },
    }).limits.maxCostCny,
    0,
  );
  assert.equal(
    budgetView({ overrides: { maxRequests: 700 } }).limits.maxRequests,
    700,
  );
  const old = budgetView({
    modelBudget: { maxCostCny: null, maxModelRequests: 7 },
  });
  assert.equal(old.costMode, "request_count");
  assert.equal(old.modelRequestLimit, 7);
  assert.equal(old.limits.maxCostCny, undefined);
  assert.equal(
    budgetView({ modelBudget: { maxModelRequests: 4 } }).costMode,
    "request_count",
  );
  assert.equal(
    budgetView({ modelBudget: { maxCostCny: NaN } }).costMode,
    "unknown",
  );
});

test("an activity owns its limits and reservation is already in the cost upper bound", () => {
  const activity = {
    runId: "root",
    collectionUsage: { costUpperBoundCny: 3.2, reservedCostCny: 0.2 },
    collectionProgress: {
      status: "paused",
      revision: 1,
      limits: { maxCostCny: 10, maxRequests: 180 },
      units: {},
    },
  };
  const view = budgetView({
    activity,
    coverageMode: "broad",
    overrides: { maxCostCny: 0, maxRequests: 700 },
  });
  assert.equal(view.source, "activity");
  assert.equal(view.limits.maxRequests, 180);
  assert.equal(view.usedCostCny, 3.2);
  assert.equal(view.remainingCostCny, 6.8);
});

test("settings preview remains pending until the service confirms saving", async (t) => {
  const f = await renderApp(t, {
    route: "#/settings",
    apiHandler: (path, options) => {
      if (path === "/settings" && options.method === "PUT")
        throw Error("合成保存失败");
    },
  });
  const input = await f.screen.findByLabelText("每任务模型费用上限（元）");
  await f.user.clear(input);
  await f.user.type(input, "0");
  assert.match(
    f.screen.getByRole("region", { name: "预算设置（待保存）" }).textContent!,
    /模型调用已关闭/,
  );
  await f.user.click(
    f.screen.getByRole("button", { name: "保存模型与预算设置" }),
  );
  await f.screen.findByText("合成保存失败");
  assert.ok(f.screen.getByRole("region", { name: "预算设置（待保存）" }));
  assert.equal((input as HTMLInputElement).value, "0");
});
