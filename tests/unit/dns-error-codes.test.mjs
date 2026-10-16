import test from "node:test";
import assert from "node:assert/strict";
import { createDnsLookup } from "../../src/infrastructure/http/dns.mjs";
import { createRequestClient } from "../../src/infrastructure/http/client.mjs";
import { createScheduler } from "../../src/infrastructure/http/scheduler.mjs";
import {
  safeSourceIssues,
  normalizeSourceStatus,
} from "../../src/sources/source-status.mjs";
import { sourceIssue } from "../../src/sources/adapters/legacy.mjs";

const host = "synthetic-private-host.example.com";
const publicAnswer = { type: 1, data: "93.184.216.34", TTL: 60 };
const response = (data, status = 200) => ({
  status,
  text: JSON.stringify(data),
});
function fixture(makeResponse, options = {}) {
  const calls = [],
    claims = [],
    settled = [],
    events = [],
    errors = [];
  const lookup = createDnsLookup({
    mode: "doh",
    budget: {
      claimRequest: async (kind, limits) => {
        const reservation = { index: claims.length };
        claims.push({ kind, limits, reservation });
        return reservation;
      },
      settleRequest: async (reservation, usage) =>
        settled.push({ reservation, usage }),
    },
    transport: async ({ url, addresses, headers, maxBytes }) => {
      assert.equal(url.origin, "https://cloudflare-dns.com");
      assert.equal(url.pathname, "/dns-query");
      assert.equal(url.searchParams.get("name"), host);
      assert.deepEqual(addresses, [{ address: "1.1.1.1", family: 4 }]);
      assert.deepEqual(headers, { accept: "application/dns-json" });
      assert.equal(maxBytes, 65536);
      const result = makeResponse(url.searchParams.get("type"));
      calls.push({
        type: url.searchParams.get("type"),
        bytes: Buffer.byteLength(result.text),
      });
      return result;
    },
    diagnostics: {
      record: (event, error) => {
        events.push(event);
        if (error) errors.push(error);
      },
    },
    diagnosticContext: {
      sourceId: "synthetic",
      siteId: "synthetic-site",
      runId: "synthetic-run",
    },
    ...options,
  });
  return { lookup, calls, claims, settled, events, errors };
}
function safeMetadata(f) {
  for (const privateValue of [
    host,
    publicAnswer.data,
    "127.0.0.1",
    "private-raw-json",
    "private-credential",
  ])
    assert.equal(
      JSON.stringify(f.events).includes(privateValue),
      false,
      privateValue,
    );
}

