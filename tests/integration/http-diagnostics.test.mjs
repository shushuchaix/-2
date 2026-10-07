import test from "node:test";
import assert from "node:assert/strict";
import { createRequestClient } from "../../src/infrastructure/http/client.mjs";
import { createDnsLookup } from "../../src/infrastructure/http/dns.mjs";
import { createSourceBudget } from "../../src/infrastructure/http/budget.mjs";
import { createScheduler } from "../../src/infrastructure/http/scheduler.mjs";

const PUBLIC = "https://private-host.example.com/list?secret=private-query";
const addresses = [{ address: "93.184.216.34", family: 4 }];
const dnsLookup = async () => addresses;
const scheduler = () => createScheduler({ minIntervalMs: 0 });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const operation = (events, name) => events.filter((e) => e.operation === name);
function fixture(options = {}) {
  const events = [];
  const errors = [];
  const request = createRequestClient({
    dnsLookup,
    scheduler: scheduler(),
    clock: { now: Date.now, sleep: async () => {} },
    diagnostics: {
      record: (event, error) => {
        events.push(event);
        if (error) errors.push(error);
      },
    },
    ...options,
  });
  return { request, events, errors };
}
function assertSafe(events) {
  const serialized = JSON.stringify(events);
  for (const secret of [
    "private-host",
    "private-query",
    "private-header",
    "private-body",
    "private-cache",
    "private-abort",
    "93.184.216.34",
  ])
    assert.equal(serialized.includes(secret), false, secret);
}
function terminal(events) {
  const ends = operation(events, "network.request");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].phase, "finished");
  assert.match(ends[0].requestId, /^q-[a-f0-9-]{36}$/);
  assert.ok(Number.isSafeInteger(ends[0].durationMs));
  return ends[0];
}

