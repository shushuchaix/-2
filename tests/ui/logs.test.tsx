import test from "node:test";
import assert from "node:assert/strict";
import { renderApp } from "../helpers/react-fixture";

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
                },
              ],
            };
    },
  });
  await f.selectTarget({ packageId: "A", targetRevisionId: "t1@1" });
  await f.selectTarget({ packageId: "B", targetRevisionId: "t2@1" });
  assert.ok(await f.screen.findByText("run-b"));
  release({
    runs: [{ runId: "private-run-a", ownerPackageId: "A", status: "failed" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.screen.queryByText("private-run-a"), null);
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
  await f.user.click(await f.screen.findByRole("button", { name: /查看诊断/ }));
  const text = document.body.textContent || "";
  assert.match(text, /ETIMEDOUT/);
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
