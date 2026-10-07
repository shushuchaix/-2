import test from "node:test";
import assert from "node:assert/strict";
import announcements from "../../src/sources/adapters/official-announcements.mjs";
import yingjiesheng from "../../src/sources/adapters/yingjiesheng.mjs";
import { createPagedProvider } from "../../src/sources/adapters/shared.mjs";
import { createSourceBudget } from "../../src/infrastructure/http/budget.mjs";
import { deriveLifecycle } from "../../src/domain/lifecycle.mjs";
import { createApplicationContext } from "../../src/application/context.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { loadConfig } from "../../src/config.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { createTempDir, job, profile, target } from "../helpers/fixtures.mjs";

const site = {
  siteId: "public-synthetic",
  name: "合成研究所",
  origin: "https://research.example.org",
  template: {
    listUrl: "https://research.example.org/recruit/",
    linkRule: ".list li a",
    bodyRule: "#body",
    pathPrefix: "/recruit/",
  },
};

for (const [name, provider, sourceSite, html] of [
  [
    "official notice",
    announcements,
    site,
    '<ul class="list"><li><a href="post.html">人才招聘公告</a></li></ul>',
  ],
  [
    "campus campaign",
    yingjiesheng,
    { siteId: "yingjiesheng", origin: "https://www.yingjiesheng.com" },
    '<table><tr><td><a href="/job-1.html">合成公司校园招聘</a></td><td>2026-12-30</td></tr></table>',
  ],
]) {
  test(`${name} reports one actual page and keeps limited coverage conservative`, async () => {
    // Returning a fictional page or treating this list as a complete archive must fail.
    const budget = createSourceBudget();
    const result = await provider.collect({
      sites: [sourceSite],
      queries: [{ keyword: "synthetic", pageLimit: 2 }],
      budget,
      request: async () => {
        budget.claimRequest();
        return { status: 200, text: html, headers: {} };
      },
    });
    assert.equal(result.records.length, 1);
    assert.equal(budget.snapshot().requests, 1);
    assert.equal(result.coverage[0].pages, 1);
    assert.equal(result.coverage[0].status, "complete");
    assert.equal(result.coverage[0].truncated, true);
    assert.equal(result.coverage[0].coverageScope, "limited");
    assert.equal(result.coverage[0].truncationReason, "listing_only");
    assert.match(result.coverage[0].reason, /列表/);
    assert.doesNotMatch(result.coverage[0].reason, /达到.*上限/);
    assert.equal(
      deriveLifecycle({
        previous: { lifecycle: "observed", absenceCounts: { synthetic: 2 } },
        coverage: [
          {
            ...result.coverage[0],
            scopeKey: "synthetic",
            previouslyObserved: true,
          },
        ],
      }).state,
      "observed",
    );
  });
}

function pagedProvider() {
  return createPagedProvider({
    id: "synthetic",
    name: "合成分页来源",
    capabilities: { category: "job_board" },
    listPage: async (_site, _query, page, ctx) => {
      ctx.budget.claimRequest();
      return {
        records: [job({ sourceRecordId: String(page) })],
        hasMore: true,
      };
    },
  });
}

test("a real paginated source identifies its per-query page limit before total requests are exhausted", async () => {
  const budget = createSourceBudget();
  const result = await pagedProvider().collect({
    sites: [site],
    queries: [{ keyword: "synthetic", pageLimit: 2 }],
    budget,
  });
  assert.equal(result.records.length, 2);
  assert.equal(result.coverage[0].pages, 2);
  assert.equal(result.coverage[0].truncated, true);
  assert.equal(result.coverage[0].status, "complete");
  assert.equal(result.coverage[0].truncationReason, "page_limit");
  assert.match(result.coverage[0].reason, /分页上限/);
  assert.equal(budget.snapshot().requests, 2);
  assert.equal(budget.snapshot().maxRequests, 120);
});

