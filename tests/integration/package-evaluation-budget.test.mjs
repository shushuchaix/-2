import test from "node:test";
import assert from "node:assert/strict";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { job } from "../helpers/fixtures.mjs";
import { createApplicationContext } from "../../src/application/context.mjs";
import { DEFAULT_CONFIG } from "../../src/config.mjs";
import { DeepSeek } from "../../src/llm/deepseek.mjs";
import { createConfiguredModelBudget } from "../../src/llm/budget.mjs";
import { handlePackageBusinessRequest } from "../../src/server/package-business-routes.mjs";

async function fixture(
  t,
  { globalLimit, targetLimit, count = 1, usage = true },
) {
  const f = await packageBusinessFixture(t);
  const { a } = await f.twoTargets();
  const ids = await f.ingest(
    a,
    Array.from({ length: count }, (_, i) =>
      job({
        title: "合成Java岗位" + i,
        sourceRecordId: String(i),
        url: "https://example.com/job/" + i,
      }),
    ),
  );
  await f.repository.mutateWorkspace((w) => {
    w.settings.budgets.maxCostCny = globalLimit;
    Object.values(w.targets)
      .flat()
      .find((v) => v.revisionId === a.targetRevisionId).budgets.maxCostCny =
      targetLimit;
  });
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.deepseek.apiKey = "synthetic-test-key";
  let transports = 0;
  const transport = async (_url, init) => {
    transports++;
    const records = JSON.parse(
      JSON.parse(init.body).messages.at(-1).content,
    ).records;
    return Response.json({
      ...(usage
        ? { usage: { prompt_tokens: 100, completion_tokens: 100 } }
        : {}),
      choices: [
        {
          message: {
            content: JSON.stringify({
              results: records.map((r) => ({
                jobId: r.jobId,
                score: 75,
                reasons: ["合成技能匹配"],
                gaps: [],
                evidence: [{ excerpt: "负责Java开发" }],
              })),
            }),
          },
          finish_reason: "stop",
        },
      ],
    });
  };
  const context = await createApplicationContext({
    cfg,
    dataDir: f.dataDir,
    dependencies: {
      startScheduler: false,
      modelFactory: (options) => new DeepSeek(cfg, { ...options, transport }),
      requestFactory: () => async () => {
        throw Error("No external requests permitted");
      },
    },
  });
  await context.ready;
  t.after(() => context.close());
  return { context, a, ids, cfg, transport, calls: () => transports };
}

for (const [globalLimit, targetLimit] of [
  [10, 0],
  [0, 10],
  [10, 3],
]) {
  test(`real package rescore route enforces global ${globalLimit} and target ${targetLimit} CNY`, async (t) => {
    const f = await fixture(t, { globalLimit, targetLimit });
    let response;
    const input = { scope: f.a, mode: "ai" };
    f.context.http = {
      readJson: async () => input,
      json: (_req, _res, status, body) => {
        response = { status, body };
      },
    };
    assert.equal(
      await handlePackageBusinessRequest(
        { method: "POST", url: "/api/v2/jobs/" + f.ids[0] + "/evaluations" },
        {},
        f.context,
      ),
      true,
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.body.usage.maxCostCny,
      Math.min(globalLimit, targetLimit),
    );
    assert.equal(f.calls(), Math.min(globalLimit, targetLimit) === 0 ? 0 : 1);
    assert.equal(
      response.body.evaluations[0].status,
      Math.min(globalLimit, targetLimit) === 0 ? "rule_fallback" : "ai",
    );
  });
}

test("direct rescore cannot bypass a zero target with a supplied ten yuan client", async (t) => {
  const f = await fixture(t, { globalLimit: 10, targetLimit: 0 });
  const client = new DeepSeek(f.cfg, {
    transport: f.transport,
    budget: createConfiguredModelBudget({
      modelConfig: f.cfg.deepseek,
      budgets: { maxCostCny: 10 },
    }),
  });
  const result = await f.context.evaluationService.rescore({
    scope: f.a,
    jobIds: f.ids,
    mode: "ai",
    modelClient: client,
  });
  assert.equal(f.calls(), 0);
  assert.equal(result.usage.maxCostCny, 0);
  assert.equal(result.evaluations[0].status, "rule_fallback");
});

test("supplied client later batches retain the smaller target money cap", async (t) => {
  const f = await fixture(t, {
    globalLimit: 10,
    targetLimit: 3,
    count: 11,
    usage: false,
  });
  const client = new DeepSeek(f.cfg, {
    transport: f.transport,
    budget: createConfiguredModelBudget({
      modelConfig: f.cfg.deepseek,
      budgets: { maxCostCny: 10 },
    }),
  });
  const result = await f.context.evaluationService.rescore({
    scope: f.a,
    jobIds: f.ids,
    mode: "ai",
    modelClient: client,
  });
  assert.equal(f.calls(), 1);
  assert.equal(result.usage.maxCostCny, 3);
  assert.ok(result.usage.costUpperBoundCny <= 3);
  assert.equal(result.evaluations.filter((e) => e.status === "ai").length, 5);
  assert.equal(
    result.evaluations.filter((e) => e.status === "rule_fallback").length,
    6,
  );
});

test("a physical retry cannot widen a supplied client's smaller target ceiling", async (t) => {
  const f = await fixture(t, { globalLimit: 10, targetLimit: 3 });
  let attempts = 0;
  const client = new DeepSeek(f.cfg, {
    retryDelayMs: 0,
    transport: async () => {
      attempts++;
      return new Response("synthetic unavailable", { status: 503 });
    },
    budget: createConfiguredModelBudget({
      modelConfig: f.cfg.deepseek,
      budgets: { maxCostCny: 10 },
    }),
  });
  const result = await f.context.evaluationService.rescore({
    scope: f.a,
    jobIds: f.ids,
    mode: "ai",
    modelClient: client,
  });
  assert.equal(attempts, 1);
  assert.equal(result.usage.maxCostCny, 3);
  assert.ok(result.usage.costUpperBoundCny <= 3);
  assert.equal(result.evaluations[0].status, "rule_fallback");
});
