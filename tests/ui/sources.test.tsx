import test from "node:test";
import assert from "node:assert/strict";
import { within, waitFor, act } from "@testing-library/react";
import { renderApp, syntheticApi } from "../helpers/react-fixture";

async function openSource(
  f: Awaited<ReturnType<typeof renderApp>>,
  name: string,
) {
  const region = await f.screen.findByRole("region", {
    name: name + "来源摘要",
  });
  await f.user.click(
    within(region).getByRole("button", { name: "查看来源配置" }),
  );
}

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

test("all-target source directory blocks creating shared sites", async (t) => {
  const f = await renderApp(t, {
    route: "#/sources?allTargets=true",
    apiHandler: (p, o) => (p === "/sources" ? catalog() : syntheticApi(p, o)),
  });
  await f.screen.findByRole("region", { name: "合成学校来源摘要" });
  const add = f.screen.getByRole("button", {
    name: "添加目录站点",
  }) as HTMLButtonElement;
  assert.equal(add.disabled, true);
  await f.user.click(add);
  assert.equal(f.screen.queryByRole("dialog"), null);
  assert.ok(f.screen.getByText(/选择一个目标版本后可添加目录站点/));
  assert.equal(
    f.apiCalls.some(
      (c) => c.path === "/sources/sites" && c.options.method === "POST",
    ),
    false,
  );
});
test("site filters and page survive closing details but clear on version switch", async (t) => {
  const data = catalog();
  data.sites = Array.from({ length: 45 }, (_, i) => ({
    ...data.sites[0],
    siteId: "site-" + i,
    name: "候选目录" + i,
  }));
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => (p === "/sources" ? data : syntheticApi(p, o)),
  });
  await openSource(f, "合成学校");
  await f.user.type(f.screen.getByLabelText("搜索此来源站点"), "候选目录");
  await f.user.click(f.screen.getByRole("button", { name: "下一页站点" }));
  await f.screen.findByText(/第 2 页 · 共 45 个站点/);
  await f.user.click(f.screen.getByRole("button", { name: "关闭来源详情" }));
  await openSource(f, "合成学校");
  assert.equal(
    (f.screen.getByLabelText("搜索此来源站点") as HTMLInputElement).value,
    "候选目录",
  );
  assert.ok(f.screen.getByText(/第 2 页 · 共 45 个站点/));
  await act(async () => {
    window.location.hash = "#/sources?packageId=B&targetRevisionId=t2%401";
    window.dispatchEvent(new Event("hashchange"));
  });
  await waitFor(() =>
    assert.equal(
      f.screen.queryByRole("button", { name: "关闭来源详情" }),
      null,
    ),
  );
  await openSource(f, "合成学校");
  assert.equal(
    (f.screen.getByLabelText("搜索此来源站点") as HTMLInputElement).value,
    "",
  );
  assert.ok(f.screen.getByText(/第 1 页 · 共 45 个站点/));
});
test("shared probe history is not attributed to the selected target version", async (t) => {
  const data = catalog();
  data.sites[0].health = {
    status: "ready",
    lastSuccessAt: "2026-10-05T00:00:00Z",
  };
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path === "/sources" ? data : syntheticApi(path, opts),
  });
  const region = await f.screen.findByRole("region", {
    name: "合成学校来源摘要",
  });
  assert.equal(within(region).queryByText(/个本版本探针/), null);
  assert.ok(f.screen.getByText(/探针包含共享历史与本版本检查/));
});
test("source save failure preserves the changed switch and diagnostic link", async (t) => {
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, options) => {
      if (path === "/collections")
        return {
          collections: [
            {
              runId: "activity-A",
              collectionProgress: { status: "collecting" },
            },
          ],
        };
      if (path === "/sources") return catalog();
      if (options?.method === "PUT")
        throw Object.assign(new Error("来源设置未保存"), {
          diagnosticId: "d-00000000-0000-4000-8000-000000000001",
        });
    },
  });
  await openSource(f, "合成学校");
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
  await f.user.click(f.screen.getByRole("button", { name: "关闭来源详情" }));
  await openSource(f, "合成学校");
  assert.equal(
    f.screen
      .getByRole("switch", { name: "启用合成学校" })
      .getAttribute("aria-checked"),
    "false",
  );
  assert.deepEqual(
    f.apiCalls.find((call) => call.options.method === "PUT")?.scope,
    { packageId: "A", targetRevisionId: "t1@1" },
  );
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
  await openSource(f, "合成学校");
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
      if (path === "/collections")
        return {
          collections: [
            {
              runId: "activity-A",
              collectionProgress: { status: "collecting" },
            },
          ],
        };
      if (path === "/sources") return catalog();
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
  await openSource(f, "合成学校");
  await f.user.click(
    await f.screen.findByRole("button", { name: "检查候选目录" }),
  );
  assert.ok(
    (await f.screen.findAllByText(/1 个目录站点 · 1 个探针取得有效样本站点/))
      .length,
  );
});

