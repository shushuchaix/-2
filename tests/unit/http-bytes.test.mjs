import test from "node:test";
import assert from "node:assert/strict";
import { createRequestClient } from "../../src/infrastructure/http/client.mjs";
import { createSourceBudget } from "../../src/infrastructure/http/budget.mjs";
import { createScheduler } from "../../src/infrastructure/http/scheduler.mjs";
const url = "https://jobs.example.com/attachment.pdf";
const bytes = new Uint8Array([0, 255, 37, 80, 68, 70]);
const setup = (transport, options = {}) =>
  createRequestClient({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    scheduler: createScheduler({ minIntervalMs: 0 }),
    transport,
    ...options,
  });
test("review: zero immediate retries preserves server cooldown", async () => {
  const now = Date.parse("2026-10-09T00:00:00Z");
  const request = setup(
    async () => ({
      status: 429,
      headers: { "retry-after": "86400" },
      text: "limited",
    }),
    { clock: { now: () => now } },
  );
  const r = await request(url, { maxRetries: 0 });
  assert.equal(r.nextDueAt, "2026-10-10T00:00:00.000Z");
});
test("binary_is_not_roundtripped_through_text_and_cache_modes_are_distinct", async () => {
  let calls = 0;
  const request = setup(async (input) => {
    calls++;
    assert.ok(["text", "bytes"].includes(input.responseType));
    return {
      status: 200,
      headers: {},
      ...(input.responseType === "bytes"
        ? { bytes: new Uint8Array(bytes) }
        : { text: "PDF" }),
    };
  });
  assert.equal((await request(url, { cacheKey: "same" })).text, "PDF");
  const result = await request(url, {
    responseType: "bytes",
    cacheKey: "same",
  });
  assert.deepEqual(result.bytes, bytes);
  result.bytes[0] = 99;
  assert.deepEqual(
    (await request(url, { responseType: "bytes", cacheKey: "same" })).bytes,
    bytes,
  );
  assert.equal(calls, 2);
});
test("binary_size_limit_and_private_redirect_fail_before_followup", async () => {
  const big = setup(async () => ({ status: 200, headers: {}, bytes }), {
    maxBytes: 2,
  });
  await assert.rejects(big(url, { responseType: "bytes" }), {
    code: "response_size_exceeded",
  });
  let calls = 0;
  const redirect = setup(async () => {
    calls++;
    return {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
      bytes: new Uint8Array(),
    };
  });
  await assert.rejects(
    redirect(url, { responseType: "bytes" }),
    /private|address/i,
  );
  assert.equal(calls, 1);
});
test("every_physical_attempt_counts_and_retry_after_is_not_shortened", async () => {
  const budget = createSourceBudget({ maxRequests: 4 }),
    waits = [];
  const replies = [
    { status: 302, headers: { location: "/next" } },
    { status: 200, headers: {} },
    { status: 429, headers: { "retry-after": "30" } },
    { status: 304, headers: {} },
  ];
  const request = setup(async () => ({ ...replies.shift(), bytes }), {
    budget,
    clock: { now: Date.now, sleep: async (ms) => waits.push(ms) },
  });
  assert.equal((await request(url, { responseType: "bytes" })).status, 200);
  assert.equal((await request(url, { responseType: "bytes" })).status, 304);
  assert.equal(budget.snapshot().requests, 4);
  assert.ok(waits[0] >= 30000);
  let delayedCalls = 0;
  const long = setup(
    async () => {
      delayedCalls++;
      return { status: 429, headers: { "retry-after": "120" }, text: "" };
    },
    { clock: { now: Date.now, sleep: async () => {} } },
  );
  await assert.rejects(
    long(url),
    (e) => e.code === "source_retry_deferred" && e.retryAfterMs >= 120000,
  );
  assert.equal(delayedCalls, 1);
});
test("fast_failures_slow_scheduler_instead_of_speeding_it_up", () => {
  const s = createScheduler({ minIntervalMs: 600, clock: { now: () => 1000 } });
  s.recordOutcome("https://example.com", { durationMs: 2, status: 503 });
  assert.ok(s.originState("https://example.com").intervalMs > 600);
  s.recordOutcome("https://example.com", { durationMs: 5000, status: 200 });
  assert.ok(s.originState("https://example.com").intervalMs >= 5000);
});