for (const [name, makeResponse, code] of [
  [
    "HTTP unavailable",
    () => response({ note: "private-credential" }, 503),
    "public_dns_unavailable",
  ],
  [
    "negative DNS status",
    () => response({ Status: 3 }),
    "public_dns_resolution_failed",
  ],
  ["missing answers", () => response({ Status: 0 }), "public_dns_no_answer"],
  [
    "empty answers",
    () => response({ Status: 0, Answer: [] }),
    "public_dns_no_answer",
  ],
  [
    "CNAME-only answers",
    () =>
      response({
        Status: 0,
        Answer: [{ type: 5, data: "private-credential.example.com" }],
      }),
    "public_dns_no_answer",
  ],
  [
    "private IPv4 answer",
    () => response({ Status: 0, Answer: [{ type: 1, data: "127.0.0.1" }] }),
    "public_dns_non_public",
  ],
  [
    "private IPv6 answer",
    () => response({ Status: 0, Answer: [{ type: 28, data: "::1" }] }),
    "public_dns_non_public",
  ],
  [
    "mixed public and private",
    () =>
      response({
        Status: 0,
        Answer: [publicAnswer, { type: 1, data: "127.0.0.1" }],
      }),
    "public_dns_non_public",
  ],
  [
    "malformed JSON",
    () => ({ status: 200, text: '{"private-raw-json": private-credential}' }),
    "public_dns_invalid_response",
  ],
  ["null root", () => response(null), "public_dns_invalid_response"],
  ["array root", () => response([]), "public_dns_invalid_response"],
  [
    "missing status",
    () => response({ Answer: [publicAnswer] }),
    "public_dns_invalid_response",
  ],
  [
    "string status",
    () => response({ Status: "0", Answer: [publicAnswer] }),
    "public_dns_invalid_response",
  ],
  [
    "fractional status",
    () => response({ Status: 0.5 }),
    "public_dns_invalid_response",
  ],
  [
    "object answers",
    () => response({ Status: 0, Answer: { data: "private-credential" } }),
    "public_dns_invalid_response",
  ],
  [
    "null answers",
    () => response({ Status: 0, Answer: null }),
    "public_dns_invalid_response",
  ],
  [
    "null answer entry",
    () => response({ Status: 0, Answer: [null] }),
    "public_dns_invalid_response",
  ],
  [
    "string answer type",
    () =>
      response({ Status: 0, Answer: [{ type: "1", data: publicAnswer.data }] }),
    "public_dns_invalid_response",
  ],
  [
    "object address",
    () =>
      response({
        Status: 0,
        Answer: [{ type: 1, data: { value: "private-credential" } }],
      }),
    "public_dns_invalid_response",
  ],
  [
    "invalid address",
    () =>
      response({
        Status: 0,
        Answer: [{ type: 1, data: "private-credential" }],
      }),
    "public_dns_invalid_response",
  ],
  [
    "wrong address family",
    () =>
      response({
        Status: 0,
        Answer: [{ type: 1, data: "2606:4700:4700::1111" }],
      }),
    "public_dns_invalid_response",
  ],
])
  test("public DNS reports a safe typed error for " + name, async () => {
    const f = fixture(makeResponse);
    const error = await f.lookup(host).then(
      () => assert.fail("invalid DNS response must reject"),
      (error) => error,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(
      f.claims.map(({ kind, limits }) => [kind, limits.bytesUpperBound]),
      [
        ["dns", 65536],
        ["dns", 65536],
      ],
    );
    assert.equal(f.settled.length, 2);
    assert.deepEqual(
      f.settled.map(({ usage }) => usage.bytes),
      f.calls.map(({ bytes }) => bytes),
    );
    const terminal = f.events.at(-1);
    assert.equal(terminal.operation, "network.dns");
    assert.equal(terminal.outcome, "failed");
    assert.equal(terminal.code, code);
    assert.equal(f.errors.at(-1), error);
    const issue = sourceIssue(error, "synthetic", "synthetic-site");
    assert.equal(issue.code, code);
    assert.equal(
      safeSourceIssues([issue], "synthetic", "synthetic-site")[0].code,
      code,
    );
    assert.equal(
      normalizeSourceStatus({ status: "error", issues: [issue] }),
      "unavailable",
    );
    safeMetadata(f);
  });

test("typed DNS failure reaches the HTTP terminal and source issues without starting target transport or retry", async () => {
  const f = fixture(() => response({ Status: 3 }));
  const events = [];
  let targetCalls = 0;
  const request = createRequestClient({
    dnsLookup: f.lookup,
    scheduler: createScheduler({ minIntervalMs: 0 }),
    transport: async () => {
      targetCalls++;
      assert.fail("DNS refusal must prevent target requests");
    },
    diagnostics: { record: (event) => events.push(event) },
  });
  await assert.rejects(request("https://" + host + "/private-credential"), {
    code: "public_dns_resolution_failed",
    phase: "dns",
  });
  assert.equal(targetCalls, 0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.claims.length, 2);
  assert.equal(f.settled.length, 2);
  const terminal = events.filter(
    (event) => event.operation === "network.request",
  );
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].failurePhase, "dns");
  assert.equal(terminal[0].code, "public_dns_resolution_failed");
  assert.equal(terminal[0].retryCount, 0);
  safeMetadata({ events: [...f.events, ...events] });
});

test("the DNS issue whitelist accepts only the fixed codes and discards upstream details", () => {
  for (const code of [
    "public_dns_unavailable",
    "public_dns_resolution_failed",
    "public_dns_no_answer",
    "public_dns_non_public",
    "public_dns_invalid_response",
  ])
    assert.deepEqual(
      safeSourceIssues(
        [
          {
            code,
            host,
            address: "127.0.0.1",
            message: "private-credential",
            response: "private-raw-json",
          },
        ],
        "synthetic",
        "synthetic-site",
      ),
      [{ code, sourceId: "synthetic", siteId: "synthetic-site" }],
    );
  assert.equal(
    safeSourceIssues(
      [{ code: "public_dns_private-credential" }],
      "synthetic",
      "synthetic-site",
    )[0].code,
    "source_probe_failed",
  );
});

test("valid A and AAAA answers remain public and cached after one two-request lookup", async () => {
  const f = fixture((type) =>
    response({
      Status: 0,
      Answer: [
        type === "A"
          ? publicAnswer
          : { type: 28, data: "2606:4700:4700::1111", TTL: 60 },
      ],
    }),
  );
  const expected = [
    { address: publicAnswer.data, family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ];
  const first = await f.lookup(host);
  assert.deepEqual(first, expected);
  first[0].address = "127.0.0.1";
  assert.deepEqual(await f.lookup(host), expected);
  assert.equal(f.calls.length, 2);
  assert.equal(f.settled.length, 2);
  assert.equal(f.events.at(-1).dnsResolver, "cache");
  safeMetadata(f);
});
