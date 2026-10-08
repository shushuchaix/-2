import { namedTargetInput } from "../helpers/fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createApplicationContext } from "../../src/application/context.mjs";
import { DEFAULT_CONFIG } from "../../src/config.mjs";
import { DeepSeek } from "../../src/llm/deepseek.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { createTempDir, profile, target, job } from "../helpers/fixtures.mjs";

async function fixture(t, count = 105) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.deepseek, {
    model: "deepseek-flash",
    apiKey: "synthetic-test-key",
  });
  cfg.limits.perIpCooldownMs = 0;
  const records = Array.from({ length: count }, (_, i) =>
    job({
      sourceRecordId: String(i),
      url: `https://jobs.example.com/${i}`,
      title: `Java开发工程师${i}`,
      company: `合成公司${i}`,
    }),
  );
  let transports = 0;
  const clients = [];
  const context = await createApplicationContext({
    cfg,
    dataDir: await createTempDir(t),
    dependencies: {legacySchema:true,
      registry: createSourceRegistry([fakeProvider({ records })]),
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
      modelFactory: (options) => {
        const client = new DeepSeek(
          { deepseek: options.modelConfig || { ...cfg.deepseek } },
          {
            ...options,
            transport: async (_url, init) => {
              transports++;
              const body = JSON.parse(init.body),
                records = JSON.parse(body.messages.at(-1).content).records;
              return new Response(
                JSON.stringify({
                  usage: { prompt_tokens: 100, completion_tokens: 100 },
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          results: records.map((r) => ({
                            jobId: r.jobId,
                            score: 75,
                            reasons: ["技能匹配"],
                            gaps: [],
                            evidence: [{ excerpt: "负责Java开发" }],
                          })),
                        }),
                      },
                      finish_reason: "stop",
                    },
                  ],
                }),
                { status: 200 },
              );
            },
          },
        );
        clients.push(client);
        return client;
      },
    },
  });
  const p = await context.workspaceService.saveProfile({ profile: profile() });
  const tar = await context.workspaceService.saveTarget(
    namedTargetInput({
      ...target(),
      profileRevisionId: p.revisionId,
      budgets: { maxModelRequests: 20 },
    }),
  );
  return {
    context,
    cfg,
    p,
    tar,
    records,
    clients,
    transports: () => transports,
  };
}

test("settings accept CNY budget and reject unpriced provider before writing", async (t) => {
  const f = await fixture(t, 1);
  await f.context.saveSettings({ budgets: { maxCostCny: 10 } });
  assert.equal((await f.context.getSettings()).budgets.maxCostCny, 10);
  await assert.rejects(
    f.context.saveSettings({
      model: { baseUrl: "https://example.com", model: "other" },
    }),
  );
  assert.equal(f.cfg.deepseek.baseUrl, "https://api.deepseek.com");
  await assert.rejects(
    f.context.saveSettings({ budgets: { maxCostCny: 10.01 } }),
  );
});

test("a currency run evaluates beyond old twenty request target cap", async (t) => {
  const f = await fixture(t);
  await f.context.saveSettings({ budgets: { maxCostCny: 10 } });
  const started = await f.context.runService.startRun({
    targetRevisionId: f.tar.revisionId,
    mode: "ai",
  });
  const result = await f.context.runService.waitForRun(started.runId);
  assert.equal(result.run.counts.aiSuccess, 105);
  assert.equal(f.transports(), 21);
  assert.equal(result.run.usage.model.maxCostCny, 10);
  assert.equal(result.run.usage.model.maxRequests, 1000);
  assert.ok(result.run.usage.model.costUpperBoundCny < 10);
  assert.equal(result.run.usage.model.uncertainRequests, 0);
});