test("fifty source summaries stay paged and share one activity query while details mount on demand", async (t) => {
  const sources = Array.from({ length: 50 }, (_, i) => ({
    sourceId: i === 0 ? "wechat" : "source-" + i,
    name: i === 0 ? "公众号" : "合成来源" + i,
    config: { enabled: i % 2 === 0 },
    capabilities: i % 3 === 0 ? { category: "education" } : {},
  }));
  const sites = sources.flatMap((s, i) =>
    Array.from({ length: 10 }, (_, j) => ({
      siteId: s.sourceId + "-" + j,
      providerId: s.sourceId,
      name: "目录" + i + "-" + j,
      category: i % 3 === 1 ? "government" : undefined,
      status: "candidate",
      origin: "https://example.org/" + i + "/" + j,
      health: {
        status: i % 2 === 0 ? "ready" : "parse_error",
        checkedAt: "2026-10-09T00:00:00Z",
      },
    })),
  );
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/sources"
        ? { sources, sites }
        : p === "/collections"
          ? { collections: [] }
          : syntheticApi(p, o),
  });
  await f.screen.findByText("合成来源19");
  assert.equal(f.apiCalls.filter((c) => c.path === "/collections").length, 1);
  const stateSummary = f.screen.getByRole("region", { name: "来源状态摘要" });
  assert.match(
    within(stateSummary).getByText("有运行问题").parentElement?.textContent ||
      "",
    /25 个来源/,
  );
  assert.equal(
    f.screen.queryAllByLabelText("已知公开文章/帖子链接（每行一个）").length,
    0,
  );
  assert.equal(
    f.screen.getAllByRole("button", { name: "查看来源配置" }).length,
    20,
  );
  assert.equal(
    f.screen.queryAllByRole("button", { name: /^检查目录/ }).length,
    0,
  );
  await f.user.click(f.screen.getByRole("button", { name: "下一页来源" }));
  await f.screen.findByText("合成来源20");
  await openSource(f, "合成来源20");
  await f.user.click(f.screen.getByRole("button", { name: "关闭来源详情" }));
  assert.ok(f.screen.getByText("合成来源20"));
  assert.ok(f.screen.getByText("第 2 页 · 共 50 个来源"));
  await f.user.type(f.screen.getByLabelText("搜索来源"), "合成来源49");
  assert.equal(
    f.screen.getAllByRole("button", { name: "查看来源配置" }).length,
    1,
  );
  await openSource(f, "合成来源49");
  assert.equal(
    f.screen.getAllByRole("button", { name: /^检查目录/ }).length,
    10,
  );
  assert.equal(f.apiCalls.filter((c) => c.path === "/collections").length, 1);
});

