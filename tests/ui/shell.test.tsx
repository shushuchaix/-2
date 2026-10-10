import test from "node:test";
import assert from "node:assert/strict";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
test("shell exposes nine destinations and exact target in the hash", async (t) => {
  const f = await renderApp(t, {
    apiHandler: syntheticApi,
    route: "#/jobs?packageId=A&targetRevisionId=t1%401",
  });
  assert.equal(
    f.screen.getAllByRole("link", {
      name: /^(工作台|岗位库|投递进度|简历管理|求职目标|招聘来源|运行日志|回收站|设置)$/,
    }).length,
    9,
  );
  assert.match(
    f.screen.getByRole("combobox", { name: "当前目标" }).textContent ?? "",
    /合成目标A/,
  );
});
test("all targets selection remains a read-only summary after navigation", async (t) => {
  const f = await renderApp(t, {
    apiHandler: syntheticApi,
    route: "#/workbench?allTargets=true",
  });
  await f.user.click(f.screen.getByRole("link", { name: "岗位库" }));
  assert.match(window.location.hash, /allTargets=true/);
  assert.ok(f.screen.getAllByText("全部目标 · 只读汇总").length > 0);
});
