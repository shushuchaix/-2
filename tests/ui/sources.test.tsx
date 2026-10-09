import test from "node:test";
import assert from "node:assert/strict";
import { renderApp } from "../helpers/react-fixture";

const catalog = () => ({
  sources: [
    {
      sourceId: "school",
      name: "合成学校",
      config: { enabled: true },
      capabilities: { collect: true },
    },
  ],
  sites: [
    {
      siteId: "sample",
      providerId: "school",
      name: "候选目录",
      status: "candidate",
      origin: "https://example.com/jobs",
      health: { status: "candidate", lastSuccessAt: "2026-10-05T00:00:00Z" },
    },
  ],
});

test("source save failure preserves the changed switch and diagnostic link", async (t) => {
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, options) => {
      if (
        path === "/collections"
          ? {
              collections: [
                {
                  runId: "activity-A",
                  collectionProgress: { status: "collecting" },
                },
              ],
            }
          : path === "/sources"
      )
        return catalog();
      if (options?.method === "PUT")
        throw Object.assign(new Error("来源设置未保存"), {
          diagnosticId: "d-00000000-0000-4000-8000-000000000001",
        });
    },
  });
  await f.user.click(
    await f.screen.findByRole("switch", { name: "启用合成学校" }),
  );
  assert.equal(
    f.screen
      .getByRole("switch", { name: "启用合成学校" })
      .getAttribute("aria-checked"),
    "false",
  );
  assert.ok(await f.screen.findByText(/来源设置未保存/));
  assert.ok(f.screen.getByRole("link", { name: /查看.*(?:日志|诊断)/ }));
  assert.equal(f.screen.queryByText("来源设置已保存"), null);
});

test("candidate probe keeps last success and explains empty content", async (t) => {
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path) =>
      path === "/collections"
        ? {
            collections: [
              {
                runId: "activity-A",
                collectionProgress: { status: "collecting" },
              },
            ],
          }
        : path === "/sources"
          ? catalog()
          : path.endsWith("/probe")
            ? {
                status: "empty",
                checkedAt: "2026-10-09T00:00:00Z",
                issues: [{ code: "empty", message: "未取得有效样本" }],
              }
            : undefined,
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "检查候选目录" }),
  );
  assert.ok((await f.screen.findAllByText(/未取得有效样本/)).length);
  assert.ok(f.screen.getByText(/最近成功：2026/));
});

test("site validation stops private URL and preserves server-rejected draft", async (t) => {
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, options) => {
      if (
        path === "/collections"
          ? {
              collections: [
                {
                  runId: "activity-A",
                  collectionProgress: { status: "collecting" },
                },
              ],
            }
          : path === "/sources"
      )
        return catalog();
      if (path === "/sources/sites")
        throw Object.assign(new Error("请修改标出的项目"), {
          fieldErrors: { siteId: "该站点编号已存在" },
        });
    },
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "添加目录站点" }),
  );
  await f.user.type(f.screen.getByLabelText("站点 ID"), "school-new");
  await f.user.type(f.screen.getByLabelText("站点名称"), "合成公开站点");
  await f.user.type(
    f.screen.getByLabelText("公开站点地址"),
    "http://127.0.0.1/jobs",
  );
  await f.user.type(
    f.screen.getByLabelText("归属证据链接"),
    "https://example.com/about",
  );
  await f.user.click(f.screen.getByRole("button", { name: "保存候选站点" }));
  assert.equal(f.apiCalls.filter((c) => c.path === "/sources/sites").length, 0);
  assert.equal(
    f.screen.getByLabelText("公开站点地址").getAttribute("aria-invalid"),
    "true",
  );
  await f.user.clear(f.screen.getByLabelText("公开站点地址"));
  await f.user.type(
    f.screen.getByLabelText("公开站点地址"),
    "https://example.com/jobs",
  );
  await f.user.click(f.screen.getByRole("button", { name: "保存候选站点" }));
  assert.ok((await f.screen.findAllByText(/该站点编号已存在/)).length);
  assert.equal(
    (f.screen.getByLabelText("站点名称") as HTMLInputElement).value,
    "合成公开站点",
  );
});

test("successful source probe updates provider availability count", async (t) => {
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path) =>
      path === "/collections"
        ? {
            collections: [
              {
                runId: "activity-A",
                collectionProgress: { status: "collecting" },
              },
            ],
          }
        : path === "/sources"
          ? catalog()
          : path.endsWith("/probe")
            ? {
                status: "ready",
                checkedAt: "2026-10-09T00:00:00Z",
                sampleCount: 1,
              }
            : undefined,
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "检查候选目录" }),
  );
  assert.ok(await f.screen.findByText(/1 个目录站点 · 1 个本版本已验证站点/));
});
