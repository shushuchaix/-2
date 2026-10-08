import test from "node:test";
import assert from "node:assert/strict";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
test("version rename validates its name and reports success only after the owning revision commits", async (t) => {
  let release: (value: unknown) => void = () => {};
  const committed = new Promise((resolve) => {
    release = resolve;
  });
  const f = await renderApp(t, {
    route: "#/profiles",
    apiHandler: (path, opts) =>
      opts.method === "PATCH" ? committed : syntheticApi(path, opts),
  });
  await f.user.click(await f.screen.findByRole("button", { name: "版本操作" }));
  await f.user.click(await f.screen.findByRole("menuitem", { name: "重命名" }));
  await f.user.clear(f.screen.getByLabelText("版本名称"));
  await f.user.click(f.screen.getByRole("button", { name: "保存名称" }));
  assert.equal(
    f.apiCalls.filter((c) => c.options.method === "PATCH").length,
    0,
  );
  await f.screen.findByRole("alert");
  await f.user.type(f.screen.getByLabelText("版本名称"), "新合成版本");
  await f.user.click(f.screen.getByRole("button", { name: "保存名称" }));
  assert.deepEqual(f.apiCalls.find((c) => c.options.method === "PATCH")?.body, {
    versionName: "新合成版本",
  });
  assert.equal(f.screen.queryByText("版本名称已保存"), null);
  release({ versionName: "新合成版本" });
  assert.ok((await f.screen.findAllByText("版本名称已保存")).length > 0);
});
test("disabling and archiving a target report committed results and clear its selected scope", async (t) => {
  let enabled = true,
    archived = false;
  const f = await renderApp(t, {
    route: "#/targets?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) => {
      if (path === "/targets")
        return {
          targets: [
            {
              targetId: "t1",
              revisionId: "t1@1",
              packageId: "A",
              versionName: "合成目标A",
              enabled,
              state: archived ? "trashed" : "active",
            },
          ],
        };
      if (path === "/trash")
        return {
          items: archived ? [{ packageId: "A", state: "trashed" }] : [],
          packageCount: archived ? 1 : 0,
        };
      if (path.startsWith("/targets/t1/revisions/t1%401")) {
        if (opts.method === "PATCH") enabled = false;
        if (opts.method === "DELETE") archived = true;
        return {};
      }
      return syntheticApi(path, opts);
    },
  });
  await f.user.click(await f.screen.findByRole("button", { name: "版本操作" }));
  await f.user.click(await f.screen.findByRole("menuitem", { name: "停用" }));
  assert.ok((await f.screen.findAllByText("版本已停用")).length > 0);
  await f.user.click(f.screen.getByRole("button", { name: "版本操作" }));
  await f.user.click(
    await f.screen.findByRole("menuitem", { name: "移入回收站" }),
  );
  await f.user.click(f.screen.getByRole("button", { name: "确认移入回收站" }));
  await f.screen.findByText("该版本已进入回收站");
  assert.equal(window.location.hash.includes("packageId=A"), false);
  assert.match(
    f.screen.getByRole("link", { name: "回收站" }).textContent ?? "",
    /1/,
  );
});
