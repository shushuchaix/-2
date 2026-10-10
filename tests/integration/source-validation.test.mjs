import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import {
  createPagedProvider,
  baseRecord,
} from "../../src/sources/adapters/shared.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { evaluateRules } from "../../src/domain/ranking.mjs";
import { createAttachmentService } from "../../src/attachments/service.mjs";
import { createRequestClient } from "../../src/infrastructure/http/client.mjs";
import { createScheduler } from "../../src/infrastructure/http/scheduler.mjs";

async function moduleUnderTest() {
  const module = await import("../../tools/source-validation.mjs").catch(
    (error) => {
      if (error.code === "ERR_MODULE_NOT_FOUND") return {};
      throw error;
    },
  );
  assert.equal(
    typeof module.validateSources,
    "function",
    "source validation tool is implemented",
  );
  return module;
}

const site = (siteId, providerId = "ncss", extra = {}) => ({
  siteId,
  providerId,
  name: "Public fixture",
  category: "national",
  origin:
    providerId === "ncss" ? "https://www.ncss.cn" : "https://jobs.example.org",
  evidenceUrl: "https://jobs.example.org",
  status: "candidate",
  ...extra,
});
const record = (siteId) =>
  baseRecord({
    id: "job-" + siteId,
    sourceId: "ncss",
    siteId,
    title: "公开岗位",
    sourceRecordIdKind: "authority",
    urlKind: "job_detail",
    url: "https://jobs.example.org/job/" + siteId,
  });

async function prepared(t, providers, catalog, limits = {}, options = {}) {
  const f = await collectionFixture(t, { providers, limits, ...options });
  const prepared = await f.service.prepare({
    scope: f.scope,
    options: { mode: "rules" },
  });
  const ref = { scope: f.scope, activityId: prepared.activityId };
  await f.repository.mutateWorkspace((w) => {
    const root = w.runs[ref.activityId];
    root.targetSnapshot.sourceIds = [
      ...new Set(catalog.map((s) => s.providerId)),
    ];
    const p = root.collectionProgress;
    p.units = Object.fromEntries(
      catalog.map((s, i) => [
        "public-unit-" + i,
        {
          unitId: "public-unit-" + i,
          sourceId: s.providerId,
          siteId: s.siteId,
          site: s,
          queryIndex: i % 2,
          query: { keyword: i % 2 ? "机场" : "消防", city: "", pageLimit: 1 },
          cursor: null,
          nextDueAt: null,
          committedPages: 0,
          committedPageKeys: [],
          status: "pending",
          lastErrorCode: null,
        },
      ]),
    );
  });
  const evaluationService = createEvaluationService({
    repository: f.repository,
    operationGate: f.operationGate,
  });
  return Object.assign(f, {
    ref,
    context: {
      repository: f.repository,
      collectionService: f.service,
      registry: createSourceRegistry(providers),
      evaluationService,
    },
  });
}

test("validation commits both diagnostic pages and evaluates the owned copy with local rules", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = createPagedProvider({
    id: "ncss",
    name: "Public fixture",
    capabilities: {},
    listPage: async (s, query, page, ctx) => {
      assert.ok(["消防", "机场"].includes(query.keyword));
      assert.equal(query.city, "");
      assert.equal(query.pageLimit, 1);
      assert.equal(page, 1);
      assert.equal(ctx.profileRevision, undefined);
      assert.deepEqual(ctx.targetSnapshot.cities, []);
      await ctx.request("https://jobs.example.org/list");
      return { records: [record(s.siteId)], raw: 1, hasMore: false };
    },
  });
  const catalog = [site("one"), site("two")];
  const f = await prepared(t, [provider], catalog, {
    maxRequests: 2,
    maxDetails: 0,
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    detailsPerSite: 0,
  });
  assert.equal(report.rows.length, 2);
  assert.deepEqual(
    report.rows.map((row) => row.parsedCount),
    [1, 1],
  );
  assert.deepEqual(
    report.rows.map((row) => row.validNewUniqueCount),
    [0, 0],
  );
  const w = await f.repository.read();
  const root = await f.service.get(f.ref);
  assert.equal(root.collectionProgress.status, "paused");
  assert.equal(root.collectionUsage.usedRequests, 2);
  assert.equal(root.collectionUsage.usedModelRequests, 0);
  assert.equal(
    Object.values(root.collectionProgress.units).filter(
      (u) => u.committedPages === 1,
    ).length,
    2,
  );
  const evaluations = Object.values(w.evaluations);
  assert.equal(evaluations.length, 2);
  assert.ok(
    evaluations.every(
      (e) =>
        e.status === "rules" &&
        e.profileRevisionId === f.target.profileSnapshot.revisionId,
    ),
  );
  assert.ok(
    Object.values(w.jobs).every(
      (job) => job.ownerPackageId === f.scope.packageId,
    ),
  );
});

test("default catalog emits all 98 rows with template, public seed and login blocks without transport", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const f = await prepared(t, [], [], { maxRequests: 0, maxDetails: 0 });
  const diagnostics = [];
  f.context.diagnostics = async (event) => {
    diagnostics.push(event);
  };
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    detailsPerSite: 0,
  });
  assert.equal(report.rows.length, 98);
  assert.equal(new Set(report.rows.map((row) => row.siteId)).size, 98);
  assert.equal(
    report.rows.filter((row) => row.blockReason === "template_missing").length,
    47,
  );
  for (const id of ["wechat", "weibo"]) {
    assert.equal(
      report.rows.find((row) => row.siteId === id).blockReason,
      "public_seeds_required",
    );
  }
  assert.equal(
    report.rows.find((row) => row.siteId === "boss").blockReason,
    "boss_login_required",
  );
  assert.equal(f.networkCalls, 0);
  assert.equal((await f.service.get(f.ref)).collectionUsage.usedRequests, 0);
  assert.equal(diagnostics.length, 98);
  assert.deepEqual(
    new Set(diagnostics.map((d) => d.siteId)),
    new Set(report.rows.map((r) => r.siteId)),
  );
});

test("source-filtered records retain trusted raw counts and cannot become a normal empty list", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = createPagedProvider({
    id: "greenhouse",
    name: "Filtered fixture",
    capabilities: {},
    listPage: async (_s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return { records: [], raw: 3, hasMore: false };
    },
  });
  const catalog = [site("board", "greenhouse", { tenantId: "canonical" })];
  const f = await prepared(t, [provider], catalog);
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    detailsPerSite: 0,
  });
  const row = report.rows[0];
  assert.equal(row.rawCount, 3);
  assert.equal(row.rawBasis, "provider_raw");
  assert.equal(row.filteredCount, 3);
  assert.equal(row.status, "filtered");
  assert.equal(row.validNewUniqueCount, 0);
});

