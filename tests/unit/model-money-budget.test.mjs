import test from "node:test";
import assert from "node:assert/strict";
import * as budgets from "../../src/llm/budget.mjs";
import { DeepSeek } from "../../src/llm/deepseek.mjs";
import { DEFAULT_CONFIG } from "../../src/config.mjs";

test("fresh default configuration uses the available V4.1 API model", () => {
  assert.equal(DEFAULT_CONFIG.deepseek.model, "deepseek-flash");
  assert.equal(
    new DeepSeek({ deepseek: { apiKey: "synthetic-key" } }).model,
    "deepseek-flash",
  );
});

const modelConfig = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-flash",
};
const identity = { ...modelConfig, maxOutputTokens: 4000 };
const money = (options = {}) =>
  budgets.createModelBudget({ maxCostCny: 10, modelConfig, ...options });
const usage = (prompt_tokens = 100, completion_tokens = 50) => ({
  prompt_tokens,
  completion_tokens,
  total_tokens: prompt_tokens + completion_tokens,
});
const reply = (content = "answer", tokenUsage = usage()) =>
  Response.json({
    model: "deepseek-flash",
    choices: [{ message: { content }, finish_reason: "stop" }],
    ...(tokenUsage !== undefined ? { usage: tokenUsage } : {}),
  });
const client = (budget, transport, options = {}) =>
  new DeepSeek(
    { deepseek: { ...modelConfig, apiKey: "synthetic-key", timeoutMs: 1000 } },
    { budget, transport, retryDelayMs: 0, ...options },
  );

test("money mode reserves full documented input context before a request", () => {
  const budget = money();
  const id = budget.claimRequest(identity);
  assert.equal(id, 1);
  assert.equal(budget.snapshot().reservedCostCny, 2.129152);
  assert.equal(budget.snapshot().costUpperBoundCny, 2.129152);
  assert.equal(budget.snapshot().maxCostCny, 10);
  assert.equal(budget.snapshot().maxRequests, 1000);
  assert.equal(budget.snapshot().costMode, "cny_upper_bound");
  assert.match(budget.snapshot().pricingVersion, /2026-10-07/);
});

test("successful usage releases the reserved difference with exact integer accounting", () => {
  const budget = money({ maxCostCny: 2.13 });
  const id = budget.claimRequest(identity);
  budget.settleRequest(id, usage(1, 1));
  assert.equal(budget.snapshot().costUpperBoundCny, 0.00001);
  assert.equal(budget.snapshot().reservedCostCny, 0);
  assert.equal(budget.snapshot().pricedRequests, 1);
  assert.equal(budget.isExhausted(), false);
  budget.claimRequest(identity);
  assert.equal(budget.snapshot().costUpperBoundCny, 2.129162);
});

test("concurrent reservations cannot overdraw the ten yuan allowance", () => {
  const budget = money();
  for (let i = 0; i < 4; i++) budget.claimRequest(identity);
  assert.throws(() => budget.claimRequest(identity), {
    code: "model_budget_exhausted",
  });
  assert.equal(budget.snapshot().requests, 4);
  assert.equal(budget.snapshot().costUpperBoundCny, 8.516608);
  assert.equal(budget.isExhausted(), true);
});

test("zero yuan prevents every request and boundary checks use the actual output cap", () => {
  const disabled = money({ maxCostCny: 0 });
  assert.throws(() => disabled.claimRequest(identity), {
    code: "model_budget_exhausted",
  });
  assert.equal(disabled.snapshot().requests, 0);
  const budget = money({ maxCostCny: 2.1 });
  assert.equal(budget.isExhausted(), true);
  assert.equal(budget.isExhausted({ maxOutputTokens: 1 }), false);
  budget.claimRequest({ ...identity, maxOutputTokens: 1 });
  assert.equal(budget.snapshot().reservedCostCny, 2.09716);
});