// Removing a retry's attempt record or its correlation fields loses the failed
// transport and its recovery, even though the returned response stays correct.
test("transport retry records the failed attempt and correlated recovery", async () => {
  let calls = 0;
  let now = 0;
  const budget = createSourceBudget({ maxRequests: 2 });
  const { request, events } = fixture({
    budget,
    dnsLookup: async () => {
      now += 3;
      return addresses;
    },
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    diagnosticContext: {
      runId: "r-run",
      sourceId: "src-source",
      siteId: "site-default",
    },
    transport: async () => {
      now += calls === 0 ? 5 : 7;
      if (++calls === 1)
        throw Object.assign(Error("private-body"), { code: "ECONNRESET" });
      return {
        status: 200,
        headers: { "content-type": "application/json; private-header" },
        text: "招聘",
      };
    },
  });
  const response = await request(PUBLIC, {
    kind: "list",
    headers: { authorization: "private-header" },
    body: "private-body",
    diagnosticContext: {
      siteId: "site-selected",
      queryIndex: 2,
      page: 3,
      endpointKind: "list",
      url: PUBLIC,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(budget.snapshot().requests, 2);
  const attempts = operation(events, "network.attempt");
  assert.deepEqual(
    attempts.map((e) => [e.attempt, e.phase, e.outcome]),
    [
      [1, "transport", "failed"],
      [2, "response", "success"],
    ],
  );
  assert.equal(attempts[0].code, "ECONNRESET");
  assert.equal(attempts[1].responseBytes, 6);
  assert.equal(attempts[1].parser.format, "json");
  const end = terminal(events);
  assert.equal(response.requestId, end.requestId);
  assert.equal(end.outcome, "success");
  assert.equal(end.retryCount, 1);
  assert.equal(end.attempt, 2);
  assert.deepEqual(
    [end.durationMs, end.queueMs, end.dnsMs, end.transportMs],
    [418, 0, 6, 12],
  );
  assert.deepEqual(
    attempts.map((e) => [e.durationMs, e.dnsMs, e.transportMs]),
    [
      [8, 3, 5],
      [10, 3, 7],
    ],
  );
  for (const event of events) {
    assert.equal(event.requestId, end.requestId);
    assert.equal(event.runId, "r-run");
    assert.equal(event.sourceId, "src-source");
    assert.equal(event.siteId, "site-selected");
    assert.equal(event.queryIndex, 2);
    assert.equal(event.page, 3);
    assert.equal(event.endpointKind, "list");
  }
  assert.deepEqual(
    operation(events, "network.retry").map((e) => e.retryDelayMs),
    [400],
  );
  assertSafe(events);
});

// A returned exhausted HTTP failure must be distinguishable from success, and a
// thrown exhausted transport failure must still end the logical request once.
test("retry exhaustion reports final HTTP and transport outcomes", async () => {
  for (const failure of ["http", "transport"]) {
    const budget = createSourceBudget({ maxRequests: 3 });
    const { request, events } = fixture({
      budget,
      transport: async () => {
        if (failure === "transport")
          throw Object.assign(Error("private-body"), { code: "ECONNRESET" });
        return { status: 503, headers: {}, text: "private-body" };
      },
    });
    if (failure === "http") assert.equal((await request(PUBLIC)).status, 503);
    else await assert.rejects(request(PUBLIC), { code: "ECONNRESET" });
    assert.equal(budget.snapshot().requests, 3);
    assert.equal(operation(events, "network.attempt").length, 3);
    const end = terminal(events);
    assert.equal(end.outcome, "failed");
    assert.equal(end.retryCount, 2);
    if (failure === "http") assert.equal(end.httpStatus, 503);
    else assert.equal(end.code, "ECONNRESET");
    assertSafe(events);
  }
});

// Cache hits must retain request correlation without consuming another request,
// while redirects remain visible as attempts without leaking the location.
test("redirect and cache records preserve independent request IDs and budgets", async () => {
  const budget = createSourceBudget({ maxRequests: 2 });
  const { request, events } = fixture({
    budget,
    transport: async ({ url }) =>
      url.pathname === "/list"
        ? {
            status: 302,
            headers: { location: "/final?secret=private-query" },
            text: "",
          }
        : {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
            text: "private-body",
          },
  });
  const first = await request(PUBLIC, { cacheKey: "private-cache" });
  assert.equal(first.status, 200);
  assert.equal(operation(events, "network.redirect").length, 1);
  const end = terminal(events);
  assert.equal(first.requestId, end.requestId);
  assert.equal(end.redirectCount, 1);
  const before = events.length;
  const second = await request(PUBLIC, { cacheKey: "private-cache" });
  assert.equal(second.text, first.text);
  assert.equal(budget.snapshot().requests, 2);
  const cached = events.slice(before);
  assert.equal(operation(cached, "network.attempt").length, 0);
  assert.equal(operation(cached, "network.cache").length, 1);
  const cacheEnd = terminal(cached);
  assert.equal(second.requestId, cacheEnd.requestId);
  assert.equal(cacheEnd.outcome, "cached");
  assert.equal(cacheEnd.cacheHit, true);
  assert.notEqual(cacheEnd.requestId, end.requestId);
  assertSafe(events);
});

// Early exits currently bypass attempts; dropping their terminal records makes
// budget rejection and malformed input indistinguishable from a hung request.
test("validation and budget refusals each emit a safe terminal record", async () => {
  for (const [value, options] of [
    [PUBLIC, { maxRetries: 3 }],
    ["https://127.0.0.1/private-query", {}],
    [PUBLIC, { headers: { Host: "private-header" } }],
  ]) {
    const { request, events } = fixture({
      transport: async () => {
        assert.fail("unexpected transport");
      },
    });
    await assert.rejects(request(value, options));
    assert.equal(operation(events, "network.attempt").length, 0);
    const end = terminal(events);
    assert.equal(end.outcome, "failed");
    assert.equal(end.failurePhase, "validation");
    assertSafe(events);
  }
  const budget = createSourceBudget({ maxRequests: 0, maxDetails: 0 });
  const { request, events } = fixture({
    budget,
    transport: async () => {
      assert.fail("unexpected transport");
    },
  });
  await assert.rejects(request(PUBLIC), {
    code: "source_budget_exhausted",
    budgetKind: "requests",
  });
  assert.equal(operation(events, "network.attempt")[0].phase, "budget");
  assert.equal(terminal(events).code, "source_budget_exhausted");
  assert.throws(() => budget.claimDetail("private-query"), {
    code: "source_budget_exhausted",
    budgetKind: "details",
  });
});

// An abort in each asynchronous phase must retain that phase and normalize the
// caller reason, without starting queued work or another retry.
test("caller cancellation records queue, DNS, transport, and retry phases", async () => {
  for (const phase of ["queue", "dns", "transport", "retry"]) {
    const started = deferred(),
      release = deferred(),
      controller = new AbortController();
    const activeScheduler = scheduler();
    let blocker;
    if (phase === "queue") {
      const s = createScheduler({ maxConcurrent: 1, minIntervalMs: 0 });
      blocker = s.run("blocker", async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      Object.assign(activeScheduler, s);
    }
    const { request, events, errors } = fixture({
      scheduler: activeScheduler,
      dnsLookup: async () => {
        if (phase === "dns") {
          started.resolve();
          await release.promise;
        }
        return addresses;
      },
      clock: {
        now: Date.now,
        sleep: async (ms, signal) => {
          started.resolve();
          await new Promise((resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      },
      transport: async () => {
        if (phase === "transport") {
          started.resolve();
          await release.promise;
        }
        return {
          status: phase === "retry" ? 503 : 200,
          headers: {},
          text: "ok",
        };
      },
    });
    const pending = request(PUBLIC, { signal: controller.signal });
    if (phase !== "queue") await started.promise;
    controller.abort(Error("private-abort"));
    await assert.rejects(pending, /private-abort/);
    const end = terminal(events);
    assert.equal(end.outcome, "cancelled");
    assert.equal(end.abortedBy, "caller");
    assert.equal(end.failurePhase, phase);
    if (phase !== "retry")
      assert.equal(operation(events, "network.attempt")[0].phase, phase);
    assertSafe(events);
    assert.equal(
      errors.some((error) => String(error.message).includes("private-abort")),
      false,
    );
    release.resolve();
    await blocker;
  }
});

// A timeout must be recorded as a timeout rather than an ordinary abort; neither
// stalled DNS nor stalled transport should start a recovery request.
test("timeouts record DNS or transport failure and a normalized timeout reason", async () => {
  for (const phase of ["dns", "transport"]) {
    const release = deferred();
    const keepAlive = setTimeout(() => release.resolve(), 1000);
    const { request, events } = fixture({
      dnsLookup: async () => {
        if (phase === "dns") await release.promise;
        return addresses;
      },
      transport: async () => {
        await release.promise;
        return { status: 200, headers: {}, text: "ok" };
      },
    });
    try {
      await assert.rejects(request(PUBLIC, { timeoutMs: 15 }), {
        name: "TimeoutError",
      });
      const end = terminal(events);
      assert.equal(end.outcome, "timeout");
      assert.equal(end.abortedBy, "timeout");
      assert.equal(end.failurePhase, phase);
      assert.equal(operation(events, "network.attempt").length, 1);
      assertSafe(events);
    } finally {
      clearTimeout(keepAlive);
      release.resolve();
    }
  }
});

// Transport timeout codes are consumed by the retry policy; diagnostics must
// retain that code while classifying the failure as a timeout.
test("transport timeout codes remain retryable and are classified as timeouts", async () => {
  const budget = createSourceBudget({ maxRequests: 2 });
  const { request, events } = fixture({
    budget,
    transport: async () => {
      throw Object.assign(Error("private-body"), { code: "ETIMEDOUT" });
    },
  });
  await assert.rejects(request(PUBLIC, { maxRetries: 1 }), {
    code: "ETIMEDOUT",
  });
  assert.equal(budget.snapshot().requests, 2);
  assert.deepEqual(
    operation(events, "network.attempt").map((event) => event.outcome),
    ["timeout", "timeout"],
  );
  const end = terminal(events);
  assert.equal(end.outcome, "timeout");
  assert.equal(end.code, "ETIMEDOUT");
  assert.equal(end.abortedBy, "timeout");
  assert.equal(end.retryCount, 1);
  assertSafe(events);
});

// A broken diagnostics callback must not become a new failure source or change
// cached responses, and its rejected promise must be handled.
test("throwing and rejecting diagnostic sinks do not affect request results", async () => {
  for (const diagnostics of [
    () => {
      throw Error("broken sink");
    },
    {
      record: async () => {
        throw Error("broken sink");
      },
    },
  ]) {
    const { request } = fixture({
      diagnostics,
      transport: async () => ({ status: 200, headers: {}, text: "ok" }),
    });
    assert.equal(
      (await request(PUBLIC, { cacheKey: "private-cache" })).text,
      "ok",
    );
    assert.equal(
      (await request(PUBLIC, { cacheKey: "private-cache" })).text,
      "ok",
    );
    await assert.rejects(request("https://127.0.0.1/"), /private/i);
  }
});

// Resolver selection and DoH cache use must be visible without another lookup
// request or a hostname/address entering the diagnostic event.
test("DNS diagnostics distinguish system, fallback, DoH, and cache safely", async () => {
  const events = [],
    budget = createSourceBudget({ maxRequests: 4 });
  const diagnostics = { record: (event) => events.push(event) };
  const system = createDnsLookup({
    mode: "system",
    diagnostics,
    lookup: async () => addresses,
  });
  assert.deepEqual(await system("private-host.example.com"), addresses);
  const fallback = createDnsLookup({
    diagnostics,
    budget,
    lookup: async () => [{ address: "198.18.0.2", family: 4 }],
    transport: async ({ url }) => ({
      status: 200,
      headers: {},
      text: JSON.stringify({
        Status: 0,
        Answer:
          url.searchParams.get("type") === "A"
            ? [{ type: 1, data: addresses[0].address, TTL: 60 }]
            : [],
      }),
    }),
  });
  assert.deepEqual(await fallback("private-host.example.com"), addresses);
  assert.deepEqual(await fallback("private-host.example.com"), addresses);
  assert.equal(budget.snapshot().requests, 2);
  assert.deepEqual(
    operation(events, "network.dns").map((e) => e.dnsResolver),
    ["system", "fallback", "doh", "fallback", "cache"],
  );
  assertSafe(events);
});