test("accepted fallback raw zero has no original empty-list proof", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = createPagedProvider({
    id: "official-announcements",
    name: "Filtered HTML fixture",
    capabilities: {},
    listPage: async (_s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return { records: [], raw: 0, hasMore: false };
    },
  });
  const catalog = [
    site("notice", "official-announcements", {
      template: {
        listUrl: "https://jobs.example.org/list",
        linkRule: "a[href]",
        bodyRule: "article",
      },
    }),
  ];
  const f = await prepared(t, [provider], catalog);
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    detailsPerSite: 0,
  });
  assert.equal(report.rows[0].rawCount, null);
  assert.equal(report.rows[0].rawBasis, "accepted_fallback");
  assert.equal(report.rows[0].status, "blocked");
  assert.equal(report.rows[0].blockReason, "empty_evidence_unverified");
});

test("exhaustion remains on one root and blocks the next site without a new request allowance", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = createPagedProvider({
    id: "ncss",
    name: "Empty fixture",
    capabilities: {},
    listPage: async (_s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return { records: [], raw: 0, hasMore: false };
    },
  });
  const catalog = [site("one"), site("two")];
  const f = await prepared(t, [provider], catalog, { maxRequests: 1 });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    detailsPerSite: 0,
  });
  assert.equal(report.rows[0].status, "empty");
  assert.equal(report.rows[1].blockReason, "source_budget_exhausted");
  assert.equal(f.networkCalls, 1);
  const again = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    detailsPerSite: 0,
  });
  assert.equal(again.rows[0].skipReason, "already_committed");
  assert.equal(f.networkCalls, 1);
  assert.equal((await f.service.get(f.ref)).collectionUsage.usedRequests, 1);
  assert.equal(
    Object.values((await f.repository.read()).runs).filter(
      (r) => r.collectionRole === "collection_root",
    ).length,
    1,
  );
});

test("public report cannot include source text, resume values, request URLs or exception messages", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const canary = "PRIVATE_CANARY_92";
  const provider = createPagedProvider({
    id: "ncss",
    name: "Failure fixture",
    capabilities: {},
    listPage: async () => {
      throw new Error(
        canary +
          " C:\\private\\resume.pdf https://private.example.org/?key=secret",
      );
    },
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog);
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  const encoded = JSON.stringify(report);
  assert.doesNotMatch(
    encoded,
    /PRIVATE_CANARY|private|resume\.pdf|secret|消防|机场|https?:/,
  );
  assert.equal(report.rows[0].status, "failed");
  assert.equal(report.rows[0].errorCode, "source_validation_failed");
});

test("rejects a private query unit before any provider call", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = createPagedProvider({
    id: "ncss",
    name: "Query fixture",
    capabilities: {},
    listPage: async (_s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return { records: [], raw: 0, hasMore: false };
    },
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog);
  await f.repository.mutateWorkspace((w) => {
    w.runs[f.ref.activityId].collectionProgress.units[
      "public-unit-0"
    ].query.keyword = "PRIVATE_QUERY";
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(report.rows[0].blockReason, "public_query_required");
  assert.equal(f.networkCalls, 0);
});

test("invalid records are rejected before ingest and are not counted as empty or filtered", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = createPagedProvider({
    id: "ncss",
    name: "Malformed fixture",
    capabilities: {},
    listPage: async (_s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return {
        records: [{ sourceId: "ncss", title: "Malformed" }],
        raw: 1,
        hasMore: false,
      };
    },
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog);
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(report.rows[0].status, "failed");
  assert.equal(report.rows[0].errorCode, "invalid_record");
  assert.equal(report.rows[0].invalidCount, 1);
  assert.equal(report.rows[0].filteredCount, 0);
  assert.equal(report.rows[0].newUniqueCount, 0);
  assert.equal(Object.keys((await f.repository.read()).jobs).length, 0);
});

test("one detail allowance is shared across sites and body alone never qualifies a valid new job", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = createPagedProvider({
    id: "ncss",
    name: "Detail fixture",
    capabilities: {},
    listPage: async (s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return { records: [record(s.siteId)], raw: 1, hasMore: false };
    },
    detail: async (r, ctx) => {
      await ctx.request(r.url);
      return {
        ...r,
        description: "公开岗位职责和要求。".repeat(12),
        detailStatus: "complete",
        deadlineAt: "2030-01-01",
      };
    },
  });
  let detailCalls = 0;
  const original = provider.fetchDetail;
  provider.fetchDetail = (...args) => {
    detailCalls++;
    return original(...args);
  };
  const catalog = [site("one"), site("two")];
  const f = await prepared(t, [provider], catalog, {
    maxDetails: 1,
    maxRequests: 3,
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(detailCalls, 1);
  assert.equal(report.rows[0].bodyVerifiedCount, 1);
  assert.equal(report.rows[1].detailErrorCode, "source_budget_exhausted");
  assert.deepEqual(
    report.rows.map((r) => r.validNewUniqueCount),
    [0, 0],
  );
  assert.equal(report.usage.usedRequests, 3);
  assert.equal(report.usage.usedDetails, 1);
  assert.equal(report.usage.usedModelRequests, 0);
  assert.equal(
    (await f.service.get(f.ref)).collectionProgress.status,
    "paused",
  );
});

test("stored source seeds never authorize public social reads", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const catalog = [site("wechat", "wechat")];
  const f = await prepared(t, [], catalog);
  f.context.sourceService = {
    listScopedSources: async () => [
      {
        sourceId: "wechat",
        config: {
          enabled: true,
          articleUrls: ["PRIVATE_SAVED_URL"],
          accountIds: ["PRIVATE_ACCOUNT"],
        },
      },
    ],
  };
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(report.rows[0].blockReason, "public_seeds_required");
  assert.doesNotMatch(
    JSON.stringify(report),
    /PRIVATE_SAVED_URL|PRIVATE_ACCOUNT/,
  );
  assert.equal(f.networkCalls, 0);
});

test("two Boss pages and one detail share a diagnostic token and one root ledger", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const tokens = new Set();
  const provider = createPagedProvider({
    id: "boss",
    name: "Boss fixture",
    capabilities: {},
    listPage: async (s, q, page, ctx) => {
      tokens.add(ctx.token.sliceRunId);
      assert.equal(q.pageLimit, 2);
      await ctx.request("https://jobs.example.org/list");
      return {
        records: [
          {
            ...record(s.siteId),
            sourceId: "boss",
            sourceRecordId: "job-" + page,
          },
        ],
        raw: 1,
        hasMore: page === 1,
      };
    },
    detail: async (r, ctx) => {
      tokens.add(ctx.token.sliceRunId);
      await ctx.request(r.url);
      return {
        ...r,
        description: "公开详情要求。".repeat(12),
        detailStatus: "complete",
      };
    },
  });
  const catalog = [site("boss", "boss")];
  const f = await prepared(t, [provider], catalog, {
    maxRequests: 3,
    maxDetails: 1,
  });
  f.context.sourceService = {
    listScopedSources: async () => [
      {
        sourceId: "boss",
        config: { enabled: true },
        sessionRef: "owned-session",
      },
    ],
  };
  f.context.contentReadService = {
    readBoss: async () => {
      throw Error("synthetic provider does not call browser");
    },
  };
  await f.repository.mutateWorkspace((w) => {
    w.runs[f.ref.activityId].collectionProgress.units[
      "public-unit-0"
    ].query.pageLimit = 2;
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    pagesPerSite: 2,
  });
  assert.equal(report.rows[0].parsedCount, 2);
  assert.equal(report.rows[0].rawCount, 2);
  assert.equal(report.rows[0].evaluatedCount, 2);
  assert.equal(report.rows[0].bodyVerifiedCount, 1);
  assert.equal(report.rows[0].committedPages, 2);
  assert.equal(tokens.size, 1);
  assert.equal(report.usage.usedRequests, 3);
  assert.equal(report.usage.usedDetails, 1);
  const child = Object.values((await f.repository.read()).runs).find(
    (r) => r.diagnosticOnly,
  );
  assert.equal(child.evaluationIds.length, 2);
});

test("Boss risk on the next page stops immediately and persists a block for subsequent invocations", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = createPagedProvider({
    id: "boss",
    name: "Boss risk fixture",
    capabilities: {},
    listPage: async (s, _q, page, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      if (page === 2)
        throw Object.assign(Error("PRIVATE_RISK_TEXT"), {
          code: "boss_account_risk",
        });
      return {
        records: [{ ...record(s.siteId), sourceId: "boss" }],
        raw: 1,
        hasMore: true,
      };
    },
  });
  const catalog = [site("boss", "boss")];
  const f = await prepared(t, [provider], catalog, {
    maxRequests: 3,
    maxDetails: 0,
  });
  f.context.sourceService = {
    listScopedSources: async () => [
      {
        sourceId: "boss",
        config: { enabled: true },
        sessionRef: "owned-session",
      },
    ],
  };
  f.context.contentReadService = { readBoss: async () => {} };
  await f.repository.mutateWorkspace((w) => {
    w.runs[f.ref.activityId].collectionProgress.units[
      "public-unit-0"
    ].query.pageLimit = 2;
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    pagesPerSite: 2,
    detailsPerSite: 0,
  });
  assert.equal(report.rows[0].blockReason, "boss_account_risk");
  assert.equal(report.rows[0].committedPages, 1);
  assert.equal(report.usage.usedRequests, 2);
  assert.equal(
    (await f.service.get(f.ref)).collectionProgress.units["public-unit-0"]
      .riskBlocked,
    true,
  );
  const again = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    pagesPerSite: 2,
  });
  assert.equal(again.rows[0].blockReason, "source_risk_blocked");
  assert.equal(f.networkCalls, 2);
});

