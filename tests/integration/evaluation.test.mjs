import { namedTargetInput } from "../helpers/fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeek } from "../../src/llm/deepseek.mjs";
import { createModelBudget } from "../../src/llm/budget.mjs";
import {
  validateModelResults,
  evaluationCacheKey,
} from "../../src/llm/validation.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
import { createWorkspaceService } from "../../src/application/workspace-service.mjs";
import { createJobService } from "../../src/application/job-service.mjs";
import { job, profile, target, createTempDir } from "../helpers/fixtures.mjs";
const cfg = {
  deepseek: {
    apiKey: "test-secret",
    baseUrl: "https://model.example.com",
    model: "fixture",
    timeoutMs: 1000,
  },
};
test("all attempts share hard budget including JSON downgrade and repair", async () => {
  const budget = createModelBudget({ maxRequests: 3 });
  const payloads = [];
  const replies = [
    new Response("response_format unsupported", { status: 400 }),
    Response.json({ choices: [{ message: { content: "broken" } }] }),
    Response.json({ choices: [{ message: { content: '{"results":[]}' } }] }),
  ];
  const client = new DeepSeek(cfg, {
    budget,
    transport: async (url, options) => {
      payloads.push(JSON.parse(options.body));
      return replies.shift();
    },
    retryDelayMs: 0,
  });
  assert.deepEqual(
    await client.chatJson("system", "user", { maxTokens: 9999 }),
    { results: [] },
  );
  assert.equal(budget.snapshot().requests, 3);
  assert.ok(payloads.every((p) => p.max_tokens === 4000));
  await assert.rejects(client.chat("", "next"), /budget_exhausted/);
  assert.equal(payloads.length, 3);
  const twenty = createModelBudget();
  for (let i = 0; i < 20; i++) twenty.claimRequest();
  assert.throws(() => twenty.claimRequest(), /budget_exhausted/);
});
test("partial model results keep valid items and only invalid missing items fall back", async (t) => {
  const repository = await openWorkspaceRepository({allowLegacy:true,
      dataDir: await createTempDir(t),
    }),
    workspace = createWorkspaceService({ repository }),
    jobs = createJobService({ repository });
  const p = await workspace.saveProfile({ profile: profile() });
  const tar = await workspace.saveTarget(
    namedTargetInput({
      ...target(),
      targetId: undefined,
      profileRevisionId: p.revisionId,
    }),
  );
  const ingested = await jobs.ingestRecords({
    runId: "test",
    targetRevisionId: tar.revisionId,
    records: [
      job(),
      job({
        sourceRecordId: "2",
        degree: "博士",
        description: "必须博士学历，掌握Java，负责服务开发。",
      }),
    ],
  });
  const service = createEvaluationService({
    repository,
    modelFactory: (options) =>
      new DeepSeek(cfg, {
        ...options,
        transport: async () =>
          Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    results: [
                      {
                        jobId: ingested.jobIds[0],
                        score: 90,
                        reasons: ["Java匹配"],
                        gaps: [],
                        evidence: [{ excerpt: "Java" }],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
      }),
  });
  const r = await service.evaluate({
    jobIds: ingested.jobIds,
    profileRevisionId: p.revisionId,
    targetRevisionId: tar.revisionId,
    mode: "ai",
  });
  assert.equal(r.evaluations[0].status, "ai");
  assert.equal(r.evaluations[1].status, "rule_fallback");
  assert.equal(r.evaluations[1].qualification.status, "fail");
  assert.equal(r.usage.requests, 1);
  const validation = validateModelResults(
    {
      results: [
        {
          jobId: "j1",
          score: 90,
          reasons: [],
          gaps: [],
          evidence: [{ excerpt: "编造内容" }],
        },
        { jobId: "j2", score: 80, reasons: [], gaps: [], evidence: [] },
        { jobId: "j2", score: 80, reasons: [], gaps: [], evidence: [] },
      ],
    },
    {
      records: [
        { jobId: "j1", description: "真实内容" },
        { jobId: "j2", description: "真实内容" },
      ],
    },
  );
  assert.equal(validation.valid.length, 0);
  assert.ok(validation.invalidIds.includes("j1"));
  assert.ok(validation.invalidIds.includes("j2"));
  const key = {
    jdHash: "a",
    profileRevisionId: "p1@1",
    targetRevisionId: "t1@1",
    promptVersion: "1",
    ruleVersion: "1",
    modelFingerprint: "m",
  };
  for (const field of Object.keys(key))
    assert.notEqual(
      evaluationCacheKey(key),
      evaluationCacheKey({ ...key, [field]: key[field] + "changed" }),
    );
});
test("cancellation in model backoff starts no more attempts", async () => {
  let calls = 0;
  const controller = new AbortController(),
    budget = createModelBudget();
  const client = new DeepSeek(cfg, {
    signal: controller.signal,
    budget,
    transport: async () => {
      calls++;
      controller.abort();
      return new Response("busy", { status: 503 });
    },
    retryDelayMs: 10,
  });
  await assert.rejects(client.chat("", "x"), /abort/i);
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().requests, 1);
});
test("parallel tasks isolate usage and cached evaluations retain immutable identity", async (t) => {
  const clients = [0, 1].map(
    () =>
      new DeepSeek(cfg, {
        transport: async () =>
          Response.json({ choices: [{ message: { content: "ok" } }] }),
      }),
  );
  await Promise.all(clients.map((c) => c.chat("", "x")));
  assert.equal(clients[0].budget.snapshot().requests, 1);
  assert.equal(clients[1].budget.snapshot().requests, 1);
  const repository = await openWorkspaceRepository({allowLegacy:true,
      dataDir: await createTempDir(t),
    }),
    workspace = createWorkspaceService({ repository }),
    jobs = createJobService({ repository });
  const p = await workspace.saveProfile({ profile: profile() }),
    tar = await workspace.saveTarget(
      namedTargetInput({
        ...target(),
        profileRevisionId: p.revisionId,
      }),
    ),
    { jobIds } = await jobs.ingestRecords({
      runId: "fixture",
      targetRevisionId: tar.revisionId,
      records: [job()],
    });
  const service = createEvaluationService({ repository });
  const input = {
    jobIds,
    profileRevisionId: p.revisionId,
    targetRevisionId: tar.revisionId,
    mode: "rules",
  };
  const first = await service.evaluate(input),
    cached = await service.evaluate(input);
  assert.equal(
    first.evaluations[0].evaluationId,
    cached.evaluations[0].evaluationId,
  );
  assert.equal(cached.usage.requests, 0);
  const failedAI = await service.evaluate({ ...input, mode: "ai" });
  assert.equal(failedAI.evaluations[0].status, "rule_fallback");
  assert.ok(failedAI.issues.some((i) => i.code === "missing_model_key"));
});