test("social source rejected draft survives reopening and is cleared on a version switch", async (t) => {
  let rejectSave: (e: unknown) => void = () => {};
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/sources"
        ? {
            sources: [
              {
                sourceId: "wechat",
                name: "公众号",
                config: { enabled: true, articleUrls: [] },
              },
            ],
            sites: [],
          }
        : p.endsWith("/settings")
          ? new Promise((_r, reject) => {
              rejectSave = reject;
            })
          : syntheticApi(p, o),
  });
  await openSource(f, "公众号");
  await f.user.type(
    f.screen.getByLabelText("已知公开文章/帖子链接（每行一个）"),
    "https://example.org/retained-draft",
  );
  await f.user.click(f.screen.getByRole("button", { name: "保存来源设置" }));
  await act(async () =>
    rejectSave(
      Object.assign(Error("设置写入失败"), { diagnosticId: "d-draft" }),
    ),
  );
  await f.screen.findByText("设置写入失败");
  await f.user.click(f.screen.getByRole("button", { name: "关闭来源详情" }));
  await openSource(f, "公众号");
  assert.equal(
    (
      f.screen.getByLabelText(
        "已知公开文章/帖子链接（每行一个）",
      ) as HTMLTextAreaElement
    ).value,
    "https://example.org/retained-draft",
  );
  await act(async () => {
    window.location.hash = "#/sources?packageId=B&targetRevisionId=t2%401";
    window.dispatchEvent(new Event("hashchange"));
  });
  await waitFor(() =>
    assert.equal(
      f.screen.queryAllByRole("dialog", { name: "公众号来源配置" }).length,
      0,
    ),
  );
  await openSource(f, "公众号");
  assert.equal(
    (
      f.screen.getByLabelText(
        "已知公开文章/帖子链接（每行一个）",
      ) as HTMLTextAreaElement
    ).value,
    "",
  );
});

test("source filters use actual categories enabled configuration and independent probe statuses", async (t) => {
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/sources"
        ? {
            sources: [
              {
                sourceId: "u",
                name: "高校来源",
                config: { enabled: true },
                capabilities: { category: "university" },
              },
              { sourceId: "g", name: "政府来源", config: { enabled: false } },
              {
                sourceId: "x",
                name: "未知类别来源",
                config: { enabled: true },
              },
            ],
            sites: [
              {
                siteId: "g-site",
                providerId: "g",
                name: "政府目录",
                category: "government",
                health: {
                  status: "content_non_json",
                  issues: [
                    { code: "content_non_json", diagnosticId: "d-html" },
                  ],
                },
              },
            ],
          }
        : syntheticApi(p, o),
  });
  await f.screen.findByRole("region", { name: "未知类别来源来源摘要" });
  assert.ok(f.screen.getByText("未分类"));
  await f.user.click(f.screen.getByRole("combobox", { name: "来源类别" }));
  await f.user.click(await f.screen.findByRole("option", { name: "高校招聘" }));
  assert.equal(
    f.screen.getAllByRole("button", { name: "查看来源配置" }).length,
    1,
  );
  assert.ok(f.screen.getByRole("region", { name: "高校来源来源摘要" }));
  await f.user.click(f.screen.getByRole("combobox", { name: "来源类别" }));
  await f.user.click(await f.screen.findByRole("option", { name: "政府招聘" }));
  await f.user.click(f.screen.getByRole("combobox", { name: "来源启用状态" }));
  await f.user.click(await f.screen.findByRole("option", { name: "未启用" }));
  await f.user.click(f.screen.getByRole("combobox", { name: "来源探针状态" }));
  await f.user.click(
    await f.screen.findByRole("option", { name: "返回 HTML 等非 JSON 内容" }),
  );
  const summary = f.screen.getByRole("region", { name: "政府来源来源摘要" });
  assert.equal(
    within(summary).queryAllByText(/认证受限|登录受限|风险阻塞/).length,
    0,
  );
  assert.ok(within(summary).getByRole("link", { name: "查看来源问题日志" }));
});

