import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { mountSettingsPage } from "../../public/js/pages/settings.js";
import { mountWorkbenchPage } from "../../public/js/pages/workbench.js";
import { runProgress } from "../../public/js/components/run-progress.js";
import { createApiClient } from "../../public/js/api.js";
import { diagnosticsPanel } from "../../public/js/components/diagnostics-panel.js";

const diagnostic = (message, diagnosticId = "diag-example") => ({
  diagnosticId,
  at: "2026-10-06T03:00:00Z",
  level: "error",
  operation: "source.collect",
  sourceId: "example-source",
  siteId: "example-site",
  stage: "collecting",
  code: "source_failed",
  message,
});
const logs = (entries = [], storage = { mode: "file" }) => ({
  entries,
  storage,
  file: "logs/application.log",
});
const settings = {
  model: {
    baseUrl: "https://example.test/v1",
    model: "example",
    configured: false,
  },
  budgets: { maxModelRequests: 20 },
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function panel(root) {
  const node = [...root.querySelectorAll("details")].find((n) =>
    n.querySelector("summary")?.textContent.includes("查看更新日志"),
  );
  assert.ok(node, "日志入口应独立显示并可在页面读取失败后打开");
  return node;
}
function open(document, node) {
  node.open = true;
  node.dispatchEvent(new document.defaultView.Event("toggle"));
}
function control(root, label) {
  const node = [...root.querySelectorAll("button")].find(
    (n) => n.textContent === label,
  );
  assert.ok(node, "缺少操作按钮：" + label);
  return node;
}
function settingsFixture(onLogs, failCatalog = false) {
  return uiFixture((path) => {
    if (path === "/sources") {
      if (failCatalog) throw Error("来源目录暂时无法读取");
      return { sources: [], sites: [] };
    }
    if (path === "/settings") return settings;
    if (path.startsWith("/diagnostics/logs")) return onLogs(path);
    throw Error("Unexpected request: " + path);
  });
}

test("API failures preserve the diagnostic ID and show it with the error", async () => {
  const api = createApiClient({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: "来源更新失败",
          code: "source_failed",
          diagnosticId: "diag-request-1",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
  });
  await assert.rejects(api.request("/runs"), (error) => {
    assert.equal(error.diagnosticId, "diag-request-1");
    assert.equal(error.code, "source_failed");
    assert.match(error.message, /错误编号.*diag-request-1/);
    return true;
  });
});

test("settings logs stay available after catalog failure and load only when opened", async () => {
  const f = settingsFixture(
    () =>
      logs([], {
        mode: "memory",
        message: "日志文件暂时不可写",
      }),
    true,
  );
  const page = mountSettingsPage(f);
  await page.ready;
  const node = panel(f.root);
  assert.equal(
    f.calls.filter((c) => c.path.startsWith("/diagnostics/logs")).length,
    0,
  );
  open(f.document, node);
  await f.settle();
  assert.equal(f.calls.at(-1).path, "/diagnostics/logs?limit=200");
  assert.match(node.textContent, /暂无.*日志/);
  assert.match(node.textContent, /内存/);
  assert.match(node.textContent, /日志文件暂时不可写/);
  page.destroy();
});

test("refresh keeps existing logs after failure, blocks duplicate reads and renders plain text", async () => {
  const pending = deferred();
  let reads = 0;
  const entry = diagnostic("<img src=x onerror=alert(1)> 来源超时");
  entry.error = {
    name: "Error",
    code: "ETIMEDOUT",
    message: "请求超时",
    stack: "Error: 请求超时\n at source.example:1",
    cause: { code: "ECONNRESET", message: "连接已重置" },
  };
  const f = settingsFixture(() =>
    ++reads === 1 ? logs([entry]) : pending.promise,
  );
  const page = mountSettingsPage(f);
  await page.ready;
  const node = panel(f.root);
  open(f.document, node);
  await f.settle();
  assert.match(node.textContent, /diag-example/);
  assert.match(node.textContent, /ECONNRESET/);
  assert.equal(node.querySelector("img"), null);
  const refresh = control(node, "刷新日志");
  refresh.click();
  refresh.click();
  assert.equal(reads, 2);
  assert.equal(refresh.disabled, true);
  pending.reject(
    Object.assign(Error("读取中断"), { diagnosticId: "diag-read-2" }),
  );
  await f.settle();
  assert.match(node.textContent, /来源超时/);
  assert.match(node.textContent, /读取失败.*读取中断/);
  assert.match(node.textContent, /错误编号.*diag-read-2/);
  assert.equal(refresh.disabled, false);
  page.destroy();
});

function workbenchFixture(onLogs) {
  const f = uiFixture((path) => {
    if (path === "/profiles") return { profiles: [] };
    if (path === "/targets")
      return {
        targets: [
          {
            targetId: "target-1",
            revisionId: "target-1@1",
            revision: 1,
            enabled: true,
            roles: ["软件开发"],
            profileRevisionId: "profile-1@1",
          },
        ],
      };
    if (path.startsWith("/jobs?")) return { items: [], total: 0 };
    if (path.startsWith("/runs?"))
      return {
        runs: [
          {
            runId: "run-old",
            createdAt: "2026-10-05",
            status: "completed",
            targetSnapshot: { revisionId: "target-1@1" },
          },
        ],
      };
    if (path === "/runs") return { runId: "run-new", status: "queued" };
    if (path.startsWith("/runs/"))
      return {
        runId: path.slice(6),
        status: "completed",
        stage: "finished",
        counts: {},
        coverage: [],
        issues: [],
        usage: {},
      };
    if (path.startsWith("/diagnostics/logs")) return onLogs(path);
    throw Error("Unexpected request: " + path);
  });
  f.api.streamRun = async (id, { onEvent }) => {
    await onEvent({
      runId: id,
      seq: 1,
      type: "stage",
      payload: { status: "running", stage: "collecting", counts: {} },
    });
    await onEvent({
      runId: id,
      seq: 2,
      type: "done",
      payload: { status: "completed", stage: "finished", counts: {} },
    });
  };
  return f;
}

test("workbench logs follow the current and historical run without stale results or progress replacement", async () => {
  const stale = deferred();
  const f = workbenchFixture((path) => {
    if (path === "/diagnostics/logs?limit=200") return stale.promise;
    if (path === "/diagnostics/logs?runId=run-new&limit=200")
      return logs([diagnostic("当前任务日志", "diag-new")]);
    if (path === "/diagnostics/logs?runId=run-old&limit=200")
      return logs([diagnostic("历史任务日志", "diag-old")]);
    throw Error("Unexpected diagnostics query: " + path);
  });
  const page = mountWorkbenchPage(f);
  await page.ready;
  const node = panel(f.root);
  open(f.document, node);
  f.root.querySelector("#startRun").click();
  await f.settle();
  assert.equal(panel(f.root), node);
  assert.match(node.textContent, /当前任务日志/);
  stale.resolve(logs([diagnostic("过期的全局日志")]));
  await f.settle();
  assert.doesNotMatch(node.textContent, /过期的全局日志/);
  control(f.root, "2026-10-05 · completed").click();
  await f.settle();
  assert.match(node.textContent, /历史任务日志/);
  assert.doesNotMatch(node.textContent, /当前任务日志/);
  page.destroy();
});

test("log export uses the selected run and blocks duplicate downloads", async () => {
  const f = workbenchFixture(() => logs());
  const page = mountWorkbenchPage(f);
  await page.ready;
  const node = panel(f.root);
  open(f.document, node);
  control(f.root, "2026-10-05 · completed").click();
  await f.settle();
  const pending = deferred(),
    paths = [],
    downloads = [];
  f.api.download = (path) => {
    paths.push(path);
    return pending.promise;
  };
  const create = f.document.createElement.bind(f.document);
  f.document.createElement = (tag) => {
    const element = create(tag);
    if (tag === "a")
      element.click = () => downloads.push(element.getAttribute("download"));
    return element;
  };
  const download = control(node, "导出日志");
  download.click();
  download.click();
  assert.deepEqual(paths, ["/diagnostics/logs/export?runId=run-old"]);
  assert.equal(download.disabled, true);
  pending.resolve(new Blob(["示例诊断日志"], { type: "text/plain" }));
  await f.settle();
  assert.equal(downloads.length, 1);
  assert.match(downloads[0], /\.log$/);
  assert.equal(download.disabled, false);
  page.destroy();
});

test("destroyed log panels ignore pending reads", async () => {
  const pending = deferred();
  const f = settingsFixture(() => pending.promise);
  const page = mountSettingsPage(f);
  await page.ready;
  const node = panel(f.root);
  open(f.document, node);
  page.destroy();
  pending.resolve(logs([diagnostic("页面关闭后的结果")]));
  await f.settle();
  assert.doesNotMatch(node.textContent, /页面关闭后的结果/);
  assert.equal(f.root.children.length, 0);
});

test("run progress explains the stage and diagnostic issue without changing run status", () => {
  const f = uiFixture(() => {});
  const node = runProgress({
    document: f.document,
    run: {
      runId: "run-example",
      status: "partial",
      stage: "collecting",
      counts: {},
      usage: {},
      coverage: [],
      issues: [
        {
          code: "source_failed",
          message: "示例来源连接超时",
          diagnosticId: "diag-source-1",
          operation: "source.collect",
        },
      ],
    },
  });
  assert.match(node.textContent, /部分来源失败/);
  assert.match(node.textContent, /阶段：采集招聘来源/);
  assert.match(node.textContent, /错误编号.*diag-source-1/);
  assert.match(node.textContent, /查看更新日志/);
  assert.match(node.textContent, /检查网络/);
});

test("diagnostic filters preserve task scope and apply equally to complete export", async () => {
  const f = uiFixture(() => ({
    ...logs(),
    summary: {
      total: 280,
      returned: 200,
      truncated: true,
      errors: 3,
      warnings: 2,
    },
    retention: { maxFiles: 2, maxFileBytes: 2097152 },
  }));
  const component = diagnosticsPanel(f);
  f.root.append(component.node);
  component.setRunId("r-filtered");
  open(f.document, component.node);
  await f.settle();
  assert.match(component.node.textContent, /200.*280/);
  assert.match(component.node.textContent, /导出.*全部|全部.*导出/);
  const severity = component.node.querySelector('[name="diagnosticLevel"]');
  const category = component.node.querySelector('[name="diagnosticCategory"]');
  const diagnosticId = component.node.querySelector('[name="diagnosticId"]');
  assert.ok(
    severity && category && diagnosticId,
    "level, category and diagnostic number filters are available",
  );
  severity.value = "problem";
  category.value = "storage";
  diagnosticId.value = "d-00000000-0000-4000-8000-000000000001";
  control(component.node, "筛选日志").click();
  await f.settle();
  const query = new URLSearchParams(f.calls.at(-1).path.split("?")[1]);
  assert.equal(query.get("runId"), "r-filtered");
  assert.equal(query.get("level"), "problem");
  assert.equal(query.get("category"), "storage");
  assert.equal(query.get("diagnosticId"), diagnosticId.value);
  const exported = [];
  f.api.download = async (path) => {
    exported.push(path);
    return new Blob(["synthetic diagnostic"]);
  };
  control(component.node, "导出日志").click();
  await f.settle();
  const exportQuery = new URLSearchParams(exported[0].split("?")[1]);
  assert.equal(exportQuery.has("limit"), false);
  assert.equal(exportQuery.get("category"), "storage");
  assert.equal(exportQuery.get("runId"), "r-filtered");
  control(component.node, "查看全部日志").click();
  await f.settle();
  assert.equal(
    new URLSearchParams(f.calls.at(-1).path.split("?")[1]).has("runId"),
    false,
  );
  component.destroy();
});

test("diagnostic details expose safe request and storage context as plain text", async () => {
  const f = uiFixture(() =>
    logs([
      {
        ...diagnostic("合成错误"),
        method: "PUT",
        route: "/api/v2/settings",
        requestId: "q-synthetic",
        phase: "mutation",
        outcome: "failed",
        httpStatus: 500,
        resource: "workspace.v2.json",
        retryCount: 2,
        retryDelayMs: 30,
        recordCount: 12,
        counts: { ingested: 12 },
        failurePhase: "dns",
        queueMs: 7,
        dnsMs: 9,
        transportMs: 11,
        timeoutMs: 12000,
        parser: { format: "html", selectorPresent: false },
        usage: { sources: { requests: 5, maxRequests: 12 } },
        truncationReason: "listing_only",
      },
    ]),
  );
  const component = diagnosticsPanel(f);
  f.root.append(component.node);
  open(f.document, component.node);
  await f.settle();
  assert.match(component.node.textContent, /PUT.*\/api\/v2\/settings/);
  assert.match(component.node.textContent, /HTTP.*500/);
  assert.match(component.node.textContent, /workspace\.v2\.json/);
  assert.match(component.node.textContent, /DNS.*9ms/);
  assert.match(component.node.textContent, /排队.*7ms/);
  assert.match(component.node.textContent, /selectorPresent/);
  assert.match(component.node.textContent, /maxRequests/);
  assert.match(component.node.textContent, /范围限制.*当前列表页/);
  assert.match(component.node.textContent, /重试.*2/);
  assert.match(component.node.textContent, /q-synthetic/);
  component.destroy();
});

test("completed task invalidates collapsed log history before reopening", async () => {
  let reads = 0;
  const f = uiFixture(() =>
    logs([diagnostic(++reads === 1 ? "任务进行中" : "任务已经结束")]),
  );
  const component = diagnosticsPanel(f);
  f.root.append(component.node);
  open(f.document, component.node);
  await f.settle();
  component.node.open = false;
  component.refresh();
  open(f.document, component.node);
  await f.settle();
  assert.match(component.node.textContent, /任务已经结束/);
  assert.equal(reads, 2);
  component.destroy();
});

test("task completion refresh preserves an export of the same selected scope", async () => {
  const f = uiFixture(() => logs([diagnostic("更新日志")]));
  const component = diagnosticsPanel(f);
  f.root.append(component.node);
  open(f.document, component.node);
  await f.settle();
  const pending = deferred(),
    downloads = [];
  f.api.download = () => pending.promise;
  const create = f.document.createElement.bind(f.document);
  f.document.createElement = (tag) => {
    const element = create(tag);
    if (tag === "a")
      element.click = () => downloads.push(element.getAttribute("download"));
    return element;
  };
  control(component.node, "导出日志").click();
  await component.refresh();
  pending.resolve(new Blob(["合成诊断"]));
  await f.settle();
  assert.equal(downloads.length, 1);
  component.destroy();
});
