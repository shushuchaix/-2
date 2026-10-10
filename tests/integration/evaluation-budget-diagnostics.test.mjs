import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";
import { DeepSeek } from "../../src/llm/deepseek.mjs";
import { createModelBudget } from "../../src/llm/budget.mjs";
import {
  validateModelResults,
  evaluationCacheKey,
} from "../../src/llm/validation.mjs";
import { contentHash } from "../../src/infrastructure/storage/repository.mjs";
import { backfillTargetMembers } from "../../src/domain/job-facts.mjs";
import { cleanMetadata } from "../../src/infrastructure/diagnostics/fields.mjs";
import { PROMPT_VERSION } from "../../src/llm/prompts.mjs";
import { RULE_VERSION } from "../../src/domain/ranking.mjs";
import { CONDITIONS_PARSER_VERSION } from "../../src/domain/recruitment-evidence.mjs";
import { job, profile, target } from "../helpers/fixtures.mjs";

const configuration = {
  deepseek: {
    apiKey: "synthetic",
    baseUrl: "https://synthetic.invalid",
    model: "fixture",
  },
};
const input = {
  profileRevisionId: "p1@1",
  targetRevisionId: "t1@1",
  mode: "ai",
};
const row = (jobId, changes = {}) => ({
  jobId,
  score: 80,
  reasons: ["synthetic"],
  gaps: [],
  evidence: [{ excerpt: "Java" }],
  ...changes,
});
const reply = (value) =>
  Response.json({
    choices: [
      {
        message: {
          content: typeof value === "string" ? value : JSON.stringify(value),
        },
      },
    ],
  });

// Replace only external transport and persistence: ranking, caching, model budgets,
// JSON parsing, diagnostic cleaning and evaluation control flow remain real.
function harness({
  count = 17,
  maxRequests = 2,
  transport,
  signal,
  mutate,
} = {}) {
  const jobs = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      "j-" + i,
      {
        jobId: "j-" + i,
        canonical: job({ sourceRecordId: String(i), title: "Java岗位" + i }),
      },
    ]),
  );
  const state = {
    revision: 0,
    runs: {},
    jobs,
    observations: Object.fromEntries(
      Object.entries(jobs).map(([jobId, stored]) => [
        "o-" + jobId,
        {
          observationId: "o-" + jobId,
          jobId,
          targetRevisionId: "t1@1",
          observedAt: "2026-10-05T00:00:00.000Z",
          fields: stored.canonical,
        },
      ]),
    ),
    profiles: { p1: [{ revisionId: "p1@1", profile: profile() }] },
    targets: { t1: [target()] },
    evaluations: {},
  };
  backfillTargetMembers(state);
  const events = [],
    payloads = [];
  const repository = {
    clock: { now: () => 0 },
    read: async () => structuredClone(state),
    mutateWorkspace: async (action, options = {}) => {
      if (mutate && !options.operationMaintenance) await mutate();
      const result = await action(state);
      state.revision++;
      return { workspace: structuredClone(state), result };
    },
  };
  const diagnostics = {
    record: async (event, error) => {
      const saved = {
        operation: event.operation,
        level: event.level || (error ? "error" : "info"),
        ...cleanMetadata(event),
        diagnosticId: "d-" + randomUUID(),
        ...(error ? { errorCode: error.code } : {}),
      };
      events.push(saved);
      return saved;
    },
  };
  const budget = createModelBudget({ maxRequests });
  const client = new DeepSeek(configuration, {
    budget,
    signal,
    diagnostics,
    retryDelayMs: 0,
    transport: async (url, options) => {
      const payload = JSON.parse(options.body);
      payloads.push(payload);
      return transport
        ? transport(payload, payloads.length)
        : reply({
            results: JSON.parse(payload.messages[1].content).records.map(
              (record) => row(record.jobId),
            ),
          });
    },
  });
  let logicalCalls = 0;
  const chatJson = client.chatJson.bind(client);
  client.chatJson = (...args) => {
    logicalCalls++;
    return chatJson(...args);
  };
  const service = createEvaluationService({ repository, diagnostics });
  return {
    state,
    events,
    payloads,
    budget,
    client,
    service,
    logicalCalls: () => logicalCalls,
    evaluate: (changes = {}) =>
      service.evaluate({
        ...input,
        jobIds: Object.keys(jobs),
        modelClient: client,
        signal,
        ...changes,
      }),
  };
}

