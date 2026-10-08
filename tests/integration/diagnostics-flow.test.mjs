import {namedTargetInput} from '../helpers/fixtures.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { createApplicationContext } from "../../src/application/context.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { createDiagnosticsLog } from "../../src/infrastructure/diagnostics/log.mjs";
import {
  createPagedProvider,
  jsonResponse,
} from "../../src/sources/adapters/shared.mjs";
import ncss from "../../src/sources/adapters/ncss.mjs";
import { DeepSeek } from "../../src/llm/deepseek.mjs";
import { createModelBudget } from "../../src/llm/budget.mjs";
import { expandArticles } from "../../src/match/article.mjs";
import { loadConfig } from "../../src/config.mjs";
import { createRequestClient } from "../../src/infrastructure/http/client.mjs";
import { createScheduler } from "../../src/infrastructure/http/scheduler.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { createTempDir, job, profile, target } from "../helpers/fixtures.mjs";

async function flow(
  t,
  {
    provider = fakeProvider(),
    modelFactory,
    requestFactory,
    diagnosticSink,
  } = {},
) {
  const dataDir = await createTempDir(t),
    cfg = loadConfig({ quiet: true, dataDir });
  cfg.deepseek.apiKey = "";
  cfg.limits.perIpCooldownMs = 0;
  const diagnostics = diagnosticSink || createDiagnosticsLog({ dataDir });
  const context = await createApplicationContext({
    cfg,
    dataDir,
    dependencies: {legacySchema:true,
      diagnostics,
      registry: createSourceRegistry([provider]),
      catalog: [
        {
          siteId: provider.id + "-1",
          providerId: provider.id,
          category: "job_board",
          name: "合成",
          origin: "https://example.com",
          status: "ready",
        },
      ],
      requestFactory: requestFactory
        ? (options) => requestFactory(options, diagnostics)
        : () => async () => {
            throw Error("Unexpected network");
          },
      ...(modelFactory ? { modelFactory } : {}),
    },
  });
  const p = await context.workspaceService.saveProfile({ profile: profile() });
  const tar = await context.workspaceService.saveTarget(namedTargetInput({
    ...target({ sourceIds: [provider.id] }),
    profileRevisionId: p.revisionId,
  }));
  return { context, diagnostics, targetRevisionId: tar.revisionId };
}

test("completed collection exports planning, stages, batches and final counters", async (t) => {
  // Removing the final summary or copying the wrong budget/counts must fail this test.
  const f = await flow(t),
    { runId } = await f.context.runService.startRun({
      targetRevisionId: f.targetRevisionId,
    });
  const result = await f.context.runService.waitForRun(runId);
  const entries = (await f.diagnostics.list({ runId })).entries;
  const final = entries.filter((e) => e.operation === "run.finished");
  assert.equal(final.length, 1);
  assert.equal(final[0].outcome, "completed");
  assert.equal(final[0].counts.raw, 1);
  assert.equal(final[0].counts.normalized, 1);
  assert.equal(final[0].counts.deduplicated, 1);
  assert.equal(final[0].usage.sources.requests, 0);
  assert.equal(result.run.status, "completed");
  assert.ok(
    entries.some(
      (e) => e.operation === "run.plan" && e.counts.plannedSites === 1,
    ),
  );
  assert.ok(
    entries.some(
      (e) =>
        e.operation === "run.stage.finished" &&
        e.stage === "collecting" &&
        e.durationMs >= 0,
    ),
  );
  assert.ok(
    entries.some((e) => e.operation === "run.batch" && e.counts.accepted === 1),
  );
  assert.ok(
    entries.some(
      (e) => e.operation === "storage.transaction" && e.runId === runId,
    ),
  );
});

