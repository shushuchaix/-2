import test from "node:test";
import assert from "node:assert/strict";
import { act, waitFor, within } from "@testing-library/react";
import { renderApp } from "../helpers/react-fixture";

test("run history explains its result and counts before safe technical details", async (t) => {
  const f = await renderApp(t, {
    route: "#/logs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path) =>
      path === "/runs"
        ? {
            runs: [
              {
                runId: "synthetic-run-counts",
                status: "partial",
                stage: "collecting",
                createdAt: "2026-10-10T02:00:00Z",
                counts: {
                  raw: 3,
                  newForTarget: 2,
                  eligible: 0,
                  secret: "PRIVATE_DIAGNOSTIC_SENTINEL",
                },
                resumeText: "PRIVATE_DIAGNOSTIC_SENTINEL",
              },
            ],
          }
        : undefined,
  });
  const summary = await f.screen.findByRole("region", { name: "运行结果摘要" });
  assert.ok(within(summary).getByText("采集 3 / 保存 2"));
  assert.ok(within(summary).getByText(/阶段：采集岗位/));
  assert.ok(within(summary).getByText("部分完成"));
  assert.match(summary.textContent ?? "", /2026-10-10/);
  assert.equal(f.screen.queryByText(/"raw":\s*3/), null);
  assert.equal(f.screen.queryByText("synthetic-run-counts"), null);
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /PRIVATE_DIAGNOSTIC_SENTINEL/,
  );
  await f.user.click(within(summary).getByRole("button", { name: "技术详情" }));
  assert.ok(f.screen.getByText("synthetic-run-counts"));
  assert.ok(f.screen.getByText(/"raw":\s*3/));
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /PRIVATE_DIAGNOSTIC_SENTINEL/,
  );
});