test("source detail mounts twenty site probes and search reaches later sites", async (t) => {
  const data = catalog();
  data.sites = Array.from({ length: 45 }, (_, i) => ({
    ...data.sites[0],
    siteId: "s" + i,
    name: "目录站点" + i,
  }));
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => (p === "/sources" ? data : syntheticApi(p, o)),
  });
  await openSource(f, "合成学校");
  assert.equal(
    f.screen.getAllByRole("button", { name: /^检查目录站点/ }).length,
    20,
  );
  await f.user.click(f.screen.getByRole("button", { name: "下一页站点" }));
  assert.ok(f.screen.getByRole("button", { name: "检查目录站点20" }));
  assert.equal(
    f.screen.queryAllByRole("button", { name: "检查目录站点0" }).length,
    0,
  );
  await f.user.type(f.screen.getByLabelText("搜索此来源站点"), "目录站点44");
  assert.equal(
    f.screen.getAllByRole("button", { name: /^检查目录站点/ }).length,
    1,
  );
  assert.ok(f.screen.getByRole("button", { name: "检查目录站点44" }));
  assert.equal(f.apiCalls.filter((c) => c.path === "/collections").length, 1);
});

test("all-target sources read the shared directory without private activity or configuration actions", async (t) => {
  const data = catalog();
  const f = await renderApp(t, {
    route: "#/sources?allTargets=true",
    apiHandler: (p, o) => (p === "/sources" ? data : syntheticApi(p, o)),
  });
  await openSource(f, "合成学校");
  assert.equal(f.apiCalls.filter((c) => c.path === "/collections").length, 0);
  assert.equal(
    f.screen.queryAllByRole("switch", { name: "启用合成学校" }).length,
    0,
  );
  assert.equal(
    f.screen.queryAllByRole("button", { name: "保存来源设置" }).length,
    0,
  );
  assert.equal(
    (
      f.screen.getByRole("button", {
        name: "检查候选目录",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(f.apiCalls.find((c) => c.path === "/sources")?.scope, undefined);
});

test("catalog readiness does not become probe evidence in source cards filters or details", async (t) => {
  const data = {
    sources: [
      { sourceId: "school", name: "目录高校", config: { enabled: true } },
    ],
    sites: [
      {
        siteId: "listed",
        providerId: "school",
        name: "已收录目录",
        status: "ready",
        origin: "https://example.org/jobs",
        verifiedAt: "2026-10-05T00:00:00Z",
      },
    ],
  };
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => (p === "/sources" ? data : syntheticApi(p, o)),
  });
  const card = await f.screen.findByRole("region", {
    name: "目录高校来源摘要",
  });
  assert.ok(within(card).getByText("1 个目录站点 · 0 个探针取得有效样本站点"));
  assert.ok(within(card).getByText("暂无探针记录"));
  const summary = f.screen.getByRole("region", { name: "来源状态摘要" });
  assert.match(
    within(summary).getByText("有有效样本探针记录").parentElement
      ?.textContent || "",
    /0 个来源/,
  );
  await f.user.click(f.screen.getByRole("combobox", { name: "来源探针状态" }));
  assert.equal(
    f.screen.queryByRole("option", { name: "最近探针取得有效样本" }),
    null,
  );
  await f.user.click(
    await f.screen.findByRole("option", { name: "暂无探针记录" }),
  );
  await openSource(f, "目录高校");
  const site = f.screen.getByRole("region", { name: "已收录目录站点探针" });
  assert.ok(within(site).getByText("暂无探针记录"));
  assert.ok(within(site).getByText("目录状态：已收录"));
  assert.ok(within(site).getByText("最近成功：未提供"));
});

test("legacy budget exhaustion describes an incomplete probe and shows the latest attempt", async (t) => {
  const data = {
    sources: [
      {
        sourceId: "school",
        name: "额度高校",
        config: { enabled: true },
        health: [
          {
            siteId: "limited",
            status: "unavailable",
            checkedAt: "2026-10-08T12:00:00Z",
            lastAttemptAt: "2026-10-11T12:00:00Z",
            lastSuccessAt: "2026-10-07T12:00:00Z",
            issues: [
              {
                code: "unavailable",
                message: "budget_exhausted:requests",
                diagnosticId: "d-budget",
              },
            ],
          },
        ],
      },
    ],
    sites: [
      {
        siteId: "limited",
        providerId: "school",
        name: "额度目录",
        status: "candidate",
        origin: "https://example.org/jobs",
      },
    ],
  };
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => (p === "/sources" ? data : syntheticApi(p, o)),
  });
  const card = await f.screen.findByRole("region", {
    name: "额度高校来源摘要",
  });
  assert.ok(within(card).getByText("累计额度不足，检查未完成"));
  assert.equal(
    within(card).queryByText(/暂时不可访问|budget_exhausted:requests/),
    null,
  );
  assert.match(
    within(card).getByText(/最近探针：/).textContent || "",
    /2026.*10.*11/,
  );
  await f.user.click(f.screen.getByRole("combobox", { name: "来源探针状态" }));
  await f.user.click(
    await f.screen.findByRole("option", { name: "累计额度不足，检查未完成" }),
  );
  await openSource(f, "额度高校");
  const site = f.screen.getByRole("region", { name: "额度目录站点探针" });
  assert.ok(within(site).getAllByText("累计额度不足，检查未完成").length);
  assert.match(
    within(site).getByText(/本次尝试：/).textContent || "",
    /2026.*10.*11/,
  );
  assert.match(
    within(site).getByText(/最近成功：/).textContent || "",
    /2026.*10.*7/,
  );
  assert.equal(
    within(site).queryByText(/暂时不可访问|budget_exhausted:requests/),
    null,
  );
  assert.ok(within(site).getByRole("link", { name: "查看更新日志" }));
});