test("exhausted evaluation budgets skip remaining model calls and save every rule result with one reminder", async () => {
  // Removing the preflight budget check produces four logical calls and two budget failures.
  const f = harness();
  const result = await f.evaluate();
  assert.equal(f.logicalCalls(), 2);
  assert.equal(f.payloads.length, 2);
  assert.equal(result.evaluations.length, 17);
  assert.equal(Object.keys(f.state.evaluations).length, 17);
  assert.equal(result.evaluations.filter((e) => e.status === "ai").length, 10);
  assert.equal(
    result.evaluations.filter((e) => e.status === "rule_fallback").length,
    7,
  );
  assert.equal(
    result.issues.filter((i) => i.code === "model_budget_exhausted").length,
    1,
  );
  assert.equal(result.issues[0].affectedCount, 7);
  const warnings = f.events.filter(
    (e) =>
      e.operation === "model.fallback" && e.code === "model_budget_exhausted",
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, "warn");
  assert.equal(warnings[0].counts.fallback, 7);
  assert.equal(
    f.events.filter((e) => e.errorCode === "model_budget_exhausted").length,
    0,
  );
});

test("a zero model allowance uses rules without invoking chatJson", async () => {
  const f = harness({ maxRequests: 0, count: 11 });
  const result = await f.evaluate();
  assert.equal(f.logicalCalls(), 0);
  assert.equal(result.evaluations.length, 11);
  assert.ok(result.evaluations.every((e) => e.status === "rule_fallback"));
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].affectedCount, 11);
});

test("JSON repair exhausting the last request stops later batches and preserves all rules", async () => {
  const f = harness({
    maxRequests: 1,
    count: 12,
    transport: async () => reply("not JSON"),
  });
  const result = await f.evaluate();
  assert.equal(f.logicalCalls(), 1);
  assert.equal(f.payloads.length, 1);
  assert.equal(result.evaluations.length, 12);
  assert.ok(result.evaluations.every((e) => e.status === "rule_fallback"));
  assert.equal(
    result.issues.filter((i) => i.code === "model_budget_exhausted").length,
    1,
  );
  assert.equal(result.issues[0].affectedCount, 12);
  assert.equal(
    f.events.filter(
      (e) =>
        e.operation === "model.fallback" && e.code === "model_budget_exhausted",
    ).length,
    1,
  );
});

test("a retry exhausting the allowance cannot start more evaluation batches", async () => {
  const f = harness({
    maxRequests: 1,
    count: 12,
    transport: async () =>
      new Response("synthetic unavailable", { status: 503 }),
  });
  const result = await f.evaluate();
  assert.equal(f.logicalCalls(), 1);
  assert.equal(f.payloads.length, 1);
  assert.equal(result.evaluations.length, 12);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].affectedCount, 12);
});

test("282 results with 64 cached AI scores retain 148 AI and 134 rule fallbacks within 20 requests", async () => {
  const f = harness({
    count: 282,
    maxRequests: 20,
    transport: async (payload, attempt) => {
      const records = JSON.parse(payload.messages[1].content).records;
      const invalid = [1, 4, 4, 4, 3][attempt - 1] || 0;
      return reply({
        results: records.map((record, i) =>
          row(record.jobId, { score: i < invalid ? 101 : 80 }),
        ),
      });
    },
  });
  const fingerprint = contentHash({
    endpoint: f.client.baseUrl,
    model: f.client.model,
    temperature: 0.2,
    maxOutputTokens: 4000,
  });
  for (let i = 0; i < 64; i++) {
    const record = { ...f.state.jobs["j-" + i].canonical, jobId: "j-" + i };
    const cacheKey = evaluationCacheKey({
      jdHash: contentHash({ ...record, retrievedAt: undefined }),
      profileRevisionId: "p1@1",
      targetRevisionId: "t1@1",
      promptVersion: PROMPT_VERSION,
      schemaVersion: "matching-results-1",
      conditionsParserVersion: CONDITIONS_PARSER_VERSION,
      ruleVersion: RULE_VERSION,
      modelFingerprint: fingerprint,
    });
    f.state.evaluations["cached-" + i] = {
      evaluationId: "cached-" + i,
      jobId: "j-" + i,
      cacheKey,
      jdHash: contentHash({ ...record, retrievedAt: undefined }),
      observationId: "o-j-" + i,
      profileRevisionId: "p1@1",
      targetRevisionId: "t1@1",
      promptVersion: PROMPT_VERSION,
      schemaVersion: "matching-results-1",
      conditionsParserVersion: CONDITIONS_PARSER_VERSION,
      ruleVersion: RULE_VERSION,
      modelFingerprint: fingerprint,
      status: "ai",
    };
  }
  const result = await f.evaluate();
  assert.equal(f.logicalCalls(), 20);
  assert.equal(result.usage.requests, 20);
  assert.equal(result.evaluations.filter((e) => e.status === "ai").length, 148);
  assert.equal(
    result.evaluations.filter((e) => e.status === "rule_fallback").length,
    134,
  );
  assert.equal(
    result.issues.find((i) => i.code === "model_budget_exhausted")
      .affectedCount,
    118,
  );
  assert.equal(
    result.evaluations.find((e) => e.jobId === "j-0").evaluationId,
    "cached-0",
  );
});