test("Boss authentication expiration stops without a risk latch and can be rechecked after login", async (t) => {
  const { validateSources } = await moduleUnderTest();
  let expired = true;
  const provider = createPagedProvider({
    id: "boss",
    name: "Boss authentication fixture",
    capabilities: {},
    listPage: async (_s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      if (expired)
        throw Object.assign(Error("PRIVATE_SESSION_MESSAGE"), {
          code: "boss_auth_expired",
        });
      return { records: [], raw: 0, hasMore: false };
    },
  });
  const catalog = [site("boss", "boss")];
  const f = await prepared(t, [provider], catalog);
  f.context.sourceService = {
    listScopedSources: async () => [
      { sourceId: "boss", sessionRef: "owned-session" },
    ],
  };
  f.context.contentReadService = { readBoss: async () => {} };
  const first = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(first.rows[0].blockReason, "boss_auth_expired");
  assert.notEqual(
    (await f.service.get(f.ref)).collectionProgress.units["public-unit-0"]
      .riskBlocked,
    true,
  );
  expired = false;
  const again = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(again.rows[0].status, "empty");
  assert.equal(f.networkCalls, 2);
});

test("an erroneous empty page does not advance a checkpoint and remains recoverable", async (t) => {
  const { validateSources } = await moduleUnderTest();
  let broken = true;
  const provider = createPagedProvider({
    id: "ncss",
    name: "Recoverable fixture",
    capabilities: {},
    listPage: async (_s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return {
        records: [],
        raw: 0,
        hasMore: false,
        issues: broken
          ? [{ code: "parse_error", message: "PRIVATE_PARSE_TEXT" }]
          : [],
      };
    },
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog);
  const first = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(first.rows[0].status, "failed");
  assert.equal(first.rows[0].pageCommitted, false);
  assert.equal(
    (await f.service.get(f.ref)).collectionProgress.units["public-unit-0"]
      .committedPages,
    0,
  );
  broken = false;
  const again = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(again.rows[0].status, "empty");
  assert.equal(f.networkCalls, 2);
});

test("a one-page probe preserves provider cursor for the second page on the same root", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const pages = [];
  const provider = createPagedProvider({
    id: "ncss",
    name: "Cursor fixture",
    capabilities: {},
    listPage: async (_s, _q, page, ctx) => {
      pages.push(page);
      await ctx.request("https://jobs.example.org/list");
      return { records: [], raw: 0, hasMore: page === 1 };
    },
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog);
  await f.repository.mutateWorkspace((w) => {
    w.runs[f.ref.activityId].collectionProgress.units[
      "public-unit-0"
    ].query.pageLimit = 2;
  });
  await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    pagesPerSite: 1,
  });
  const current = (await f.service.get(f.ref)).collectionProgress.units[
    "public-unit-0"
  ];
  assert.deepEqual(current.cursor, { page: 2 });
  assert.notEqual(current.status, "completed");
  const again = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    pagesPerSite: 2,
  });
  assert.equal(again.rows[0].committedPages, 1);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(again.usage.usedRequests, 2);
});

