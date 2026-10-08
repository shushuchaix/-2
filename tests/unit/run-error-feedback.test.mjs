import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { runProgress } from "../../public/js/components/run-progress.js";
import { mountWorkbenchPage } from "../../public/js/pages/workbench.js";
import { sourceTable } from "../../public/js/components/source-table.js";
import { feedback } from "../../public/js/components/feedback.js";

const run = (overrides = {}) => ({
  runId: "synthetic-run",
  status: "partial",
  stage: "finished",
  counts: { raw: 122, deduplicated: 122, shortlisted: 37 },
  usage: {},
  coverage: [],
  issues: [],
  ...overrides,
});
const text = (value) =>
  runProgress({ document: uiFixture(() => {}).document, run: value })
    .textContent;

test("unavailable source errors show the source and HTTP reason without AI advice", () => {
  const rendered = text(
    run({
      coverage: [
        {
          sourceId: "synthetic-source",
          siteId: "synthetic-site",
          status: "failed",
          truncated: true,
        },
      ],
      issues: [
        {
          code: "unavailable",
          message: "HTTP 504",
          sourceId: "synthetic-source",
          siteId: "synthetic-site",
          diagnosticId: "diag-synthetic",
        },
      ],
    }),
  );
  assert.match(rendered, /HTTP 504/);
  assert.match(rendered, /synthetic-source/);
  assert.match(rendered, /synthetic-site/);
  assert.match(rendered, /diag-synthetic/);
  assert.doesNotMatch(rendered, /建议检查模型设置|使用规则模式重试/);
});

test("explicit model failures still offer model settings and rule mode advice", () => {
  const rendered = text(
    run({ issues: [{ code: "missing_model_key", message: "未配置模型密钥" }] }),
  );
  assert.match(rendered, /检查模型设置/);
  assert.match(rendered, /规则模式/);
});

test("missing original detail is an information notice rather than a retry instruction", () => {
  const rendered = text(
    run({
      status: "completed",
      issues: [
        {
          code: "detail_insufficient",
          operation: "run.detail",
          sourceId: "synthetic-source",
          message: "原网站详情没有完整要求",
          siteId: "synthetic-site",
        },
      ],
    }),
  );
  assert.match(rendered, /原网站未提供完整岗位要求，已保留列表信息/);
  assert.doesNotMatch(rendered, /检查网络|重试|检查模型/);
});

test("partial source failure confirms retained records and distinguishes it from a page limit", () => {
  const rendered = text(
    run({
      coverage: [
        { status: "failed", truncated: true, siteId: "synthetic-site" },
      ],
    }),
  );
  assert.match(rendered, /部分来源失败/);
  assert.match(rendered, /已保存 122 条记录/);
  assert.match(rendered, /候选 37 条/);
  assert.doesNotMatch(rendered, /达到.*采集上限/);
});

test("normal page budget partial result is explained without source failure advice", () => {
  const rendered = text(
    run({
      coverage: [
        { status: "complete", truncated: true, siteId: "synthetic-site" },
      ],
      issues: [{ code: "budget_exhausted", message: "达到本次采集上限" }],
    }),
  );
  assert.match(rendered, /采集上限/);
  assert.match(rendered, /已保存 122 条记录/);
  assert.match(rendered, /候选 37 条/);
  assert.doesNotMatch(rendered, /来源失败|检查网络|检查模型|失败操作/);
});