test("budget fallback does not swallow a later cancellation", async () => {
  const controller = new AbortController();
  const reason = Error("synthetic cancellation");
  const f = harness({
    count: 11,
    maxRequests: 0,
    signal: controller.signal,
    mutate: async () => controller.abort(reason),
  });
  await assert.rejects(f.evaluate(), (error) => error === reason);
});

test("budget fallback does not swallow persistence failures", async () => {
  const reason = Error("synthetic storage failure");
  const f = harness({
    maxRequests: 0,
    mutate: async () => {
      throw reason;
    },
  });
  await assert.rejects(f.evaluate(), (error) => error === reason);
  assert.equal(Object.keys(f.state.evaluations).length, 0);
});

const checks = [
  ["duplicate_id", { results: [row("j1"), row("j1")] }],
  ["invalid_score", { results: [row("j1", { score: "80" })] }],
  ["invalid_reasons", { results: [row("j1", { reasons: "private reason" })] }],
  ["invalid_gaps", { results: [row("j1", { gaps: [42] })] }],
  ["missing_evidence", { results: [row("j1", { evidence: [] })] }],
  [
    "invalid_evidence",
    { results: [row("j1", { evidence: [{ excerpt: 3 }] })] },
  ],
  [
    "evidence_not_in_source",
    {
      results: [
        row("j1", { evidence: [{ excerpt: "private fabricated excerpt" }] }),
      ],
    },
  ],
  ["unknown_id", { results: [row("private unknown job ID")] }],
  ["missing_result", { results: [] }],
  ["invalid_results_shape", { results: "private malformed results" }],
];
for (const [reason, value] of checks)
  test(
    "model validation identifies " +
      reason +
      " without accepting untrusted output",
    () => {
      const parsed = validateModelResults(value, {
        records: [
          { jobId: "j1", title: "Java岗位", description: "负责Java开发" },
        ],
      });
      assert.equal(parsed.valid.length, 0);
      assert.equal(parsed.validationCounts[reason], 1);
      assert.equal(
        JSON.stringify(parsed.validationCounts).includes("private"),
        false,
      );
    },
  );

test("parser validation counts and qualification counts preserve only approved nonnegative counters", () => {
  const cleaned = cleanMetadata({
    counts: { qualificationUnknown: 3, qualificationFailed: 2, private: 5 },
    parser: {
      validationCounts: {
        invalid_score: 2,
        evidence_not_in_source: 1,
        unknown_id: 0,
        invalid_reasons: -1,
        invalid_gaps: 0.5,
        private: 3,
        output: "private result",
      },
    },
  });
  assert.deepEqual(cleaned.counts, {
    qualificationUnknown: 3,
    qualificationFailed: 2,
  });
  assert.deepEqual(cleaned.parser.validationCounts, {
    invalid_score: 2,
    evidence_not_in_source: 1,
    unknown_id: 0,
  });
  assert.equal(JSON.stringify(cleaned).includes("private"), false);
});

test("source truncation diagnostics accept only fixed limit reason values", () => {
  for (const reason of ["listing_only", "page_limit", "request_budget"])
    assert.equal(
      cleanMetadata({ truncationReason: reason }).truncationReason,
      reason,
    );
  assert.equal(
    cleanMetadata({ truncationReason: "private input" }).truncationReason,
    undefined,
  );
});

test("business validation traces the physical model response rather than its parent API request", async () => {
  const f = harness({ count: 1 });
  const parent = "q-00000000-0000-4000-8000-000000000001";
  await f.evaluate({ diagnosticContext: { requestId: parent } });
  const request = f.events.find((e) => e.operation === "model.request");
  const validation = f.events.find((e) => e.operation === "model.validation");
  assert.notEqual(request.requestId, parent);
  assert.equal(validation.requestId, request.requestId);
});

test("business validation includes fixed failure counts without raw model results", async () => {
  const f = harness({
    count: 1,
    transport: async (payload) =>
      reply({
        results: [
          row(JSON.parse(payload.messages[1].content).records[0].jobId, {
            evidence: [{ excerpt: "private fabricated excerpt" }],
          }),
        ],
      }),
  });
  const result = await f.evaluate();
  assert.equal(result.evaluations[0].status, "rule_fallback");
  const validation = f.events.find((e) => e.operation === "model.validation");
  assert.deepEqual(validation.parser.validationCounts, {
    evidence_not_in_source: 1,
  });
  assert.equal(JSON.stringify(f.events).includes("private fabricated"), false);
});

