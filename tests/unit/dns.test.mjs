import test from "node:test";
import assert from "node:assert/strict";
import { createDnsLookup } from "../../src/infrastructure/http/dns.mjs";
import { createSourceBudget } from "../../src/infrastructure/http/budget.mjs";
test("a valid public DNS cache skips repeated system Fake-IP lookups until TTL expiry", async () => {
  let now = 0,
    systems = 0,
    wires = 0;
  const lookup = createDnsLookup({
    clock: { now: () => now },
    lookup: async () => {
      systems++;
      return [{ address: "198.18.0.2", family: 4 }];
    },
    transport: async ({ url }) => {
      wires++;
      return {
        status: 200,
        text: JSON.stringify({
          Status: 0,
          Answer:
            url.searchParams.get("type") === "A"
              ? [{ type: 1, data: "8.8.8.8", TTL: 30 }]
              : [],
        }),
      };
    },
  });
  await lookup("jobs.example.com");
  await lookup("jobs.example.com");
  assert.equal(
    systems,
    1,
    "cached public answers must not wait for the system resolver again",
  );
  assert.equal(wires, 2);
  now = 30001;
  await lookup("jobs.example.com");
  assert.equal(systems, 2);
  assert.equal(wires, 4);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    lookup("jobs.example.com", { signal: controller.signal }),
    { name: "AbortError" },
  );
});
test("Fake-IP resolution uses public DoH without trusting private answers", async () => {
  let calls = 0;
  const budget = createSourceBudget({ maxRequests: 6 });
  const lookup = createDnsLookup({
    budget,
    lookup: async () => [{ address: "198.18.0.2", family: 4 }],
    transport: async ({ url }) => {
      calls++;
      return {
        status: 200,
        text: JSON.stringify({
          Status: 0,
          Answer:
            url.searchParams.get("type") === "A"
              ? [{ type: 1, data: "93.184.216.34", TTL: 60 }]
              : [],
        }),
      };
    },
  });
  assert.deepEqual(await lookup("jobs.example.com"), [
    { address: "93.184.216.34", family: 4 },
  ]);
  await lookup("jobs.example.com");
  assert.equal(calls, 2);
  assert.equal(budget.snapshot().requests, 2);
  const bad = createDnsLookup({
    mode: "doh",
    transport: async () => ({
      status: 200,
      text: JSON.stringify({
        Status: 0,
        Answer: [{ type: 1, data: "127.0.0.1" }],
      }),
    }),
  });
  await assert.rejects(bad("private.example.com"), /public|address/i);
});

test("per-call cancellation stops fallback after system lookup and credit reservation", async () => {
  for (const phase of ["lookup", "budget"]) {
    const controller = new AbortController();
    let transportCalls = 0;
    const lookup = createDnsLookup({
      mode: phase === "budget" ? "doh" : "auto",
      lookup: async () => {
        controller.abort();
        return [{ address: "198.18.0.2", family: 4 }];
      },
      budget: {
        claimRequest: async () => {
          if (phase === "budget") controller.abort();
        },
      },
      transport: async () => {
        transportCalls++;
        return {
          status: 200,
          text: JSON.stringify({
            Status: 0,
            Answer: [{ type: 1, data: "93.184.216.34" }],
          }),
        };
      },
    });
    await assert.rejects(
      lookup("jobs.example.com", { signal: controller.signal }),
      { name: "AbortError" },
    );
    assert.equal(transportCalls, 0, phase);
  }
});

test("per-call cancellation reaches in-flight DoH transports", async () => {
  const controller = new AbortController();
  const signals = [];
  const lookup = createDnsLookup({
    mode: "doh",
    transport: async ({ signal }) => {
      signals.push(signal);
      if (signals.length === 2) controller.abort();
      return {
        status: 200,
        text: JSON.stringify({
          Status: 0,
          Answer: [{ type: 1, data: "93.184.216.34" }],
        }),
      };
    },
  });
  await assert.rejects(
    lookup("jobs.example.com", { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
});
