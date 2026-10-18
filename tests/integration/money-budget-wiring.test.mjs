import { namedTargetInput } from "../helpers/fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApplicationContext } from "../../src/application/context.mjs";
import { DEFAULT_CONFIG } from "../../src/config.mjs";
import { DeepSeek } from "../../src/llm/deepseek.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { fakeProvider } from "../helpers/fake-sources.mjs";
import { createTempDir, registerTestResource, profile, target, job } from "../helpers/fixtures.mjs";

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
      description: job().description.repeat(3),
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
    dependencies: {startScheduler:false,
      registry: createSourceRegistry([fakeProvider({ records })]),
      catalog: [
        {
          siteId: "synthetic-1",
          providerId: "synthetic",
          category: "job_board",
          name: "合成",
          origin: "https://example.com",
          status: "ready",
          verifiedAt: new Date().toISOString(),
          probeEvidence: [{ hasRequirements: true }],
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
  registerTestResource(t,()=>context.close());
  // Bind only the synthetic transport key through the real schema3 settings port.
  await context.saveSettings({ model: { apiKey: "synthetic-test-key" } });
  const p = await context.workspaceService.saveProfile(namedTargetInput({
    text: "合成测试简历：本科软件工程专业，2027届毕业，拥有Java开发技能和软件项目经验。",
    profile: profile(),
  }));
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
    scope: { packageId: tar.packageId, targetRevisionId: tar.revisionId },
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
    scope: f.scope,
    mode: "ai",
  });
  const result = await f.context.runService.waitForRun(started.runId, f.scope);
  assert.equal(result.evaluations.filter((e) => e.status === "ai").length, 105);
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
    scope: f.scope,
    mode: "ai",
  });
  const result = await f.context.runService.waitForRun(started.runId, f.scope);
  assert.equal(f.transports(), 0);
  assert.equal(result.evaluations.length, 6);
  assert.equal(result.run.usage.model.maxCostCny, 0);
  assert.equal(
    result.run.issues.filter((i) => i.code === "model_budget_exhausted").length,
    1,
  );
  assert.equal(result.run.issues.find((i) => i.code === "model_budget_exhausted").affectedCount, 6);
  assert.equal(result.run.issueCount, 1);
});

test("model issues without evaluation IDs remain owned counted and redacted", async (t) => {
  const f = await fixture(t, 6);
  const diagnosticId = "d-" + randomUUID();
  f.context.evaluationService.evaluate = async () => ({
    evaluations: [],
    issues: [
      { code: "model_budget_exhausted", affectedCount: 6, diagnosticId, message: "private model text", sourceId: "private source" },
      { code: "private upstream code", affectedCount: -1, diagnosticId: "private diagnostic", jobId: "private job" },
    ],
  });
  const started = await f.context.runService.startRun({ scope: f.scope, mode: "ai" });
  const result = await f.context.runService.waitForRun(started.runId, f.scope);
  assert.equal(result.evaluations.length, 0);
  assert.equal(result.run.issueCount, 2);
  assert.deepEqual(result.run.issues, [
    { code: "model_budget_exhausted", affectedCount: 6, diagnosticId },
    { code: "model_unavailable" },
  ]);
  const stored = await f.context.repository.queryRows({ collection: "runIssues", ownerPackageId: f.scope.packageId, where: { runId: started.runId }, limit: 50 }, { scope: f.scope });
  assert.equal(stored.rows.length, 2);
  assert.ok(stored.rows.every((row) => row.indexes.ownerPackageId === f.scope.packageId));
  assert.equal(JSON.stringify(stored).includes("private"), false);
  await assert.rejects(f.context.runService.waitForRun(started.runId, { ...f.scope, packageId: randomUUID() }));
});

test("cancelled evaluation cannot append a late model issue", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, 6);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), aborted = Promise.withResolvers();
  registerTestResource(t, () => release.resolve());
  f.context.evaluationService.evaluate = async ({ signal }) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    await release.promise;
    return { evaluations: [], issues: [{ code: "model_budget_exhausted", affectedCount: 6 }] };
  };
  const started = await f.context.runService.startRun({ scope: f.scope, mode: "ai" });
  await entered.promise;
  const cancelled = f.context.collectionService.cancel({ scope: f.scope, activityId: started.activityId });
  await aborted.promise;
  release.resolve();
  await cancelled;
  await f.context.collectionService.wait({ scope: f.scope, activityId: started.activityId });
  const rows = await f.context.repository.queryRows({ collection: "runIssues", ownerPackageId: f.scope.packageId, where: { runId: started.runId }, limit: 50 }, { scope: f.scope });
  assert.equal(rows.rows.some((row) => row.value.code === "model_budget_exhausted"), false);
});

test("saved job rescore uses the same configured money budget", async (t) => {
  const f = await fixture(t);
  await f.context.saveSettings({ budgets: { maxCostCny: 10 } });
  // Saved-job rescoring starts from a real owned run; an invented run ID is
  // deliberately rejected by the formal ingest port before any write.
  await f.context.repository.transaction({ select: [{ collection: "runs", ownerPackageId: f.scope.packageId, ids: ["manual"] }] }, (tx) => {
    tx.putRow({ collection: "runs", id: "manual", ownerPackageId: f.scope.packageId,
      targetRevisionId: f.scope.targetRevisionId,
      value: { runId: "manual", recordId: randomUUID(), ownerPackageId: f.scope.packageId,
        status: "completed", counts: {}, usage: {} } });
  }, { scope: f.scope });
  const ingested = await f.context.jobService.ingestRecords({
    runId: "manual",
    targetRevisionId: f.tar.revisionId,
    scope: f.scope,
    records: f.records,
  });
  const result = await f.context.evaluationService.rescore({
    jobIds: ingested.jobIds,
    profileRevisionId: f.p.revisionId,
    targetRevisionId: f.tar.revisionId,
    scope: f.scope,
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
    scope: { packageId: tar.packageId, targetRevisionId: tar.revisionId },
    mode: "ai",
  });
  const result = await f.context.runService.waitForRun(started.runId, { packageId: tar.packageId, targetRevisionId: tar.revisionId });
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