test("snapshot failure still exports final status and preserved collection counters", async (t) => {
  const f = await flow(t);
  f.context.repository.writeRunSnapshot = async () => {
    throw Object.assign(Error("private snapshot location"), { code: "EPERM" });
  };
  const { runId } = await f.context.runService.startRun({
    targetRevisionId: f.targetRevisionId,
  });
  await assert.rejects(f.context.runService.waitForRun(runId), {
    code: "EPERM",
  });
  const entries = (await f.diagnostics.list({ runId })).entries;
  const final = entries.filter((e) => e.operation === "run.finished");
  assert.equal(final.length, 1);
  assert.equal(final[0].outcome, "failed");
  assert.equal(final[0].counts.deduplicated, 1);
  assert.ok(entries.some((e) => e.operation === "run.snapshot"));
  assert.equal(JSON.stringify(entries).includes("private snapshot"), false);
});

test("explicit cancellation records its request and one final summary", async (t) => {
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const provider = fakeProvider({
    hold: async (ctx) => {
      entered();
      await new Promise((resolve, reject) =>
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), {
          once: true,
        }),
      );
    },
  });
  const f = await flow(t, { provider });
  const { runId } = await f.context.runService.startRun({
    targetRevisionId: f.targetRevisionId,
  });
  await ready;
  await f.context.runService.cancelRun(runId);
  const result = await f.context.runService.waitForRun(runId);
  const entries = (await f.diagnostics.list({ runId })).entries;
  assert.equal(result.run.status, "cancelled");
  assert.ok(entries.some((e) => e.operation === "run.cancel"));
  const final = entries.filter((e) => e.operation === "run.finished");
  assert.equal(final.length, 1);
  assert.equal(final[0].outcome, "cancelled");
  assert.equal(final[0].counts.deduplicated, 1);
});

test("paged parsing exports page location and accepted versus rejected counts", async (t) => {
  const provider = createPagedProvider({
    id: "synthetic",
    name: "合成",
    capabilities: { category: "job_board" },
    listPage: async () => ({
      records: [job(), job({ sourceRecordId: "bad", title: "" })],
      raw: 2,
      hasMore: false,
    }),
  });
  const f = await flow(t, { provider }),
    { runId } = await f.context.runService.startRun({
      targetRevisionId: f.targetRevisionId,
    });
  await f.context.runService.waitForRun(runId);
  const entries = (await f.diagnostics.list({ runId })).entries;
  const page = entries.find((e) => e.operation === "run.page");
  assert.ok(page);
  assert.equal(page.page, 1);
  assert.equal(page.queryIndex, 0);
  assert.deepEqual(page.counts, { raw: 2, accepted: 1, rejected: 1 });
  const rejected = entries.find(
    (e) => e.error?.message === "Missing source title",
  );
  assert.equal(rejected.page, 1);
  assert.equal(rejected.queryIndex, 0);
});

test("JSON parse failures retain structure metadata without response fragments", () => {
  assert.throws(
    () => jsonResponse({ status: 200, text: "private invalid body" }),
    (error) => {
      assert.equal(error.code, "parse_error");
      assert.equal(error.phase, "parse");
      assert.equal(error.parser.format, "json");
      assert.equal(error.parser.documentLength, 20);
      assert.equal(JSON.stringify(error.parser).includes("private"), false);
      return true;
    },
  );
});

test("NCSS insufficient detail retains selector and length diagnostics", async () => {
  const record = job({ title: "合成岗位", sourceId: "ncss", siteId: "ncss-1" });
  await assert.rejects(
    ncss.fetchDetail(record, {
      request: async () => ({
        status: 200,
        headers: {},
        text: '<div class="mainContent">合成岗位</div>',
      }),
    }),
    (error) => {
      assert.equal(error.code, "detail_insufficient");
      assert.equal(error.parser.selectorPresent, true);
      assert.equal(error.parser.titleOnly, true);
      assert.equal(error.parser.textLength, 4);
      assert.equal(JSON.stringify(error.parser).includes("合成岗位"), false);
      return true;
    },
  );
});