for (const [status, wording, coverage] of [
  ["completed", /更新完成/, []],
  ["partial", /部分来源失败/, [{ status: "failed", siteId: "synthetic-site" }]],
  ["failed", /更新失败/, []],
  ["cancelled", /取消/, []],
  ["interrupted", /中断/, []],
]) {
  test(`workbench replaces running feedback after ${status} while preserving the terminal state`, async () => {
    const finished = run({ status, coverage });
    const f = uiFixture((path) => {
      if (path === "/profiles") return { profiles: [] };
      if (path === "/targets")
        return {
          targets: [
            {
              targetId: "synthetic-target",
              revisionId: "synthetic-target@1",
              revision: 1,
              enabled: true,
              roles: ["合成岗位"],
            },
          ],
        };
      if (path.startsWith("/jobs?")) return { items: [], total: 0 };
      if (path.startsWith("/runs?")) return { runs: [] };
      if (path === "/runs") return { runId: "synthetic-run", status: "queued" };
      if (path === "/runs/synthetic-run") return finished;
      throw Error("Unexpected request: " + path);
    });
    f.api.streamRun = async (_, { onEvent }) => {
      await onEvent({
        runId: "synthetic-run",
        seq: 1,
        type: "done",
        payload: finished,
      });
    };
    const page = mountWorkbenchPage(f);
    await page.ready;
    f.root.querySelector("#startRun").click();
    await f.settle();
    const feedback = f.root.querySelector(".feedback").textContent;
    assert.match(feedback, wording);
    assert.match(feedback, /已保存 122 条记录/);
    assert.match(feedback, /候选 37 条/);
    assert.doesNotMatch(feedback, /在服务端运行|关闭页面后会继续/);
    assert.equal(f.store.getState().run.status, status);
    assert.equal(f.root.querySelector("#startRun").disabled, false);
    page.destroy();
  });
}

test("source availability uses current health and falls back to the catalog only when health is absent", () => {
  const f = uiFixture(() => {}),
    status = feedback(f.document);
  const sourceId = "synthetic-source";
  const blocked = [
    "unavailable",
    "restricted",
    "parse_error",
    "empty",
    "candidate",
    "skipped",
  ];
  const sources = [
    {
      sourceId,
      name: "合成来源",
      health: [
        {
          siteId: "source-health",
          status: "unavailable",
          backoffUntil: "2099-01-01",
          lastSuccessAt: "2026-01-01",
        },
        { siteId: "recovered", status: "ready" },
      ],
    },
  ];
  const sites = [
    ...blocked.map((state) => ({
      siteId: state,
      providerId: sourceId,
      name: state,
      status: "ready",
      health: { status: state },
    })),
    {
      siteId: "source-health",
      providerId: sourceId,
      name: "来源健康状态",
      status: "ready",
    },
    {
      siteId: "recovered",
      providerId: sourceId,
      name: "恢复站点",
      status: "candidate",
    },
    {
      siteId: "catalog-ready",
      providerId: sourceId,
      name: "未检查可用站点",
      status: "ready",
    },
    {
      siteId: "catalog-candidate",
      providerId: sourceId,
      name: "未检查候选站点",
      status: "candidate",
    },
  ];
  const node = sourceTable({
    document: f.document,
    sources,
    sites,
    api: f.api,
    status,
  });
  assert.match(
    node.querySelector("summary").textContent,
    /2 可用 \/ 10 目录站点/,
  );
  assert.equal(
    [...node.querySelectorAll(".badge")].filter(
      (badge) => badge.textContent === "可自动采集",
    ).length,
    2,
  );
  assert.match(node.textContent, /暂时不可访问/);
});

test("a source probe updates the availability summary together with its badge", async () => {
  let available = false;
  const f = uiFixture(() => ({
    status: available ? "ready" : "unavailable",
    checkedAt: "2026-10-06",
    issues: [],
  }));
  const node = sourceTable({
    document: f.document,
    sources: [{ sourceId: "synthetic-source", name: "合成来源", health: [] }],
    sites: [
      {
        providerId: "synthetic-source",
        siteId: "synthetic-site",
        name: "合成站点",
        status: "ready",
      },
    ],
    api: f.api,
    status: feedback(f.document),
  });
  node.querySelector("[data-probe]").click();
  await f.settle();
  assert.match(node.querySelector(".badge").textContent, /暂时不可访问/);
  assert.match(
    node.querySelector("summary").textContent,
    /0 可用 \/ 1 目录站点/,
  );
  available = true;
  node.querySelector("[data-probe]").click();
  await f.settle();
  assert.match(node.querySelector(".badge").textContent, /可自动采集/);
  assert.match(
    node.querySelector("summary").textContent,
    /1 可用 \/ 1 目录站点/,
  );
});