test("safe transport codes and numeric HTTP status survive without exception text", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = createPagedProvider({
    id: "ncss",
    name: "Transport fixture",
    capabilities: {},
    listPage: async () => {
      throw Object.assign(Error("PRIVATE_HOST_TOKEN"), {
        cause: { code: "ENOTFOUND" },
        status: 503,
      });
    },
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog);
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(report.rows[0].errorCode, "ENOTFOUND");
  assert.equal(report.rows[0].httpStatus, 503);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_HOST_TOKEN/);
});

test("detail capability works when body capability is unspecified", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = createPagedProvider({
    id: "ncss",
    name: "Legacy capability fixture",
    capabilities: { detail: true },
    listPage: async (s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return { records: [record(s.siteId)], raw: 1, hasMore: false };
    },
    detail: async (r, ctx) => {
      await ctx.request(r.url);
      return {
        ...r,
        description: "公开正文。".repeat(20),
        detailStatus: "complete",
      };
    },
  });
  delete provider.capabilities.body;
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog);
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(report.rows[0].bodyVerifiedCount, 1);
  assert.equal(report.usage.usedDetails, 1);
});

test("detail sampling prioritizes related nonfailed candidates over an unrelated high score and a hard failure without filtering the page", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const detailedIds = [];
  const candidates = (s) => [
    {
      ...record(s.siteId),
      sourceRecordId: s.siteId + "-unrelated",
      title: "软件开发工程师",
      description: "负责 Java 软件开发，要求本科。".repeat(5),
      degree: "本科",
      jobType: "campus",
    },
    {
      ...record(s.siteId),
      sourceRecordId: s.siteId + "-failed",
      title: "消防机场工程师",
      description: "负责 Java 系统和消防机场安全，要求博士学历。".repeat(5),
      degree: "博士",
      jobType: "campus",
    },
    {
      ...record(s.siteId),
      sourceRecordId: s.siteId + "-related",
      title: s.siteId === "fire" ? "消防安全岗位" : "机场安全岗位",
    },
  ];
  const provider = createPagedProvider({
    id: "ncss",
    name: "Sampling fixture",
    capabilities: {},
    listPage: async (s, query, _p, ctx) => {
      assert.ok(["消防", "机场"].includes(query.keyword));
      assert.equal(ctx.profileRevision, undefined);
      assert.equal(ctx.profileSnapshot, undefined);
      assert.doesNotMatch(
        JSON.stringify(ctx.targetSnapshot),
        /PRIVATE_LOCAL_CANARY/,
      );
      await ctx.request("https://jobs.example.org/list");
      return { records: candidates(s), raw: 3, hasMore: false };
    },
    detail: async (r, ctx) => {
      detailedIds.push(r.sourceRecordId);
      assert.equal(ctx.profileRevision, undefined);
      assert.equal(ctx.profileSnapshot, undefined);
      assert.doesNotMatch(
        JSON.stringify(ctx.targetSnapshot),
        /PRIVATE_LOCAL_CANARY/,
      );
      await ctx.request(r.url);
      return {
        ...r,
        description: "公开岗位职责与任务。".repeat(10),
        detailStatus: "complete",
        deadlineAt: "2030-01-01",
      };
    },
  });
  const catalog = [site("fire"), site("airport")];
  const f = await prepared(t, [provider], catalog, {
    maxDetails: 2,
    maxRequests: 4,
  });
  await f.repository.mutateWorkspace((w) => {
    const root = w.runs[f.ref.activityId];
    root.targetSnapshot.roles = ["消防", "机场"];
    root.profileSnapshot.profile.skills = ["Java"];
    root.profileSnapshot.profile.personalNote = "PRIVATE_LOCAL_CANARY";
    const target = Object.values(w.targets)
      .flat()
      .find((v) => v.revisionId === f.scope.targetRevisionId);
    target.roles = [...root.targetSnapshot.roles];
    target.profileSnapshot = structuredClone(root.profileSnapshot);
  });
  const root = await f.service.get(f.ref);
  const drafts = candidates(catalog[0]).map((r) =>
    evaluateRules(r, root.profileSnapshot.profile, root.targetSnapshot, {
      now: f.clock.now(),
    }),
  );
  assert.ok(
    drafts[0].score > drafts[2].score,
    "total score alone would select the unrelated candidate",
  );
  assert.equal(drafts[1].qualification.status, "fail");
  assert.equal(drafts[2].qualification.status, "unknown");
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.deepEqual(detailedIds, ["fire-related", "airport-related"]);
  assert.deepEqual(
    report.rows.map((r) => r.rawCount),
    [3, 3],
  );
  assert.deepEqual(
    report.rows.map((r) => r.parsedCount),
    [3, 3],
  );
  assert.deepEqual(
    report.rows.map((r) => r.newUniqueCount),
    [3, 3],
  );
  assert.equal(report.usage.usedDetails, 2);
  assert.equal(report.usage.usedRequests, 4);
  assert.equal(report.usage.usedModelRequests, 0);
  const workspace = await f.repository.read();
  assert.equal(Object.keys(workspace.jobs).length, 6);
  const selectedJobs = Object.values(workspace.jobs).filter((j) =>
    /-related$/.test(j.canonical.sourceRecordId),
  );
  assert.equal(selectedJobs.length, 2);
  for (const j of selectedJobs) {
    const evaluation = Object.values(workspace.evaluations).find(
      (e) => e.jobId === j.jobId,
    );
    assert.equal(evaluation.qualification.status, "unknown");
    assert.equal(evaluation.recommended, false);
  }
  assert.doesNotMatch(
    JSON.stringify(report),
    /PRIVATE_LOCAL_CANARY|软件开发|消防|机场|公开岗位职责/,
  );
});

