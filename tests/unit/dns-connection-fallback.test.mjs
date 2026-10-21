import test from "node:test";
import assert from "node:assert/strict";
import { createDnsLookup } from "../../src/infrastructure/http/dns.mjs";
const response = (type) => ({
  status: 200,
  text: JSON.stringify({
    Status: 0,
    Answer: type === "A" ? [{ type: 1, data: "93.184.216.34", TTL: 30 }] : [],
  }),
});
const timeout = () =>
  Object.assign(Error("private transport message"), {
    code: "ABORT_ERR",
    cause: Object.assign(Error("private timeout"), { name: "TimeoutError" }),
  });
function fixture(transport, { signal, budget } = {}) {
  const calls = [],
    claims = [],
    settled = [],
    events = [];
  const lookup = createDnsLookup({
    mode: "doh",
    signal,
    budget: budget || {
      claimRequest: async () => {
        const r = { id: claims.length };
        claims.push(r);
        return r;
      },
      settleRequest: async (r, u) => settled.push({ r, u }),
    },
    transport: async (r) => {
      calls.push({
        address: r.addresses[0].address,
        type: r.url.searchParams.get("type"),
      });
      return transport(r);
    },
    diagnostics: { record: (e) => events.push(e) },
  });
  return { lookup, calls, claims, settled, events };
}
test("a transient primary DNS timeout tries the fixed secondary once and charges every attempt", async () => {
  const f = fixture(async (r) => {
    if (r.addresses[0].address === "1.1.1.1") throw timeout();
    return response(r.url.searchParams.get("type"));
  });
  assert.deepEqual(await f.lookup("jobs.example.org"), [
    { address: "93.184.216.34", family: 4 },
  ]);
  assert.equal(f.calls.length, 4);
  assert.equal(f.claims.length, 4);
  assert.equal(f.settled.length, 2);
  assert.equal(f.calls.filter((c) => c.address === "1.0.0.1").length, 2);
  assert.equal(
    f.events.filter(
      (e) =>
        e.outcome === "retrying" &&
        e.code === "request_timeout" &&
        e.retryCount === 1,
    ).length,
    2,
  );
  assert.equal(f.events.at(-1).outcome, "success");
  assert.doesNotMatch(
    JSON.stringify(f.events),
    /jobs.example|private transport|1\.1\.1\.1|1\.0\.0\.1|93\.184/,
  );
  await f.lookup("jobs.example.org");
  assert.equal(f.calls.length, 4);
});
test("only the failed address family uses secondary DNS", async () => {
  const f = fixture(async (r) => {
    if (
      r.addresses[0].address === "1.1.1.1" &&
      r.url.searchParams.get("type") === "A"
    )
      throw Object.assign(Error("reset"), { code: "ECONNRESET" });
    return response(r.url.searchParams.get("type"));
  });
  await f.lookup("jobs.example.org");
  assert.equal(f.calls.length, 3);
  assert.equal(f.settled.length, 2);
  assert.deepEqual(
    f.calls.filter((c) => c.address === "1.0.0.1"),
    [{ address: "1.0.0.1", type: "A" }],
  );
});
test("both exhausted DNS connections report timeout rather than an unclassified abort", async () => {
  const f = fixture(async () => {
    throw timeout();
  });
  await assert.rejects(f.lookup("jobs.example.org"), {
    name: "TimeoutError",
    code: "request_timeout",
  });
  assert.ok(f.calls.length <= 4);
  assert.equal(f.events.at(-1).outcome, "timeout");
  assert.equal(f.events.at(-1).abortedBy, "timeout");
});
for (const code of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"])
  test(
    "certificate failure does not switch DNS connections: " + code,
    async () => {
      const f = fixture(async () => {
        throw Object.assign(Error("private certificate details"), { code });
      });
      await assert.rejects(f.lookup("jobs.example.org"), { code });
      assert.ok(f.calls.every((c) => c.address === "1.1.1.1"));
    },
  );
test("cancellation during the first DNS attempt prevents the fallback and drains all requests", async () => {
  const c = new AbortController(),
    f = fixture(
      async () => {
        c.abort();
        throw timeout();
      },
      { signal: c.signal },
    );
  await assert.rejects(f.lookup("jobs.example.org"), { name: "AbortError" });
  assert.ok(f.calls.every((v) => v.address === "1.1.1.1"));
  assert.equal(f.events.at(-1).outcome, "cancelled");
});
test("a refused fallback reservation sends no secondary traffic", async () => {
  let claimed = 0;
  const f = fixture(
    async () => {
      throw timeout();
    },
    {
      budget: {
        claimRequest: async () => {
          if (++claimed > 2)
            throw Object.assign(Error("budget"), {
              code: "source_budget_exhausted",
              budgetKind: "requests",
            });
          return {};
        },
      },
    },
  );
  await assert.rejects(f.lookup("jobs.example.org"), {
    code: "source_budget_exhausted",
  });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((v) => v.address === "1.1.1.1"));
});

test("a private answer aborts its sibling before a late reset can send secondary traffic", async () => {
  const f = fixture(async (r) => {
    if (r.url.searchParams.get("type") === "A")
      return {
        status: 200,
        text: JSON.stringify({
          Status: 0,
          Answer: [{ type: 1, data: "127.0.0.1" }],
        }),
      };
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw Object.assign(Error("reset"), { code: "ECONNRESET" });
  });
  await assert.rejects(f.lookup("jobs.example.org"), {
    code: "public_dns_non_public",
  });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => c.address === "1.1.1.1"));
});

test("a late certificate error remains a certificate failure even if the timeout clock elapsed", async () => {
  const f = fixture(async (r) => {
    if (r.addresses[0].address === "1.0.0.1")
      return response(r.url.searchParams.get("type"));
    await new Promise((resolve) => setTimeout(resolve, 5050));
    throw Object.assign(Error("certificate"), { code: "CERT_HAS_EXPIRED" });
  });
  await assert.rejects(f.lookup("jobs.example.org"), {
    code: "CERT_HAS_EXPIRED",
  });
  assert.equal(f.calls.length, 2);
});