test("settlement is idempotent and cannot release an uncertain request later", () => {
  const budget = money();
  const id = budget.claimRequest(identity);
  budget.settleRequest(id);
  budget.settleRequest(id, usage(0, 0));
  budget.settleRequest(99, usage(0, 0));
  assert.equal(budget.snapshot().costUpperBoundCny, 2.129152);
  assert.equal(budget.snapshot().uncertainCostCny, 2.129152);
  assert.equal(budget.snapshot().uncertainRequests, 1);
});

for (const invalid of [
  undefined,
  null,
  {},
  usage(-1, 1),
  usage("100", 1),
  usage(1.5, 1),
  usage(1048577, 1),
  usage(1, 4001),
  { ...usage(), total_tokens: 0 },
  { ...usage(), prompt_cache_hit_tokens: 101 },
  { ...usage(), completion_tokens_details: { reasoning_tokens: 51 } },
])
  test(
    "untrustworthy usage retains the full reservation: " +
      JSON.stringify(invalid),
    () => {
      const budget = money();
      const id = budget.claimRequest(identity);
      budget.settleRequest(id, invalid);
      assert.equal(budget.snapshot().reservedCostCny, 0);
      assert.equal(budget.snapshot().uncertainCostCny, 2.129152);
      assert.equal(budget.snapshot().pricedRequests, 0);
      assert.equal(budget.snapshot().uncertainRequests, 1);
    },
  );

test("known cached usage still charges the worst cache miss price and accepts zero tokens", () => {
  const budget = money();
  budget.settleRequest(budget.claimRequest(identity), {
    ...usage(100, 50),
    prompt_cache_hit_tokens: 100,
    prompt_cache_miss_tokens: 0,
  });
  budget.settleRequest(budget.claimRequest(identity), usage(0, 0));
  assert.equal(budget.snapshot().costUpperBoundCny, 0.0006);
  assert.equal(budget.snapshot().pricedRequests, 2);
});

test("money configuration fails closed for unsupported model endpoints and invalid yuan values", () => {
  for (const baseUrl of [
    "http://api.deepseek.com",
    "https://api.deepseek.com:444",
    "https://api.deepseek.com.example.org",
    "https://api.deepseek.com/v2",
    "https://api.deepseek.com?key=value",
    "https://user:pass@api.deepseek.com",
    "https://api.deepseek.com/#fragment",
  ])
    assert.throws(() => money({ modelConfig: { ...modelConfig, baseUrl } }), {
      code: "model_pricing_unsupported",
    });
  assert.throws(
    () => money({ modelConfig: { ...modelConfig, model: "deepseek-chat" } }),
    { code: "model_pricing_unsupported" },
  );
  for (const maxCostCny of [-1, 10.01, 0.001, "10", Infinity, NaN])
    assert.throws(() => money({ maxCostCny }));
  assert.doesNotThrow(() => money({ maxCostCny: 0.29 }));
  assert.throws(() => budgets.createModelBudget({ maxRequests: 21 }));
});

test("factory migrates old positive request caps to money mode but retains disabled settings", () => {
  assert.equal(typeof budgets.createConfiguredModelBudget, "function");
  const budget = budgets.createConfiguredModelBudget({
    modelConfig,
    budgets: { maxCostCny: 10, maxModelRequests: 20 },
  });
  assert.equal(budget.snapshot().maxRequests, 1000);
  const disabled = budgets.createConfiguredModelBudget({
    modelConfig,
    budgets: { maxCostCny: 10, maxModelRequests: 0 },
  });
  assert.equal(disabled.snapshot().maxRequests, 0);
  const old = budgets.createConfiguredModelBudget({
    budgets: { maxModelRequests: 3 },
  });
  assert.deepEqual(old.snapshot(), {
    requests: 0,
    maxRequests: 3,
    maxOutputTokens: 4000,
  });
});