test("known hard qualification failure cannot win detail selection by matching a title", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const detailedIds = [];
  const provider = createPagedProvider({
    id: "ncss",
    name: "Hard gate sampling fixture",
    capabilities: {},
    listPage: async (s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return {
        records: [
          {
            ...record(s.siteId),
            sourceRecordId: "failed-title",
            title: "消防工程师",
            description: "博士学历，负责消防工作。".repeat(6),
            degree: "博士",
            jobType: "campus",
          },
          {
            ...record(s.siteId),
            sourceRecordId: "unknown-body",
            title: "公开安全岗位",
            description: "参与消防检查与巡检任务。".repeat(6),
          },
        ],
        raw: 2,
        hasMore: false,
      };
    },
    detail: async (r, ctx) => {
      detailedIds.push(r.sourceRecordId);
      await ctx.request(r.url);
      return { ...r, detailStatus: "complete" };
    },
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog, {
    maxDetails: 1,
    maxRequests: 2,
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.deepEqual(detailedIds, ["unknown-body"]);
  assert.equal(report.rows[0].qualificationFailCount, 1);
  assert.equal(report.rows[0].qualificationUnknownCount, 1);
  assert.equal(report.rows[0].validNewUniqueCount, 0);
  assert.equal(report.usage.usedDetails, 1);
});

test("equal local sampling ranks retain the original page order", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const detailedIds = [];
  const provider = createPagedProvider({
    id: "ncss",
    name: "Stable sampling fixture",
    capabilities: {},
    listPage: async (s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return {
        records: ["first", "second"].map((id) => ({
          ...record(s.siteId),
          title: "消防岗位",
          sourceRecordId: id,
        })),
        raw: 2,
        hasMore: false,
      };
    },
    detail: async (r, ctx) => {
      detailedIds.push(r.sourceRecordId);
      await ctx.request(r.url);
      return {
        ...r,
        description: "公开职责。".repeat(10),
        detailStatus: "complete",
      };
    },
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog, {
    maxDetails: 1,
    maxRequests: 2,
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.deepEqual(detailedIds, ["first"]);
  assert.equal(report.rows[0].parsedCount, 2);
  assert.equal(report.rows[0].rawCount, 2);
  assert.equal(report.usage.usedDetails, 1);
});

test("empty lists never evaluate a detail sample or consume a detail credit", async (t) => {
  const { validateSources } = await moduleUnderTest();
  let calls = 0;
  const provider = createPagedProvider({
    id: "ncss",
    name: "Empty sampling fixture",
    capabilities: {},
    listPage: async (_s, _q, _p, ctx) => {
      await ctx.request("https://jobs.example.org/list");
      return { records: [], raw: 0, hasMore: false };
    },
    detail: async () => {
      calls++;
      throw Error("empty list must not invoke detail");
    },
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog, {
    maxDetails: 1,
    maxRequests: 1,
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(calls, 0);
  assert.equal(report.rows[0].status, "empty");
  assert.equal(report.usage.usedDetails, 0);
  assert.equal(report.rows[0].evaluatedCount, 0);
});

test("sampling applies owned overrides and the local target roles while the public query remains fixed", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const detailedIds = [];
  const provider = createPagedProvider({
    id: "ncss",
    name: "Owned sampling fixture",
    capabilities: {},
    listPage: async (s, query, _p, ctx) => {
      assert.equal(query.keyword, "消防");
      assert.deepEqual(ctx.targetSnapshot.roles, []);
      assert.equal(ctx.profileSnapshot, undefined);
      await ctx.request("https://jobs.example.org/list");
      return {
        records: [
          {
            ...record(s.siteId),
            sourceRecordId: "base-eligible",
            title: "消防岗位",
            description: "公开岗位职责，要求本科。".repeat(6),
            degree: "本科",
            jobType: "campus",
          },
          {
            ...record(s.siteId),
            sourceRecordId: "owned-override-eligible",
            title: "机场岗位",
            description: "公开岗位职责，要求博士。".repeat(6),
            degree: "博士",
            jobType: "campus",
          },
        ],
        raw: 2,
        hasMore: false,
      };
    },
    detail: async (r, ctx) => {
      detailedIds.push(r.sourceRecordId);
      await ctx.request(r.url);
      return { ...r, detailStatus: "complete" };
    },
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog, {
    maxRequests: 2,
    maxDetails: 1,
  });
  await f.repository.mutateWorkspace((w) => {
    const root = w.runs[f.ref.activityId];
    root.targetSnapshot.roles = ["机场"];
    root.profileSnapshot.profile.education = "本科";
    root.profileSnapshot.overrides = { education: "博士" };
    const target = Object.values(w.targets)
      .flat()
      .find((v) => v.revisionId === f.scope.targetRevisionId);
    target.roles = ["机场"];
    target.profileSnapshot = structuredClone(root.profileSnapshot);
    target.profileSnapshot.profile.education = "博士";
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.deepEqual(detailedIds, ["owned-override-eligible"]);
  assert.equal(report.rows[0].rawCount, 2);
  assert.equal(report.rows[0].parsedCount, 2);
  assert.equal(report.usage.usedDetails, 1);
  assert.equal(report.usage.usedModelRequests, 0);
});

test("limited root requests reach different providers before a second station and skip missing templates without delaying a configured announcement", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const calls = [];
  const providers = [
    "ncss",
    "tencent",
    "official-announcements",
    "greenhouse",
  ].map((id) =>
    createPagedProvider({
      id,
      name: "Fair provider fixture",
      capabilities: {},
      listPage: async (s, _q, _p, ctx) => {
        calls.push(s.siteId);
        assert.notEqual(s.siteId, "missing-template");
        await ctx.request("https://jobs.example.org/list");
        return { records: [], raw: 0, hasMore: false };
      },
    }),
  );
  const catalog = [
    site("a1"),
    site("a2"),
    site("a3"),
    site("b1", "tencent"),
    site("b2", "tencent"),
    site("missing-template", "official-announcements"),
    site("configured-notice", "official-announcements", {
      template: {
        listUrl: "https://jobs.example.org/list",
        linkRule: "a[href]",
        bodyRule: "article",
      },
    }),
    site("c1", "greenhouse", { tenantId: "canonical" }),
  ];
  const f = await prepared(t, providers, catalog, {
    maxRequests: 4,
    maxDetails: 0,
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    detailsPerSite: 0,
  });
  assert.deepEqual(calls, ["a1", "b1", "configured-notice", "c1"]);
  assert.deepEqual(
    report.rows.map((row) => row.siteId),
    catalog.map((s) => s.siteId),
  );
  const rows = new Map(report.rows.map((row) => [row.siteId, row]));
  assert.equal(rows.get("missing-template").blockReason, "template_missing");
  assert.equal(rows.get("missing-template").requestsUsed, 0);
  for (const id of ["a2", "a3", "b2"]) {
    assert.equal(rows.get(id).blockReason, "source_budget_exhausted");
    assert.equal(rows.get(id).listAttempted, false);
    assert.equal(rows.get(id).parsedCount, null);
  }
  assert.equal(rows.get("configured-notice").requestsUsed, 1);
  assert.equal(report.usage.usedRequests, 4);
  assert.equal(report.usage.usedDetails, 0);
  assert.equal(report.usage.usedModelRequests, 0);
  assert.equal(
    Object.values((await f.repository.read()).runs).filter(
      (r) => r.collectionRole === "collection_root",
    ).length,
    1,
  );
});

test("provider rounds preserve each provider station order and the original final matrix order", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const calls = [];
  const providers = ["ncss", "tencent", "greenhouse"].map((id) =>
    createPagedProvider({
      id,
      name: "Ordered provider fixture",
      capabilities: {},
      listPage: async (s, _q, _p, ctx) => {
        calls.push(s.siteId);
        await ctx.request("https://jobs.example.org/list");
        return { records: [], raw: 0, hasMore: false };
      },
    }),
  );
  const catalog = [
    site("a1"),
    site("a2"),
    site("a3"),
    site("b1", "tencent"),
    site("b2", "tencent"),
    site("c1", "greenhouse", { tenantId: "canonical" }),
  ];
  const f = await prepared(t, providers, catalog, {
    maxRequests: 6,
    maxDetails: 0,
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    detailsPerSite: 0,
  });
  assert.deepEqual(calls, ["a1", "b1", "c1", "a2", "b2", "a3"]);
  assert.deepEqual(
    report.rows.map((row) => row.siteId),
    ["a1", "a2", "a3", "b1", "b2", "c1"],
  );
  assert.ok(
    report.rows.every(
      (row) => row.status === "empty" && row.committedPages === 1,
    ),
  );
  assert.equal(report.usage.usedRequests, 6);
});

test("a failing provider keeps its failed row while the remaining first-round providers share the original budget", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const calls = [];
  const providers = ["ncss", "tencent", "greenhouse"].map((id) =>
    createPagedProvider({
      id,
      name: "Failure fairness fixture",
      capabilities: {},
      listPage: async (s, _q, _p, ctx) => {
        calls.push(s.siteId);
        await ctx.request("https://jobs.example.org/list");
        if (s.siteId === "a1")
          throw Object.assign(Error("PRIVATE_FAILURE_TEXT"), {
            code: "ECONNRESET",
          });
        return { records: [], raw: 0, hasMore: false };
      },
    }),
  );
  const catalog = [
    site("a1"),
    site("a2"),
    site("b1", "tencent"),
    site("b2", "tencent"),
    site("c1", "greenhouse", { tenantId: "canonical" }),
  ];
  const f = await prepared(t, providers, catalog, {
    maxRequests: 3,
    maxDetails: 0,
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    detailsPerSite: 0,
  });
  assert.deepEqual(calls, ["a1", "b1", "c1"]);
  assert.equal(report.rows[0].status, "failed");
  assert.equal(report.rows[0].errorCode, "ECONNRESET");
  assert.equal(report.rows[1].blockReason, "source_budget_exhausted");
  assert.equal(report.rows[2].status, "empty");
  assert.equal(report.rows[3].blockReason, "source_budget_exhausted");
  assert.equal(report.rows[4].status, "empty");
  assert.equal(report.usage.usedRequests, 3);
  assert.equal(
    (await f.service.get(f.ref)).collectionProgress.status,
    "paused",
  );
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_FAILURE_TEXT/);
});

const sampleBody =
  "公开消防岗位负责消防设施维护、设备巡检和安全保障，资格条件尚需核实。";
const sampleApplyUrl = "https://jobs.example.org/apply/selected";
const deferredSample = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function enrichmentProvider({ listed, detailed } = {}) {
  return createPagedProvider({
    id: "ncss",
    name: "Enrichment fixture",
    capabilities: {},
    listPage: async (s, _q, _p, ctx) => {
      assert.equal(ctx.profileRevision, undefined);
      assert.equal(ctx.profileSnapshot, undefined);
      assert.doesNotMatch(
        JSON.stringify(ctx.targetSnapshot),
        /OWNED_PROFILE_CANARY/,
      );
      await ctx.request("https://jobs.example.org/list");
      const records = listed
        ? listed(s)
        : [{ ...record(s.siteId), title: "消防岗位" }];
      return { records, raw: records.length, hasMore: false };
    },
    detail: async (r, ctx) => {
      assert.equal(ctx.profileRevision, undefined);
      assert.equal(ctx.profileSnapshot, undefined);
      await ctx.request(r.url);
      return detailed
        ? detailed(r)
        : {
            ...r,
            description: sampleBody,
            detailStatus: "complete",
            deadlineAt: "2030-01-01",
            applyUrl: sampleApplyUrl,
          };
    },
  });
}
function attachSyntheticService(f) {
  f.service.setAttachmentService(
    createAttachmentService({
      ledger: f.ledger,
      clock: f.clock,
      cleanup: { cleanupAttempt: async () => {} },
    }),
  );
}

test("selected detail uses owned enrichment for public application verification while other stubs enter the existing queue", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const calls = [];
  const provider = enrichmentProvider({
    listed: (s) => [
      {
        ...record(s.siteId),
        sourceRecordId: "unrelated-stub",
        title: "软件岗位",
      },
      {
        ...record(s.siteId),
        sourceRecordId: "related-sample",
        title: "消防岗位",
      },
    ],
  });
  const catalog = [site("one")];
  const f = await prepared(
    t,
    [provider],
    catalog,
    { maxRequests: 3, maxDetails: 1 },
    {
      transport: async (url, options) => {
        calls.push(url);
        assert.equal(options.profileRevision, undefined);
        assert.equal(options.profileSnapshot, undefined);
        assert.doesNotMatch(JSON.stringify(options), /OWNED_PROFILE_CANARY/);
        return {
          status: 200,
          headers: {},
          text:
            url === sampleApplyUrl
              ? "<form>公开招聘报名<button>提交申请</button></form>"
              : "{}",
        };
      },
    },
  );
  await f.repository.mutateWorkspace((w) => {
    w.runs[f.ref.activityId].profileSnapshot.profile.personalNote =
      "OWNED_PROFILE_CANARY";
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(report.rows[0].applicationAvailableCount, 1);
  assert.equal(report.rows[0].bodyVerifiedCount, 1);
  assert.equal(report.rows[0].rawCount, 2);
  assert.equal(report.rows[0].parsedCount, 2);
  assert.equal(report.usage.usedRequests, 3);
  assert.equal(report.usage.usedDetails, 1);
  assert.equal(report.usage.usedModelRequests, 0);
  assert.equal(report.rows[0].validNewUniqueCount, 0);
  assert.deepEqual(calls, [
    "https://jobs.example.org/list",
    "https://jobs.example.org/job/one",
    sampleApplyUrl,
  ]);
  const root = await f.service.get(f.ref);
  const pending = Object.values(root.collectionProgress.pendingBodies);
  assert.deepEqual(
    pending.map((p) => p.record.sourceRecordId),
    ["unrelated-stub"],
  );
  assert.equal(pending[0].record.bodyStatus, "incomplete");
  assert.equal(pending[0].record.retryEligible, true);
  assert.equal(root.collectionProgress.status, "paused");
  assert.doesNotMatch(
    JSON.stringify(report),
    /OWNED_PROFILE_CANARY|公开招聘|消防|sampleBody/,
  );
});

test("unselected legacy incomplete stubs are queued without changing permanent failures, authentication restrictions or complete bodies", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = enrichmentProvider({
    listed: (s) => [
      { ...record(s.siteId), sourceRecordId: "chosen", title: "消防岗位" },
      {
        ...record(s.siteId),
        sourceRecordId: "university-style",
        detailStatus: "incomplete",
      },
      { ...record(s.siteId), sourceRecordId: "91job-style" },
      {
        ...record(s.siteId),
        sourceRecordId: "permanent",
        retryEligible: false,
      },
      {
        ...record(s.siteId),
        sourceRecordId: "authentication",
        bodyStatus: "restricted",
        retryEligible: true,
      },
      {
        ...record(s.siteId),
        sourceRecordId: "already-complete",
        description: "已核实的公开岗位正文。".repeat(5),
        bodyStatus: "complete",
        detailStatus: "complete",
        retryEligible: false,
      },
    ],
    detailed: (r) => ({
      ...r,
      description: sampleBody,
      detailStatus: "complete",
    }),
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog, {
    maxRequests: 2,
    maxDetails: 1,
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  const root = await f.service.get(f.ref);
  const pending = new Map(
    Object.values(root.collectionProgress.pendingBodies).map((p) => [
      p.record.sourceRecordId,
      p,
    ]),
  );
  assert.deepEqual([...pending.keys()].sort(), [
    "91job-style",
    "authentication",
    "university-style",
  ]);
  for (const id of ["university-style", "91job-style"]) {
    assert.equal(pending.get(id).record.bodyStatus, "incomplete");
    assert.equal(pending.get(id).record.retryEligible, true);
  }
  assert.equal(pending.get("authentication").record.bodyStatus, "restricted");
  assert.equal(pending.get("authentication").status, "waiting_for_auth");
  assert.equal(report.rows[0].rawCount, 6);
  assert.equal(report.rows[0].parsedCount, 6);
  assert.equal(report.rows[0].bodyVerifiedCount, 2);
  assert.equal(report.usage.usedDetails, 1);
  assert.equal(Object.keys((await f.repository.read()).jobs).length, 6);
});

test("uncertain attachment evidence stays pending and cannot upgrade a sampled notice or the whole page", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = enrichmentProvider({
    listed: (s) => [
      { ...record(s.siteId), title: "消防公告", kind: "recruitment_notice" },
      { ...record(s.siteId), sourceRecordId: "other-stub" },
    ],
    detailed: (r) => ({
      ...r,
      description: "详见附件岗位表",
      detailStatus: "incomplete",
      bodyStatus: "incomplete",
      retryEligible: true,
      attachmentBodyPending: true,
      attachments: [
        {
          url: "https://jobs.example.org/roles.xlsx",
          textStatus: "extracted",
          extraction: {
            status: "extracted",
            tables: [],
            blocks: [
              {
                text: sampleBody,
                confidence: 100,
                row: 1,
                location: { page: 1, row: 1 },
              },
              {
                text: "UNTRUSTED_ATTACHMENT_TEXT",
                confidence: 84,
                row: 2,
                location: { page: 1, row: 2 },
              },
              {
                text: "AMBIGUOUS_ATTACHMENT_TEXT",
                confidence: 100,
                ambiguousMerge: true,
                row: 3,
                location: { page: 1, row: 3 },
              },
            ],
          },
        },
      ],
    }),
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog, {
    maxRequests: 2,
    maxDetails: 1,
  });
  attachSyntheticService(f);
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  const pending = Object.values(
    (await f.service.get(f.ref)).collectionProgress.pendingBodies,
  );
  const sampled = pending.find(
    (p) => p.record.sourceRecordId === "job-one",
  ).record;
  assert.equal(sampled.attachmentRows?.length, 1);
  assert.equal(sampled.bodyStatus, "incomplete");
  assert.equal(sampled.attachmentBodyPending, true);
  assert.doesNotMatch(
    sampled.description,
    /UNTRUSTED_ATTACHMENT_TEXT|AMBIGUOUS_ATTACHMENT_TEXT/,
  );
  assert.equal(pending.length, 2);
  assert.equal(report.rows[0].bodyVerifiedCount, 0);
  assert.equal(report.rows[0].rawCount, 2);
  assert.equal(report.rows[0].parsedCount, 2);
  assert.equal(report.usage.usedRequests, 2);
  assert.equal(report.usage.usedModelRequests, 0);
});

test("application enrichment exhausted on the same root retains fetched body without claiming successful verification", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const catalog = [site("one")];
  const f = await prepared(t, [enrichmentProvider()], catalog, {
    maxRequests: 2,
    maxDetails: 1,
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(report.rows[0].detailErrorCode, "source_budget_exhausted");
  assert.equal(report.rows[0].status, "blocked");
  assert.equal(report.rows[0].blockReason, "source_budget_exhausted");
  assert.equal(report.rows[0].committedPages, 1);
  assert.equal(report.rows[0].bodyVerifiedCount, 1);
  assert.equal(report.rows[0].applicationAvailableCount, 0);
  assert.equal(report.usage.usedRequests, 2);
  assert.equal(report.usage.usedDetails, 1);
  assert.equal(report.usage.usedModelRequests, 0);
  const jobs = Object.values((await f.repository.read()).jobs);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].canonical.description, sampleBody);
});

test("attachment allowance exhaustion is reported as blocked while incomplete sampled evidence remains queued", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const provider = enrichmentProvider({
    detailed: (r) => ({
      ...r,
      description: "详见附件",
      kind: "recruitment_notice",
      bodyStatus: "incomplete",
      detailStatus: "incomplete",
      retryEligible: true,
      attachmentBodyPending: true,
      attachments: [
        {
          url: "https://jobs.example.org/roles.xlsx",
          textStatus: "not_extracted",
        },
      ],
    }),
  });
  const catalog = [site("one")];
  const f = await prepared(t, [provider], catalog, {
    maxRequests: 2,
    maxDetails: 1,
    maxAttachments: 0,
  });
  attachSyntheticService(f);
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(report.rows[0].status, "blocked");
  assert.equal(report.rows[0].detailErrorCode, "source_budget_exhausted");
  assert.equal(report.rows[0].blockReason, "source_budget_exhausted");
  assert.equal(report.rows[0].bodyVerifiedCount, 0);
  assert.equal(report.rows[0].committedPages, 1);
  const root = await f.service.get(f.ref);
  const pending = Object.values(root.collectionProgress.pendingBodies)[0]
    .record;
  assert.equal(pending.attachmentBudgetExhausted, true);
  assert.equal(pending.attachments[0].textStatus, "pending");
  assert.equal(root.collectionUsage.usedAttachments, 0);
  assert.equal(report.usage.usedRequests, 2);
  assert.equal(report.usage.usedModelRequests, 0);
});

test("pause during sampled application enrichment rejects the late response without committing the page", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const ready = deferredSample(),
    release = deferredSample(),
    aborted = deferredSample();
  t.after(() => release.resolve());
  let started = false;
  const catalog = [site("one")];
  const f = await prepared(
    t,
    [enrichmentProvider()],
    catalog,
    { maxRequests: 3, maxDetails: 1 },
    {
      transport: async (url) => {
        if (url === sampleApplyUrl) {
          started = true;
          ready.resolve();
          await release.promise;
        }
        return {
          status: 200,
          headers: {},
          text: "<form>公开招聘报名<button>提交申请</button></form>",
        };
      },
    },
  );
  const original = f.service.withDiagnosticContext.bind(f.service);
  f.service.withDiagnosticContext = (args, callback) =>
    original(args, (ctx) => {
      ctx.signal.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      });
      return callback(ctx);
    });
  const validation = validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  await Promise.race([ready.promise, validation]);
  assert.equal(
    started,
    true,
    "sample must enter the owned application request before pausing",
  );
  const pause = f.service.pause(f.ref);
  await aborted.promise;
  release.resolve();
  await pause;
  const report = await validation;
  assert.equal(report.rows[0].errorCode, "collection_stale_epoch");
  assert.equal(report.rows[0].pageCommitted, false);
  const root = await f.service.get(f.ref);
  assert.equal(
    root.collectionProgress.units["public-unit-0"].committedPages,
    0,
  );
  assert.equal(root.collectionProgress.status, "paused");
  assert.equal(Object.keys((await f.repository.read()).jobs).length, 0);
  assert.equal(report.usage.usedRequests, 3);
  assert.equal(report.usage.usedModelRequests, 0);
});

test("invalid enrichment lease is fatal and cannot turn a fetched sample into a committed page", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const catalog = [site("one")];
  const f = await prepared(t, [enrichmentProvider()], catalog, {
    maxRequests: 3,
    maxDetails: 1,
  });
  const original = f.service.withDiagnosticContext.bind(f.service);
  f.service.withDiagnosticContext = (args, callback) =>
    original(args, (ctx) => {
      ctx.enrichRecord = async () => {
        throw Object.assign(Error("PRIVATE_LEASE_FAILURE"), {
          code: "invalid_operation_lease",
        });
      };
      return callback(ctx);
    });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
  });
  assert.equal(report.rows[0].errorCode, "invalid_operation_lease");
  assert.equal(report.rows[0].pageCommitted, false);
  assert.equal(report.rows[0].committedPages, 0);
  assert.equal(Object.keys((await f.repository.read()).jobs).length, 0);
  assert.equal(report.usage.usedRequests, 2);
  assert.equal(report.usage.usedModelRequests, 0);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_LEASE_FAILURE/);
});