test("a budget issue does not hide an independent network failure", async (t) => {
  const data = {
    sources: [
      {
        sourceId: "school",
        name: "失败高校",
        config: { enabled: true },
        health: [
          {
            siteId: "mixed",
            status: "unavailable",
            checkedAt: "2026-10-11T12:00:00Z",
            issues: [{ code: "budget_exhausted" }, { code: "network_error" }],
          },
        ],
      },
    ],
    sites: [
      {
        siteId: "mixed",
        providerId: "school",
        name: "失败目录",
        status: "candidate",
        origin: "https://example.org/jobs",
      },
    ],
  };
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => (p === "/sources" ? data : syntheticApi(p, o)),
  });
  const card = await f.screen.findByRole("region", {
    name: "失败高校来源摘要",
  });
  assert.ok(within(card).getByText("暂时不可访问"));
  await openSource(f, "失败高校");
  assert.ok(f.screen.getByText("网络读取失败"));
  assert.equal(f.screen.queryByText("network_error"), null);
});

test("unmatched provider history does not qualify a catalog site as probed", async (t) => {
  const data = {
    sources: [
      {
        sourceId: "school",
        name: "历史高校",
        config: { enabled: true },
        health: [
          {
            siteId: "school",
            status: "ready",
            checkedAt: "2026-10-10T12:00:00Z",
            sampleCount: 1,
          },
        ],
      },
    ],
    sites: [
      {
        siteId: "listed",
        providerId: "school",
        name: "未检查目录",
        status: "candidate",
        origin: "https://example.org/jobs",
      },
    ],
  };
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => (p === "/sources" ? data : syntheticApi(p, o)),
  });
  const card = await f.screen.findByRole("region", {
    name: "历史高校来源摘要",
  });
  assert.ok(within(card).getByText("1 个目录站点 · 0 个探针取得有效样本站点"));
  assert.ok(within(card).getByText("暂无探针记录"));
  assert.ok(within(card).getByText("来源历史探针（未关联目录站点）"));
  assert.match(
    within(card).getByText(/最近探针：/).textContent || "",
    /2026.*10.*10/,
  );
  await f.user.click(f.screen.getByRole("combobox", { name: "来源探针状态" }));
  assert.equal(
    f.screen.queryByRole("option", { name: "最近探针取得有效样本" }),
    null,
  );
});