test("a request budget failure retains successful pages and identifies the exhausted budget", async () => {
  const budget = createSourceBudget({ maxRequests: 1 });
  const result = await pagedProvider().collect({
    sites: [site],
    queries: [{ keyword: "synthetic", pageLimit: 2 }],
    budget,
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.coverage[0].pages, 1);
  assert.equal(result.coverage[0].status, "failed");
  assert.equal(result.coverage[0].truncated, true);
  assert.equal(result.coverage[0].truncationReason, "request_budget");
  assert.match(result.coverage[0].reason, /请求预算/);
  assert.equal(result.issues[0].code, "source_budget_exhausted");
});

test("an exhausted genuine list remains complete without an invented truncation reason", async () => {
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成完整来源",
    capabilities: { category: "job_board" },
    listPage: async () => ({ records: [job()], hasMore: false }),
  });
  const result = await provider.collect({
    sites: [site],
    queries: [{ keyword: "synthetic", pageLimit: 2 }],
  });
  assert.equal(result.coverage[0].pages, 1);
  assert.equal(result.coverage[0].truncated, false);
  assert.equal(result.coverage[0].truncationReason, undefined);
});

test("page diagnostics expose only the actual limiting reason at the terminal page", async () => {
  const events = [];
  const diagnosticContext = (budget) => ({
    sites: [site],
    queries: [{ keyword: "synthetic", pageLimit: 2 }],
    budget,
    reportDiagnostic: (event) => events.push(event),
  });
  await pagedProvider().collect(diagnosticContext(createSourceBudget()));
  assert.equal(events[0].truncationReason, undefined);
  assert.equal(events[1].truncationReason, "page_limit");
  events.length = 0;
  await pagedProvider().collect(
    diagnosticContext(createSourceBudget({ maxRequests: 1 })),
  );
  assert.equal(events[0].truncationReason, undefined);
  assert.equal(events[1].outcome, "failed");
  assert.equal(events[1].truncationReason, "request_budget");
  events.length = 0;
  await announcements.collect({
    ...diagnosticContext(createSourceBudget()),
    request: async () => ({
      status: 200,
      text: '<ul class="list"><li><a href="post.html">人才招聘公告</a></li></ul>',
    }),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].page, 1);
  assert.equal(events[0].truncationReason, "listing_only");
});

test("a run separates confirmed qualification from unknown and failed while retaining unknown candidates", async (t) => {
  // Counting unknown as pass or leaving the new terminal counters at zero must fail.
  const provider = fakeProvider({
    records: [
      job({
        sourceRecordId: "pass",
        title: "Java开发已确认岗位",
        description:
          "要求本科，2027届毕业。负责 Java 开发、需求分析和团队沟通等岗位工作。",
      }),
      job({
        sourceRecordId: "unknown",
        title: "Java开发待核实岗位",
        jobType: "unknown",
        description:
          "要求本科，2027届毕业。负责 Java 开发、需求分析和团队沟通等岗位工作。",
      }),
      job({
        sourceRecordId: "fail",
        title: "Java开发不符合岗位",
        degree: "博士",
        description:
          "要求博士，2027届毕业。负责 Java 开发、需求分析和团队沟通等岗位工作。",
      }),
    ],
  });
  const dataDir = await createTempDir(t),
    cfg = loadConfig({ quiet: true, dataDir });
  cfg.deepseek.apiKey = "";
  cfg.limits.perIpCooldownMs = 0;
  const context = await createApplicationContext({
    cfg,
    dataDir,
    dependencies: {
      registry: createSourceRegistry([provider]),
      catalog: [
        {
          siteId: "synthetic-1",
          providerId: "synthetic",
          category: "job_board",
          name: "合成",
          origin: "https://example.com",
          status: "ready",
        },
      ],
      requestFactory: () => async () => {
        throw Error("Unexpected network");
      },
    },
  });
  const p = await context.workspaceService.saveProfile({ profile: profile() });
  const tar = await context.workspaceService.saveTarget({
    ...target(),
    profileRevisionId: p.revisionId,
  });
  const { runId } = await context.runService.startRun({
    targetRevisionId: tar.revisionId,
    mode: "rules",
  });
  const result = await context.runService.waitForRun(runId);
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.counts.deduplicated, 3);
  assert.equal(result.run.counts.eligible, 1);
  assert.equal(result.run.counts.qualificationUnknown, 1);
  assert.equal(result.run.counts.qualificationFailed, 1);
  assert.equal(result.run.counts.shortlisted, 2);
  const stored = await context.runService.getRun(runId);
  assert.equal(stored.counts.qualificationUnknown, 1);
  assert.equal(stored.counts.qualificationFailed, 1);
});