test("zero currency budget performs no transport while preserving rule results", async (t) => {
  const f = await fixture(t, 6);
  await f.context.saveSettings({ budgets: { maxCostCny: 0 } });
  const started = await f.context.runService.startRun({
    targetRevisionId: f.tar.revisionId,
    mode: "ai",
  });
  const result = await f.context.runService.waitForRun(started.runId);
  assert.equal(f.transports(), 0);
  assert.equal(result.evaluations.length, 6);
  assert.equal(result.run.usage.model.maxCostCny, 0);
  assert.equal(
    result.run.issues.filter((i) => i.code === "model_budget_exhausted").length,
    1,
  );
});

test("saved job rescore uses the same configured money budget", async (t) => {
  const f = await fixture(t);
  await f.context.saveSettings({ budgets: { maxCostCny: 10 } });
  const ingested = await f.context.jobService.ingestRecords({
    runId: "manual",
    targetRevisionId: f.tar.revisionId,
    records: f.records,
  });
  const result = await f.context.evaluationService.rescore({
    jobIds: ingested.jobIds,
    profileRevisionId: f.p.revisionId,
    targetRevisionId: f.tar.revisionId,
    mode: "ai",
  });
  assert.equal(result.evaluations.filter((e) => e.status === "ai").length, 105);
  assert.equal(f.transports(), 21);
  assert.equal(f.clients[0].budget.snapshot().maxCostCny, 10);
});

test("target currency budget uses the configured model and cannot exceed the workspace ceiling", async (t) => {
  const f = await fixture(t, 6);
  await f.context.saveSettings({ budgets: { maxCostCny: 0 } });
  const tar = await f.context.workspaceService.saveTarget(
    namedTargetInput({
      ...target(),
      profileRevisionId: f.p.revisionId,
      budgets: { maxCostCny: 10 },
    }),
  );
  const started = await f.context.runService.startRun({
    targetRevisionId: tar.revisionId,
    mode: "ai",
  });
  const result = await f.context.runService.waitForRun(started.runId);
  assert.equal(f.transports(), 0);
  assert.equal(result.run.usage.model.maxCostCny, 0);
});

test("explicitly clearing currency switches back to bounded request-only compatible models", async (t) => {
  const f = await fixture(t, 1);
  await f.context.saveSettings({
    budgets: { maxCostCny: 10, maxModelRequests: 1000 },
  });
  await f.context.saveSettings({
    model: { baseUrl: "http://localhost:11434/v1", model: "local-model" },
    budgets: { maxCostCny: null, maxModelRequests: 12 },
  });
  const settings = await f.context.getSettings();
  assert.equal(Object.hasOwn(settings.budgets, "maxCostCny"), false);
  assert.equal(
    (await f.context.createModelBudget()).snapshot().maxRequests,
    12,
  );
});

test("concurrent settings patches retain both budgets", async (t) => {
  const f = await fixture(t, 1);
  await Promise.all([
    f.context.saveSettings({ budgets: { maxRequests: 100 } }),
    f.context.saveSettings({ budgets: { maxDetails: 15 } }),
  ]);
  const settings = await f.context.getSettings();
  assert.equal(settings.budgets.maxRequests, 100);
  assert.equal(settings.budgets.maxDetails, 15);
});

test("simultaneous money enable and unpriced model change cannot commit an inconsistent configuration", async (t) => {
  const f = await fixture(t, 1);
  const results = await Promise.allSettled([
    f.context.saveSettings({ budgets: { maxCostCny: 10 } }),
    f.context.saveSettings({
      model: { baseUrl: "https://compatible.example/v1", model: "other" },
    }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  const settings = await f.context.getSettings();
  assert.equal(settings.model.model, "deepseek-flash");
  assert.equal(settings.budgets.maxCostCny, 10);
  assert.equal((await f.context.createModelBudget()).snapshot().maxCostCny, 10);
});

test("malformed settings return the expected field validation error", async (t) => {
  const f = await fixture(t, 1);
  for (const value of [null, undefined, [], "invalid"])
    await assert.rejects(
      f.context.saveSettings(value),
      (error) => error.code === "invalid_input",
    );
});