test("business history uses exact owner scope and clears old response when selection changes", async (t) => {
  let release!: (data: unknown) => void;
  const old = new Promise((resolve) => {
    release = resolve;
  });
  const f = await renderApp(t, {
    route: "#/logs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path, options) => {
      if (path === "/runs")
        return options?.scope &&
          "packageId" in options.scope &&
          options.scope.packageId === "A"
          ? old
          : {
              runs: [
                {
                  runId: "run-b",
                  ownerPackageId: "B",
                  status: "completed",
                  stage: "finished",
                  counts: { accepted: 4 },
                  issues: [
                    {
                      code: "ETIMEDOUT",
                      diagnosticId: "d-00000000-0000-4000-8000-000000000004",
                    },
                  ],
                },
              ],
            };
    },
  });
  await f.selectTarget({ packageId: "A", targetRevisionId: "t1@1" });
  await f.selectTarget({ packageId: "B", targetRevisionId: "t2@1" });
  await f.user.click(await f.screen.findByRole("button", { name: "技术详情" }));
  assert.ok(await f.screen.findByText("run-b"));
  await act(async () => {
    release({
      runs: [{ runId: "private-run-a", ownerPackageId: "A", status: "failed" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(f.screen.queryByText("private-run-a"), null);
  assert.ok(f.screen.getByText("run-b"));
  const diagnosticLink = f.screen.getByRole("link", { name: "查看更新日志" });
  const linkedScope = new URLSearchParams(
    diagnosticLink.getAttribute("href")?.split("?")[1],
  );
  assert.equal(linkedScope.get("packageId"), "B");
  assert.equal(linkedScope.get("targetRevisionId"), "t2@1");
  const requests = f.apiCalls.filter((c) => c.path === "/runs");
  assert.ok(
    requests.some(
      (c) =>
        c.scope &&
        "packageId" in c.scope &&
        c.scope.packageId === "B" &&
        c.scope.targetRevisionId === "t2@1",
    ),
  );
});

test("same-page history diagnostic link synchronizes tab filters export and browser history in the exact scope", async (t) => {
  const diagnosticId = "d-00000000-0000-4000-8000-000000000005";
  const f = await renderApp(t, {
    route: "#/logs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path) =>
      path === "/runs"
        ? {
            runs: [
              {
                runId: "run-diagnostic",
                status: "failed",
                issues: [{ code: "ETIMEDOUT", diagnosticId }],
              },
            ],
          }
        : path.startsWith("/diagnostics/logs/export")
          ? new Blob(["synthetic-log"])
          : path.startsWith("/diagnostics/logs")
            ? { entries: [] }
            : undefined,
  });
  await f.user.click(
    await f.screen.findByRole("link", { name: "查看更新日志" }),
  );
  await waitFor(() =>
    assert.equal(
      f.screen
        .getByRole("tab", { name: "系统诊断" })
        .getAttribute("aria-selected"),
      "true",
    ),
  );
  assert.equal(
    (f.screen.getByLabelText("错误编号") as HTMLInputElement).value,
    diagnosticId,
  );
  await waitFor(() =>
    assert.ok(
      f.apiCalls.some(
        (c) =>
          c.path.startsWith("/diagnostics/logs?") &&
          c.path.includes(diagnosticId),
      ),
    ),
  );
  const read = f.apiCalls
    .filter((c) => c.path.startsWith("/diagnostics/logs?"))
    .at(-1)!;
  assert.deepEqual(read.scope, { packageId: "A", targetRevisionId: "t1@1" });
  t.mock.method(window.HTMLAnchorElement.prototype, "click", () => {});
  await f.user.click(f.screen.getByRole("button", { name: "导出日志" }));
  await f.screen.findAllByText("日志已生成，已开始下载");
  const exported = f.apiCalls.find((c) =>
    c.path.startsWith("/diagnostics/logs/export"),
  )!;
  assert.equal(
    new URLSearchParams(exported.path.split("?")[1]).get("diagnosticId"),
    diagnosticId,
  );
  assert.deepEqual(exported.scope, {
    packageId: "A",
    targetRevisionId: "t1@1",
  });
  window.history.back();
  await waitFor(() =>
    assert.equal(
      f.screen
        .getByRole("tab", { name: "业务历史" })
        .getAttribute("aria-selected"),
      "true",
    ),
  );
  await f.user.click(await f.screen.findByRole("button", { name: "技术详情" }));
  await f.screen.findByText("run-diagnostic");
  window.history.forward();
  await waitFor(() =>
    assert.equal(
      f.screen
        .getByRole("tab", { name: "系统诊断" })
        .getAttribute("aria-selected"),
      "true",
    ),
  );
  assert.equal(
    (f.screen.getByLabelText("错误编号") as HTMLInputElement).value,
    diagnosticId,
  );
});

test("switching to business history updates the hash so the same diagnostic link can reopen its system view", async (t) => {
  const diagnosticId = "d-00000000-0000-4000-8000-000000000009";
  const f = await renderApp(t, {
    route: `#/logs?packageId=A&targetRevisionId=t1%401&tab=system&diagnosticId=${diagnosticId}`,
    apiHandler: (path) =>
      path === "/runs"
        ? {
            runs: [
              {
                runId: "same-diagnostic-run",
                status: "failed",
                issues: [{ code: "ETIMEDOUT", diagnosticId }],
              },
            ],
          }
        : path.startsWith("/diagnostics/logs")
          ? { entries: [] }
          : undefined,
  });
  await f.screen.findByLabelText("错误编号");
  await f.user.clear(f.screen.getByLabelText("错误编号"));
  await f.user.type(
    f.screen.getByLabelText("错误编号"),
    "UNAPPLIED_FILTER_DRAFT",
  );
  await f.user.click(f.screen.getByRole("tab", { name: "业务历史" }));
  const hash = new URLSearchParams(window.location.hash.split("?")[1]);
  assert.equal(hash.get("tab"), "business");
  assert.equal(hash.get("packageId"), "A");
  assert.equal(hash.get("targetRevisionId"), "t1@1");
  await f.user.click(await f.screen.findByRole("button", { name: "技术详情" }));
  await f.screen.findByText("same-diagnostic-run");
  await f.user.click(f.screen.getByRole("tab", { name: "系统诊断" }));
  assert.equal(
    (f.screen.getByLabelText("错误编号") as HTMLInputElement).value,
    "UNAPPLIED_FILTER_DRAFT",
  );
  await f.user.click(f.screen.getByRole("tab", { name: "业务历史" }));
  const before = f.apiCalls.filter((c) =>
    c.path.startsWith("/diagnostics/logs"),
  ).length;
  await f.user.click(
    await f.screen.findByRole("link", { name: "查看更新日志" }),
  );
  await waitFor(() =>
    assert.equal(
      f.screen
        .getByRole("tab", { name: "系统诊断" })
        .getAttribute("aria-selected"),
      "true",
    ),
  );
  assert.equal(
    (f.screen.getByLabelText("错误编号") as HTMLInputElement).value,
    diagnosticId,
  );
  await waitFor(() =>
    assert.ok(
      f.apiCalls.filter((c) => c.path.startsWith("/diagnostics/logs")).length >
        before,
    ),
  );
  const last = f.apiCalls
    .filter((c) => c.path.startsWith("/diagnostics/logs"))
    .at(-1)!;
  assert.equal(
    new URLSearchParams(last.path.split("?")[1]).get("diagnosticId"),
    diagnosticId,
  );
  assert.deepEqual(last.scope, { packageId: "A", targetRevisionId: "t1@1" });
});

test("log hash filters synchronize meaningful navigation without overwriting an unrelated-hash draft", async (t) => {
  const first = "d-00000000-0000-4000-8000-000000000006";
  const draft = "d-00000000-0000-4000-8000-000000000007";
  const next = "d-00000000-0000-4000-8000-000000000008";
  const f = await renderApp(t, {
    route: `#/logs?packageId=A&targetRevisionId=t1%401&tab=system&level=warn&category=network&diagnosticId=${first}`,
    apiHandler: (path) =>
      path.startsWith("/diagnostics/logs") ? { entries: [] } : undefined,
  });
  await f.screen.findByLabelText("错误编号");
  const initial = f.apiCalls
    .filter((c) => c.path.startsWith("/diagnostics/logs"))
    .at(-1)!;
  const query = new URLSearchParams(initial.path.split("?")[1]);
  assert.equal(query.get("level"), "warn");
  assert.equal(query.get("category"), "network");
  await f.user.clear(f.screen.getByLabelText("错误编号"));
  await f.user.type(f.screen.getByLabelText("错误编号"), draft);
  const before = f.apiCalls.filter((c) =>
    c.path.startsWith("/diagnostics/logs"),
  ).length;
  await act(async () => {
    window.history.replaceState(
      null,
      "",
      "http://localhost/" + window.location.hash + "&view=unrelated",
    );
    window.dispatchEvent(new Event("hashchange"));
  });
  assert.equal(
    (f.screen.getByLabelText("错误编号") as HTMLInputElement).value,
    draft,
  );
  assert.equal(
    f.apiCalls.filter((c) => c.path.startsWith("/diagnostics/logs")).length,
    before,
  );
  await act(async () => {
    window.history.replaceState(
      null,
      "",
      `http://localhost/#/logs?packageId=A&targetRevisionId=t1%401&tab=system&level=error&category=storage&diagnosticId=${next}`,
    );
    window.dispatchEvent(new Event("hashchange"));
  });
  assert.equal(
    (f.screen.getByLabelText("错误编号") as HTMLInputElement).value,
    next,
  );
  const applied = f.apiCalls
    .filter((c) => c.path.startsWith("/diagnostics/logs"))
    .at(-1)!;
  const changed = new URLSearchParams(applied.path.split("?")[1]);
  assert.equal(changed.get("level"), "error");
  assert.equal(changed.get("category"), "storage");
  assert.equal(changed.get("diagnosticId"), next);
  assert.deepEqual(applied.scope, { packageId: "A", targetRevisionId: "t1@1" });
});

test("system diagnostics render safe context and never arbitrary private fields", async (t) => {
  const f = await renderApp(t, {
    route: "#/logs?packageId=A&targetRevisionId=t1%401",
    apiHandler: (path) =>
      path.startsWith("/diagnostics/logs")
        ? {
            entries: [
              {
                at: "2026-10-09T00:00:00Z",
                level: "error",
                operation: "network.request",
                diagnosticId: "d-00000000-0000-4000-8000-000000000002",
                code: "ETIMEDOUT",
                queueMs: 7,
                dnsMs: 9,
                transportMs: 11,
                counts: { accepted: 4, secret: "PRIVATE_KEY_SENTINEL" },
                parser: {
                  format: "html",
                  selectorPresent: false,
                  body: "PRIVATE_BODY_SENTINEL",
                },
                usage: {
                  model: {
                    costUpperBoundCny: 2.3,
                    maxCostCny: 10,
                    maxOutputTokens: 4000,
                    costMode: "cny_upper_bound",
                    secret: "PRIVATE_KEY_SENTINEL",
                  },
                  sources: {
                    requests: 5,
                    maxRequests: 10,
                    byKind: { detail: 2 },
                  },
                },
                resumeText: "PRIVATE_RESUME_SENTINEL",
                path: "C:/PRIVATE_PATH_SENTINEL",
                keywords: "PRIVATE_KEYWORD_SENTINEL",
                message: "PRIVATE_MESSAGE_SENTINEL",
              },
            ],
            summary: { returned: 1, total: 1, errors: 1, warnings: 0 },
          }
        : undefined,
  });
  await f.user.click(f.screen.getByRole("tab", { name: "系统诊断" }));
  const details = await f.screen.findByRole("button", { name: /查看诊断/ });
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /d-00000000-0000-4000-8000-000000000002|ETIMEDOUT/,
  );
  assert.doesNotMatch(details.getAttribute("aria-label") ?? "", /d-00000000/);
  assert.ok(f.screen.getByText("请求超时"));
  await f.user.click(details);
  const summary = f.screen.getByRole("region", { name: "诊断事件摘要" });
  assert.ok(within(summary).getByText("网络请求"));
  assert.ok(within(summary).getByText("错误"));
  assert.ok(within(summary).getByText("请求超时"));
  assert.doesNotMatch(summary.textContent ?? "", /d-00000000|ETIMEDOUT/);
  assert.equal(f.screen.queryByText(/costUpperBoundCny/), null);
  assert.doesNotMatch(document.body.textContent ?? "", /PRIVATE_/);
  await f.user.click(f.screen.getByRole("button", { name: "技术详情" }));
  const text = document.body.textContent || "";
  assert.match(text, /ETIMEDOUT/);
  assert.match(text, /d-00000000-0000-4000-8000-000000000002/);
  assert.match(text, /9/);
  assert.match(text, /costUpperBoundCny/);
  assert.match(text, /2\.3/);
  assert.match(text, /byKind/);
  assert.doesNotMatch(text, /PRIVATE_/);
  assert.deepEqual(
    f.apiCalls.find((c) => c.path.startsWith("/diagnostics/logs"))?.scope,
    { packageId: "A", targetRevisionId: "t1@1" },
  );
});

test("log validation rejects malformed diagnostic ID before reading filtered logs", async (t) => {
  const f = await renderApp(t, {
    route: "#/logs",
    apiHandler: (path) =>
      path.startsWith("/diagnostics/logs") ? { entries: [] } : undefined,
  });
  await f.user.click(f.screen.getByRole("tab", { name: "系统诊断" }));
  await f.user.type(f.screen.getByLabelText("错误编号"), "not-a-diagnostic-id");
  const before = f.apiCalls.filter((c) =>
    c.path.startsWith("/diagnostics/logs"),
  ).length;
  await f.user.click(f.screen.getByRole("button", { name: "筛选日志" }));
  assert.equal(
    f.apiCalls.filter((c) => c.path.startsWith("/diagnostics/logs")).length,
    before,
  );
  assert.equal(
    f.screen.getByLabelText("错误编号").getAttribute("aria-invalid"),
    "true",
  );
});

test("filtered diagnostic export keeps filters omits list limit and blocks duplicate downloads", async (t) => {
  let release!: (data: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const downloads: string[] = [];
  const create = document.createElement.bind(document);
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = create(tag, options);
    if (tag === "a")
      element.click = () =>
        downloads.push((element as HTMLAnchorElement).download);
    return element;
  }) as typeof document.createElement;
  t.after(() => {
    document.createElement = create;
  });
  const f = await renderApp(t, {
    route:
      "#/logs?packageId=A&targetRevisionId=t1%401&tab=system&diagnosticId=d-00000000-0000-4000-8000-000000000003",
    apiHandler: (path) =>
      path.startsWith("/diagnostics/logs/export")
        ? pending
        : path.startsWith("/diagnostics/logs")
          ? {
              entries: [],
              summary: { returned: 0, total: 500, truncated: true },
            }
          : undefined,
  });
  const button = await f.screen.findByRole("button", { name: "导出日志" });
  await f.screen.findByText(/错误 未统计，提醒 未统计/);
  await f.user.click(button);
  await f.user.click(button);
  const calls = f.apiCalls.filter((c) =>
    c.path.startsWith("/diagnostics/logs/export"),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].scope, {
    packageId: "A",
    targetRevisionId: "t1@1",
  });
  const query = new URLSearchParams(calls[0].path.split("?")[1]);
  assert.equal(
    query.get("diagnosticId"),
    "d-00000000-0000-4000-8000-000000000003",
  );
  assert.equal(query.has("limit"), false);
  release(new Blob(["合成诊断日志"]));
  assert.ok((await f.screen.findAllByText("日志已生成，已开始下载")).length);
  assert.deepEqual(downloads, ["job-radar-diagnostics.log"]);
});

test("maintenance diagnostics use unscoped safe logs only after explicit server confirmation", async (t) => {
  const f = await renderApp(t, {
    route: "#/logs?tab=system",
    apiHandler: (path) => {
      if (path === "/profiles" || path === "/targets")
        throw Object.assign(new Error("工作区需要维护"), {
          status: 503,
          code: "workspace_control_invalid",
        });
      if (path === "/maintenance")
        return { status: "maintenance", maintenance: true };
      if (path.startsWith("/diagnostics/logs")) return { entries: [] };
    },
  });
  assert.ok(await f.screen.findByText(/维护模式：仅显示安全系统诊断/));
  assert.ok(f.apiCalls.some((c) => c.path === "/maintenance"));
  const reads = f.apiCalls.filter((c) =>
    c.path.startsWith("/diagnostics/logs"),
  );
  assert.ok(reads.length > 0);
  assert.ok(reads.every((c) => !c.scope));
});