test("budget binds to immutable model identity and accepts the official v1 endpoint alias", () => {
  const config = { ...modelConfig };
  const budget = money({ modelConfig: config });
  config.model = "other-model";
  assert.doesNotThrow(() =>
    budget.assertModel({
      ...modelConfig,
      baseUrl: "https://api.deepseek.com/",
    }),
  );
  assert.throws(
    () => budget.claimRequest({ ...identity, model: "other-model" }),
    { code: "model_pricing_unsupported" },
  );
  assert.equal(budget.snapshot().requests, 0);
});

test("physical requests settle before returning and disable thinking on official flash", async () => {
  const budget = money();
  const payloads = [];
  const model = client(budget, async (url, options) => {
    payloads.push(JSON.parse(options.body));
    return reply();
  });
  assert.equal(await model.chat("system", "user"), "answer");
  assert.deepEqual(payloads[0].thinking, { type: "disabled" });
  assert.equal(payloads[0].max_tokens, 4000);
  assert.equal(budget.snapshot().costUpperBoundCny, 0.0006);
  assert.equal(budget.snapshot().reservedCostCny, 0);
});

test("ten yuan permits only four concurrent transports until their usage is settled", async () => {
  const budget = money();
  const pending = [];
  const model = client(
    budget,
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const calls = Array.from({ length: 5 }, () => model.chat("system", "user"));
  const settled = Promise.allSettled(calls);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 4);
  for (const resolve of pending) resolve(reply());
  const results = await settled;
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 4);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "model_budget_exhausted",
  );
  assert.equal(budget.snapshot().costUpperBoundCny, 0.0024);
  assert.equal(budget.snapshot().reservedCostCny, 0);
});

test("retry, JSON downgrade and repair each reserve from the same money ledger", async () => {
  const budget = money();
  const responses = [
    new Response("unavailable", { status: 503 }),
    new Response("response_format unsupported", { status: 400 }),
    reply("broken JSON"),
    reply('{"results":[]}'),
  ];
  let calls = 0;
  const model = client(budget, async () => {
    calls++;
    return responses.shift();
  });
  assert.deepEqual(await model.chatJson("system", "user"), { results: [] });
  assert.equal(calls, 4);
  assert.equal(budget.snapshot().uncertainRequests, 2);
  assert.equal(budget.snapshot().pricedRequests, 2);
  assert.equal(budget.snapshot().uncertainCostCny, 4.258304);
  assert.equal(budget.snapshot().costUpperBoundCny, 4.259504);
});

test("JSON repair cannot start a new transport when unknown usage consumed the remainder", async () => {
  const budget = money({ maxCostCny: 2.13 });
  let calls = 0;
  const model = client(budget, async () => {
    calls++;
    return reply("broken JSON", null);
  });
  await assert.rejects(model.chatJson("system", "user"), {
    code: "model_budget_exhausted",
  });
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().uncertainRequests, 1);
});

test("cancelled and unparsable responses retain their possible billed cost", async () => {
  const cancelled = money();
  const controller = new AbortController();
  const reason = Object.assign(Error("synthetic abort"), {
    name: "AbortError",
  });
  const model = client(
    cancelled,
    async () => {
      controller.abort(reason);
      throw reason;
    },
    { signal: controller.signal },
  );
  await assert.rejects(model.chat("system", "user"), { name: "AbortError" });
  assert.equal(cancelled.snapshot().uncertainCostCny, 2.129152);
  const malformed = money({ maxCostCny: 2.13 });
  let calls = 0;
  await assert.rejects(
    client(malformed, async () => {
      calls++;
      return new Response("not JSON", { status: 200 });
    }).chat("system", "user"),
    { code: "model_budget_exhausted" },
  );
  assert.equal(calls, 1);
  assert.equal(malformed.snapshot().uncertainCostCny, 2.129152);
});

test("binding validation prevents a mutated model from reaching transport", async () => {
  const budget = money();
  let calls = 0;
  const model = client(budget, async () => {
    calls++;
    return reply();
  });
  model.model = "other-model";
  await assert.rejects(model.chat("system", "user"), {
    code: "model_pricing_unsupported",
  });
  assert.equal(calls, 0);
  assert.equal(budget.snapshot().requests, 0);
});