test("NCSS list shape failure is correlated with the successful HTTP response", async (t) => {
  const provider = { ...ncss, id: "ncss" };
  const f = await flow(t, {
    provider,
    requestFactory: (options, diagnostics) =>
      createRequestClient({
        ...options,
        diagnostics,
        scheduler: createScheduler({ minIntervalMs: 0 }),
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        transport: async () => ({
          status: 200,
          headers: { "content-type": "application/json" },
          text: "null",
        }),
      }),
  });
  const { runId } = await f.context.runService.startRun({
    targetRevisionId: f.targetRevisionId,
  });
  await f.context.runService.waitForRun(runId);
  const entries = (await f.diagnostics.list({ runId })).entries;
  const parse = entries.find((entry) => entry.operation === "run.collect");
  assert.equal(parse.error.code, "parse_error");
  assert.equal(parse.error.parser.resultType, "null");
  const request = entries.find(
    (entry) => entry.operation === "network.request",
  );
  assert.equal(parse.error.requestId, request.requestId);
  assert.equal(request.sourceId, "ncss");
  assert.equal(request.siteId, "ncss-1");
  assert.equal(request.page, 1);
  assert.equal(request.queryIndex, 0);
  assert.equal(JSON.stringify(entries).includes("jobName"), false);
});

test("model failure exports fallback cause and run totals while preserving rules", async (t) => {
  const f = await flow(t, {
    modelFactory: ({ budget }) => ({
      available: true,
      budget,
      baseUrl: "https://example.com",
      model: "fixture",
      chatJson: async () => {
        throw Object.assign(Error("private model response"), { status: 503 });
      },
    }),
  });
  const { runId } = await f.context.runService.startRun({
    targetRevisionId: f.targetRevisionId,
    mode: "ai",
  });
  const result = await f.context.runService.waitForRun(runId),
    entries = (await f.diagnostics.list({ runId })).entries;
  assert.equal(result.run.counts.fallback, 1);
  const fallback = entries.find((e) => e.operation === "model.fallback");
  assert.equal(fallback.error.status, 503);
  assert.equal(fallback.counts.fallback, 1);
  assert.equal(
    entries.find((e) => e.operation === "run.finished").counts.fallback,
    1,
  );
  assert.equal(
    JSON.stringify(entries).includes("private model response"),
    false,
  );
});

test("model JSON downgrade and repair exports attempts without prompts or output", async (t) => {
  const diagnostics = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  const responses = [
    new Response("response_format unsupported", { status: 400 }),
    Response.json({
      choices: [{ message: { content: "private broken output" } }],
    }),
    Response.json({ choices: [{ message: { content: '{"results":[]}' } }] }),
  ];
  const client = new DeepSeek(
    { deepseek: { apiKey: "private-key", timeoutMs: 1000 } },
    {
      diagnostics,
      diagnosticContext: { runId: "r-json" },
      budget: createModelBudget({ maxRequests: 3 }),
      transport: async () => responses.shift(),
    },
  );
  assert.deepEqual(await client.chatJson("private-system", "private-user"), {
    results: [],
  });
  const entries = (await diagnostics.list({ runId: "r-json" })).entries;
  assert.equal(
    entries.filter((e) => e.operation === "model.request").length,
    3,
  );
  assert.ok(
    entries.some(
      (e) =>
        e.operation === "model.fallback" && e.code === "json_mode_unsupported",
    ),
  );
  assert.ok(
    entries.some(
      (e) => e.operation === "model.validation" && e.code === "json_repair",
    ),
  );
  assert.equal(JSON.stringify(entries).includes("private-"), false);
  assert.equal(JSON.stringify(entries).includes("private broken"), false);
});

test("article expansion reports a swallowed model error through diagnostics", async (t) => {
  const diagnostics = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  const result = await expandArticles(
    {
      chatJson: async () => {
        throw Object.assign(Error("private article error"), { status: 503 });
      },
    },
    profile(),
    [job({ kind: "recruitment_notice" })],
    { diagnostics, diagnosticContext: { runId: "r-article" } },
  );
  assert.equal(result.failed, 1);
  const entries = (await diagnostics.list({ runId: "r-article" })).entries;
  assert.ok(
    entries.some(
      (e) => e.operation === "model.fallback" && e.error.status === 503,
    ),
  );
  assert.equal(JSON.stringify(entries).includes("private article"), false);
});