test("unconfigured and bounded probe issues use readable labels in cards and details", async (t) => {
  const data = {
    sources: [
      {
        sourceId: "notices",
        name: "公告来源",
        config: { enabled: true },
        health: [
          {
            siteId: "notice-site",
            status: "skipped",
            checkedAt: "2026-10-11T12:00:00Z",
            issues: [
              { code: "template_not_configured" },
              { code: "candidate_not_verified" },
              { code: "page_limit_reached" },
            ],
          },
        ],
      },
    ],
    sites: [
      {
        siteId: "notice-site",
        providerId: "notices",
        name: "公告目录",
        status: "candidate",
        origin: "https://example.org/jobs",
      },
    ],
  };
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => (p === "/sources" ? data : syntheticApi(p, o)),
  });
  const card = await f.screen.findByRole("region", {
    name: "公告来源来源摘要",
  });
  assert.match(card.textContent || "", /尚未配置公告列表与正文模板/);
  assert.match(card.textContent || "", /目录候选，尚未验证采集能力/);
  assert.match(card.textContent || "", /已达到本次分页上限/);
  assert.doesNotMatch(
    card.textContent || "",
    /template_not_configured|candidate_not_verified|page_limit_reached/,
  );
  await openSource(f, "公告来源");
  const site = f.screen.getByRole("region", { name: "公告目录站点探针" });
  assert.ok(within(site).getByText("尚未配置公告列表与正文模板"));
  assert.ok(within(site).getByText("目录候选，尚未验证采集能力"));
  assert.ok(within(site).getByText("已达到本次分页上限"));
  assert.doesNotMatch(
    site.textContent || "",
    /template_not_configured|candidate_not_verified|page_limit_reached/,
  );
});

test("list samples do not claim verified content when the body remains unverified", async (t) => {
  const data = {
    sources: [
      {
        sourceId: "school",
        name: "正文高校",
        config: { enabled: true },
        health: [
          {
            siteId: "body-pending",
            status: "parse_error",
            checkedAt: "2026-10-11T12:00:00Z",
            sampleCount: 1,
            capabilities: { list: "verified", body: "unverified" },
            issues: [{ code: "body_unverified" }],
          },
        ],
      },
    ],
    sites: [
      {
        siteId: "body-pending",
        providerId: "school",
        name: "正文目录",
        status: "ready",
        origin: "https://example.org/jobs",
      },
    ],
  };
  const f = await renderApp(t, {
    route: "#/sources?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => (p === "/sources" ? data : syntheticApi(p, o)),
  });
  await openSource(f, "正文高校");
  const site = f.screen.getByRole("region", { name: "正文目录站点探针" });
  assert.ok(within(site).getByText("列表样本：1 条"));
  assert.equal(within(site).queryByText(/有效样本：1/), null);
  assert.ok(within(site).getByText("页面结构无法解析"));
  assert.ok(within(site).getByText("正文待验证"));
});

for (const [code, label] of [
  ["tls_certificate_expired", "当前连接的证书已过期"],
  ["tls_hostname_mismatch", "当前连接的证书与访问域名不匹配"],
]) {
  test(`source card explains ${code} while retaining last successful probe`, async t => {
    const data = { ...catalog(), sites: [{ ...catalog().sites[0], health: {
      status: "unavailable", checkedAt: "2026-10-24T00:00:00Z", lastSuccessAt: "2026-10-05T00:00:00Z",
      issues: [{ code, diagnosticId: "d-00000000-0000-4000-8000-000000000024", message: "TLS_PRIVATE_CANARY" }],
    } }] };
    const f = await renderApp(t, { route: "#/sources?packageId=A&targetRevisionId=t1%401",
      apiHandler: (p, o) => p === "/sources" ? data : syntheticApi(p, o) });
    await openSource(f, "合成学校");
    const card = f.screen.getByRole("region", { name: "候选目录站点探针" });
    assert.ok(within(card).getByText(label));
    assert.ok(within(card).getByText(/最近成功：2026/));
    assert.ok(within(card).getByRole("link", { name: /查看.*(?:日志|诊断)/ }));
    assert.doesNotMatch(document.body.textContent ?? "", /TLS_PRIVATE_CANARY/);
  });
}