test("DOM timeouts match production request diagnostics while native codes and unknown errors retain safe attribution", async (t) => {
  const { validateSources } = await moduleUnderTest();
  const events = [];
  const provider = createPagedProvider({
    id: "ncss",
    name: "Timeout attribution fixture",
    capabilities: {},
    listPage: async (s, _q, _p, ctx) => {
      const request = createRequestClient({
        budget: ctx.budget,
        signal: ctx.signal,
        scheduler: createScheduler({ minIntervalMs: 0 }),
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        transport: async () => {
          if (s.siteId === "dom-timeout")
            throw new DOMException("PRIVATE_TIMEOUT_MESSAGE", "TimeoutError");
          if (s.siteId === "native-timeout")
            throw Object.assign(Error("PRIVATE_NATIVE_MESSAGE"), {
              code: "ETIMEDOUT",
            });
          throw Error("request_timeout PRIVATE_UNKNOWN_MESSAGE");
        },
        diagnostics: { record: (event) => events.push(event) },
        diagnosticContext: {
          runId: ctx.runId,
          sourceId: s.providerId,
          siteId: s.siteId,
          endpointKind: "list",
        },
      });
      await request("https://jobs.example.org/list?private=PRIVATE_QUERY", {
        maxRetries: 0,
      });
      throw Error("Synthetic transport must fail");
    },
  });
  const catalog = [
    site("dom-timeout"),
    site("native-timeout"),
    site("unknown-error"),
  ];
  const f = await prepared(t, [provider], catalog, {
    maxRequests: 3,
    maxDetails: 0,
  });
  const report = await validateSources({
    context: f.context,
    ref: f.ref,
    catalog,
    detailsPerSite: 0,
  });
  const terminal = events.filter(
    (event) =>
      event.operation === "network.request" && event.phase === "finished",
  );
  assert.equal(terminal[0].code, "request_timeout");
  assert.equal(report.rows[0].errorCode, terminal[0].code);
  assert.equal(terminal[1].code, "ETIMEDOUT");
  assert.equal(report.rows[1].errorCode, terminal[1].code);
  assert.equal(report.rows[2].errorCode, "source_validation_failed");
  assert.ok(
    report.rows.every(
      (row) => row.status === "failed" && row.committedPages === 0,
    ),
  );
  assert.equal(report.usage.usedRequests, 3);
  assert.equal(report.usage.usedModelRequests, 0);
  assert.doesNotMatch(
    JSON.stringify(report),
    /PRIVATE_|jobs\.example|requestId|TimeoutError/,
  );
});
