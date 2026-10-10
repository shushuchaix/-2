import test from "node:test";
import assert from "node:assert/strict";
import { waitFor, act } from "@testing-library/react";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
test("a hash navigation restores job filters without changing its owner scope", async (t) => {
  const f = await renderApp(t, {
    route: "#/jobs?packageId=A&targetRevisionId=t1%401&search=first",
    apiHandler: syntheticApi,
  });
  await act(async () => {
    window.location.hash =
      "#/jobs?packageId=A&targetRevisionId=t1%401&search=restored";
    window.dispatchEvent(new Event("hashchange"));
  });
  await waitFor(() =>
    assert.equal(
      (f.screen.getByLabelText("搜索岗位") as HTMLInputElement).value,
      "restored",
    ),
  );
  assert.deepEqual(
    f.apiCalls.filter((c) => c.path.startsWith("/jobs?")).at(-1)?.scope,
    { packageId: "A", targetRevisionId: "t1@1" },
  );
});
test("social recruitment import validates content and preserves a rejected version-scoped draft", async (t) => {
  const f = await renderApp(t, {
    route: "#/jobs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path === "/imports"
        ? Promise.reject(
            Object.assign(Error("导入失败，请重试。"), {
              fieldErrors: { text: "正文尚无法确认" },
            }),
          )
        : syntheticApi(path, opts),
  });
  await f.user.click(f.screen.getByRole("button", { name: "导入招聘线索" }));
  await f.user.type(
    f.screen.getByLabelText("来源链接"),
    "https://mp.weixin.qq.com/s/synthetic",
  );
  await f.user.click(f.screen.getByRole("button", { name: "导入到当前版本" }));
  assert.equal(f.apiCalls.filter((c) => c.path === "/imports").length, 0);
  await f.user.type(f.screen.getByLabelText("招聘正文"), "合成招聘公告正文");
  await f.user.click(f.screen.getByRole("button", { name: "导入到当前版本" }));
  await f.screen.findAllByText("正文尚无法确认");
  assert.deepEqual(f.apiCalls.find((c) => c.path === "/imports")?.scope, {
    packageId: "A",
    targetRevisionId: "t1@1",
  });
  assert.equal(
    (f.screen.getByLabelText("招聘正文") as HTMLTextAreaElement).value,
    "合成招聘公告正文",
  );
});
test("job CSV export retains current filters and the exact selected owner", async (t) => {
  t.mock.method(window.HTMLAnchorElement.prototype, "click", () => {});
  const f = await renderApp(t, {
    route: "#/jobs?packageId=A&targetRevisionId=t1%401&recommendation=high",
    apiHandler: syntheticApi,
  });
  await f.user.click(
    f.screen.getByRole("button", { name: "导出筛选结果 CSV" }),
  );
  await f.screen.findAllByText("岗位导出已完成");
  const call = f.apiCalls.find((c) => c.path === "/exports");
  assert.deepEqual(call?.scope, { packageId: "A", targetRevisionId: "t1@1" });
  assert.deepEqual(call?.body, {
    format: "csv",
    filters: { recommendation: "high" },
  });
});
const item = (name: string, packageId: string) => ({
  jobId: "j-" + packageId,
  ownerPackageId: packageId,
  job: {
    jobId: "j-" + packageId,
    title: name,
    organization: "合成机场",
    cities: ["合成城市"],
    deadline: "2026-12-01",
    url: "https://example.invalid/job",
  },
  application: { applicationId: "a-" + packageId, status: "new" },
  evaluation: { score: 85, qualified: true, recommendation: "recommended" },
});
test("jobs keeps only the selected version when an old response arrives late", async (t) => {
  let resolveA: (v: unknown) => void = () => {};
  const f = await renderApp(t, {
    route: "#/jobs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path.startsWith("/jobs?")
        ? opts.scope &&
          "packageId" in opts.scope &&
          opts.scope.packageId === "A"
          ? new Promise((r) => (resolveA = r))
          : { items: [item("B的岗位", "B")], total: 1 }
        : syntheticApi(path, opts),
  });
  await f.selectTarget({ packageId: "B", targetRevisionId: "t2@1" });
  await f.screen.findByText("B的岗位");
  resolveA({ items: [item("A的岗位", "A")], total: 1 });
  await waitFor(() => assert.equal(f.screen.queryByText("A的岗位"), null));
  assert.equal(
    f.apiCalls.filter((c) => c.path.startsWith("/jobs?")).at(-1)?.scope
      ?.packageId,
    "B",
  );
});
test("jobs uses 25 rows by default and debounces search for 250 ms", async (t) => {
  const f = await renderApp(t, {
    route: "#/jobs?packageId=A&targetRevisionId=t1%401",
    apiHandler: syntheticApi,
  });
  await f.screen.findByLabelText("搜索岗位");
  assert.match(
    f.apiCalls.find((c) => c.path.startsWith("/jobs?"))!.path,
    /pageSize=25/,
  );
  await f.user.type(f.screen.getByLabelText("搜索岗位"), "消防");
  assert.equal(f.apiCalls.filter((c) => c.path.includes("search=")).length, 0);
  // Flush the native debounce timer inside React's act boundary. Polling a
  // failed DOM assertion can hold a concurrent render until waitFor times out.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.ok(
    f.apiCalls.some((c) => c.path.includes("search=%E6%B6%88%E9%98%B2")),
  );
  assert.equal(f.apiCalls.filter((c) => c.path.includes("search=")).length, 1);
});