test("missing model results produce a counted fallback reason", async (t) => {
  const f = await flow(t, {
    modelFactory: ({ budget }) => ({
      available: true,
      budget,
      baseUrl: "https://example.com",
      model: "fixture",
      chatJson: async () => ({ results: [] }),
    }),
  });
  const { runId } = await f.context.runService.startRun({
    targetRevisionId: f.targetRevisionId,
    mode: "ai",
  });
  const result = await f.context.runService.waitForRun(runId);
  assert.equal(result.run.counts.fallback, 1);
  const entries = (await f.diagnostics.list({ runId })).entries;
  const fallback = entries.find(
    (entry) => entry.operation === "model.fallback",
  );
  assert.ok(fallback);
  assert.equal(fallback.code, "missing_model_result");
  assert.equal(fallback.counts.fallback, 1);
  assert.equal(fallback.counts.missing, 1);
});

test("a throwing diagnostic sink never turns a completed run into a failure", async (t) => {
  const f = await flow(t, {
    diagnosticSink: {
      record: async () => {
        throw Error("synthetic sink failure");
      },
    },
  });
  const { runId } = await f.context.runService.startRun({
    targetRevisionId: f.targetRevisionId,
  });
  const result = await f.context.runService.waitForRun(runId);
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.counts.deduplicated, 1);
});

test("model cancellation logs a fixed reason without retaining the private caller error", async (t) => {
  const diagnostics = createDiagnosticsLog({ dataDir: await createTempDir(t) });
  const controller = new AbortController();
  const reason = Object.assign(Error("private model prompt"), {
    code: "private-key-secret",
  });
  const model = new DeepSeek(
    { deepseek: { apiKey: "synthetic" } },
    {
      diagnostics,
      signal: controller.signal,
      transport: async (_url, options) => {
        controller.abort(reason);
        throw options.signal.reason;
      },
    },
  );
  await assert.rejects(
    model.chat("private system", "private resume", { retries: 0 }),
    (error) => error === reason,
  );
  const result = await diagnostics.list({ category: "model" });
  assert.equal(result.entries[0].outcome, "cancelled");
  assert.equal(result.entries[0].code, "request_cancelled");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("model diagnostic annotations preserve frozen errors and their retry behavior", async () => {
  const reason = Object.freeze(
    Object.assign(Error("reset"), { code: "ECONNRESET" }),
  );
  let attempts = 0;
  const model = new DeepSeek(
    { deepseek: { apiKey: "synthetic" } },
    {
      retryDelayMs: 0,
      transport: async () => {
        attempts++;
        throw reason;
      },
    },
  );
  await assert.rejects(
    model.chat("system", "user", { retries: 1 }),
    (error) => error === reason,
  );
  assert.equal(attempts, 2);
});

test("a failed page observer cannot discard a valid collection batch", async () => {
  const provider = createPagedProvider({
    id: "synthetic",
    name: "synthetic",
    capabilities: {},
    listPage: async () => ({ records: [job()], hasMore: false }),
  });
  const result = await provider.collect({
    sites: [{ siteId: "synthetic-1" }],
    reportDiagnostic: async () => {
      throw Error("sink unavailable");
    },
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.issues.length, 0);
  assert.equal(result.coverage[0].status, "complete");
});

test("model JSON validation identifies the response being parsed and its repair", async () => {
  const events = [],
    responses = ["invalid JSON", '{"results":[]}'];
  const model = new DeepSeek(
    { deepseek: { apiKey: "synthetic" } },
    {
      diagnostics: (event) => events.push(event),
      transport: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: responses.shift() } }],
        }),
      }),
    },
  );
  await model.chatJson("system", "user", { retries: 0 });
  const physical = events.filter((e) => e.operation === "model.request");
  assert.equal(physical.length, 2);
  assert.equal(
    events.find((e) => e.code === "json_repair").requestId,
    physical[0].requestId,
  );
  assert.equal(
    events.find((e) => e.code === "json_repaired").requestId,
    physical[1].requestId,
  );
});