test("title-only zero-score evidence stays valid while missing evidence still fails", () => {
  const records = [
    job({ jobId: "j-empty", title: "合成机场岗位", description: "" }),
  ];
  const result = row("j-empty", {
    score: 0,
    reasons: [],
    gaps: ["岗位要求未知"],
    evidence: [{ excerpt: "合成机场岗位" }],
  });
  assert.equal(
    validateModelResults({ results: [result] }, { records }).valid.length,
    1,
  );
  assert.deepEqual(
    validateModelResults(
      { results: [{ ...result, evidence: [] }] },
      { records },
    ).validationCounts,
    { missing_evidence: 1 },
  );
});

test("parallel JSON callbacks receive their own physical response identifiers", async () => {
  const events = [],
    gates = {};
  let markTransportsReady;
  const transportsReady = new Promise((resolve) => {
    markTransportsReady = resolve;
  });
  const client = new DeepSeek(configuration, {
    diagnostics: (event) => events.push(event),
    transport: async (_url, options) => {
      const name = JSON.parse(options.body).messages.find(
        (message) => message.role === "user",
      ).content;
      await new Promise((resolve) => {
        gates[name] = resolve;
        if (Object.keys(gates).length === 2) markTransportsReady();
      });
      return reply({ name });
    },
  });
  const seen = {};
  const first = client.chatJson("", "first", {
    diagnosticContext: { jobId: "j-first" },
    onResponse: (metadata) => {
      seen.first = metadata;
    },
  });
  const second = client.chatJson("", "second", {
    diagnosticContext: { jobId: "j-second" },
    onResponse: (metadata) => {
      seen.second = metadata;
    },
  });
  await transportsReady;
  gates.second();
  assert.deepEqual(await second, { name: "second" });
  gates.first();
  assert.deepEqual(await first, { name: "first" });
  assert.equal(
    seen.first.requestId,
    events.find((e) => e.jobId === "j-first").requestId,
  );
  assert.equal(
    seen.second.requestId,
    events.find((e) => e.jobId === "j-second").requestId,
  );
  assert.notEqual(seen.first.requestId, seen.second.requestId);
  assert.deepEqual(Object.keys(seen.first), ["requestId"]);
});

test("JSON repair metadata identifies the repaired response and its original request", async () => {
  const events = [],
    metadata = [],
    values = ["broken", '{"results":[]}'];
  const client = new DeepSeek(configuration, {
    diagnostics: (event) => events.push(event),
    transport: async () => reply(values.shift()),
  });
  assert.deepEqual(
    await client.chatJson("", "synthetic", {
      onResponse: (value) => metadata.push(value),
    }),
    { results: [] },
  );
  const physical = events.filter((e) => e.operation === "model.request");
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].requestId, physical[1].requestId);
  assert.equal(metadata[0].parentRequestId, physical[0].requestId);
});

test("a failed response observer preserves a successfully parsed model answer", async () => {
  const client = new DeepSeek(configuration, {
    transport: async () => reply({ results: [] }),
  });
  let observed = false;
  assert.deepEqual(
    await client.chatJson("", "synthetic", {
      onResponse: () => {
        observed = true;
        throw Error("synthetic observer failure");
      },
    }),
    { results: [] },
  );
  assert.equal(observed, true);
});

test("a rejected asynchronous response observer cannot reject a successful model answer", async () => {
  const client = new DeepSeek(configuration, {
    transport: async () => reply({ results: [] }),
  });
  let observed = false;
  assert.deepEqual(
    await client.chatJson("", "synthetic", {
      onResponse: async () => {
        observed = true;
        throw Error("synthetic observer failure");
      },
    }),
    { results: [] },
  );
  assert.equal(observed, true);
  await new Promise((resolve) => setImmediate(resolve));
});

test("a stalled response observer does not delay the parsed model answer", async () => {
  const client = new DeepSeek(configuration, {
    transport: async () => reply({ results: [] }),
  });
  let observed = false,
    timer;
  try {
    const answer = await Promise.race([
      client.chatJson("", "synthetic", {
        onResponse: () => {
          observed = true;
          return new Promise(() => {});
        },
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("blocked"), 150);
      }),
    ]);
    assert.deepEqual(answer, { results: [] });
    assert.equal(observed, true);
  } finally {
    clearTimeout(timer);
  }
});
