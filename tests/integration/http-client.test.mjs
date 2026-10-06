import test from "node:test";
import assert from "node:assert/strict";
import { createRequestClient } from "../../src/infrastructure/http/client.mjs";
import { createSourceBudget } from "../../src/infrastructure/http/budget.mjs";
import { createScheduler } from "../../src/infrastructure/http/scheduler.mjs";
const PUBLIC = "https://jobs.example.com/list";
const dnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const scheduler = () => createScheduler({ minIntervalMs: 0 });
test("per-request retry cap avoids repeated gateway and transport failures", async () => {
  for (const transportFailure of [false, true]) {
    let calls = 0,
      waits = 0;
    const budget = createSourceBudget({ maxRequests: 5 });
    const request = createRequestClient({
      budget,
      dnsLookup,
      scheduler: scheduler(),
      clock: {
        now: Date.now,
        sleep: async () => {
          waits++;
        },
      },
      transport: async () => {
        calls++;
        if (transportFailure)
          throw Object.assign(Error("timeout"), { code: "ETIMEDOUT" });
        return { status: 504, headers: {}, text: "gateway timeout" };
      },
    });
    if (transportFailure)
      await assert.rejects(request(PUBLIC, { maxRetries: 0 }), {
        code: "ETIMEDOUT",
      });
    else assert.equal((await request(PUBLIC, { maxRetries: 0 })).status, 504);
    assert.equal(calls, 1);
    assert.equal(waits, 0);
    assert.equal(budget.snapshot().requests, 1);
    if (transportFailure)
      await assert.rejects(request(PUBLIC, { maxRetries: 1 }), {
        code: "ETIMEDOUT",
      });
    else assert.equal((await request(PUBLIC, { maxRetries: 1 })).status, 504);
    assert.equal(calls, 3);
    assert.equal(waits, 1);
    assert.equal(budget.snapshot().requests, 3);
  }
});

test("invalid retry caps are rejected before network or cached results", async () => {
  let calls = 0;
  const request = createRequestClient({
    dnsLookup,
    scheduler: scheduler(),
    transport: async () => {
      calls++;
      return { status: 200, headers: {}, text: "{}" };
    },
  });
  await request(PUBLIC, { cacheKey: "example" });
  for (const maxRetries of [-1, 3, 0.5, "0", null])
    await assert.rejects(
      request(PUBLIC, { maxRetries, cacheKey: "example" }),
      /retry limit/i,
    );
  assert.equal(calls, 1);
});
test("retries and redirects count every actual attempt", async () => {
  let calls = 0;
  const statuses = [429, 503, 200],
    budget = createSourceBudget({ maxRequests: 3, maxDetails: 2 });
  const request = createRequestClient({
    budget,
    dnsLookup,
    scheduler: scheduler(),
    clock: { now: Date.now, sleep: async () => {} },
    transport: async () => ({
      status: statuses[calls++],
      headers: {},
      text: "{}",
      url: PUBLIC,
    }),
  });
  assert.equal((await request(PUBLIC)).status, 200);
  assert.equal(budget.snapshot().requests, 3);
  await assert.rejects(request(PUBLIC), /budget_exhausted/);
  assert.equal(calls, 3);
  const redirect = createRequestClient({
    dnsLookup,
    scheduler: scheduler(),
    transport: async () => ({
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
      text: "",
    }),
  });
  await assert.rejects(redirect(PUBLIC), /private|address/i);
});
test("DNS rebinding mixed answers, credentials and Host overrides are refused", async () => {
  let calls = 0;
  const request = createRequestClient({
    scheduler: scheduler(),
    dnsLookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ],
    transport: async () => {
      calls++;
    },
  });
  await assert.rejects(request(PUBLIC), /address/i);
  assert.equal(calls, 0);
  await assert.rejects(
    request("https://user:pass@jobs.example.com/"),
    /credential/i,
  );
  await assert.rejects(
    request(PUBLIC, { headers: { Host: "elsewhere" } }),
    /Host/i,
  );
});
test("abort cancels queued work and retry waits; size limits and cache isolation hold", async () => {
  let calls = 0,
    release;
  const s = createScheduler({ maxConcurrent: 1, minIntervalMs: 0 });
  const request = createRequestClient({
    dnsLookup,
    scheduler: s,
    transport: async () => {
      calls++;
      await new Promise((r) => (release = r));
      return { status: 200, headers: {}, text: "ok" };
    },
  });
  const first = request(PUBLIC);
  while (!release) await new Promise((r) => setTimeout(r, 1));
  const ac = new AbortController();
  const queued = request(PUBLIC, { signal: ac.signal });
  ac.abort();
  await assert.rejects(queued, /abort/i);
  release();
  await first;
  assert.equal(calls, 1);
  const big = createRequestClient({
    dnsLookup,
    scheduler: scheduler(),
    maxBytes: 2,
    transport: async () => ({ status: 200, headers: {}, text: "long" }),
  });
  await assert.rejects(big(PUBLIC), /size/i);
  let n = 0;
  const cached = createRequestClient({
    dnsLookup,
    scheduler: scheduler(),
    transport: async () => ({ status: 200, headers: {}, text: String(++n) }),
  });
  assert.equal((await cached(PUBLIC, { cacheKey: "parser1" })).text, "1");
  assert.equal((await cached(PUBLIC, { cacheKey: "parser1" })).text, "1");
  assert.equal((await cached(PUBLIC, { cacheKey: "parser2" })).text, "2");
});
test("retry waits abort immediately and origins share spacing without blocking other domains", async () => {
  const ac = new AbortController();
  let calls = 0;
  const request = createRequestClient({
    dnsLookup,
    scheduler: scheduler(),
    transport: async () => {
      calls++;
      return { status: 429, headers: { "retry-after": "60" }, text: "" };
    },
  });
  const pending = request(PUBLIC, { signal: ac.signal });
  while (calls < 1) await new Promise((r) => setTimeout(r, 1));
  ac.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(calls, 1);
  const s = createScheduler({ minIntervalMs: 25, maxConcurrent: 3 });
  const starts = [];
  await Promise.all([
    s.run("a", () => starts.push(["a", Date.now()])),
    s.run("a", () => starts.push(["a", Date.now()])),
    s.run("b", () => starts.push(["b", Date.now()])),
  ]);
  assert.equal(starts[1][0], "b");
  assert.ok(starts[2][1] - starts[0][1] >= 24);
});
