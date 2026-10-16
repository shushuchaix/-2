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
  assert.equal(f.screen.getAllByRole("main").length, 1);
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
test("current navigation is named and all-target context stays read-only", async (t) => {
  const f = await renderApp(t, {
    apiHandler: syntheticApi,
    route: "#/workbench?allTargets=true",
  });
  const workbench = f.screen.getByRole("link", { name: "工作台" });
  assert.equal(workbench.getAttribute("aria-current"), "page");
  assert.equal(
    f.screen.getAllByRole("link", {
      name: /^(工作台|岗位库|投递进度|简历管理|求职目标|招聘来源|运行日志|回收站|设置)$/,
    }).length,
    9,
  );
  const update = f.screen.queryByRole("button", { name: "更新岗位" });
  assert.ok(update === null || (update as HTMLButtonElement).disabled);

  await f.user.click(f.screen.getByRole("link", { name: "岗位库" }));
  assert.equal(window.location.hash, "#/jobs?allTargets=true");
  assert.equal(
    f.screen.getByRole("link", { name: "岗位库" }).getAttribute("aria-current"),
    "page",
  );
  assert.equal(workbench.getAttribute("aria-current"), null);
  const jobsUpdate = f.screen.queryByRole("button", { name: "更新岗位" });
  assert.ok(jobsUpdate === null || (jobsUpdate as HTMLButtonElement).disabled);
});
test("page navigation preserves the exact selected target and clears page filters", async (t) => {
  const f = await renderApp(t, {
    apiHandler: syntheticApi,
    route: "#/jobs?packageId=A&targetRevisionId=t1%401&city=深圳",
  });
  await f.user.click(f.screen.getByRole("link", { name: "工作台" }));
  assert.equal(
    window.location.hash,
    "#/workbench?packageId=A&targetRevisionId=t1%401",
  );
});
test("navigation is a named sheet at 768px and closes after choosing a page", async (t) => {
  const originalWidth = window.innerWidth;
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "innerWidth", {
    value: 768,
    configurable: true,
  });
  window.matchMedia = (query) => ({
    ...originalMatchMedia(query),
    matches: query === "(max-width: 768px)",
  });
  t.after(() => {
    Object.defineProperty(window, "innerWidth", {
      value: originalWidth,
      configurable: true,
    });
    window.matchMedia = originalMatchMedia;
  });
  const f = await renderApp(t, {
    apiHandler: syntheticApi,
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
  });
  assert.equal(f.screen.queryByRole("link", { name: "岗位库" }), null);
  await f.user.click(f.screen.getByRole("button", { name: "切换导航" }));
  assert.ok(f.screen.getByRole("dialog", { name: "主要导航" }));
  await f.user.click(f.screen.getByRole("link", { name: "岗位库" }));
  assert.equal(
    window.location.hash,
    "#/jobs?packageId=A&targetRevisionId=t1%401",
  );
  assert.equal(f.screen.queryByRole("dialog", { name: "主要导航" }), null);
});