test("job pagination supports fifty and one hundred rows and resets the page in its exact scope", async (t) => {
  const f = await renderApp(t, {
    route: "#/jobs?packageId=A&targetRevisionId=t1%401&recommendation=high",
    apiHandler: (path, options) => {
      if (path.startsWith("/jobs?")) {
        const query = new URLSearchParams(path.split("?")[1]);
        return {
          items: [
            item(
              `合成第${query.get("page")}页每页${query.get("pageSize")}条`,
              "A",
            ),
          ],
          total: 251,
        };
      }
      return syntheticApi(path, options);
    },
  });
  await f.screen.findByText("合成第1页每页25条");
  await f.user.click(f.screen.getByRole("combobox", { name: "每页条数" }));
  await f.user.click(await f.screen.findByRole("option", { name: "50 条/页" }));
  await f.screen.findByText("合成第1页每页50条");
  await f.user.click(f.screen.getByRole("button", { name: "下一页" }));
  await f.screen.findByText("合成第2页每页50条");
  await f.user.click(f.screen.getByRole("combobox", { name: "每页条数" }));
  await f.user.click(
    await f.screen.findByRole("option", { name: "100 条/页" }),
  );
  await f.screen.findByText("合成第1页每页100条");
  assert.ok(f.screen.getByText("第 1 页 · 共 251 条"));
  const last = f.apiCalls.filter((c) => c.path.startsWith("/jobs?")).at(-1)!;
  const query = new URLSearchParams(last.path.split("?")[1]);
  assert.equal(query.get("page"), "1");
  assert.equal(query.get("pageSize"), "100");
  assert.equal(query.get("recommendation"), "high");
  assert.deepEqual(last.scope, { packageId: "A", targetRevisionId: "t1@1" });
});
test("all-target job summaries require entering the owning version before edit", async (t) => {
  const f = await renderApp(t, {
    route: "#/jobs?allTargets=true",
    apiHandler: (path, opts) =>
      path.startsWith("/jobs?")
        ? { items: [item("共享岗位", "A")], total: 1 }
        : syntheticApi(path, opts),
  });
  await f.screen.findByText("共享岗位");
  assert.equal(f.screen.queryByRole("button", { name: "记录投递" }), null);
  await f.user.click(f.screen.getByRole("button", { name: "进入所属版本" }));
  assert.match(window.location.hash, /packageId=A/);
});
test("job detail uses this version fact record and exposes its own evaluation history", async (t) => {
  const detail = {
    jobId: "j-A",
    ownerPackageId: "A",
    job: {
      canonical: {
        title: "该版本岗位",
        company: "合成机场",
        cities: ["合成市"],
        deadlineAt: "2026-12-01",
        description: "本版本完整招聘正文",
        url: "https://example.invalid/job",
      },
    },
    fact: {
      status: "verified",
      record: {
        title: "该版本岗位",
        company: "合成机场",
        cities: ["合成市"],
        deadlineAt: "2026-12-01",
        description: "本版本完整招聘正文",
        url: "https://example.invalid/job",
      },
    },
    evaluation: {
      score: 85,
      status: "rules_fallback",
      qualification: {
        status: "pass",
        checks: [
          {
            type: "degree",
            status: "pass",
            requirement: "本科及以上",
            reason: "合成当前学历比较依据",
            evidence: { excerpt: "合成岗位学历原文" },
          },
          { type: "graduation_year", status: "pass", requirement: [2026, 2027], reason: "合成毕业届核对" },
        ],
      },
      components: {
        role: {
          score: 22,
          max: 22,
          evidence: [{ matchedText: "合成机场消防命中" }],
        },
      },
      evidence: [{ excerpt: "合成当前匹配原文" }],
      gaps: ["合成当前待核实证书"],
      recommendation: "high",
    },
    evaluations: [
      {
        evaluationId: "e-A",
        score: 85,
        matchesCurrentFact: true,
        createdAt: "2026-10-09",
        status: "rules",
        qualification: {
          status: "unknown",
          checks: [
            {
              type: "degree",
              status: "unknown",
              reason: "合成历史学历未确认",
              evidence: null,
            },
          ],
        },
        components: {
          skills: {
            score: 3,
            max: 45,
            evidence: [{ matchedText: "合成历史技能命中" }],
          },
        },
        evidence: [{ excerpt: "合成历史匹配原文" }],
        gaps: ["合成历史需确认学历"],
      },
    ],
    observations: [
      {
        observationId: "o-A",
        sourceId: "synthetic-source",
        observedAt: "2026-10-09",
      },
    ],
  };
  const f = await renderApp(t, {
    route: "#/jobs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, opts) =>
      path.startsWith("/jobs?")
        ? { items: [{ ...detail, title: "该版本岗位" }], total: 1 }
        : path === "/jobs/j-A"
          ? detail
          : syntheticApi(path, opts),
  });
  await f.user.click(await f.screen.findByRole("button", { name: "查看岗位" }));
  await f.screen.findByRole("dialog", { name: "该版本岗位" });
  assert.ok(f.screen.getByText("本版本完整招聘正文"));
  assert.ok(f.screen.getByText("评价历史"));
  assert.ok(f.screen.getAllByText("符合已知要求").length > 0);
  for (const text of [
    "合成当前学历比较依据",
    "合成岗位学历原文",
    "合成机场消防命中",
    "合成当前匹配原文",
    "合成当前待核实证书",
    "合成历史学历未确认",
    "合成历史技能命中",
    "合成历史匹配原文",
    "合成历史需确认学历",
  ])
    assert.ok(f.screen.getByText(text));
  assert.ok(f.screen.getByText("22 / 22 分"));
  assert.ok(f.screen.getByText("3 / 45 分"));
  assert.ok(f.screen.getByText("要求：2026、2027"));
  assert.deepEqual(f.apiCalls.find((c) => c.path === "/jobs/j-A")?.scope, {
    packageId: "A",
    targetRevisionId: "t1@1",
  });
});
